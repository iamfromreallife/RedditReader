/** Google Drive appDataFolder synchronization. No post bodies, media or Reddit credentials are uploaded.
 * Chrome Identity manages Google access tokens; nothing secret is stored in extension sync metadata.
 */
import { sanitizeSettings } from './backup.js';
import { SHARD_PREFIX, shardName, ownWriterEntries, mergeShards } from './drive-shards.js';
import { DEFAULTS, normalizedFeedPath, searchFeedDetails, validRefreshOverride } from './shared.js';
import { all, getSettings, saveSettings, setRecord, removeFeed, removeFolder, applySyncedPostFlags } from './db.js';
import { GOOGLE_SESSION_TOKEN, validGoogleClientId, googleOAuthUrl, parseGoogleOAuthResponse, googleCodeUrl, exchangeGoogleCode, renewGoogleToken, createPkceChallenge } from './google-auth.js';
const FILENAME = 'reddit-reader-sync-v1.json';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const SYNC_ALARM = 'reddit-reader-cloud-sync';
export const DIRTY_ALARM = 'reddit-reader-cloud-dirty';
const LOCAL_KEY = 'rrDriveJournal';
// Same-profile operations are serialized; remote-device races still require
// provider-side version preconditions for full conflict safety.
let journalTail = Promise.resolve();
let driveStatusTail = Promise.resolve();
function withJournalLock(action) {
    const run = journalTail.then(action);
    journalTail = run.catch(() => { });
    return run;
}

export const SYNC_PREFS = ['language', 'theme', 'density', 'accent', 'font', 'fontSize', 'lineHeight', 'layout', 'sidebarWidth', 'readerWidth', 'fullPopupWidthPct', 'fullPopupHeightPct', 'showThumbs', 'showSnippets', 'hideRead', 'markReadOnOpen', 'popupLimit', 'popupGrouping', 'popupCollapsed', 'sidebarCollapsed', 'badgeMode', 'badgeColor', 'sidebarItemBg', 'sidebarItemText', 'highlighters', 'hoverZoomEnabled', 'hoverZoomImages', 'hoverZoomVideos', 'hoverZoomDelay', 'hoverZoomDismissDistance', 'sidebarCompactness', 'sidebarFontSize', 'keepUnreadOnTop', 'autoNextUnreadCategory', 'openReaderOnIconClick', 'readerRailCollapsed', 'readingFont', 'readingFontSize', 'readingLineHeight', 'notificationRules'];
let active = null;
let signingIn = null;
const settingsKey = 'rrDriveSettings';
const clientKey = 'rrGoogleWebClientId';
const secretKey = 'rrGoogleWebClientSecret';
const refreshKey = 'rrGoogleDriveRefreshToken';
// Persistent tokens survive MV3 worker restarts and unpacked extension upgrades.
const accessKey = 'rrGoogleDrivePersistentAccessToken';
const restoredAccountKey = 'rrDriveRestoredAccountV1';
export const BUNDLED_GOOGLE_CLIENT_ID = ''; // Public ID may be supplied for a private build; never package login tokens.
async function readClientSecret() { return String((await chrome.storage.local.get(secretKey))[secretKey] || ''); }
async function readClientId() { return String((await chrome.storage.local.get(clientKey))[clientKey] || BUNDLED_GOOGLE_CLIENT_ID).trim(); }
export async function driveConfigured() { return validGoogleClientId(await readClientId()); }
/** Validate the minimal Drive About user fields; never persist OAuth tokens in this profile. */
export function parseDriveAccount(input, clientId, now = Date.now()) {
    const user = input?.user;
    const name = typeof user?.displayName === 'string' ? user.displayName.trim().slice(0, 140) : '';
    const email = typeof user?.emailAddress === 'string' ? user.emailAddress.trim().slice(0, 254) : '';
    const id = typeof user?.permissionId === 'string' ? user.permissionId.slice(0, 140) : '';
    if (!name || !email || !email.includes('@'))
        throw new Error('Google Drive did not return the account name and email. Please reconnect your Google account.');
    let photo = '';
    if (typeof user?.photoLink === 'string') {
        try {
            const u = new URL(user.photoLink);
            if (u.protocol === 'https:' && (u.hostname === 'googleusercontent.com' || u.hostname.endsWith('.googleusercontent.com')))
                photo = u.href;
        }
        catch { /* Reject unsafe photo URLs */ }
    }
    return { name, email, photo, id, verifiedAt: now, clientId };
}
export async function driveStatus() {
    const saved = (await chrome.storage.local.get(settingsKey))[settingsKey] || {};
    const clientId = await readClientId(), configured = validGoogleClientId(clientId);
    const credentials = await chrome.storage.local.get([accessKey, refreshKey, restoredAccountKey]);
    const access = credentials[accessKey], refresh = credentials[refreshKey];
    const hasAccess = Boolean(access?.clientId === clientId && typeof access?.token === 'string' && access.expiresAt > Date.now() + 90000);
    const hasRefresh = Boolean(refresh?.clientId === clientId && typeof refresh?.token === 'string');
    const restorePaused = Boolean(saved.restorePaused);
    const preserved = credentials[restoredAccountKey];
    const accountRecord = saved.account?.clientId === clientId ? saved.account :
        preserved?.clientId === clientId ? preserved : null;
    const account = configured && typeof accountRecord?.email === 'string' && typeof accountRecord?.name === 'string' ? accountRecord : null;
    const enabled = Boolean(saved.enabled && configured && !restorePaused);
    let message;
    if (!configured) message = 'One-time setup: create a Google OAuth Web application Client ID, then paste it below.';
    else if (restorePaused) message = 'Google account restored from backup. Sync is paused until you review and resume it. Restored credentials have not yet been verified.';
    else if (enabled) message = hasRefresh ? 'Automatic Google Drive sync enabled (refresh grant stored)' : 'Google Drive connected; a new sign-in may be needed when the access token expires';
    else message = account ? 'Saved Google account; synchronization is not active. Verify or reconnect to continue.' : 'Ready to sign in with your Google account';
    return { account, refreshConfigured: hasRefresh, accessTokenAvailable: hasAccess,
        restoredPendingReview: restorePaused, savedConnection: Boolean(saved.enabled),
        enabled, configured, clientId, lastSync: saved.lastSync || 0,
        lastError: saved.lastError || '', lastAttempt: saved.lastAttempt || 0,
        message, redirect: chrome.identity.getRedirectURL('google'), extensionId: chrome.runtime.id };
}
/** Never start a sync with restored credentials until the user has explicitly
 * approved the snapshot and Google has reverified the account identity.
 */
export async function resumeRestoredDrive() {
    const status = await driveStatus();
    if (!status.restoredPendingReview)
        return status;
    if (!status.configured || !status.account)
        throw new Error('Restored Google configuration is incomplete. Sign in with Google again.');
    if (!(status.accessTokenAvailable || status.refreshConfigured))
        throw new Error('No valid reusable Google grant was restored. Sign in with Google again.');
    const token = await getToken(false);
    const actual = await fetchDriveAccount(token, status.clientId);
    // Accounts must match before an existing cloud journal is allowed to sync.
    if (actual.email.toLocaleLowerCase() !== status.account.email.toLocaleLowerCase())
        throw new Error('Restored Google account differs from the active login. Please reconnect the intended account.');
    await statusPatch({ restorePaused: false, enabled: true, account: actual, lastError: '' });
    await chrome.storage.local.set({ [restoredAccountKey]: actual });
    return driveStatus();
}

export async function saveDriveClientId(clientId) {
    clientId = clientId.trim();
    if (!validGoogleClientId(clientId))
        throw new Error('Invalid Google Web application Client ID. See Help for setup.');
    const previous = await readClientId();
    if (previous !== clientId) {
        await chrome.storage.local.set({ [clientKey]: clientId });
        await chrome.storage.session.remove(GOOGLE_SESSION_TOKEN);
        await chrome.storage.local.remove([accessKey, refreshKey, secretKey, restoredAccountKey]);
        await statusPatch({ enabled: false, restorePaused: false, lastError: '', lastSync: 0, account: null });
    }
    return driveStatus();
}
export async function saveDriveClientSecret(secret) {
    secret = secret.trim();
    if (secret.length > 400)
        throw new Error('Google OAuth client secret is too long');
    const prior = await readClientSecret();
    if (prior !== secret) {
        await chrome.storage.local.set({ [secretKey]: secret });
        await chrome.storage.local.remove(refreshKey);
    }
}
async function statusPatch(patch) {
    // Serialize status writes: concurrent sync completion and account refresh
    // must not overwrite a restored account with an earlier stale snapshot.
    const next = driveStatusTail.then(async () => {
        const current = (await chrome.storage.local.get(settingsKey))[settingsKey] || {};
        await chrome.storage.local.set({ [settingsKey]: { ...current, ...patch } });
    });
    driveStatusTail = next.catch(() => {});
    return next;
}
async function journal() {
    const val = (await chrome.storage.local.get(LOCAL_KEY))[LOCAL_KEY];
    if (val && typeof val.writer === 'string' && val.entries)
        return val;
    const initialized = { writer: crypto.randomUUID(), counter: Date.now(), entries: {}, initialized: false };
    await chrome.storage.local.set({ [LOCAL_KEY]: initialized });
    return initialized;
}
function latest(a, b) {
    if (!a)
        return b;
    if (!b)
        return a;
    return a.at !== b.at ? (a.at > b.at ? a : b) : (a.writer >= b.writer ? a : b);
}
export function mergeEntries(a, b) {
    const merged = { ...a };
    for (const [key, record] of Object.entries(b)) {
        if (!record || typeof record.at !== 'number' || typeof record.writer !== 'string' || key.length > 250)
            continue;
        merged[key] = latest(merged[key], record);
    }
    return merged;
}
function stamp(j) { j.counter = Math.max(Date.now(), j.counter + 1); return j.counter; }
function stripFeed(f) { return { id: f.id, name: f.name, subreddit: f.subreddit, folderId: f.folderId, order: f.order, viewMode: f.viewMode ?? null, refreshMinutes: f.refreshMinutes, createdAt: f.createdAt, searchQuery: f.searchQuery, searchSort: f.searchSort, searchScope: f.searchScope }; }
function stripFolder(f) { return { id: f.id, name: f.name, parentId: f.parentId, order: f.order, refreshMinutes: f.refreshMinutes ?? null }; }
function add(j, key, value, deleted = false) { j.entries[key] = { at: stamp(j), writer: j.writer, ...(deleted ? { deleted: true } : { value }) }; }
/** Existing installations are seeded once. Default settings and unread flags do not override the cloud. */
async function prepareJournal() {
    const j = await journal();
    if (j.initialized)
        return j;
    const [feeds, folders, posts, settings] = await Promise.all([all('feeds'), all('folders'), all('posts'), getSettings()]);
    for (const f of folders)
        add(j, 'folder:' + f.id, stripFolder(f));
    for (const f of feeds)
        add(j, 'feed:' + f.subreddit, stripFeed(f));
    for (const p of posts) {
        if (p.read)
            add(j, 'read:' + p.id, true);
        if (p.starred)
            add(j, 'star:' + p.id, true);
    }
    const restore = (await chrome.storage.local.get('restoredFlags')).restoredFlags || {};
    for (const id of restore.read || [])
        if (typeof id === 'string' && !j.entries['read:' + id])
            add(j, 'read:' + id, true);
    for (const id of restore.starred || [])
        if (typeof id === 'string' && !j.entries['star:' + id])
            add(j, 'star:' + id, true);
    for (const key of SYNC_PREFS)
        if (settings[key] !== DEFAULTS[key])
            add(j, 'pref:' + key, settings[key]);
    j.initialized = true;
    await chrome.storage.local.set({ [LOCAL_KEY]: j });
    return j;
}
/** Every local user mutation is journaled; tombstones stop deleted items from reappearing. */
export async function recordChanges(changes) {
    return withJournalLock(() => recordChangesLocked(changes));
}
async function recordChangesLocked(changes) {
    const j = await prepareJournal();
    for (const f of changes.feeds || [])
        add(j, 'feed:' + f.subreddit, stripFeed(f));
    for (const f of changes.folders || [])
        add(j, 'folder:' + f.id, stripFolder(f));
    if (changes.deletedFeed)
        add(j, 'feed:' + changes.deletedFeed, null, true);
    if (changes.deletedFolder)
        add(j, 'folder:' + changes.deletedFolder, null, true);
    for (const id of changes.read?.ids || [])
        if (typeof id === 'string' && id.length < 160)
            add(j, 'read:' + id, !!changes.read?.value);
    if (changes.star && changes.star.id.length < 160)
        add(j, 'star:' + changes.star.id, !!changes.star.value);
    for (const id of changes.stars?.ids || [])
        if (typeof id === 'string' && id.length < 160)
            add(j, 'star:' + id, !!changes.stars?.value);
    for (const key of SYNC_PREFS)
        if (changes.settings && Object.hasOwn(changes.settings, key))
            add(j, 'pref:' + key, changes.settings[key]);
    await chrome.storage.local.set({ [LOCAL_KEY]: j });
    const status = await driveStatus();
    if (status.enabled)
        await chrome.alarms.create(DIRTY_ALARM, { delayInMinutes: 1 });
}
function safeDoc(raw) {
    if (!raw || raw.format !== 'reddit-reader-drive-v1' || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries))
        throw new Error('Unknown Drive sync file format; no changes applied');
    const serialized = JSON.stringify(raw);
    if (serialized.length > 7_000_000)
        throw new Error('Drive sync data exceeds safe size limit');
    return raw.entries;
}
/** Background sync uses persistent locally stored access tokens and, when the
 * user has configured their OWN Web client secret, a renewable offline grant.
 * The legacy implicit flow remains supported without refresh credentials.
 */
async function getToken(interactive = false) {
    const clientId = await readClientId();
    if (!validGoogleClientId(clientId))
        throw new Error('Google OAuth Web application Client ID is not configured. Follow the Help guide in Settings.');
    const cached = (await chrome.storage.local.get([accessKey, refreshKey]));
    const local = cached[accessKey];
    if (!interactive && local?.clientId === clientId && typeof local.token === 'string' && local.expiresAt > Date.now() + 90000)
        return local.token;
    // Migrate any old live session token into persistent storage on first access.
    const ephemeral = (await chrome.storage.session.get(GOOGLE_SESSION_TOKEN))[GOOGLE_SESSION_TOKEN];
    if (!interactive && ephemeral?.clientId === clientId && ephemeral.expiresAt > Date.now() + 90000) {
        await chrome.storage.local.set({ [accessKey]: ephemeral });
        return ephemeral.token;
    }
    if (signingIn)
        return signingIn;
    signingIn = (async () => {
        const secret = await readClientSecret();
        const storedRefresh = cached[refreshKey];
        if (!interactive && secret && storedRefresh?.clientId === clientId && storedRefresh?.token) {
            try {
                const renewed = await renewGoogleToken(clientId, secret, storedRefresh.token);
                const record = { token: renewed.token, expiresAt: renewed.expiresAt, clientId };
                await chrome.storage.local.set({ [accessKey]: record });
                return renewed.token;
            }
            catch (error) {
                // Leave the refresh grant intact for diagnostics; never log its value.
                // Preserve the saved grant for backup diagnostics, but expire the
                // unusable access token so a rejected token isn't reused.
                if (local?.clientId === clientId)
                    await chrome.storage.local.set({ [accessKey]: { ...local, expiresAt: 0 } });
                throw new Error('Google token refresh failed. Verify the Google OAuth client secret or reconnect: ' + String(error.message || error));
            }
        }
        const state = crypto.randomUUID(), redirect = chrome.identity.getRedirectURL('google');
        let url;
        let verifier = '';
        if (secret) {
            const pkce = await createPkceChallenge();
            verifier = pkce.verifier;
            url = googleCodeUrl(clientId, redirect, state, pkce.challenge);
        }
        else
            url = googleOAuthUrl(clientId, redirect, state, interactive);
        let callback;
        try {
            callback = await chrome.identity.launchWebAuthFlow({ url, interactive });
        }
        catch (error) {
            throw new Error(interactive ? 'Google sign-in cancelled or blocked: ' + String(error.message || error) : 'Google session expired. Open Settings and click Sign in with Google again. For reliable background sync, set your Web OAuth client secret.');
        }
        if (!callback)
            throw new Error('Google did not complete the authorization flow.');
        let record;
        if (secret) {
            const actual = new URL(callback), expected = new URL(redirect);
            if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.searchParams.get('state') !== state)
                throw new Error('Google OAuth callback or state mismatch');
            if (actual.searchParams.get('error'))
                throw new Error('Google authorization error: ' + actual.searchParams.get('error'));
            const code = actual.searchParams.get('code');
            if (!code)
                throw new Error('Google authorization did not return a code');
            const result = await exchangeGoogleCode(clientId, secret, code, verifier, redirect);
            record = { token: result.token, expiresAt: result.expiresAt, clientId };
            if (result.refreshToken)
                await chrome.storage.local.set({ [refreshKey]: { token: result.refreshToken, clientId } });
        }
        else {
            const result = parseGoogleOAuthResponse(callback, redirect, state);
            record = { ...result, clientId };
        }
        await chrome.storage.local.set({ [accessKey]: record });
        await chrome.storage.session.set({ [GOOGLE_SESSION_TOKEN]: record });
        return record.token;
    })().finally(() => { signingIn = null; });
    return signingIn;
}
/** Drive about.get supports the existing drive.appdata scope; no new Google consent is needed. */
async function fetchDriveAccount(token, clientId) {
    const response = await driveFetch('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink,permissionId)', token, { cache: 'no-store' });
    if (!response.ok)
        throw new Error('Unable to verify the signed-in Google account (HTTP ' + response.status + ').');
    return parseDriveAccount(await response.json(), clientId);
}
async function driveFetch(url, token, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + token);
    const response = await fetch(url, { ...init, headers, redirect: 'error' });
    if (response.status === 401) {
        await chrome.storage.session.remove(GOOGLE_SESSION_TOKEN);
        // HTTP 401 is NOT a user-requested disconnection. Keep the saved
        // account and refresh grant. Mark the access grant expired to prevent
        // futile reuse, without erasing it from a future backup.
        const storedAccess = (await chrome.storage.local.get(accessKey))[accessKey];
        if (storedAccess?.token === token)
            await chrome.storage.local.set({ [accessKey]: { ...storedAccess, expiresAt: 0 } });
        throw new Error('Google token rejected. It will be refreshed on the next sync if a refresh grant is configured.');
    }
    if (response.status === 403)
        throw new Error('Google Drive denied access. Check the Drive API, app audience and drive.appdata scope in Help.');
    if (response.status === 429 || response.status >= 500)
        throw new Error('Drive temporarily unavailable or rate limited (HTTP ' + response.status + '). Retry later.');
    return response;
}
async function findFile(token) {
    const p = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,mimeType,modifiedTime)', pageSize: '100', q: `name = '${FILENAME}' and trashed = false` });
    const res = await driveFetch(`${API}?${p}`, token);
    if (!res.ok)
        throw new Error('Google Drive list failed: HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data.files) ? data.files : [];
    return list.find((item) => item.name === FILENAME) || null;
}
/** List independently written shards rather than trusting a mutable shared
 * snapshot. Every client uses a unique journal writer UUID and updates only its
 * own shard. Old v1.0.54 clients can still consume the shared compatibility file. */
async function findShardFiles(token) {
    const files = [];
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,mimeType,modifiedTime)', pageSize: '100', q: `name contains '${SHARD_PREFIX}' and trashed = false` });
        if (pageToken) params.set('pageToken', pageToken);
        const response = await driveFetch(`${API}?${params}`, token);
        if (!response.ok) throw new Error('Google Drive shard list failed (HTTP ' + response.status + ')');
        const result = await response.json();
        for (const item of result.files || []) {
            if (typeof item?.id === 'string' && /^reddit-reader-sync-v2-[a-f0-9-]{36}\.json$/i.test(item.name || '')) files.push(item);
        }
        pageToken = result.nextPageToken || '';
        if (!pageToken) return files;
    }
    throw new Error('Too many Google Drive sync shards; refusing an incomplete merge');
}
async function readRemote(token, file) {
    if (!file)
        return {};
    const response = await driveFetch(`${API}/${encodeURIComponent(file.id)}?alt=media`, token);
    if (!response.ok)
        throw new Error('Drive sync file could not be read (HTTP ' + response.status + ')');
    const raw = await response.text();
    if (raw.length > 7_000_000)
        throw new Error('Cloud sync data too large');
    return safeDoc(JSON.parse(raw));
}
async function upload(token, file, entries, filename = FILENAME) {
    const json = JSON.stringify({ format: 'reddit-reader-drive-v1', schemaVersion: 1, updatedAt: Date.now(), entries });
    if (json.length > 7_000_000)
        throw new Error('Cloud sync is over 7MB; too many saved read flags');
    let response;
    if (file) {
        response = await driveFetch(`${UPLOAD}/${encodeURIComponent(file.id)}?uploadType=media`, token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json });
    }
    else {
        const boundary = 'rrdrive' + crypto.randomUUID().replace(/-/g, '');
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: filename, mimeType: 'application/json', parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--\r\n`;
        response = await driveFetch(`${UPLOAD}?uploadType=multipart&fields=id`, token, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    }
    if (!response.ok)
        throw new Error('Google Drive upload failed: HTTP ' + response.status + ' ' + (await response.text()).slice(0, 250));
}
/** Apply the winning cloud records without writing new journal operations, to avoid echo loops. */
async function applyEntries(entries) {
    const folderEntries = Object.entries(entries).filter(([k]) => k.startsWith('folder:'));
    const feedEntries = Object.entries(entries).filter(([k]) => k.startsWith('feed:'));
    const folders = await all('folders');
    const folderMap = new Map(folders.map(f => [f.id, f]));
    for (const [key, entry] of folderEntries) {
        const id = key.slice(7);
        if (!id || id.length > 140)
            continue;
        if (entry.deleted) {
            if (folderMap.has(id)) {
                await removeFolder(id);
                folderMap.delete(id);
            }
            continue;
        }
        const f = entry.value;
        if (!f || f.id !== id || typeof f.name !== 'string' || f.name.length > 75)
            continue;
        const candidate = { id, name: f.name, parentId: typeof f.parentId === 'string' ? f.parentId : null, order: Number.isFinite(f.order) ? f.order : 0, refreshMinutes: f.refreshMinutes === null || validRefreshOverride(f.refreshMinutes) ? f.refreshMinutes ?? null : null };
        await setRecord('folders', candidate);
        folderMap.set(id, candidate);
    }
    const feeds = await all('feeds');
    const bySub = new Map(feeds.map(f => [f.subreddit, f]));
    for (const [key, entry] of feedEntries) {
        const sub = key.slice(5);
        if (normalizedFeedPath(sub) !== sub)
            continue;
        const existing = bySub.get(sub);
        if (entry.deleted) {
            if (existing) {
                await removeFeed(existing.id);
                bySub.delete(sub);
            }
            continue;
        }
        const val = entry.value;
        if (!val || val.subreddit !== sub || typeof val.id !== 'string')
            continue;
        const id = existing?.id || val.id;
        const candidate = { id, name: String(val.name || 'r/' + sub).slice(0, 200), subreddit: sub, folderId: typeof val.folderId === 'string' && folderMap.has(val.folderId) ? val.folderId : null, order: Number.isFinite(val.order) ? val.order : 0,
            viewMode: ['list', 'small-list', 'magazine', 'cards', 'three-pane'].includes(val.viewMode) ? val.viewMode : existing?.viewMode,
            refreshMinutes: val.refreshMinutes === null || [0, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].includes(val.refreshMinutes) ? val.refreshMinutes : null,
            createdAt: Number.isFinite(val.createdAt) ? val.createdAt : Date.now(), lastFetched: existing?.lastFetched || 0, nextDue: existing?.nextDue || Date.now(), lastError: existing?.lastError || '', failureCount: existing?.failureCount || 0,
            etag: existing?.etag || '', modified: existing?.modified || '', searchQuery: typeof val.searchQuery === 'string' ? val.searchQuery.slice(0, 180) : existing?.searchQuery, searchSort: val.searchSort || existing?.searchSort, searchScope: searchFeedDetails(sub)?.scope, iconUrl: existing?.iconUrl || '', iconFetchedAt: existing?.iconFetchedAt || 0 };
        await setRecord('feeds', candidate);
        bySub.set(sub, candidate);
    }
    const restore = { read: [], starred: [] };
    for (const [key, entry] of Object.entries(entries)) {
        if (entry.deleted)
            continue;
        if (key.startsWith('read:') && entry.value === true)
            restore.read.push(key.slice(5));
        else if (key.startsWith('star:') && entry.value === true)
            restore.starred.push(key.slice(5));
    }
    await chrome.storage.local.set({ restoredFlags: restore });
    await applySyncedPostFlags(entries);
    const preferences = {};
    for (const key of SYNC_PREFS) {
        const entry = entries['pref:' + key];
        if (entry && !entry.deleted)
            preferences[key] = entry.value;
    }
    if (Object.keys(preferences).length) {
        try {
            await saveSettings(sanitizeSettings(preferences));
        }
        catch (error) {
            console.warn('Ignored invalid synced preferences', error);
        }
    }
}
async function perform() {
    const generation = (await chrome.storage.local.get('rrDriveRestoreGenerationV1')).rrDriveRestoreGenerationV1 || '';
    const safeToApply = async () => {
        const nowGeneration = (await chrome.storage.local.get('rrDriveRestoreGenerationV1')).rrDriveRestoreGenerationV1 || '';
        if (nowGeneration !== generation || !(await driveStatus()).enabled)
            throw new Error('Google Drive sync was stopped by a backup restore or account change.');
    };
    const status = await driveStatus();
    if (!status.enabled)
        throw new Error('Connect Google Drive first in Settings');
    await withJournalLock(() => prepareJournal());
    await safeToApply();
    const token = await getToken(false);
    // Existing connected installations can populate the banner on their next successful sync.
    if (!status.account) {
        try {
            const account = await fetchDriveAccount(token, status.clientId);
            await safeToApply();
            await statusPatch({ account });
        }
        catch { /* Never block Drive synchronization if optional profile metadata is unavailable. */ }
    }
    // Cloud v2 uses independent writer-owned shards: another device cannot
    // clobber this device's journal file by racing to update a shared document.
    // Read the v1 shared file too so upgrades and temporarily older clients work.
    const local = await withJournalLock(() => journal());
    const ownFileName = shardName(local.writer);
    let file = await findFile(token);
    const shardFiles = await findShardFiles(token);
    const remoteLegacy = await readRemote(token, file);
    const remoteShards = await Promise.all(shardFiles.map(shard => readRemote(token, shard)));
    const remote = mergeShards(mergeEntries, remoteLegacy, ...remoteShards);
    let merged = await withJournalLock(async () => {
        const current = await journal();
        const next = mergeEntries(current.entries, remote);
        current.entries = next;
        // Absorb remote logical timestamps, reducing clock-skew inversions on
        // subsequent local edits without changing the existing LWW wire format.
        for (const record of Object.values(remote)) {
            if (Number.isFinite(record?.at)) current.counter = Math.max(current.counter || 0, record.at);
        }
        await chrome.storage.local.set({ [LOCAL_KEY]: current });
        return next;
    });
    await safeToApply();
    await applyEntries(merged);
    // Always upload this device's records to its own shard first. Even if a
    // concurrent compatibility-file PATCH later overwrites a shared snapshot,
    // the shard remains an independent source of truth on the next sync.
    const currentLocal = await withJournalLock(() => journal());
    const ownEntries = ownWriterEntries(currentLocal.entries, currentLocal.writer);
    const ownShard = shardFiles.find(shard => shard.name === ownFileName) || null;
    if (Object.keys(ownEntries).length) {
        const remoteOwn = ownShard ? remoteShards[shardFiles.indexOf(ownShard)] : {};
        if (!ownShard || JSON.stringify(ownEntries) !== JSON.stringify(remoteOwn)) {
            await safeToApply();
            await upload(token, ownShard, ownEntries, ownFileName);
        }
    }
    // Compatibility write: keep the existing shared format usable by older
    // extension versions. This file alone is not atomic across devices; v2
    // readers reconcile from all writer shards to recover concurrent edits.
    if (!file || JSON.stringify(merged) !== JSON.stringify(remoteLegacy)) {
        file = await findFile(token);
        const latestLegacy = await readRemote(token, file);
        merged = await withJournalLock(async () => {
            const current = await journal();
            const next = mergeEntries(current.entries, latestLegacy);
            current.entries = next;
            await chrome.storage.local.set({ [LOCAL_KEY]: current });
            return next;
        });
        await safeToApply();
        await applyEntries(merged);
        await safeToApply();
        if (!file || JSON.stringify(merged) !== JSON.stringify(latestLegacy)) {
            await safeToApply();
            await upload(token, file, merged);
        }
    }
    await safeToApply();
    await statusPatch({ lastSync: Date.now(), lastAttempt: Date.now(), lastError: '' });
    return { items: Object.keys(merged).length, message: 'Google Drive sync completed' };
}
export function syncNow() {
    if (active)
        return active;
    active = perform().catch(async (error) => { await statusPatch({ lastAttempt: Date.now(), lastError: String(error?.message || error) }); throw error; }).finally(() => { active = null; });
    return active;
}
export async function connectDrive(clientId, clientSecret) {
    if (clientId?.trim())
        await saveDriveClientId(clientId);
    if (clientSecret !== undefined)
        await saveDriveClientSecret(clientSecret);
    // User-visible authorization is only launched by an explicit Connect click.
    const token = await getToken(true);
    const account = await fetchDriveAccount(token, await readClientId());
    // Only show a connected-account banner after Google's Drive API verifies the identity.
    await statusPatch({ enabled: true, restorePaused: false, lastError: '', account });
    await chrome.storage.local.set({ [restoredAccountKey]: account });
    try {
        await syncNow();
    }
    catch (error) {
        await statusPatch({ lastError: String(error.message || error) });
        throw error;
    }
    return driveStatus();
}
export async function disconnectDrive() {
    // Disable sync and clear this browser's ephemeral token, not the user's cloud data.
    await statusPatch({ enabled: false, restorePaused: false, lastError: '', account: null });
    await chrome.alarms.clear(DIRTY_ALARM);
    await chrome.storage.session.remove(GOOGLE_SESSION_TOKEN);
    await chrome.storage.local.remove([accessKey, refreshKey, secretKey, restoredAccountKey]);
    return driveStatus();
}
