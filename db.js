import { mayNeedRestoredImages } from './restore-recovery.js';
import { cleanFeedTitle, EMPTY_DIAG, makeId, DEFAULTS, calculateCounts, normalizedFeedPath, defaultFeedTitle, searchFeedDetails, planSidebarMove } from './shared.js';
const DB_NAME = 'substream-local-v1';
const VERSION = 1;
let instance = null;
function request(req) { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function finished(tx) { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Transaction aborted')); }); }
async function open() {
    if (instance)
        return instance;
    instance = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore('feeds', { keyPath: 'id' }).createIndex('subreddit', 'subreddit', { unique: true });
            db.createObjectStore('folders', { keyPath: 'id' });
            const posts = db.createObjectStore('posts', { keyPath: 'id' });
            posts.createIndex('createdAt', 'createdAt');
            posts.createIndex('read', 'read');
            posts.createIndex('firstSeen', 'firstSeen');
            const subs = db.createObjectStore('subscriptions', { keyPath: 'id' });
            subs.createIndex('feedId', 'feedId');
            subs.createIndex('postId', 'postId');
        };
        req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); instance = null; }; resolve(req.result); };
        req.onerror = () => { instance = null; reject(req.error); };
    });
    return instance;
}
export async function all(store) { const db = await open(); const tx = db.transaction(store, 'readonly'); return request(tx.objectStore(store).getAll()); }
export async function getRecord(store, id) { const db = await open(); const tx = db.transaction(store, 'readonly'); return request(tx.objectStore(store).get(id)); }
export async function setRecord(store, value) { const db = await open(); const tx = db.transaction(store, 'readwrite'); const done = finished(tx); tx.objectStore(store).put(value); await done; }
export async function deleteRecord(store, key) { const db = await open(); const tx = db.transaction(store, 'readwrite'); const done = finished(tx); tx.objectStore(store).delete(key); await done; }
/** On-demand, bounded-memory storage inventory. The breakdown is an approximate
 * UTF-8 JSON footprint; Chrome does not expose exact bytes per IDB object store.
 * Invoked only from Diagnostics, never from ordinary feed refreshes. */
let cachedStorageMetrics = null;
export async function getStorageMetrics(force = false) {
    if (!force && cachedStorageMetrics && Date.now() - cachedStorageMetrics.measuredAt < 60000)
        return cachedStorageMetrics;
    const db = await open();
    const encoder = new TextEncoder();
    const stores = {};
    for (const name of ['posts', 'subscriptions', 'feeds', 'folders']) {
        stores[name] = await new Promise((resolve, reject) => {
            const transaction = db.transaction(name, 'readonly');
            const cursorRequest = transaction.objectStore(name).openCursor();
            const record = { count: 0, estimatedJsonBytes: 0 };
            cursorRequest.onerror = () => reject(cursorRequest.error);
            transaction.onabort = () => reject(transaction.error || Error('Storage scan aborted'));
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor) { resolve(record); return; }
                record.count++;
                try { record.estimatedJsonBytes += encoder.encode(JSON.stringify(cursor.value)).byteLength; }
                catch { /* An unencodable value is not included in the size estimate. */ }
                cursor.continue();
            };
        });
    }
    const localBytes = await chrome.storage.local.getBytesInUse(null).catch(() => null);
    const estimate = await (typeof navigator !== 'undefined' && navigator.storage?.estimate
        ? navigator.storage.estimate().catch(() => null) : Promise.resolve(null));
    cachedStorageMetrics = {
        measuredAt: Date.now(), stores,
        estimatedJsonBytes: Object.values(stores).reduce((sum, row) => sum + row.estimatedJsonBytes, 0),
        localBytes,
        originUsageBytes: Number.isFinite(estimate?.usage) ? estimate.usage : null,
        originQuotaBytes: Number.isFinite(estimate?.quota) ? estimate.quota : null
    };
    return cachedStorageMetrics;
}
export async function getSettings() {
    const r = await chrome.storage.local.get(['settings', 'rrPopupSizeDefaultsMigratedV168']);
    let saved = r.settings || {};
    // Migrate only the original paired defaults. Keep custom percentages intact.
    if (!r.rrPopupSizeDefaultsMigratedV168) {
        if (saved.fullPopupWidthPct === 80 && saved.fullPopupHeightPct === 85) {
            saved = { ...saved, fullPopupWidthPct: 60, fullPopupHeightPct: 80 };
            await chrome.storage.local.set({ settings: saved });
        }
        await chrome.storage.local.set({ rrPopupSizeDefaultsMigratedV168: true });
    }
    const out = { ...DEFAULTS, ...saved }; if (out.layout === 'compact')
    out.layout = 'list'; out.providerMode = 'oauth'; return out; }
export async function saveSettings(patch) { const current = await getSettings(); const updated = { ...current, ...patch, providerMode: 'oauth' }; if (updated.layout === 'compact')
    updated.layout = 'list'; await chrome.storage.local.set({ settings: updated }); return updated; }
export async function getDiagnostics() { const r = await chrome.storage.local.get('diagnostics'); const d = { ...EMPTY_DIAG, ...(r.diagnostics || {}) }; const today = new Date().toISOString().slice(0, 10); if (d.requestDay !== today) {
    d.requestsToday = 0;
    d.iconRequestsToday = 0;
    d.requestDay = today;
} if (/daily (reddit )?request budget reached/i.test(d.providerStatus || '')) d.providerStatus = 'Ready for refresh';
if (/daily (reddit )?request budget reached/i.test(d.lastError || '')) d.lastError = '';
return d; }
// Serialize diagnostic read-modify-write operations, including request counters.
let diagnosticsWriteTail = Promise.resolve();
export function updateDiagnostics(updater) {
    const work = diagnosticsWriteTail.then(async () => {
        const previous = await getDiagnostics();
        const patch = updater(previous);
        if (!patch) return null;
        const next = { ...previous, ...patch };
        await chrome.storage.local.set({ diagnostics: next });
        return next;
    });
    diagnosticsWriteTail = work.catch(() => {});
    return work;
}
export async function setDiagnostics(patch) { await updateDiagnostics(() => patch); }
export async function snapshot() {
    const [feeds, folders, posts, subscriptions, settings, diagnostics] = await Promise.all([all('feeds'), all('folders'), all('posts'), all('subscriptions'), getSettings(), getDiagnostics()]);
    const counts = calculateCounts(feeds, folders, posts, subscriptions, diagnostics.lastRun);
    return { feeds: feeds.sort((a, b) => a.order - b.order), folders: folders.sort((a, b) => a.order - b.order), posts: posts.sort((a, b) => b.createdAt - a.createdAt), subscriptions, settings, diagnostics, counts };
}
/** Return at most popupLimit unread previews per feed (plus chronological
 * previews) while retaining exact global/feed/folder counters. The full reader
 * deliberately retains its complete snapshot for now.
 */
export async function popupSnapshot() {
    const state = await snapshot();
    const limit = Math.max(1, Math.min(500, Number(state.settings.popupLimit) || 35));
    const subsByPost = new Map();
    for (const subscription of state.subscriptions) {
        if (!subsByPost.has(subscription.postId)) subsByPost.set(subscription.postId, []);
        subsByPost.get(subscription.postId).push(subscription);
    }
    const perFeed = new Map(), kept = new Set();
    let chronological = 0;
    for (const post of state.posts) {
        if (post.read) continue;
        if (chronological++ < limit) kept.add(post.id);
        for (const sub of subsByPost.get(post.id) || []) {
            const count = perFeed.get(sub.feedId) || 0;
            if (count >= limit) continue;
            kept.add(post.id);
            perFeed.set(sub.feedId, count + 1);
        }
    }
    return { ...state, posts: state.posts.filter(p => kept.has(p.id)),
        subscriptions: state.subscriptions.filter(s => kept.has(s.postId)) };
}
/** Initial migration retains the older UI's folders-first order. */
let sidebarMigration = null;
export async function ensureSidebarOrder() {
    if (sidebarMigration)
        return sidebarMigration;
    sidebarMigration = (async () => {
        const { rrSidebarOrderV1 } = await chrome.storage.local.get('rrSidebarOrderV1');
        if (rrSidebarOrderV1)
            return;
        const [feeds, folders] = await Promise.all([all('feeds'), all('folders')]);
        const updatesF = [], updatesD = [];
        const parents = new Set([null, ...folders.map(f => f.id)]);
        for (const parent of parents) {
            const ordered = [...folders.filter(f => f.parentId === parent).sort((a, b) => a.order - b.order).map(f => ({ type: 'folder', record: f })),
                ...feeds.filter(f => f.folderId === parent).sort((a, b) => a.order - b.order).map(f => ({ type: 'feed', record: f }))];
            ordered.forEach(({ type, record }, index) => {
                if (record.order === index)
                    return;
                if (type === 'folder')
                    updatesD.push({ ...record, order: index });
                else
                    updatesF.push({ ...record, order: index });
            });
        }
        if (updatesF.length || updatesD.length) {
            const db = await open();
            const tx = db.transaction(['feeds', 'folders'], 'readwrite');
            const done = finished(tx);
            for (const f of updatesF)
                tx.objectStore('feeds').put(f);
            for (const f of updatesD)
                tx.objectStore('folders').put(f);
            await done;
        }
        await chrome.storage.local.set({ rrSidebarOrderV1: true });
    })().catch(error => { sidebarMigration = null; throw error; });
    return sidebarMigration;
}
export async function moveSidebarItem(source, destination, placement) {
    await ensureSidebarOrder();
    const [feeds, folders] = await Promise.all([all('feeds'), all('folders')]);
    const planned = planSidebarMove(feeds, folders, source, destination, placement);
    if (!planned.feeds.length && !planned.folders.length)
        return planned;
    const db = await open();
    const tx = db.transaction(['feeds', 'folders'], 'readwrite');
    const done = finished(tx);
    for (const f of planned.feeds)
        tx.objectStore('feeds').put(f);
    for (const f of planned.folders)
        tx.objectStore('folders').put(f);
    await done;
    return planned;
}
export async function importFeeds(items) {
    const [existing, allFolders] = await Promise.all([all('feeds'), all('folders')]);
    const lookup = new Map(existing.map(f => [f.subreddit.toLowerCase(), f]));
    const folders = [...allFolders];
    const now = Date.now();
    let added = 0, duplicates = 0, invalid = 0, foldersAdded = 0;
    const newFeeds = [];
    const db = await open();
    const tx = db.transaction(['feeds', 'folders'], 'readwrite');
    const complete = finished(tx);
    const fStore = tx.objectStore('feeds'), dirStore = tx.objectStore('folders');
    for (const item of items) {
        const canonical = normalizedFeedPath(item.subreddit);
        if (!canonical) {
            invalid++;
            continue;
        }
        if (lookup.has(canonical)) {
            duplicates++;
            continue;
        }
        let parentId = null;
        for (const raw of item.folderPath.slice(0, 12)) {
            const name = raw.trim().slice(0, 75);
            if (!name)
                continue;
            let folder = folders.find(f => f.name.toLowerCase() === name.toLowerCase() && f.parentId === parentId);
            if (!folder) {
                folder = { id: makeId(), name, parentId, order: Math.max(-1, ...folders.filter(f => f.parentId === parentId).map(f => f.order), ...existing.filter(f => f.folderId === parentId).map(f => f.order)) + 1 };
                folders.push(folder);
                dirStore.put(folder);
                foldersAdded++;
            }
            parentId = folder.id;
        }
        const feed = { id: makeId(), name: (item.name || defaultFeedTitle(canonical)).slice(0, 75), subreddit: canonical, folderId: parentId, order: Math.max(-1, ...folders.filter(f => f.parentId === parentId).map(f => f.order), ...existing.filter(f => f.folderId === parentId).map(f => f.order), ...newFeeds.filter(f => f.folderId === parentId).map(f => f.order)) + 1, refreshMinutes: null, createdAt: now, lastFetched: 0, nextDue: now, lastError: '', failureCount: 0, etag: '', modified: '', ...(searchFeedDetails(canonical) ? { searchQuery: (item.searchQuery || searchFeedDetails(canonical).query).trim(), searchSort: searchFeedDetails(canonical).sort, searchScope: searchFeedDetails(canonical).scope } : {}), iconUrl: '', iconFetchedAt: 0 };
        fStore.put(feed);
        newFeeds.push(feed);
        lookup.set(feed.subreddit, feed);
        added++;
    }
    await complete;
    return { added, duplicates, invalid, foldersAdded };
}
/** IndexedDB writes are scoped to the incoming IDs, not every cached article.
 * All lookups and mutations use one transaction so two concurrent refreshes
 * cannot overwrite local read/starred changes made before their completion.
 */
export async function putPosts(feed, incoming, maxPostsPerFeed) {
    const restored = (await chrome.storage.local.get('restoredFlags')).restoredFlags || {};
    const restoredRead = new Set(restored.read || []);
    const restoredStar = new Set(restored.starred || []);
    const unique = new Set();
    const limit = Math.min(100, maxPostsPerFeed);
    const batch = incoming.slice(0, limit).filter(post => {
        if (!post || typeof post.id !== 'string' || unique.has(post.id)) return false;
        unique.add(post.id);
        return true;
    });
    if (!batch.length) return { newPosts: 0, updated: 0, newPostRecords: [] };
    const db = await open();
    const tx = db.transaction(['posts', 'subscriptions'], 'readwrite');
    const done = finished(tx);
    const posts = tx.objectStore('posts'), subscriptions = tx.objectStore('subscriptions');
    let newPosts = 0, updated = 0;
    const newPostRecords = [];
    for (const post of batch) {
        const existing = posts.get(post.id);
        existing.onsuccess = () => {
            const old = existing.result;
            if (old) {
                // Reddit can omit galleries/media on some listing responses. Do
                // not replace previously recovered detail images with an empty
                // listing. Preserve the user's read/starred flags as before.
                posts.put({ ...post,
                    images: post.images?.length ? post.images : (old.images || []),
                    thumbnail: post.thumbnail || old.thumbnail || '',
                    video: post.video || old.video || '',
                    text: post.text || old.text || '',
                    firstSeen: old.firstSeen, read: old.read, starred: old.starred });
                updated++;
            } else {
                posts.put({ ...post, read: restoredRead.has(post.id), starred: restoredStar.has(post.id) });
                newPosts++;
                newPostRecords.push(post);
            }
        };
        const id = feed.id + '|' + post.id;
        const subscription = subscriptions.get(id);
        subscription.onsuccess = () => {
            if (!subscription.result)
                subscriptions.put({ id, feedId: feed.id, postId: post.id, addedAt: Date.now() });
        };
    }
    await done;
    return { newPosts, updated, newPostRecords };
}
/** Returns only actual changes, allowing callers to journal exact affected IDs. */
export async function markPosts(ids, read) {
    const uniqueIds = [...new Set(ids.filter(id => typeof id === 'string' && id.length <= 180))];
    if (!uniqueIds.length) return [];
    const db = await open();
    const tx = db.transaction('posts', 'readwrite');
    const done = finished(tx);
    const posts = tx.objectStore('posts');
    const changed = [];
    for (const id of uniqueIds) {
        const req = posts.get(id);
        req.onsuccess = () => {
            const post = req.result;
            if (post && post.read !== read) {
                posts.put({ ...post, read });
                changed.push(id);
            }
        };
    }
    await done;
    return changed;
}
/** For folder/feed scopes look up subscriptions through the feedId index.
 * The all-posts scope uses a cursor, avoiding materializing a second copy.
 */
export async function markScope(scope, id, read) {
    if (scope !== 'all' && scope !== 'feed' && scope !== 'folder')
        throw new Error('Invalid mark scope');
    const db = await open();
    if (scope === 'all') {
        const tx = db.transaction('posts', 'readwrite');
        const done = finished(tx);
        const changed = [];
        const req = tx.objectStore('posts').openCursor();
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            if (cursor.value.read !== read) {
                changed.push(cursor.value.id);
                cursor.update({ ...cursor.value, read });
            }
            cursor.continue();
        };
        await done;
        return changed;
    }
    const feedIds = new Set();
    if (scope === 'feed') feedIds.add(id);
    else {
        const [feeds, folders] = await Promise.all([all('feeds'), all('folders')]);
        const folderChildren = new Map(), feedsByFolder = new Map();
        for (const folder of folders) {
            if (!folderChildren.has(folder.parentId)) folderChildren.set(folder.parentId, []);
            folderChildren.get(folder.parentId).push(folder.id);
        }
        for (const feed of feeds) {
            if (!feedsByFolder.has(feed.folderId)) feedsByFolder.set(feed.folderId, []);
            feedsByFolder.get(feed.folderId).push(feed.id);
        }
        const seen = new Set(), walk = (folderId, depth) => {
            if (depth > 12 || seen.has(folderId)) return;
            seen.add(folderId);
            for (const feedId of feedsByFolder.get(folderId) || []) feedIds.add(feedId);
            for (const child of folderChildren.get(folderId) || []) walk(child, depth + 1);
        };
        walk(id, 0);
    }
    if (!feedIds.size) return [];
    const tx = db.transaction('subscriptions', 'readonly');
    const index = tx.objectStore('subscriptions').index('feedId');
    const grouped = await Promise.all([...feedIds].map(feedId => request(index.getAll(IDBKeyRange.only(feedId)))));
    const ids = grouped.flatMap(group => group.map(subscription => subscription.postId));
    return markPosts(ids, read);
}
export async function starPost(id, starred) { const db = await open(); const tx = db.transaction('posts', 'readwrite'); const done = finished(tx); const req = tx.objectStore('posts').get(id); req.onsuccess = () => { if (req.result)
    tx.objectStore('posts').put({ ...req.result, starred }); }; await done; }
/** Apply a synced flag snapshot as one atomic transaction instead of one
 * transaction for every cached post. Unmentioned flags are preserved.
 */
/** Apply cloud flags using direct keys: unchanged cached articles are never scanned.
 * The transaction commits all affected read/star fields atomically. */
export async function applySyncedPostFlags(entries) {
    const byId = new Map();
    for (const [key, item] of Object.entries(entries || {})) {
        const type = key.startsWith('read:') ? 'read' : key.startsWith('star:') ? 'starred' : null;
        if (!type || !item || item.deleted || typeof item.value !== 'boolean') continue;
        const id = key.slice(type === 'read' ? 5 : 5);
        if (!id || id.length > 180) continue;
        if (!byId.has(id)) byId.set(id, {});
        byId.get(id)[type] = item.value;
    }
    if (!byId.size) return 0;
    const db = await open();
    const tx = db.transaction('posts', 'readwrite');
    const done = finished(tx), posts = tx.objectStore('posts');
    let changed = 0;
    for (const [id, patch] of byId) {
        const req = posts.get(id);
        req.onsuccess = () => {
            const old = req.result;
            if (!old) return;
            const next = { ...old, ...patch };
            if (next.read !== old.read || next.starred !== old.starred) {
                posts.put(next);
                changed++;
            }
        };
    }
    await done;
    return changed;
}
/** Determine which feed subscriptions and orphaned posts to remove.
 * Shared posts and explicit stars stay in the library. Pure for regression tests.
 */
export function planFeedRemoval(subs, posts, feedId) {
    const toRemove = subs.filter(s => s.feedId === feedId);
    const retainedPostIds = new Set(subs.filter(s => s.feedId !== feedId).map(s => s.postId));
    const orphanedIds = new Set(toRemove.map(s => s.postId).filter(postId => !retainedPostIds.has(postId)));
    return {
        subscriptionIds: toRemove.map(s => s.id),
        postIds: posts.filter(post => orphanedIds.has(post.id) && !post.starred).map(post => post.id)
    };
}
/** Delete only this feed's subscription links and check shared-post references
 * through indexed lookups. Starred orphaned posts are deliberately preserved. */
export async function removeFeed(id) {
    if (typeof id !== 'string' || !id) return;
    const db = await open();
    const tx = db.transaction(['feeds', 'subscriptions', 'posts'], 'readwrite');
    const done = finished(tx);
    const feeds = tx.objectStore('feeds');
    const subs = tx.objectStore('subscriptions');
    const posts = tx.objectStore('posts');
    const byFeed = subs.index('feedId');
    const byPost = subs.index('postId');
    const req = byFeed.getAll(IDBKeyRange.only(id));
    req.onsuccess = () => {
        const candidates = new Set();
        for (const subscription of req.result || []) {
            subs.delete(subscription.id);
            candidates.add(subscription.postId);
        }
        for (const postId of candidates) {
            const linked = byPost.getAll(IDBKeyRange.only(postId));
            linked.onsuccess = () => {
                if (linked.result.length) return;
                const record = posts.get(postId);
                record.onsuccess = () => {
                    if (record.result && !record.result.starred) posts.delete(postId);
                };
            };
        }
    };
    feeds.delete(id);
    await done;
}
export async function addFolder(name, parentId) { const [folders, feeds] = await Promise.all([all('folders'), all('feeds')]); if (parentId && !folders.some(f => f.id === parentId))
    throw new Error('Parent folder not found'); const folder = { id: makeId(), name: name.trim().slice(0, 75), parentId, refreshMinutes: null, order: Math.max(-1, ...folders.filter(f => f.parentId === parentId).map(f => f.order), ...feeds.filter(f => f.folderId === parentId).map(f => f.order)) + 1 }; if (!folder.name)
    throw new Error('Folder name required'); await setRecord('folders', folder); return folder; }
export async function updateFolder(id, patch) { const folders = await all('folders'); const existing = folders.find(f => f.id === id); if (!existing)
    throw new Error('Folder not found'); let parentId = patch.parentId === undefined ? existing.parentId : patch.parentId; if (parentId) {
    let cur = parentId;
    const seen = new Set([id]);
    while (cur) {
        if (seen.has(cur))
            throw new Error('Circular folder hierarchy');
        seen.add(cur);
        cur = folders.find(f => f.id === cur)?.parentId || null;
    }
} await setRecord('folders', { ...existing, ...patch, parentId, name: (patch.name ?? existing.name).trim().slice(0, 75) }); }
export async function removeFolder(id) { const [folders, feeds] = await Promise.all([all('folders'), all('feeds')]); const folder = folders.find(f => f.id === id); if (!folder)
    return; const db = await open(); const tx = db.transaction(['feeds', 'folders'], 'readwrite'); const done = finished(tx); for (const f of folders)
    if (f.parentId === id)
        tx.objectStore('folders').put({ ...f, parentId: folder.parentId }); for (const f of feeds)
    if (f.folderId === id)
        tx.objectStore('feeds').put({ ...f, folderId: folder.parentId }); tx.objectStore('folders').delete(id); await done; }
export async function patchFeed(id, patch) {
    const allowed = {};
    if (patch.name !== undefined) patch = { ...patch, name: cleanFeedTitle(patch.name) };
    for (const key of ['folderId', 'refreshMinutes', 'order', 'name', 'viewMode', 'lastFetched', 'nextDue', 'lastError', 'failureCount', 'etag', 'modified', 'iconUrl', 'iconFetchedAt', 'sidebarBg', 'sidebarText'])
        if (patch[key] !== undefined) allowed[key] = patch[key];
    const db = await open();
    const tx = db.transaction('feeds', 'readwrite');
    const done = finished(tx), store = tx.objectStore('feeds');
    let found = false;
    const req = store.get(id);
    req.onsuccess = () => {
        if (!req.result) return;
        found = true;
        store.put({ ...req.result, ...allowed });
    };
    await done;
    if (!found) throw new Error('Feed not found');
}
export async function cleanup(keepDays, maxPerFeed) {
    const [posts, subs] = await Promise.all([all('posts'), all('subscriptions')]);
    const cutoff = Date.now() - keepDays * 86400000;
    const postMap = new Map(posts.map(p => [p.id, p]));
    const byFeed = new Map();
    for (const sub of subs) {
        let list = byFeed.get(sub.feedId);
        if (!list)
            byFeed.set(sub.feedId, list = []);
        list.push(sub);
    }
    const deleteSubscriptions = new Set();
    for (const list of byFeed.values()) {
        list.sort((a, b) => (postMap.get(b.postId)?.createdAt || 0) - (postMap.get(a.postId)?.createdAt || 0));
        for (let i = 0; i < list.length; i++) {
            const sub = list[i], post = postMap.get(sub.postId);
            if (!post || (!post.starred && (post.firstSeen < cutoff || i >= maxPerFeed)))
                deleteSubscriptions.add(sub.id);
        }
    }
    const keptPostIds = new Set(subs.filter(s => !deleteSubscriptions.has(s.id)).map(s => s.postId));
    const deletedPostIds = new Set(posts.filter(p => !p.starred && !keptPostIds.has(p.id)).map(p => p.id));
    if (!deleteSubscriptions.size && !deletedPostIds.size)
        return;
    const db = await open();
    const tx = db.transaction(['posts', 'subscriptions'], 'readwrite');
    const done = finished(tx);
    for (const id of deletedPostIds)
        tx.objectStore('posts').delete(id);
    for (const id of deleteSubscriptions)
        tx.objectStore('subscriptions').delete(id);
    await done;
}
export async function restoreBackup(backup) {
    if (!backup || backup.format !== 'substream-backup-v1' || !Array.isArray(backup.feeds) || backup.feeds.length > 5000)
        throw new Error('Invalid Reddit Reader backup');
    const items = backup.feeds.map((f) => ({ subreddit: String(f.subreddit || ''), name: String(f.name || ('r/' + f.subreddit)).slice(0, 80), folderPath: Array.isArray(f.folderPath) ? f.folderPath.slice(0, 12).map((s) => String(s).slice(0, 75)) : [] }));
    const imported = await importFeeds(items);
    const read = Array.isArray(backup.readPosts) ? backup.readPosts.slice(0, 50000).filter((s) => typeof s === 'string') : [];
    const starred = Array.isArray(backup.starredPosts) ? backup.starredPosts.slice(0, 50000).filter((s) => typeof s === 'string') : [];
    const old = (await chrome.storage.local.get('restoredFlags')).restoredFlags || { read: [], starred: [] };
    await chrome.storage.local.set({ restoredFlags: { read: [...new Set([...old.read, ...read])], starred: [...new Set([...old.starred, ...starred])] } });
    const existing = await all('posts');
    const readIds = new Set(read), starIds = new Set(starred);
    const db = await open();
    const tx = db.transaction('posts', 'readwrite');
    const done = finished(tx);
    for (const p of existing)
        if (readIds.has(p.id) || starIds.has(p.id))
            tx.objectStore('posts').put({ ...p, read: readIds.has(p.id) || p.read, starred: starIds.has(p.id) || p.starred });
    await done;
    if (backup.settings && typeof backup.settings === 'object') {
        const safeKeys = ['theme', 'accent', 'density', 'font', 'fontSize', 'lineHeight', 'layout', 'sidebarWidth', 'sidebarFontSize', 'readerWidth', 'fullPopupWidthPct', 'fullPopupHeightPct', 'showThumbs', 'showSnippets', 'hideRead', 'markReadOnOpen', 'popupLimit', 'popupGrouping', 'badgeMode', 'badgeColor', 'refreshMinutes', 'keepDays', 'maxPostsPerFeed'];
        const patch = {};
        for (const key of safeKeys)
            if (backup.settings[key] !== undefined)
                patch[key] = backup.settings[key];
        await saveSettings(patch);
    }
    return { ...imported, readStatesSaved: read.length, starredStatesSaved: starred.length };
}
export async function clearAll() { const db = await open(); const tx = db.transaction(['feeds', 'folders', 'posts', 'subscriptions'], 'readwrite'); const done = finished(tx); for (const name of ['feeds', 'folders', 'posts', 'subscriptions'])
    tx.objectStore(name).clear(); await done; }
/** Preserve backed-up Google identity and grants while pausing any cloud merge.
 * The account is a saved (not reverified) identity until the user resumes.
 */
export function restoredDriveSettings(previous, localState, backup) {
    const hasDriveSettings = Object.hasOwn(localState, 'rrDriveSettings');
    const saved = hasDriveSettings ? localState.rrDriveSettings : previous;
    const base = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const clientId = localState.rrGoogleWebClientId;
    const candidateAccount = base.account || localState.rrDriveRestoredAccountV1;
    const account = candidateAccount && typeof candidateAccount === 'object'
        && typeof candidateAccount.email === 'string' && typeof candidateAccount.name === 'string'
        && typeof candidateAccount.clientId === 'string' && candidateAccount.clientId === clientId
        ? candidateAccount : null;
    const hadConnection = Boolean(base.enabled || backup.driveSyncWasEnabled ||
        (account && (localState.rrGoogleDriveRefreshToken || localState.rrGoogleDrivePersistentAccessToken)));
    return {
        ...base, account, enabled: hadConnection,
        restorePaused: hadConnection,
        restoredFromBackupAt: Date.now(),
        lastError: ''
    };
}
/** Restore a v2 library without changing any IndexedDB store until every record
 * has passed strict backup validation. The four stores are committed in ONE
 * transaction so malformed references cannot leave half a restored library.
 */
export async function restoreCompleteBackup(backup, mode) {
    if (mode !== 'replace' && mode !== 'merge')
        throw new Error('Choose replace or merge for restore');
    const [oldFeeds, oldFolders, oldPosts, oldSubscriptions] = mode === 'merge' ? await Promise.all([
        all('feeds'), all('folders'), all('posts'), all('subscriptions')
    ]) : [[], [], [], []];
    const existingIds = new Set(oldFeeds.map(f => f.id));
    const oldBySub = new Map(oldFeeds.map(f => [f.subreddit, f]));
    const mapped = new Map();
    const folderById = new Map(oldFolders.map(f => [f.id, f]));
    for (const folder of backup.folders)
        folderById.set(folder.id, folder);
    const feedsById = new Map(oldFeeds.map(f => [f.id, f]));
    const postsById = new Map(oldPosts.map(p => [p.id, p]));
    const subscriptionsById = new Map(oldSubscriptions.map(s => [s.id, s]));
    for (const feed of backup.feeds) {
        let id = oldBySub.get(feed.subreddit)?.id || feed.id;
        if (existingIds.has(id) && !oldBySub.has(feed.subreddit))
            id = makeId();
        existingIds.add(id);
        mapped.set(feed.id, id);
        feedsById.set(id, { ...feed, id });
    }
    for (const post of backup.posts)
        postsById.set(post.id, post);
    for (const subscription of backup.subscriptions) {
        const feedId = mapped.get(subscription.feedId);
        const id = feedId + '|' + subscription.postId;
        subscriptionsById.set(id, { ...subscription, id, feedId });
    }
    // Replacing the complete cache also removes orphan records from earlier installs.
    const db = await open();
    const tx = db.transaction(['feeds', 'folders', 'posts', 'subscriptions'], 'readwrite');
    const done = finished(tx);
    if (mode === 'replace')
        for (const name of ['feeds', 'folders', 'posts', 'subscriptions'])
            tx.objectStore(name).clear();
    for (const folder of backup.folders)
        tx.objectStore('folders').put(folder);
    for (const feed of feedsById.values())
        tx.objectStore('feeds').put(feed);
    for (const post of postsById.values())
        tx.objectStore('posts').put(post);
    for (const sub of subscriptionsById.values())
        tx.objectStore('subscriptions').put(sub);
    await done;
    // Browser-managed identity grants cannot be exported. Locally saved Reddit
    // and Google credentials in v3 backups can be restored as plain JSON.
    const current = await getSettings();
    const stored = await chrome.storage.local.get(['restoredFlags', 'substreamUserOAuth', 'rrDriveSettings', 'rrGoogleWebClientId']);
    const redditCreds = backup.credentials ? backup.credentials.redditOAuth : stored.substreamUserOAuth ?? null;
    const localTokens = backup.credentials?.settings ?? { oauthToken: current.oauthToken, providerToken: current.providerToken };
    const mergedSettings = { ...DEFAULTS, ...backup.settings, ...localTokens,
        oauthConfigured: !!(redditCreds?.accessToken || localTokens.oauthToken) };
    if (mergedSettings.providerMode === 'oauth' && !mergedSettings.oauthConfigured)
        mergedSettings.providerMode = 'session';
    const flags = mode === 'merge' ? {
        read: [...new Set([...(stored.restoredFlags?.read || []), ...backup.restoredFlags.read])],
        starred: [...new Set([...(stored.restoredFlags?.starred || []), ...backup.restoredFlags.starred])]
    } : backup.restoredFlags;
    // Suspend cross-browser syncing until the user reviews the restored snapshot.
    // Otherwise a stale remote journal might immediately undo a local REPLACE.
    const extraLocal = backup.localState || {};
    const effectiveDriveState = {
        ...extraLocal,
        rrGoogleWebClientId: extraLocal.rrGoogleWebClientId || stored.rrGoogleWebClientId
    };
    const restoredDrive = restoredDriveSettings(stored.rrDriveSettings, effectiveDriveState, backup);
    const changes = { ...extraLocal, settings: mergedSettings, restoredFlags: flags,
        rrDriveSettings: restoredDrive, rrDriveRestoreGenerationV1: crypto.randomUUID() };
    // The saved display identity is durable independently of short-lived access
    // tokens and background sync status. Never erase it on HTTP 401/expiry.
    if (restoredDrive.account && restoredDrive.account.clientId === effectiveDriveState.rrGoogleWebClientId)
        changes.rrDriveRestoredAccountV1 = restoredDrive.account;
    if (backup.credentials && backup.credentials.redditOAuth)
        changes.substreamUserOAuth = backup.credentials.redditOAuth;
    await chrome.storage.local.set(changes);
    if (backup.credentials && backup.credentials.redditOAuth === null)
        await chrome.storage.local.remove('substreamUserOAuth');
    // Preserve a v3 journal when explicitly included in the user's backup.
    // Older backups have no journal and must not retain stale pre-restore entries.
    if (!Object.hasOwn(extraLocal, 'rrDriveJournal')) await chrome.storage.local.remove('rrDriveJournal');
    return { mode, feeds: feedsById.size, folders: folderById.size, posts: postsById.size, subscriptions: subscriptionsById.size, restoredSettings: Object.keys(backup.settings).length,
        credentialsRestored: !!backup.credentials, googleReconnectRequired: backup.driveSyncWasEnabled };
}

/** A full post-restore feed update must not reuse stale conditional cache
 * validators copied from the old installation. One transaction updates all
 * feed validators and due times without touching reading state. */
export async function invalidateRestoredFeedValidators() {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('feeds', 'readwrite');
        const req = tx.objectStore('feeds').openCursor();
        let changed = 0;
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error || new Error('Feed invalidation aborted'));
        tx.oncomplete = () => resolve(changed);
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) return;
            cursor.update({ ...cursor.value, etag: '', modified: '', nextDue: Date.now() });
            changed++;
            cursor.continue();
        };
    });
}

/** Efficient, resumable media-recovery scan. A cursor is used rather than
 * materialising the complete library. The checkpoint is an indexed primary
 * key, so this scales to backups containing thousands of posts. */
export async function missingRestoreMediaBatch(afterId = '', maxCandidates = 8, maxVisited = 1200) {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('posts', 'readonly');
        let range = null;
        if (afterId && typeof IDBKeyRange?.lowerBound === 'function')
            range = IDBKeyRange.lowerBound(afterId, true);
        const req = tx.objectStore('posts').openCursor(range);
        const candidates = [];
        let scanned = 0, checkpoint = afterId;
        req.onerror = () => reject(req.error || new Error('Post recovery scan failed'));
        tx.onabort = () => reject(tx.error || new Error('Post recovery scan aborted'));
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
                resolve({ candidates, checkpoint, done: true, visited: scanned });
                return;
            }
            // The fallback supports minimal IndexedDB test stubs.
            if (afterId && !range && String(cursor.key) <= afterId) {
                cursor.continue();
                return;
            }
            checkpoint = String(cursor.key);
            scanned++;
            if (!cursor.value.read && mayNeedRestoredImages(cursor.value)) candidates.push({ id: checkpoint, url: cursor.value.url });
            if (candidates.length >= maxCandidates || scanned >= maxVisited) {
                resolve({ candidates, checkpoint, done: false, visited: scanned });
            } else cursor.continue();
        };
    });
}

/** Count only UNREAD image candidates. Run once after feed refresh, not on each
 * UI poll. The result is a point-in-time estimate: the reader can mark posts
 * read while recovery runs, and freshly fetched details can repair images. */
export async function countUnreadRestoreMediaCandidates() {
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('posts', 'readonly');
        const req = tx.objectStore('posts').openCursor();
        let total = 0;
        req.onerror = () => reject(req.error || Error('Unable to count image recovery candidates'));
        tx.onabort = () => reject(tx.error || Error('Recovery count transaction aborted'));
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) { resolve(total); return; }
            if (!cursor.value.read && mayNeedRestoredImages(cursor.value)) total++;
            cursor.continue();
        };
    });
}

/** Store richer explicitly requested post details without changing read/starred flags,
 * which may have changed while the network request was in flight. */
export async function mergePostDetails(id, details) {
    const db = await open();
    const tx = db.transaction('posts', 'readwrite');
    const done = finished(tx);
    const store = tx.objectStore('posts'), req = store.get(id);
    req.onsuccess = () => {
        const current = req.result;
        if (!current)
            return;
        const images = details.images.length ? details.images : current.images;
        store.put({ ...current, text: details.text || current.text, images, video: details.video || current.video,
            thumbnail: current.thumbnail || images[0] || '' });
    };
    await done;
}
