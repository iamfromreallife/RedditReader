import { sanitizeNotificationRules, matchingNotificationRules } from './rules.js';
import { MAX_PARALLEL_FEEDS, REQUEST_SPACING_MS, AUTO_BATCH_LIMIT, MANUAL_BATCH_LIMIT, SharedRequestBudget, runParallelQueue, serialExecutor, chunkFeedIds } from './refresh-scheduler.js';
import { createRefreshCoordinator } from './refresh-coordinator.js';
import { publicSettings, UI_SETTINGS_KEYS, subredditIconUrl, searchFeedDetails, postToReddit, effectiveFeedRefreshMinutes, validRefreshOverride } from './shared.js';
import { sanitizeHighlighters } from './highlighters.js';
import { FONT_VALUES } from './font-options.js';
import { invalidateRestoredFeedValidators, missingRestoreMediaBatch, countUnreadRestoreMediaCandidates, snapshot, popupSnapshot, getRecord, getSettings, saveSettings, getDiagnostics, setDiagnostics, updateDiagnostics, getStorageMetrics, importFeeds, patchFeed, mergePostDetails, putPosts, markPosts, markScope, starPost, removeFeed, addFolder, updateFolder, removeFolder, cleanup, clearAll, all, restoreBackup, restoreCompleteBackup, ensureSidebarOrder, moveSidebarItem } from './db.js';
import { fetchFeed, fetchSubredditAboutIcon, fetchRedditPostDetails, providerReady, ProviderError } from './provider.js';
import { fetchSessionPage, canUsePageFallback, checkRedditSession } from './session.js';
import { SYNC_ALARM, DIRTY_ALARM, recordChanges, driveStatus, saveDriveClientId, connectDrive, disconnectDrive, syncNow, resumeRestoredDrive } from './drive.js';
import { beginManualOAuth, exchangeManualOAuth, getOAuthStatus, getOAuthAccessToken, disconnectOAuth } from './oauth.js';
import { PORTABLE_LOCAL_KEYS, buildPlainBackup, readBackup } from './backup.js';
import { RESTORE_RECOVERY_KEY, RESTORE_RECOVERY_LAST_KEY, RESTORE_RECOVERY_ALARM, RESTORE_MEDIA_BATCH, newRestoreRecovery, directRestoredImage } from './restore-recovery.js';
// Content scripts must not read extension-local credentials via chrome.storage.local.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);
const ALARM = 'substream-cycle';
let running = null;
let refreshProgress = { active: false, total: 0, completed: 0, checked: 0, added: 0, current: '' };
function updateRefreshProgress(patch) {
    refreshProgress = { ...refreshProgress, ...patch };
    void chrome.runtime.sendMessage({ type: 'refreshProgressChanged', progress: { ...refreshProgress } }).catch(() => { });
}
/** All Reddit requests share one paced start lane. The daily count is diagnostic
 * only; actual Reddit HTTP rate-limit responses are still respected. */
let lastRedditStart = 0;
let redditStartTail = Promise.resolve();
function appendRequestBucket(buckets, weight = 1, now = Date.now()) {
    const minute = Math.floor(now / 60000);
    const records = Array.isArray(buckets) ? buckets
        .filter(pair => Array.isArray(pair) && Number.isInteger(pair[0]) && Number.isFinite(pair[1]) && pair[0] >= minute - 59 && pair[0] <= minute)
        .slice(-60) : [];
    const last = records[records.length - 1];
    if (last?.[0] === minute) last[1] += weight;
    else records.push([minute, weight]);
    return records;
}
async function recordRedditRate(rateLimit) {
    if (!rateLimit) return;
    await updateDiagnostics(diag => (diag.redditRateLimit?.observedAt || 0) > rateLimit.observedAt
        ? null : { redditRateLimit: rateLimit });
}
async function reserveRedditRequest(settings, label, weight = 1, icon = false) {
    const next = await updateDiagnostics(d => {
        if (d.rateReset > Date.now()) return null;
        return {
            requestsToday: d.requestsToday + weight,
            requestDay: new Date().toISOString().slice(0, 10),
            providerStatus: 'Fetching ' + label,
            ...(icon ? { iconRequestsToday: (d.iconRequestsToday || 0) + 1 } : {}),
            requestMinuteBuckets: appendRequestBucket(d.requestMinuteBuckets, weight)
        };
    });
    if (!next) return false;
    // A single pacing lane covers scheduled feeds and auxiliary requests.
    // Actual request starts are staggered even when several handlers run in
    // parallel or a user opens details while feeds are refreshing.
    const work = redditStartTail.then(async () => {
        const delay = Math.max(0, lastRedditStart + REQUEST_SPACING_MS - Date.now());
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        lastRedditStart = Date.now();
    });
    redditStartTail = work.catch(() => {});
    await work;
    return true;
}
const ICON_CACHE_KEY = 'rrCommunityIconsV101';
/** Safe CDN-only local artwork cache; never synchronizes authentication data. */
async function readIconCache() {
    const raw = (await chrome.storage.local.get(ICON_CACHE_KEY))[ICON_CACHE_KEY] || {};
    const result = {};
    for (const [key, value] of Object.entries(raw))
        if (/^[a-z0-9_]{2,21}$/.test(key)) {
            const url = subredditIconUrl(value);
            if (url)
                result[key] = url;
        }
    return result;
}
async function saveCommunityIcons(icons) {
    const prior = await readIconCache();
    let changed = false;
    for (const [name, value] of Object.entries(icons)) {
        const key = name.toLowerCase();
        const url = subredditIconUrl(value);
        if (/^[a-z0-9_]{2,21}$/.test(key) && url && prior[key] !== url) {
            prior[key] = url;
            changed = true;
        }
    }
    if (!changed)
        return;
    const entries = Object.entries(prior).slice(-1500);
    await chrome.storage.local.set({ [ICON_CACHE_KEY]: Object.fromEntries(entries) });
}
/** Badge updates don't need folder, feed and subscription snapshots. */
async function badge() {
    const [posts, settings, diagnostics] = await Promise.all([all('posts'), getSettings(), getDiagnostics()]);
    const count = posts.reduce((total, post) => total + (!post.read && (settings.badgeMode !== 'new' || (diagnostics.lastRun > 0 && post.firstSeen >= diagnostics.lastRun)) ? 1 : 0), 0);
    await chrome.action.setBadgeText({ text: count === 0 ? '' : String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: settings.badgeColor });
}
async function broadcast() { await badge(); try {
    await chrome.runtime.sendMessage({ type: 'stateChanged' });
}
catch { /* no open views */ } }
function intervalFor(feed, folders, settings, added) { const wanted = effectiveFeedRefreshMinutes(feed, folders, settings.refreshMinutes); const mins = wanted === 0 ? (added ? 15 : Math.min(360, Math.max(30, 60 * (1 + feed.failureCount)))) : wanted; return Math.max(5, mins) * 60000; }
/** Fallback to the supported /r/{community}/about metadata endpoint. One
 * additional request at most per tick; metadata found in post listings is free. */
async function refreshOneIconBatch(settings, feeds, diagnostics) {
    const now = Date.now();
    if (!['session', 'oauth'].includes(settings.providerMode) || diagnostics.rateReset > now || (diagnostics.iconPauseUntil || 0) > now)
        return false;
    const cache = await readIconCache();
    // Prefer missing metadata, and do not refetch a known missing icon for seven days.
    const eligible = feeds.filter(f => !searchFeedDetails(f.subreddit) && (!f.iconFetchedAt || now - f.iconFetchedAt > 7 * 86400000)).sort((a, b) => (a.iconFetchedAt || 0) - (b.iconFetchedAt || 0));
    for (const feed of eligible) {
        const name = feed.subreddit.toLowerCase().split('+')[0];
        const cached = cache[name];
        if (cached) {
            await patchFeed(feed.id, { iconUrl: cached, iconFetchedAt: now });
            return true;
        }
    }
    const feed = eligible[0];
    if (!feed)
        return false;
    const name = feed.subreddit.toLowerCase().split('+')[0];
    if (!(await reserveRedditRequest(settings, 'Community icon: ' + name, 1, true))) return false;
    try {
        const token = settings.providerMode === 'oauth' ? (settings.oauthConfigured ? await getOAuthAccessToken() : settings.oauthToken) : '';
        const result = await fetchSubredditAboutIcon(name, settings, token);
        await recordRedditRate(result.rateLimit);
        await patchFeed(feed.id, { iconUrl: result.icon, iconFetchedAt: now });
        if (result.icon)
            await saveCommunityIcons({ [name]: result.icon });
        if (result.remaining !== null && result.remaining < 2 && result.resetMs > 0)
            await setDiagnostics({ rateReset: Date.now() + result.resetMs });
        return true;
    }
    catch (error) {
        const issue = error instanceof ProviderError ? error : new ProviderError(String(error));
        await recordRedditRate(issue.rateLimit);
        const pause = issue.status === 429 ? Math.max(300000, issue.retryMs) : issue.status === 401 || issue.status === 403 ? 43200000 : issue.status === 422 ? 3600000 : 900000;
        await setDiagnostics({ iconPauseUntil: Date.now() + pause, ...(issue.status === 429 ? { rateReset: Date.now() + pause } : {}) });
        return false;
    }
}
async function doTick(manual = false, onlyFeed = '', scopedFeedIds = null, progressContext = null) {
    // A manual refresh can span many bounded batches. Do not reset the public
    // progress bar between them; report cumulative counts from one operation.
    const progress = patch => {
        if (!progressContext) return updateRefreshProgress(patch);
        const adjusted = { ...patch, active: true,
            total: progressContext.total,
            completed: progressContext.completed + (Object.hasOwn(patch, 'completed') ? (Number(patch.completed) || 0) : Math.max(0, refreshProgress.completed - progressContext.completed)),
            checked: progressContext.checked + (Object.hasOwn(patch, 'checked') ? (Number(patch.checked) || 0) : Math.max(0, refreshProgress.checked - progressContext.checked)),
            added: progressContext.added + (Object.hasOwn(patch, 'added') ? (Number(patch.added) || 0) : Math.max(0, refreshProgress.added - progressContext.added)) };
        return updateRefreshProgress(adjusted);
    };
    const settings = await getSettings(), check = providerReady(settings), diagnostics = await getDiagnostics(), now = Date.now();
    if (!check.ready) {
        await setDiagnostics({ providerStatus: check.message });
        return { checked: 0, added: 0, reason: check.message };
    }
    if (diagnostics.rateReset > now)
        return { checked: 0, added: 0, reason: 'Waiting for rate-limit reset' };
    const allSubscriptions = await all('feeds');
    const allFolders = await all('folders');
    let feeds = allSubscriptions;
    if (Array.isArray(scopedFeedIds)) {
        const selectedIds = new Set(scopedFeedIds);
        feeds = feeds.filter(f => selectedIds.has(f.id));
    } else if (onlyFeed)
        feeds = feeds.filter(f => f.id === onlyFeed);
    const due = feeds.filter(f => manual || f.nextDue <= now).sort((a, b) => a.nextDue - b.nextDue || a.order - b.order);
    const batch = due.slice(0, onlyFeed ? 1 : manual && Array.isArray(scopedFeedIds) ? scopedFeedIds.length : manual ? MANUAL_BATCH_LIMIT : AUTO_BATCH_LIMIT);
    let checked = 0, completed = 0, added = 0, noticesSent = 0;
    const notifiedThisCycle = new Set();
    const activeFeedNames = new Set();
    const errors = [];
    const cycleStarted = Date.now();
    const gate = new SharedRequestBudget(diagnostics.requestsToday, Infinity,
        async (_used, label, weight) => reserveRedditRequest(settings, label, weight), 0);
    const writePosts = serialExecutor();
    if (batch.length)
        progress({ active: true, total: batch.length, completed: 0, checked: 0, added: 0, current: 'Preparing feeds', activeFeeds: [] });
    await runParallelQueue(batch, MAX_PARALLEL_FEEDS, async (feed) => {
        // Acquiring this shared slot is the only way a feed job can start an API call.
        if (!(await gate.reserve(feed.name)))
            return;
        checked++;
        activeFeedNames.add(feed.name);
        progress({ current: feed.name, activeFeeds: [...activeFeedNames] });
        try {
            let result;
            try {
                if (settings.providerMode === 'oauth') {
                    const accessToken = settings.oauthConfigured ? await getOAuthAccessToken() : settings.oauthToken;
                    try {
                        result = await fetchFeed(feed, { ...settings, oauthToken: accessToken }, diagnostics, allSubscriptions);
                    }
                    catch (error) {
                        if (!(error instanceof ProviderError) || error.status !== 401 || !settings.oauthConfigured)
                            throw error;
                        if (!(await gate.reserve('Retrying ' + feed.name)))
                            throw error;
                        // Another worker may have refreshed the expired token already.
                        const latest = await getOAuthAccessToken();
                        const renewed = latest === accessToken ? await getOAuthAccessToken(true) : latest;
                        result = await fetchFeed(feed, { ...settings, oauthToken: renewed }, diagnostics, allSubscriptions);
                    }
                }
                else
                    result = await fetchFeed(feed, settings, diagnostics, allSubscriptions);
            }
            catch (error) {
                const issue = error instanceof ProviderError ? error : new ProviderError(String(error));
                if (!canUsePageFallback(settings, issue))
                    throw issue;
                if (!(await gate.reserve('Checking first-party page: ' + feed.name, 2)))
                    throw issue;
                result = await fetchSessionPage(feed);
            }
            await recordRedditRate(result.rateLimit);
            let fresh = 0;
            if (!result.notModified) {
                // IndexedDB updates remain serialized; only network requests are parallel.
                const outcome = await writePosts(() => putPosts(feed, result.posts, settings.maxPostsPerFeed));
                fresh = outcome.newPosts;
                added += fresh;
                if (feed.lastFetched && settings.notificationRules?.length && noticesSent < 3) {
                    for (const post of outcome.newPostRecords) {
                        if (noticesSent >= 3)
                            break;
                        if (notifiedThisCycle.has(post.id)) continue;
                        const matchingRules = matchingNotificationRules(post, feed, settings.notificationRules, allFolders);
                        if (!matchingRules.length) continue;
                        // Optional permission may not have been granted on a new install.
                        // Do not count notifications which cannot be delivered.
                        if (!chrome.notifications?.create) break;
                        notifiedThisCycle.add(post.id);
                        noticesSent++; // One notification per article, even when several rules match.
                        try {
                            const labels = matchingRules.map(rule => rule.name).join(', ');
                            await chrome.notifications.create('rr-post:' + post.id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/128.png'), title: post.title.slice(0, 180), message: (labels + ' · r/' + post.subreddit).slice(0, 250), priority: 0 });
                        }
                        catch (err) {
                            console.warn('Desktop notification unavailable', err);
                            break;
                        }
                    }
                }
                if (result.icons && Object.keys(result.icons).length) {
                    await saveCommunityIcons(result.icons);
                    const ownIcon = result.icons[feed.subreddit.toLowerCase().split('+')[0]];
                    if (ownIcon)
                        await patchFeed(feed.id, { iconUrl: ownIcon, iconFetchedAt: Date.now() });
                }
            }
            const remainingLow = result.remaining !== null && result.remaining <= MAX_PARALLEL_FEEDS + 1;
            const next = Math.max(Date.now() + intervalFor(feed, allFolders, settings, fresh), remainingLow ? Date.now() + Math.max(result.resetMs, 60000) : 0);
            await patchFeed(feed.id, { lastFetched: Date.now(), nextDue: next, lastError: '', failureCount: 0, etag: result.etag, modified: result.modified });
            // A few requests may already be in flight; stop issuing new ones before
            // the server-reported shared quota is exhausted.
            if (remainingLow) {
                const resetAt = Date.now() + Math.max(result.resetMs, 60000);
                gate.stop('Provider rate budget nearly exhausted');
                await setDiagnostics({ rateReset: resetAt });
            }
        }
        catch (err) {
            const issue = err instanceof ProviderError ? err : new ProviderError(String(err));
            await recordRedditRate(issue.rateLimit);
            errors.push(`r/${feed.subreddit}: ${issue.message}`);
            const failed = feed.failureCount + 1;
            let retry = issue.retryMs || Math.min(86400000, Math.max(300000, Math.pow(2, failed) * 60000));
            if (issue.status === 401 || issue.status === 403)
                retry = 43200000;
            await patchFeed(feed.id, { lastError: issue.message, failureCount: failed, nextDue: Date.now() + retry });
            if (issue.status === 429) {
                gate.stop('Reddit rate limit reached');
                await setDiagnostics({ rateReset: Date.now() + retry });
            }
            if (issue.status === 401 || issue.status === 403)
                gate.stop('Reddit authorization unavailable');
        }
        finally {
            completed++;
            activeFeedNames.delete(feed.name);
            if (refreshProgress.active)
                progress({ completed, checked, added, current: feed.name, activeFeeds: [...activeFeedNames] });
        }
    }, () => gate.stopped);
    if (refreshProgress.active)
        progress({ active: false, current: '', activeFeeds: [] });
    // Metadata requests remain separate and are skipped while the feed gate is paused.
    const iconsUpdated = !gate.stopped && await refreshOneIconBatch(settings, Array.isArray(scopedFeedIds) ? feeds : await all('feeds'), await getDiagnostics());
    const reason = gate.reason || errors[0] || 'OK';
    await setDiagnostics({ ...(checked ? { lastRun: cycleStarted } : {}), providerStatus: errors.length ? errors[0] : gate.reason || (checked ? `Updated ${checked} feed(s)` : 'Up to date'), lastError: errors.join(' | ') });
    if (checked || iconsUpdated) {
        const last = (await chrome.storage.local.get('lastCleanup')).lastCleanup || 0;
        // Do not prune older restored posts before their media can be
        // rehydrated. Retention resumes on later ordinary refreshes.
        const restorePending = (await chrome.storage.local.get(RESTORE_RECOVERY_KEY))[RESTORE_RECOVERY_KEY];
        if (!restorePending && Date.now() - last > 86400000) {
            await cleanup(settings.keepDays, settings.maxPostsPerFeed);
            await chrome.storage.local.set({ lastCleanup: Date.now() });
        }
        await broadcast();
    }
    return { checked, completed, added, reason, planned: batch.length, deferred: gate.stopped && checked < batch.length };
}
/** Each distinct refresh scope is queued rather than lost to a running job. */
const tick = createRefreshCoordinator(async (manual, onlyFeed, scopedFeedIds, progressContext) => {
    running = crypto.randomUUID();
    try { return await doTick(manual, onlyFeed, scopedFeedIds, progressContext); }
    finally {
        if (!progressContext && refreshProgress.active)
            updateRefreshProgress({ active: false, current: '', activeFeeds: [] });
        running = null;
    }
});
/** One durable, user-visible manual refresh operation across all selected feeds.
 * Previous builds acknowledged several independent 48-feed jobs and completed
 * each with an active=false transition. That made every refresh entry point
 * appear inert or left its progress bar blinking between batches. */
const PENDING_REFRESH_KEY = 'rrManualRefreshQueueV1'; // migration only
const MANUAL_REFRESH_KEY = 'rrManualRefreshOperationV2';
const REFRESH_RECOVERY_ALARM = 'rr-refresh-recovery';
let manualOperationPromise = null;
let manualStartTail = Promise.resolve();
const MAX_MANUAL_FEEDS = 5000;
const safeIds = items => [...new Set((Array.isArray(items) ? items : [])
    .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(0, MAX_MANUAL_FEEDS);
async function storedManualOperation() {
    const state = await chrome.storage.local.get([MANUAL_REFRESH_KEY, PENDING_REFRESH_KEY]);
    const saved = state[MANUAL_REFRESH_KEY];
    if (saved && Array.isArray(saved.ids) && Number.isInteger(saved.cursor))
        return { ...saved, ids: safeIds(saved.ids), cursor: Math.max(0, Math.min(saved.cursor, saved.ids.length)) };
    // Upgrade in place: preserve scopes that were queued by v1.0.56.
    const legacy = state[PENDING_REFRESH_KEY];
    if (!Array.isArray(legacy) || !legacy.length) return null;
    const feeds = await all('feeds');
    const known = new Set(feeds.map(feed => feed.id));
    const gathered = [];
    for (const job of legacy) {
        if (!job || job.manual !== true) continue;
        if (job.feedId && known.has(job.feedId)) gathered.push(job.feedId);
        else if (Array.isArray(job.ids)) gathered.push(...job.ids);
        else if (job.ids === null) gathered.push(...feeds.map(feed => feed.id));
    }
    const ids = safeIds(gathered).filter(id => known.has(id));
    const task = ids.length ? { id: crypto.randomUUID(), ids, cursor: 0,
        checked: 0, added: 0, createdAt: Date.now(), updatedAt: Date.now() } : null;
    if (task) await chrome.storage.local.set({ [MANUAL_REFRESH_KEY]: task });
    await chrome.storage.local.remove(PENDING_REFRESH_KEY);
    return task;
}
function initialManualProgress(task) {
    return { active: true, total: task.ids.length, completed: task.cursor,
        checked: task.checked || 0, added: task.added || 0,
        current: task.cursor ? 'Resuming refresh…' : 'Preparing feeds…',
        activeFeeds: [], lastResult: null };
}
function reportManualStopped(reason, task, deferred = false) {
    const result = { checked: task.checked || 0, added: task.added || 0,
        completed: task.cursor, total: task.ids.length,
        reason: reason || 'OK', deferred, finishedAt: Date.now() };
    updateRefreshProgress({active: false, total: task.ids.length,
        completed: task.cursor, checked: task.checked || 0, added: task.added || 0,
        current: '', activeFeeds: [], lastResult: result});
}
/** Return true while an actual update is running, not merely while a request
 * acknowledgment is pending. All three UIs use the same status. */
async function currentRefreshProgress() {
    const task = await storedManualOperation();
    if (task && !manualOperationPromise) {
        const status = await getDiagnostics();
        if ((task.retryAt || 0) <= Date.now() && status.rateReset <= Date.now())
            void launchManualOperation().catch(console.error);
    }
    if (task && manualOperationPromise && !refreshProgress.active)
        return { ...initialManualProgress(task), lastResult: refreshProgress.lastResult };
    return { ...refreshProgress };
}
async function processManualOperation() {
    let task = await storedManualOperation();
    if (!task || task.cursor >= task.ids.length) {
        if (task) await chrome.storage.local.remove(MANUAL_REFRESH_KEY);
        return;
    }
    if ((task.retryAt || 0) > Date.now()) {
        await chrome.alarms.create(REFRESH_RECOVERY_ALARM, {
            delayInMinutes: Math.max(1, Math.ceil((task.retryAt - Date.now()) / 60000)) });
        return;
    }
    const settings = await getSettings();
    const ready = providerReady(settings);
    const diagnostics = await getDiagnostics();
    if (!ready.ready || diagnostics.rateReset > Date.now()) {
        const reason = !ready.ready ? ready.message :
            'Reddit rate limit active until ' + new Date(diagnostics.rateReset).toLocaleTimeString();
        task.retryAt = diagnostics.rateReset > Date.now() ? diagnostics.rateReset : Date.now() + 30 * 60000;
        await chrome.storage.local.set({[MANUAL_REFRESH_KEY]:task});
        reportManualStopped(reason, task, true);
        await chrome.alarms.create(REFRESH_RECOVERY_ALARM, { delayInMinutes: Math.max(1, Math.ceil((task.retryAt-Date.now())/60000)) });
        return;
    }
    updateRefreshProgress(initialManualProgress(task));
    let finalReason = 'OK';
    let pause = false;
    try {
        while (task.cursor < task.ids.length) {
            const ids = task.ids.slice(task.cursor, task.cursor + MANUAL_BATCH_LIMIT);
            // Exclude feeds deleted while the refresh was running.
            const valid = new Set((await all('feeds')).map(feed => feed.id));
            const present = ids.filter(id => valid.has(id));
            if (!present.length) {
                task.cursor += ids.length;
                await chrome.storage.local.set({ [MANUAL_REFRESH_KEY]: task });
                updateRefreshProgress({active:true,total:task.ids.length,completed:task.cursor,
                    checked:task.checked,added:task.added,current:'Skipping removed feeds',activeFeeds:[]});
                continue;
            }
            const context = { total: task.ids.length, completed: task.cursor,
                checked: task.checked, added: task.added };
            const result = await tick(true, '', present, context);
            const processed = Math.min(present.length, Math.max(0, Number(result.completed) || 0));
            task.checked += result.checked || 0;
            task.added += result.added || 0;
            // Batches are ordered. A stopped request may leave some IDs unstarted.
            task.cursor += processed;
            task.updatedAt = Date.now();
            await chrome.storage.local.set({ [MANUAL_REFRESH_KEY]: task });
            if (result.reason && result.reason !== 'OK') finalReason = result.reason;
            if (result.deferred || processed < present.length) { pause = true; break; }
        }
        if (task.cursor >= task.ids.length) {
            await chrome.storage.local.remove(MANUAL_REFRESH_KEY);
            reportManualStopped(finalReason, task);
        } else {
            const diag = await getDiagnostics();
            task.retryAt = diag.rateReset > Date.now() ? diag.rateReset :
                /authoriz|forbid|403|401|authentication/i.test(finalReason) ? Date.now() + 30 * 60000 : Date.now() + 5 * 60000;
            await chrome.storage.local.set({[MANUAL_REFRESH_KEY]:task});
            reportManualStopped(finalReason === 'OK' ? 'Refresh was paused; remaining feeds will be retried' : finalReason, task, true);
            await chrome.alarms.create(REFRESH_RECOVERY_ALARM, { delayInMinutes: Math.max(1, Math.ceil((task.retryAt-Date.now())/60000)) });
        }
    } catch (error) {
        const reason = String(error?.message || error);
        task.retryAt = Date.now() + 5 * 60000;
        await chrome.storage.local.set({ [MANUAL_REFRESH_KEY]: task });
        reportManualStopped(reason, task, true);
        await chrome.alarms.create(REFRESH_RECOVERY_ALARM, { delayInMinutes: 5 });
        console.error('Reddit Reader refresh failed', error);
    }
}
function launchManualOperation() {
    if (manualOperationPromise) return manualOperationPromise;
    const work = processManualOperation();
    manualOperationPromise = work.finally(() => {
        manualOperationPromise = null;
        // Don't wait for the one-minute alarm once the full restored-feed
        // refresh finishes. Resume the unread-image pass immediately.
        void resumePostRestoreRecovery().catch(console.error);
    });
    return manualOperationPromise;
}
async function durableManualRefresh(feedId = '', ids = null) {
    // Only reject a new click if an update is actually running. Keep all buttons
    // in sync through refreshProgressChanged and the state snapshot endpoint.
    const prior = await currentRefreshProgress();
    if (prior.active) return {alreadyRunning:true, reason:'An update is already running'};
    const settings = await getSettings();
    const ready = providerReady(settings);
    if (!ready.ready) throw new Error(ready.message);
    const diag = await getDiagnostics();
    if (diag.rateReset > Date.now())
        throw new Error('Reddit rate limit active until ' + new Date(diag.rateReset).toLocaleTimeString());
    // Lock concurrent button requests before either can enqueue a duplicate.
    const work = manualStartTail.then(async () => {
        if (refreshProgress.active || manualOperationPromise) return {alreadyRunning:true,reason:'An update is already running'};
        let task = await storedManualOperation();
        if (!task) {
            const feeds = await all('feeds');
            const known = new Set(feeds.map(feed => feed.id));
            const requested = feedId ? [feedId] : Array.isArray(ids) ? ids : feeds.map(feed => feed.id);
            const chosen = safeIds(requested).filter(id => known.has(id));
            if (!chosen.length) return {queued:false, reason:'No matching feeds'};
            task = {id:crypto.randomUUID(), ids:chosen, cursor:0, checked:0, added:0,
                createdAt:Date.now(),updatedAt:Date.now()};
            await chrome.storage.local.set({[MANUAL_REFRESH_KEY]:task});
        }
        // A user click deliberately retries a paused operation. If it selects
        // a different scope, replace the paused scope rather than unexpectedly
        // refreshing unrelated feeds; a future automatic cycle still covers
        // any feeds that remain due.
        const feeds = await all('feeds');
        const known = new Set(feeds.map(feed => feed.id));
        const requested = safeIds(feedId ? [feedId] : Array.isArray(ids) ? ids : feeds.map(feed => feed.id))
            .filter(id => known.has(id));
        if (!requested.length) return {queued:false, reason:'No matching feeds'};
        const remaining = task.ids.slice(task.cursor).filter(id => known.has(id));
        if (requested.length !== remaining.length || requested.some((id, index) => id !== remaining[index])) {
            task = {id:crypto.randomUUID(), ids:requested, cursor:0, checked:0, added:0,
                createdAt:Date.now(),updatedAt:Date.now()};
        }
        task.retryAt = 0;
        await chrome.storage.local.set({[MANUAL_REFRESH_KEY]:task});
        updateRefreshProgress(initialManualProgress(task));
        // The alarm can revive an interrupted MV3 worker. The asynchronous
        // operation also starts immediately, rather than waiting a minute.
        await chrome.alarms.create(REFRESH_RECOVERY_ALARM,{delayInMinutes:1});
        void launchManualOperation().catch(console.error);
        return {queued:true,started:true,total:task.ids.length,operationId:task.id};
    });
    manualStartTail = work.catch(() => {});
    return work;
}
function replayManualRefreshes() {
    return launchManualOperation();
}
let lastSyncAttempt = 0;
async function maybeSyncOnOpen() {
    if (Date.now() - lastSyncAttempt < 120000)
        return;
    lastSyncAttempt = Date.now();
    const status = await driveStatus();
    if (status.enabled && Date.now() - status.lastSync > 300000)
        await syncNow().then(broadcast).catch(() => { });
}
async function queueSyncMutation(changes) { await recordChanges(changes); }
async function getDetailedDiagnostics(force = false) {
    const [storage, diagnostics, iconCache] = await Promise.all([
        getStorageMetrics(force), getDiagnostics(), readIconCache()
    ]);
    const nowMinute = Math.floor(Date.now() / 60000);
    const buckets = Array.isArray(diagnostics.requestMinuteBuckets) ? diagnostics.requestMinuteBuckets : [];
    const lastMinute = buckets.reduce((sum, item) => sum + (Array.isArray(item) && item[0] === nowMinute ? (Number(item[1]) || 0) : 0), 0);
    const lastHour = buckets.reduce((sum, item) => sum + (Array.isArray(item) && item[0] >= nowMinute - 59 && item[0] <= nowMinute ? (Number(item[1]) || 0) : 0), 0);
    const recoveryState = await chrome.storage.local.get([RESTORE_RECOVERY_KEY, RESTORE_RECOVERY_LAST_KEY]);
    return { ...storage, restoreRecovery: recoveryState[RESTORE_RECOVERY_KEY] || recoveryState[RESTORE_RECOVERY_LAST_KEY] || null, iconCacheEntries: Object.keys(iconCache).length,
        requestsLastMinute: lastMinute, requestsLastHour: lastHour,
        requestsToday: diagnostics.requestsToday || 0,
        rateLimit: diagnostics.redditRateLimit || null,
        blockedUntil: diagnostics.rateReset || 0,
        refresh: await currentRefreshProgress() };
}
async function getState() { await ensureSidebarOrder(); maybeSyncOnOpen().catch(console.error); const [state, communityIcons] = await Promise.all([snapshot(), readIconCache()]); return { ...state, communityIcons, refreshProgress: await currentRefreshProgress(), restoreRecovery: await getRestoreRecoveryProgress(), settings: publicSettings(state.settings) }; }
/** Small, durable, read-only recovery telemetry for popup/reader/Settings.
 * Do not scan the database or expose tokens on every UI poll. */
async function getRestoreRecoveryProgress() {
    const records = await chrome.storage.local.get([RESTORE_RECOVERY_KEY, RESTORE_RECOVERY_LAST_KEY]);
    const task = records[RESTORE_RECOVERY_KEY];
    const recent = records[RESTORE_RECOVERY_LAST_KEY];
    const source = task || (recent?.finishedAt > Date.now() - 16000 ? recent : null);
    if (!source) return { active:false };
    return {
        active: !!task, stage: String(source.stage || 'feeds'),
        checked: Math.max(0, Number(source.checked)||0),
        repaired: Math.max(0, Number(source.repaired)||0),
        scanned: Math.max(0, Number(source.scanned)||0),
        total: Number.isFinite(source.totalCandidates) ? source.totalCandidates : null,
        feedCount: Array.isArray(source.feedIds) ? source.feedIds.length : 0,
        retryAt: Math.max(0, Number(source.retryAt)||0),
        error: String(source.lastError || '').slice(0,250),
        finishedAt: Number(source.finishedAt)||0,
        startedAt: Number(source.createdAt)||0
    };
}
async function createFullBackup() {
    const [snap, stored] = await Promise.all([
        snapshot(), chrome.storage.local.get(['restoredFlags', 'substreamUserOAuth', ...PORTABLE_LOCAL_KEYS])
    ]);
    return buildPlainBackup(snap, stored, chrome.runtime.getManifest().version);
}
async function inspectFullBackup(input) { const parsed = await readBackup(input); return parsed.summary; }
/** Resume a post-restore job after a worker restart. Both the scope and the
 * post cursor are durable; a new worker never needs to start from scratch. */
let postRestorePromise = null;
async function schedulePostRestore(delayMinutes = 1) {
    await chrome.alarms.create(RESTORE_RECOVERY_ALARM, { delayInMinutes: Math.max(1, delayMinutes) });
}
async function savePostRestoreTask(task) {
    const current = (await chrome.storage.local.get(RESTORE_RECOVERY_KEY))[RESTORE_RECOVERY_KEY];
    if (current?.id !== task.id) return false; // a newer restore superseded this one
    task.updatedAt = Date.now();
    await chrome.storage.local.set({ [RESTORE_RECOVERY_KEY]: task });
    return true;
}
async function finishPostRestore(task) {
    const current = (await chrome.storage.local.get(RESTORE_RECOVERY_KEY))[RESTORE_RECOVERY_KEY];
    if (current?.id !== task.id) return;
    await chrome.storage.local.set({ [RESTORE_RECOVERY_LAST_KEY]: {
        ...task, stage: 'complete', finishedAt: Date.now() } });
    await chrome.storage.local.remove(RESTORE_RECOVERY_KEY);
    await chrome.alarms.clear(RESTORE_RECOVERY_ALARM);
    await broadcast();
}
async function queuePostRestoreRecovery() {
    // The backup import is finished before this is scheduled. Setting the
    // validators to empty guarantees an actual fresh response for each feed,
    // rather than a conditional HTTP 304 from the old installation.
    const feeds = await all('feeds');
    await invalidateRestoredFeedValidators();
    const task = newRestoreRecovery(feeds.map(feed => feed.id));
    await chrome.storage.local.set({ [RESTORE_RECOVERY_KEY]: task });
    await broadcast();
    await schedulePostRestore();
    void resumePostRestoreRecovery().catch(console.error);
    return { queued: true, feeds: feeds.length, stage: 'feeds' };
}
async function processPostRestoreRecovery() {
    const task = (await chrome.storage.local.get(RESTORE_RECOVERY_KEY))[RESTORE_RECOVERY_KEY];
    if (!task || !Array.isArray(task.feedIds)) return;
    // Upgrade an unfinished v1.0.69 restore: the old cursor could have
    // advanced past unread posts while trying to repair already-read items.
    if ((task.version || 1) < 2) {
        task.version = 2;
        task.lastPostId = '';
        task.scanned = 0;
        task.checked = 0;
        task.totalCandidates = null;
        task.retryAt = 0;
        await savePostRestoreTask(task);
    }
    if ((task.retryAt || 0) > Date.now()) {
        await schedulePostRestore(Math.ceil((task.retryAt - Date.now()) / 60000));
        return;
    }
    if (task.stage === 'feeds') {
        if (!task.feedIds.length) {
            task.stage = 'media';
            await savePostRestoreTask(task);
        } else if (!task.refreshId) {
            // Do not discard or replace a refresh the user started manually.
            if ((await currentRefreshProgress()).active) {
                await schedulePostRestore();
                return;
            }
            try {
                const started = await durableManualRefresh('', task.feedIds);
                if (started.alreadyRunning) { await schedulePostRestore(); return; }
                if (started.queued) {
                    task.refreshId = started.operationId;
                    task.lastError = '';
                    await savePostRestoreTask(task);
                    await schedulePostRestore();
                    return;
                }
                task.stage = 'media';
                await savePostRestoreTask(task);
            } catch (err) {
                task.lastError = String(err.message || err);
                if (!providerReady(await getSettings()).ready) {
                    // Missing or expired Reddit authorization must not block
                    // recovery of direct-image links, which need no API call.
                    // Remember that the full feed update still needs a retry.
                    task.stage = 'media';
                    task.feedRefreshPending = true;
                    task.retryAt = 0;
                    await savePostRestoreTask(task);
                } else {
                    task.retryAt = Date.now() + 5 * 60000;
                    await savePostRestoreTask(task);
                    await schedulePostRestore(5);
                    return;
                }
            }
        } else {
            // A paused operation still exists on disk. Wait until ALL restored
            // feeds complete, even when the service worker was restarted.
            const ongoing = await storedManualOperation();
            if (ongoing?.id === task.refreshId || manualOperationPromise || refreshProgress.active) {
                await schedulePostRestore();
                return;
            }
            task.stage = 'media';
            task.retryAt = 0;
            await savePostRestoreTask(task);
        }
    }
    if (task.stage !== 'media') return;
    if ((await currentRefreshProgress()).active) { await schedulePostRestore(); return; }
    if (task.feedRefreshPending && providerReady(await getSettings()).ready) {
        // The user has restored Reddit access after an earlier failed full
        // refresh. Retry that update before continuing the unread-image pass.
        try {
            const next = await durableManualRefresh('', task.feedIds);
            if (next.queued) {
                task.stage = 'feeds';
                task.feedRefreshPending = false;
                task.refreshId = next.operationId;
                task.lastPostId = '';
                task.scanned = 0;
                task.checked = 0;
                task.totalCandidates = null;
                task.retryAt = 0;
                await savePostRestoreTask(task);
                await schedulePostRestore();
                return;
            }
        } catch { /* Retry later; still allow direct media repair below. */ }
    }
    if (!Number.isFinite(task.totalCandidates)) {
        task.totalCandidates = await countUnreadRestoreMediaCandidates();
        await savePostRestoreTask(task);
    }
    const settings = await getSettings();
    const ready = providerReady(settings);
    const diagnostics = await getDiagnostics();
    // Direct image URLs need no Reddit access and must be recovered even if
    // the imported OAuth credentials are expired. Remote galleries pause at
    // the exact post until authorization/rate limits are available.
    const batch = await missingRestoreMediaBatch(task.lastPostId, RESTORE_MEDIA_BATCH);
    const previouslyRepaired = task.repaired;
    let checkpoint = task.lastPostId;
    let paused = false;
    for (const candidate of batch.candidates) {
        const post = await getRecord('posts', candidate.id);
        if (!post || post.read || (Array.isArray(post.images) && post.images.length) || post.video) {
            checkpoint = candidate.id;
            continue;
        }
        const direct = directRestoredImage(post);
        try {
            if (direct) {
                await mergePostDetails(post.id, { images: [direct], text: '', video: '' });
                task.repaired++;
            } else {
                if (!ready.ready || diagnostics.rateReset > Date.now()) {
                    task.lastError = !ready.ready ? ready.message : 'Reddit rate-limit pause';
                    task.retryAt = diagnostics.rateReset > Date.now()
                        ? diagnostics.rateReset : Date.now() + 5 * 60000;
                    paused = true;
                    break;
                }
                if (!(await reserveRedditRequest(settings, 'Restore image: ' + post.id))) {
                    task.retryAt = Date.now() + 5 * 60000;
                    paused = true;
                    break;
                }
                const token = settings.providerMode === 'oauth'
                    ? (settings.oauthConfigured ? await getOAuthAccessToken() : settings.oauthToken) : '';
                const result = await fetchRedditPostDetails(post, settings, token);
                await recordRedditRate(result.rateLimit);
                if (Array.isArray(result.images) && result.images.length) {
                    await mergePostDetails(post.id, result);
                    task.repaired++;
                }
                if (Number.isFinite(result.rateLimit?.remaining) && result.rateLimit.remaining <= 1) {
                    task.retryAt = Date.now() + Math.max(60000,
                        (result.rateLimit.resetAt || 0) - Date.now());
                    paused = true;
                }
            }
            task.checked++;
            task.lastError = '';
            checkpoint = candidate.id;
            if (paused) break;
        } catch (err) {
            await recordRedditRate(err instanceof ProviderError ? err.rateLimit : null);
            const issue = err instanceof ProviderError ? err : new ProviderError(String(err));
            if ([401, 403, 429].includes(issue.status) || issue.status >= 500 || !issue.status) {
                task.lastError = issue.message;
                task.retryAt = Date.now() + Math.max(issue.retryMs || 0,
                    issue.status === 401 || issue.status === 403 ? 30 * 60000 : 5 * 60000);
                if (issue.status === 429) await setDiagnostics({ rateReset: task.retryAt });
                paused = true;
                break; // retry this exact post later
            }
            // A deleted/inaccessible post cannot be repaired; skip it rather
            // than holding up media recovery for the rest of the library.
            task.checked++;
            checkpoint = candidate.id;
        }
    }
    if (!paused && batch.candidates.length === 0) checkpoint = batch.checkpoint;
    if (!paused && batch.candidates.length > 0) checkpoint = batch.checkpoint;
    task.lastPostId = checkpoint;
    task.scanned += batch.visited; // visited entries, not necessarily media candidates
    await savePostRestoreTask(task);
    if (!paused && batch.done && checkpoint === batch.checkpoint) {
        await finishPostRestore(task);
    } else {
        await schedulePostRestore(task.retryAt > Date.now()
            ? Math.ceil((task.retryAt - Date.now()) / 60000) : 1);
        if (task.repaired > previouslyRepaired) void broadcast().catch(() => {});
    }
}
/** One-time remediation for backups already restored under v1.0.69.
 * If its previous image job finished unsuccessfully, launch a new unread-only
 * pass without re-importing the user's private backup. */
const RESTORE_UNREAD_MIGRATION_KEY = 'rrUnreadMediaRecoveryMigrationV170';
async function migratePreviousImageRecovery() {
    const values = await chrome.storage.local.get([
        RESTORE_RECOVERY_KEY, RESTORE_RECOVERY_LAST_KEY, RESTORE_UNREAD_MIGRATION_KEY
    ]);
    if (values[RESTORE_RECOVERY_KEY] || values[RESTORE_UNREAD_MIGRATION_KEY]) return;
    const last = values[RESTORE_RECOVERY_LAST_KEY];
    if (!last || (last.version || 1) >= 2 || last.stage !== 'complete') return;
    const task = newRestoreRecovery((await all('feeds')).map(feed => feed.id));
    task.stage = 'media'; // feed updates were performed by the preceding restore
    await chrome.storage.local.set({
        [RESTORE_RECOVERY_KEY]: task, [RESTORE_UNREAD_MIGRATION_KEY]: true
    });
    await schedulePostRestore();
    void resumePostRestoreRecovery().catch(console.error);
}
function resumePostRestoreRecovery() {
    if (postRestorePromise) return postRestorePromise;
    const work = processPostRestoreRecovery();
    postRestorePromise = work.finally(() => { postRestorePromise = null; });
    return postRestorePromise;
}

async function restoreFullBackup(input, mode) {
    const parsed = await readBackup(input);
    if (parsed.legacy) {
        const result = await restoreBackup(parsed.legacy);
        const snap = await snapshot();
        const flags = (await chrome.storage.local.get('restoredFlags')).restoredFlags || {};
        await queueSyncMutation({ feeds: snap.feeds, folders: snap.folders, read: { ids: [...new Set([...snap.posts.filter(p => p.read).map(p => p.id), ...(flags.read || [])])], value: true },
            stars: { ids: [...new Set([...snap.posts.filter(p => p.starred).map(p => p.id), ...(flags.starred || [])])], value: true } });
        const recovery = await queuePostRestoreRecovery();
        await broadcast();
        return { ...result, recovery, legacy: true, message: 'Legacy v1 backup merged. It did not contain the complete library.' };
    }
    if (!parsed.data)
        throw new Error('Backup has no restorable data');
    const result = await restoreCompleteBackup(parsed.data, mode);
    const recovery = await queuePostRestoreRecovery();
    await broadcast();
    return { ...result, recovery, legacy: false, message: 'Full library restored. Google account and saved tokens are preserved when present; synchronization is paused until reviewed.' };
}
async function onRequest(msg) {
    switch (msg.type) {
        case 'testNotificationRule': {
            const state = await snapshot();
            const rule = (state.settings.notificationRules || []).find(r => r.id === msg.ruleId);
            if (!rule) throw new Error('Notification rule not found');
            const subscriptionsByPost = new Map();
            for (const sub of state.subscriptions) {
                if (!subscriptionsByPost.has(sub.postId)) subscriptionsByPost.set(sub.postId, new Set());
                subscriptionsByPost.get(sub.postId).add(sub.feedId);
            }
            const feeds = new Map(state.feeds.map(feed => [feed.id, feed]));
            const matches = [];
            // Include read posts for a test without modifying their read state.
            // Count each post only once even when it belongs to multiple feeds.
            for (const post of state.posts) {
                const feedIds = subscriptionsByPost.get(post.id) || new Set();
                if ([...feedIds].some(id => {
                    const feed = feeds.get(id);
                    return feed && matchingNotificationRules(post, feed, [{...rule, enabled:true}], state.folders).length > 0;
                })) matches.push(post);
            }
            let sent = 0, failed = 0;
            // The notification API is absent until the optional permission is
            // granted. Report missing permission rather than trying 50 calls.
            if (!chrome.notifications?.create)
                return { matches:matches.length, sent:0, failed:Math.min(50, matches.length),
                    capped:matches.length > 50, permissionRequired:true };
            // Protect the browser against an unlimited burst of desktop alerts.
            // The full match count is still returned to the rule editor.
            for (const post of matches.slice(0, 50)) {
                try {
                    await chrome.notifications.create('rr-test:' + post.id, {
                        type:'basic', iconUrl: chrome.runtime.getURL('icons/128.png'),
                        title: ('[TEST] ' + post.title).slice(0, 180),
                        message: (rule.name + ' · r/' + post.subreddit).slice(0, 250), priority:0
                    });
                    sent++;
                } catch (err) { failed++; console.warn('Rule test notification unavailable', err); }
            }
            return {matches:matches.length, sent, failed, capped:matches.length > 50};
        }
        case 'getState': return getState();
        case 'getDetailedDiagnostics': return getDetailedDiagnostics(msg.force === true);
        case 'getPopupState': { await ensureSidebarOrder(); const [state, communityIcons] = await Promise.all([popupSnapshot(), readIconCache()]); return { ...state, communityIcons, refreshProgress: await currentRefreshProgress(), restoreRecovery: await getRestoreRecoveryProgress(), settings: publicSettings(state.settings) }; }
        case 'import': {
            const items = msg.items;
            if (!Array.isArray(items) || items.length > 5000)
                throw new Error('Invalid feed import');
            const beforeFeeds = new Set((await all('feeds')).map(f => f.id));
            const beforeFolders = new Set((await all('folders')).map(f => f.id));
            const result = await importFeeds(items);
            await queueSyncMutation({ feeds: (await all('feeds')).filter(f => !beforeFeeds.has(f.id)), folders: (await all('folders')).filter(f => !beforeFolders.has(f.id)) });
            await broadcast();
            return result;
        }
        case 'refresh': return durableManualRefresh(String(msg.feedId || ''));
        case 'refreshView': {
            if (!Array.isArray(msg.feedIds) || msg.feedIds.length > 5000 || msg.feedIds.some(id => typeof id !== 'string' || id.length > 200))
                throw new Error('Invalid view feed selection');
            return durableManualRefresh('', [...new Set(msg.feedIds)]);
        }
        case 'getRefreshProgress': return currentRefreshProgress();
        case 'getRestoreRecoveryProgress': return getRestoreRecoveryProgress();
        case 'exportFullBackup': return createFullBackup();
        case 'inspectFullBackup': return inspectFullBackup(msg.backup);
        case 'restoreFullBackup': return restoreFullBackup(msg.backup, msg.mode === 'merge' ? 'merge' : 'replace');
        case 'restoreBackup': {
            const outcome = await restoreBackup(msg.backup);
            const snap = await snapshot();
            const restore = (await chrome.storage.local.get('restoredFlags')).restoredFlags || {};
            await queueSyncMutation({ feeds: snap.feeds, folders: snap.folders, read: { ids: [...new Set([...snap.posts.filter(p => p.read).map(p => p.id), ...(restore.read || [])])], value: true },
                stars: { ids: [...new Set([...snap.posts.filter(p => p.starred).map(p => p.id), ...(restore.starred || [])])], value: true } });
            const recovery = await queuePostRestoreRecovery();
            await broadcast();
            return { ...outcome, recovery };
        }
        case 'mark':
            await markPosts([String(msg.id)], !!msg.read);
            await queueSyncMutation({ read: { ids: [String(msg.id)], value: !!msg.read } });
            await broadcast();
            return true;
        case 'markMany': {
            if (!Array.isArray(msg.ids) || msg.ids.length > 25000)
                throw new Error('Invalid bulk selection');
            const ids = msg.ids.filter((s) => typeof s === 'string');
            await markPosts(ids, !!msg.read);
            await queueSyncMutation({ read: { ids, value: !!msg.read } });
            await broadcast();
            return true;
        }
        case 'markScope': {
            const changed = await markScope(String(msg.scope), String(msg.id || ''), !!msg.read);
            if (changed.length)
                await queueSyncMutation({ read: { ids: changed, value: !!msg.read } });
            await broadcast();
            return true;
        }
        case 'star':
            await starPost(String(msg.id), !!msg.starred);
            await queueSyncMutation({ star: { id: String(msg.id), value: !!msg.starred } });
            await broadcast();
            return true;
        case 'moveSidebar': {
            if (typeof msg.source !== 'string' || typeof msg.destination !== 'string' || !['before', 'after', 'inside', 'root'].includes(msg.placement))
                throw new Error('Invalid sidebar move');
            const changed = await moveSidebarItem(msg.source, msg.destination, msg.placement);
            if (changed.feeds.length || changed.folders.length) {
                await queueSyncMutation(changed);
                await broadcast();
            }
            return { feeds: changed.feeds.length, folders: changed.folders.length };
        }
        case 'addFolder': {
            const result = await addFolder(String(msg.name || ''), msg.parentId || null);
            await queueSyncMutation({ folders: [result] });
            await broadcast();
            return result;
        }
        case 'editFolder': {
            const patch = msg.patch || {};
            for (const key of ['sidebarBg', 'sidebarText'])
                if (key in patch && patch[key] !== '' && !/^#[a-f\d]{6}$/i.test(String(patch[key])))
                    throw new Error('Invalid folder colour');
            if ('refreshMinutes' in patch && !validRefreshOverride(patch.refreshMinutes))
                throw new Error('Invalid folder refresh interval');
            const previousFolders = await all('folders');
            const existingFeeds = await all('feeds');
            await updateFolder(String(msg.id), patch);
            const updatedFolders = await all('folders');
            const touched = [];
            if ('refreshMinutes' in patch || 'parentId' in patch) {
                const settings = await getSettings();
                for (const feed of existingFeeds) {
                    if (feed.refreshMinutes !== null && feed.refreshMinutes !== undefined)
                        continue;
                    if (effectiveFeedRefreshMinutes(feed, previousFolders, settings.refreshMinutes) === effectiveFeedRefreshMinutes(feed, updatedFolders, settings.refreshMinutes))
                        continue;
                    if (feed.failureCount > 0)
                        continue; // Keep provider-imposed retry backoff.
                    const nextDue = feed.lastFetched ? Math.max(Date.now(), feed.lastFetched + intervalFor(feed, updatedFolders, settings, 0)) : Date.now();
                    await patchFeed(feed.id, { nextDue });
                    touched.push({ ...feed, nextDue });
                }
            }
            await queueSyncMutation({ folders: updatedFolders.filter(f => f.id === msg.id), ...(touched.length ? { feeds: touched } : {}) });
            await broadcast();
            return true;
        }
        case 'removeFolder':
            await removeFolder(String(msg.id));
            await queueSyncMutation({ deletedFolder: String(msg.id), folders: await all('folders'), feeds: await all('feeds') });
            await broadcast();
            return true;
        case 'removeFeed': {
            const found = (await all('feeds')).find(f => f.id === msg.id);
            await removeFeed(String(msg.id));
            if (found)
                await queueSyncMutation({ deletedFeed: found.subreddit });
            await broadcast();
            return true;
        }
        case 'patchFeed': {
            const patch = msg.patch || {};
            if ('refreshMinutes' in patch && !validRefreshOverride(patch.refreshMinutes))
                throw new Error('Invalid feed refresh interval');
            if ('viewMode' in patch && !['list', 'small-list', 'magazine', 'cards', 'three-pane'].includes(patch.viewMode))
                throw new Error('Invalid feed view');
            for (const key of ['sidebarBg', 'sidebarText'])
                if (key in patch && patch[key] !== '' && !/^#[a-f\d]{6}$/i.test(String(patch[key])))
                    throw new Error('Invalid feed colour');
            if ('refreshMinutes' in patch) {
                const feed = (await all('feeds')).find(f => f.id === msg.id);
                if (feed && !feed.failureCount) {
                    const next = { ...feed, refreshMinutes: patch.refreshMinutes };
                    const settings = await getSettings();
                    patch.nextDue = feed.lastFetched ? Math.max(Date.now(), feed.lastFetched + intervalFor(next, await all('folders'), settings, 0)) : Date.now();
                }
            }
            await patchFeed(String(msg.id), patch);
            await queueSyncMutation({ feeds: (await all('feeds')).filter(f => f.id === msg.id) });
            await broadcast();
            return true;
        }
        case 'saveSettings': {
            const patch = msg.patch || {};
            const allowed = new Set(UI_SETTINGS_KEYS);
            const filtered = {};
            for (const [k, v] of Object.entries(patch))
                if (allowed.has(k))
                    filtered[k] = v;
            if (filtered.endpointTemplate) {
                const url = new URL(String(filtered.endpointTemplate).replaceAll('{{subreddit}}', 'example'));
                if (url.protocol !== 'https:' || !String(filtered.endpointTemplate).includes('{{subreddit}}'))
                    throw new Error('Provider requires HTTPS URL containing {{subreddit}}');
            }
            for (const key of ['popupCollapsed', 'sidebarCollapsed'])
                if (key in filtered) {
                    if (!Array.isArray(filtered[key]) || filtered[key].length > 500 || filtered[key].some((id) => typeof id !== 'string' || id.length > 180))
                        throw new Error('Invalid collapsed section list');
                    filtered[key] = [...new Set(filtered[key])];
                }
            if ('highlighters' in filtered)
                filtered.highlighters = sanitizeHighlighters(filtered.highlighters);
            if ('notificationRules' in filtered)
                filtered.notificationRules = sanitizeNotificationRules(filtered.notificationRules);
            for (const key of ['sidebarItemBg', 'sidebarItemText'])
                if (key in filtered && !/^#[a-f\d]{6}$/i.test(String(filtered[key])))
                    throw new Error('Invalid sidebar colour');
            for (const key of ['hoverZoomEnabled', 'hoverZoomImages', 'hoverZoomVideos'])
                if (key in filtered && typeof filtered[key] !== 'boolean')
                    throw new Error('Invalid hover zoom setting');
            if ('hoverZoomDelay' in filtered && (!Number.isInteger(filtered.hoverZoomDelay) || filtered.hoverZoomDelay < 100 || filtered.hoverZoomDelay > 3000))
                throw new Error('Hover delay must be 100–3000 ms');
            if ('hoverZoomDismissDistance' in filtered && (!Number.isInteger(filtered.hoverZoomDismissDistance) || filtered.hoverZoomDismissDistance < 50 || filtered.hoverZoomDismissDistance > 1000))
                throw new Error('HoverZoom dismissal distance must be 50–1000 px');
            for (const key of ['fullPopupWidthPct', 'fullPopupHeightPct'])
                if (key in filtered && (!Number.isInteger(filtered[key]) || filtered[key] < 20 || filtered[key] > 100))
                    throw new Error('Full-content popup size must be 20–100%');
            if ('sidebarFontSize' in filtered && (!Number.isInteger(filtered.sidebarFontSize) || filtered.sidebarFontSize < 10 || filtered.sidebarFontSize > 20))
                throw new Error('Sidebar item font size must be 10–20 px');
            if ('sidebarCompactness' in filtered && (!Number.isInteger(filtered.sidebarCompactness) || filtered.sidebarCompactness < 0 || filtered.sidebarCompactness > 100))
                throw new Error('Sidebar compactness must be 0–100');
            if ('keepUnreadOnTop' in filtered && typeof filtered.keepUnreadOnTop !== 'boolean')
                throw new Error('Invalid unread-first preference');
            if ('autoNextUnreadCategory' in filtered && typeof filtered.autoNextUnreadCategory !== 'boolean')
                throw new Error('Invalid automatic unread category preference');
            for (const key of ['openReaderOnIconClick', 'readerRailCollapsed'])
                if (key in filtered && typeof filtered[key] !== 'boolean')
                    throw new Error('Invalid reader preference');
            if ('font' in filtered && !FONT_VALUES.has(filtered.font))
                throw new Error('Invalid interface font');
            if ('readingFont' in filtered && !FONT_VALUES.has(filtered.readingFont))
                throw new Error('Invalid reading font');
            if ('readingFontSize' in filtered && (!Number.isFinite(filtered.readingFontSize) || filtered.readingFontSize < 10 || filtered.readingFontSize > 36))
                throw new Error('Invalid article font size');
            if ('readingLineHeight' in filtered && (!Number.isFinite(filtered.readingLineHeight) || filtered.readingLineHeight < 1 || filtered.readingLineHeight > 2.5))
                throw new Error('Invalid article line spacing');
            const changedProvider = ['providerMode', 'allowPageFallback', 'oauthToken', 'endpointTemplate', 'providerToken'].some(k => k in filtered);
            const next = await saveSettings(filtered);
            if ('openReaderOnIconClick' in filtered)
                await updateToolbarAction(next);
            if ('language' in filtered)
                await ensureToolbarMenu().catch(console.error);
            await queueSyncMutation({ settings: filtered });
            if (changedProvider) {
                const feeds = await all('feeds');
                for (const feed of feeds)
                    await patchFeed(feed.id, { nextDue: Date.now(), lastError: '', etag: '', modified: '' });
                await setDiagnostics({ rateReset: 0, iconPauseUntil: 0, providerStatus: providerReady(next).message });
            }
            await broadcast();
            return publicSettings(next);
        }
        case 'providerStatus': {
            const settings = await getSettings();
            return providerReady(settings);
        }
        case 'oauthStatus': return getOAuthStatus();
        case 'oauthBegin': return beginManualOAuth(String(msg.clientId || ''), String(msg.redirectUri || ''));
        case 'oauthExchange': {
            const status = await exchangeManualOAuth(String(msg.clientId || ''), String(msg.redirectUri || ''), String(msg.authorizationCode || ''));
            const updated = await saveSettings({ oauthConfigured: true, oauthToken: '', providerMode: 'oauth' });
            const feeds = await all('feeds');
            for (const feed of feeds)
                await patchFeed(feed.id, { nextDue: Date.now(), lastError: '', etag: '', modified: '' });
            await setDiagnostics({ rateReset: 0, iconPauseUntil: 0, providerStatus: status.username ? 'Connected as u/' + status.username : 'OAuth authorization connected' });
            const pendingRestore = (await chrome.storage.local.get(RESTORE_RECOVERY_KEY))[RESTORE_RECOVERY_KEY];
            if (pendingRestore) { pendingRestore.retryAt = 0; await savePostRestoreTask(pendingRestore); void resumePostRestoreRecovery().catch(console.error); }
            await broadcast();
            return status;
        }
        case 'oauthDisconnect': {
            await disconnectOAuth();
            await saveSettings({ oauthConfigured: false, oauthToken: '' });
            await setDiagnostics({ providerStatus: 'OAuth credentials disconnected' });
            await broadcast();
            return true;
        }
        case 'getPostDetails': {
            const id = String(msg.id || '');
            const post = await getRecord('posts', id);
            if (!post)
                throw new Error('Post no longer exists');
            const settings = await getSettings();
            if (!['session', 'oauth'].includes(settings.providerMode))
                return { text: post.text, images: post.images, video: post.video, comments: [], note: 'Additional text requires a Reddit session or approved OAuth provider' };
            // Only called on explicit user opening; no automatic scraping or request loops.
            if (!(await reserveRedditRequest(settings, 'Post details')))
                return { text: post.text, images: post.images, video: post.video, comments: [], note: 'Reddit rate limit active; please retry later' };
            try {
                const token = settings.providerMode === 'oauth' ? (settings.oauthConfigured ? await getOAuthAccessToken() : settings.oauthToken) : '';
                const result = await fetchRedditPostDetails(post, settings, token);
                await recordRedditRate(result.rateLimit);
                await mergePostDetails(post.id, result);
                return { ...result, note: result.text ? '' : 'This Reddit link post does not expose self-text' };
            }
            catch (error) {
                await recordRedditRate(error instanceof ProviderError ? error.rateLimit : null);
                if (error instanceof ProviderError && error.status === 429)
                    await setDiagnostics({ rateReset: Date.now() + Math.max(300000, error.retryMs) });
                return { text: post.text, images: post.images, video: post.video, comments: [], note: String(error.message || error) };
            }
        }
        case 'sessionStatus': return checkRedditSession();
        case 'driveStatus': return driveStatus();
        case 'driveResumeRestored': return resumeRestoredDrive();
        case 'driveConnect': {
            const status = await connectDrive(String(msg.clientId || ''), typeof msg.clientSecret === 'string' ? msg.clientSecret : undefined);
            await broadcast();
            return status;
        }
        case 'driveSaveClient': return saveDriveClientId(String(msg.clientId || ''));
        case 'driveDisconnect': return disconnectDrive();
        case 'driveSync': {
            const result = await syncNow();
            await broadcast();
            return result;
        }
        case 'reset': {
            if (msg.confirm !== 'RESET')
                throw new Error('Confirmation required');
            const feeds = await all('feeds'), folders = await all('folders');
            await clearAll();
            await chrome.storage.local.remove([RESTORE_RECOVERY_KEY, RESTORE_RECOVERY_LAST_KEY]);
            await chrome.alarms.clear(RESTORE_RECOVERY_ALARM);
            for (const f of feeds)
                await queueSyncMutation({ deletedFeed: f.subreddit });
            for (const f of folders)
                await queueSyncMutation({ deletedFolder: f.id });
            await broadcast();
            return true;
        }
        case 'openSettings': {
            await openSettingsTab(msg.focus === 'highlighters' ? 'highlighters' : '');
            return true;
        }
        case 'openReader': {
            const base = chrome.runtime.getURL('reader.html');
            const existing = await chrome.tabs.query({ url: base + '*' });
            const tab = existing.find((x) => x.url?.startsWith(base));
            if (tab) {
                await chrome.tabs.update(tab.id, { active: true });
                await chrome.windows.update(tab.windowId, { focused: true });
            }
            else
                await chrome.tabs.create({ url: base });
            return true;
        }
        default: throw new Error('Unknown request');
    }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message?.type || message.type === 'stateChanged' || message.type === 'refreshProgressChanged')
        return false;
    // Reddit tabs, content scripts, and external pages cannot invoke privileged
    // state-changing actions or request the user's local reading history.
    // Embedded Settings is an options.html document with a query string.
    const source = (sender.url || '').split(/[?#]/, 1)[0];
    const permitted = new Set(['reader.html', 'popup.html', 'options.html'].map(name => chrome.runtime.getURL(name)));
    if (sender.id !== chrome.runtime.id || !permitted.has(source)) {
        sendResponse({ ok: false, error: 'This action is restricted to Reddit Reader pages' });
        return false;
    }
    const isTrustedOptions = source === chrome.runtime.getURL('options.html');
    if (['oauthBegin', 'oauthExchange', 'oauthDisconnect', 'oauthStatus', 'driveConnect', 'driveDisconnect', 'driveSync', 'driveStatus', 'driveResumeRestored', 'driveSaveClient', 'inspectFullBackup', 'restoreFullBackup', 'restoreBackup'].includes(message.type) && !isTrustedOptions) {
        sendResponse({ ok: false, error: 'OAuth operations are restricted to the extension settings page' });
        return false;
    }
    if (['getPostDetails', 'testNotificationRule'].includes(message.type) && sender.url !== chrome.runtime.getURL('reader.html')) {
        sendResponse({ ok: false, error: 'Post details are available only inside the reader' });
        return false;
    }
    onRequest(message).then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
});
/** Open settings in a normal browser tab. Reader settings are embedded in the
 * reader itself, so this action is used by the toolbar popup and other entrypoints. */
async function openSettingsTab(focus = '') {
    const url = chrome.runtime.getURL('options.html');
    const requestedUrl = focus === 'highlighters' ? `${url}#highlighters` : url;
    const matches = await chrome.tabs.query({ url: url + '*' });
    const existing = matches.find(tab => tab.id != null && tab.windowId != null);
    if (existing) {
        await chrome.tabs.update(existing.id, { active: true, url: requestedUrl });
        await chrome.windows.update(existing.windowId, { focused: true });
    } else {
        await chrome.tabs.create({ url: requestedUrl, active: true });
    }
}
/** Chromium only sends action.onClicked when no default popup is registered.
 * A stored setting controls the popup at runtime; keep the manifest default as
 * popup.html to avoid changing existing users' behaviour during an update. */
async function updateToolbarAction(settings = null) {
    const pref = settings || await getSettings();
    await chrome.action.setPopup({ popup: pref.openReaderOnIconClick ? '' : 'popup.html' });
}
chrome.action.onClicked.addListener(() => {
    onRequest({ type: 'openReader' }).catch(console.error);
});
// Other paths (Drive synchronization, backup restores) may write settings
// directly to storage instead of using the saveSettings message handler.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const previous = Boolean(changes.settings.oldValue?.openReaderOnIconClick);
    const current = Boolean(changes.settings.newValue?.openReaderOnIconClick);
    if (previous !== current) {
        updateToolbarAction(changes.settings.newValue).catch(console.error);
    }
});
// The action's default popup opens on a toolbar click; its own logo opens the full reader.
chrome.commands.onCommand.addListener((name) => {
    if (name === 'open-full-reader')
        onRequest({ type: 'openReader' }).catch(console.error);
});
// Notifications is an OPTIONAL permission. On a clean install Chromium omits
// chrome.notifications entirely until the user grants that permission. An
// unconditional .onClicked access would throw during module evaluation, fail
// service-worker registration (status 15), and leave the reader without a
// functioning background service. Install this listener only when available.
function onDesktopNotificationClicked(id) {
    if (typeof id !== 'string' || (!id.startsWith('rr-post:') && !id.startsWith('rr-test:')))
        return;
    const postId = id.slice(id.indexOf(':') + 1);
    getRecord('posts', postId).then(post => {
        if (post) return chrome.tabs.create({ url: postToReddit(post), active: true });
    }).catch(console.error);
}
let notificationClickListenerRegistered = false;
function registerOptionalNotificationListener() {
    const onClicked = chrome.notifications?.onClicked;
    if (notificationClickListenerRegistered || !onClicked?.addListener) return;
    onClicked.addListener(onDesktopNotificationClicked);
    notificationClickListenerRegistered = true;
}
registerOptionalNotificationListener();
// If the permission is granted while the worker remains alive, register the
// handler without requiring the user to reload the extension.
chrome.permissions?.onAdded?.addListener(({ permissions = [] }) => {
    if (permissions.includes('notifications')) registerOptionalNotificationListener();
});
chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === 'reddit-reader-open')
        onRequest({ type: 'openReader' }).catch(console.error);
    if (info.menuItemId === 'reddit-reader-preview')
        chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 442, height: 620 }).catch(console.error);
});
async function ensureToolbarMenu() {
    try {
        await chrome.contextMenus.remove('reddit-reader-open');
    }
    catch { /* not installed yet */ }
    try {
        await chrome.contextMenus.remove('reddit-reader-preview');
    }
    catch { /* not installed yet */ }
    const preferences = await getSettings();
    await chrome.contextMenus.create({ id: 'reddit-reader-open', title: preferences.language === 'pt-PT' ? 'Abrir leitor completo' : 'Open Full Reader', contexts: ['action'] });
    await chrome.contextMenus.create({ id: 'reddit-reader-preview', title: preferences.language === 'pt-PT' ? 'Pré-visualização de não lidos' : 'Unread preview', contexts: ['action'] });
}
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) {
        if (!refreshProgress.active) {
            storedManualOperation().then(task => task ? replayManualRefreshes() : tick()).catch(console.error);
        }
    }
    if (alarm.name === REFRESH_RECOVERY_ALARM) replayManualRefreshes().catch(console.error);
    if (alarm.name === RESTORE_RECOVERY_ALARM) resumePostRestoreRecovery().catch(console.error);
    if (alarm.name === SYNC_ALARM || alarm.name === DIRTY_ALARM)
        driveStatus().then(status => status.enabled ? syncNow().then(broadcast) : null).catch(console.error);
});
async function ensureAlarm() { const alarm = await chrome.alarms.get(ALARM); if (!alarm)
    await chrome.alarms.create(ALARM, { periodInMinutes: 1 }); const syncAlarm = await chrome.alarms.get(SYNC_ALARM); if (!syncAlarm)
    await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 }); }
/** Identify this extension to YouTube's embedded player requests (error 153)
 * without modifying any non-extension navigation. The Referer is the
 * extension's own registered OAuth origin; never impersonate other sites. */
export async function ensureYouTubeEmbedIdentity() {
    if (!chrome.declarativeNetRequest?.updateDynamicRules)
        return;
    const referrer = new URL(chrome.identity.getRedirectURL()).origin + '/';
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [153], addRules: [{
                id: 153, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referrer }] },
                condition: { urlFilter: '||www.youtube-nocookie.com/embed/', initiatorDomains: [chrome.runtime.id], resourceTypes: ['sub_frame'] }
            }] });
}
chrome.runtime.onStartup.addListener(() => { replayManualRefreshes().catch(console.error); resumePostRestoreRecovery().catch(console.error); migratePreviousImageRecovery().catch(console.error); });
chrome.runtime.onInstalled.addListener((detail) => {
    if (detail.reason === 'update') migratePreviousImageRecovery().catch(console.error);
    ensureAlarm();
    badge();
    ensureToolbarMenu().catch(console.error);
    ensureYouTubeEmbedIdentity().catch(console.error);
    updateToolbarAction().catch(console.error);
    if (detail.reason === 'install') {
        // chrome.permissions.request requires a direct user gesture. Open a
        // first-run explanation with an Enable button rather than calling it
        // from onInstalled, which Chromium will reject.
        (async () => {
            await chrome.storage.local.set({ rrNotificationOnboardingPending: true });
            await openSettingsTab();
        })().catch(console.error);
    }
    // Legacy browser-session providers remain stored only for backup compatibility.
    // The settings UI now exposes and uses the user's own authorized OAuth app.
});
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); badge(); updateToolbarAction().catch(console.error); ensureYouTubeEmbedIdentity().catch(console.error); maybeSyncOnOpen().catch(console.error); });
ensureAlarm();
badge();
updateToolbarAction().catch(console.error);
ensureYouTubeEmbedIdentity().catch(console.error);

// Resume durable user refresh scopes on any worker cold start.
void replayManualRefreshes().catch(console.error);
void resumePostRestoreRecovery().catch(console.error);
