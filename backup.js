/** Explicit user-requested, plaintext portable backups. Files include locally
 * stored Reddit/Google credentials; they must never be shared. Chrome-owned
 * identity tokens (if any) are not exportable through Chrome extension APIs.
 */
import { sanitizeNotificationRules } from './rules.js';
import { sanitizeHighlighters } from './highlighters.js';
import { FONT_VALUES } from './font-options.js';
import { DEFAULTS, normalizedFeedPath, SEARCH_SORTS, searchFeedDetails } from './shared.js';
export const BACKUP_FORMAT = 'reddit-reader-complete-v2';
export const PLAIN_BACKUP_FORMAT = 'reddit-reader-complete-v3';
export const MAX_BACKUP_BYTES = 100_000_000;
export const SAFE_SETTINGS_KEYS = Object.keys(DEFAULTS).filter(k => k !== 'oauthToken' && k !== 'providerToken');
const READING_FONTS = FONT_VALUES;
const ALLOWED_FONTS = FONT_VALUES;
const ENUMS = {
    theme: new Set(['system', 'light', 'dark', 'oled', 'sepia', 'slate', 'solarized']), density: new Set(['ultra', 'compact', 'comfortable', 'spacious']),
    font: ALLOWED_FONTS, layout: new Set(['list', 'small-list', 'magazine', 'cards', 'three-pane', 'compact']), language: new Set(['en', 'pt-PT']), popupGrouping: new Set(['feed', 'time']),
    badgeMode: new Set(['unread', 'new']), readingFont: READING_FONTS, providerMode: new Set(['session', 'none', 'oauth', 'custom'])
};
const RANGES = { fontSize: [8, 48], lineHeight: [0.8, 3], readingFontSize: [10, 36], readingLineHeight: [1, 2.5], hoverZoomDelay: [100, 3000], hoverZoomDismissDistance: [50, 1000], sidebarCompactness: [0, 100], sidebarFontSize: [10, 20], sidebarWidth: [120, 900], readerWidth: [300, 3200], fullPopupWidthPct: [20, 100], fullPopupHeightPct: [20, 100], popupLimit: [1, 500], refreshMinutes: [0, 1440], keepDays: [1, 3650], maxPostsPerFeed: [10, 10000] };
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function str(v, field, max, empty = false) {
    if (typeof v !== 'string' || v.length > max || (!empty && !v.length))
        throw new Error(`Invalid ${field}`);
    return v;
}
function number(v, field) { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new Error(`Invalid ${field}`); return v; }
function limitArray(v, field, max) { if (!Array.isArray(v) || v.length > max)
    throw new Error(`Invalid ${field} (max ${max})`); return v; }
function idList(v, field, max = 250000) {
    const values = limitArray(v, field, max);
    const ids = new Set();
    for (const item of values)
        ids.add(str(item, field + ' ID', 180));
    return [...ids];
}
function defaultValueForExport(key) { return Array.isArray(DEFAULTS[key]) ? [...DEFAULTS[key]] : DEFAULTS[key]; }
export function sanitizeSettings(raw, includeSecrets = false, repair = false) {
    if (!obj(raw))
        throw new Error('Backup settings are missing');
    const out = {};
    for (const k of SAFE_SETTINGS_KEYS) {
        if (!Object.hasOwn(raw, k))
            continue;
        try {
            let value = raw[k]; const defaultValue = DEFAULTS[k];
            // Historical builds saved refresh intervals that the old exporter later
            // rejected. Normalise those legacy values only while exporting.
            if (repair && k === 'refreshMinutes' && !(value === 0 || (Number.isInteger(value) && value >= 5 && value <= 1440)))
                value = Number.isFinite(value) ? Math.max(5, Math.min(1440, Math.round(value))) : DEFAULTS.refreshMinutes;
            if (k === 'highlighters') {
                out[k] = sanitizeHighlighters(value);
                continue;
            }
            if (k === 'notificationRules') {
                out[k] = sanitizeNotificationRules(value);
                continue;
            }
            if (k === 'popupCollapsed' || k === 'sidebarCollapsed') {
                out[k] = idList(value, k === 'popupCollapsed' ? 'collapsed popup sections' : 'collapsed sidebar folders', 500);
                continue;
            }
            if (typeof defaultValue === 'boolean') {
                if (typeof value !== 'boolean')
                    throw new Error('Invalid setting: ' + k);
            }
            else if (typeof defaultValue === 'number') {
                if (typeof value !== 'number' || !Number.isFinite(value))
                    throw new Error('Invalid setting: ' + k);
                const range = RANGES[k];
                if (range && (value < range[0] || value > range[1]))
                    throw new Error('Out-of-range setting: ' + k);
                if (k === 'refreshMinutes' && !(value === 0 || (Number.isInteger(value) && value >= 5 && value <= 1440)))
                    throw new Error('Invalid refresh interval');
            }
            else if (typeof value !== 'string' || value.length > 3000)
                throw new Error('Invalid setting: ' + k);
            if (ENUMS[k] && !ENUMS[k].has(String(value)))
                throw new Error('Unknown value for ' + k);
            if ((k === 'accent' || k === 'badgeColor' || k === 'sidebarItemBg' || k === 'sidebarItemText') && !/^#[a-f\d]{6}$/i.test(String(value)))
                throw new Error('Invalid color: ' + k);
            if (k === 'endpointTemplate' && value) {
                let url;
                try {
                    url = new URL(String(value).replaceAll('{{subreddit}}', 'example'));
                }
                catch {
                    throw new Error('Invalid provider URL');
                }
                if (url.protocol !== 'https:' || !String(value).includes('{{subreddit}}'))
                    throw new Error('Provider URL must be HTTPS and contain {{subreddit}}');
            }
            out[k] = value;

        } catch (error) {
            if (!repair) throw error;
            out[k] = defaultValueForExport(k);
        }
    }
    if (includeSecrets) {
        for (const k of ['oauthToken', 'providerToken']) {
            const v = raw[k];
            if (typeof v !== 'string' || v.length > 20000)
                throw new Error('Invalid secret setting: ' + k);
            out[k] = v;
        }
    }
    return out;
}
function checkOptionalColor(v, field) { if (v === undefined || v === '')
    return ''; if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v))
    throw new Error('Invalid ' + field); return v; }
function checkFolder(f) {
    if (!obj(f))
        throw new Error('Invalid folder record');
    const refresh = f.refreshMinutes === undefined || f.refreshMinutes === null ? null : number(f.refreshMinutes, 'folder refresh');
    if (refresh !== null && !(refresh === 0 || (Number.isInteger(refresh) && refresh >= 5 && refresh <= 1440)))
        throw new Error('Invalid folder refresh interval');
    return { id: str(f.id, 'folder ID', 150), name: str(f.name, 'folder name', 75), parentId: f.parentId == null ? null : str(f.parentId, 'parent folder ID', 150), order: number(f.order, 'folder order'), refreshMinutes: refresh, sidebarBg: checkOptionalColor(f.sidebarBg, 'folder background'), sidebarText: checkOptionalColor(f.sidebarText, 'folder text') };
}
function checkFeed(f) {
    if (!obj(f))
        throw new Error('Invalid feed record');
    const subreddit = str(f.subreddit, 'subreddit', 2500);
    const searchDetails = searchFeedDetails(subreddit);
    if (searchDetails) {
        if (f.searchSort !== undefined && !SEARCH_SORTS.includes(f.searchSort))
            throw new Error('Invalid search feed sorting option');
        if (f.searchQuery !== undefined && (typeof f.searchQuery !== 'string' || f.searchQuery.length > 180))
            throw new Error('Invalid search feed query');
    }
    if (normalizedFeedPath(subreddit) !== subreddit)
        throw new Error('Invalid or non-canonical subreddit: ' + subreddit.slice(0, 80));
    if (f.viewMode !== undefined && f.viewMode !== null && !['list', 'small-list', 'magazine', 'cards', 'three-pane', 'compact'].includes(f.viewMode))
        throw new Error('Invalid feed layout');
    const refresh = f.refreshMinutes == null ? null : number(f.refreshMinutes, 'feed refresh');
    if (refresh !== null && !(refresh === 0 || (Number.isInteger(refresh) && refresh >= 5 && refresh <= 1440)))
        throw new Error('Invalid feed refresh interval');
    return { id: str(f.id, 'feed ID', 150), name: str(f.name, 'feed name', 200), subreddit, ...(String(subreddit).startsWith('search:') ? { searchQuery: str(f.searchQuery ?? '', 'search query', 180, true), searchSort: str(f.searchSort ?? 'new', 'search sort', 20), searchScope: searchDetails?.scope } : {}), folderId: f.folderId == null ? null : str(f.folderId, 'feed folder ID', 150), order: number(f.order, 'feed order'),
        viewMode: f.viewMode === undefined || f.viewMode === null ? undefined : str(f.viewMode, 'feed view mode', 20),
        refreshMinutes: refresh, createdAt: number(f.createdAt, 'feed createdAt'), lastFetched: number(f.lastFetched, 'feed lastFetched'), nextDue: number(f.nextDue, 'feed nextDue'),
        lastError: str(f.lastError, 'feed error', 3000, true), failureCount: number(f.failureCount, 'feed failure count'), etag: str(f.etag, 'feed ETag', 1000, true), modified: str(f.modified, 'feed modified', 1000, true),
        iconUrl: f.iconUrl === undefined ? '' : str(f.iconUrl, 'feed icon', 3000, true), iconFetchedAt: f.iconFetchedAt === undefined ? 0 : number(f.iconFetchedAt, 'icon time'), sidebarBg: checkOptionalColor(f.sidebarBg, 'feed background'), sidebarText: checkOptionalColor(f.sidebarText, 'feed text') };
}
function checkPost(p) {
    if (!obj(p))
        throw new Error('Invalid post record');
    const score = (key) => {
        if (p[key] === null)
            return null;
        if (typeof p[key] !== 'number' || !Number.isFinite(p[key]))
            throw new Error('Invalid post ' + key);
        if (key === 'upvoteRatio' && (p[key] < 0 || p[key] > 1))
            throw new Error('Invalid upvote ratio');
        return p[key];
    };
    const bool = (key) => { if (typeof p[key] !== 'boolean')
        throw new Error('Invalid post ' + key); return p[key]; };
    const images = limitArray(p.images, 'post images', 50).map(x => str(x, 'image URL', 5000, true));
    return { id: str(p.id, 'post ID', 180), title: str(p.title, 'post title', 3000, true), subreddit: str(p.subreddit, 'post subreddit', 100, true), author: str(p.author, 'post author', 150, true),
        url: str(p.url, 'post URL', 5000, true), permalink: str(p.permalink, 'post permalink', 5000, true), createdAt: number(p.createdAt, 'post createdAt'), firstSeen: number(p.firstSeen, 'post firstSeen'),
        score: score('score'), upvoteRatio: score('upvoteRatio'), comments: score('comments'), text: str(p.text, 'post text', 250000, true), thumbnail: str(p.thumbnail, 'post thumbnail', 5000, true),
        images, video: str(p.video, 'post video', 5000, true), flair: str(p.flair, 'post flair', 500, true), nsfw: bool('nsfw'), spoiler: bool('spoiler'), sticky: bool('sticky'), domain: str(p.domain, 'post domain', 500, true), read: bool('read'), starred: bool('starred') };
}
function checkSubscription(s) {
    if (!obj(s))
        throw new Error('Invalid subscription record');
    return { id: str(s.id, 'subscription ID', 350), feedId: str(s.feedId, 'subscription feed ID', 150), postId: str(s.postId, 'subscription post ID', 180), addedAt: number(s.addedAt, 'subscription addedAt') };
}
function unique(records, field, get) { const seen = new Set(); for (const r of records) {
    const key = get(r);
    if (seen.has(key))
        throw new Error('Duplicate ' + field + ': ' + key.slice(0, 120));
    seen.add(key);
} }
function oauthRecord(input) {
    if (input === null)
        return null;
    if (!obj(input))
        throw new Error('Invalid Reddit OAuth credentials');
    return { clientId: str(input.clientId, 'OAuth client ID', 100), redirectUri: str(input.redirectUri, 'OAuth redirect URI', 500), accessToken: str(input.accessToken, 'OAuth access token', 10000),
        refreshToken: str(input.refreshToken, 'OAuth refresh token', 10000, true), expiresAt: number(input.expiresAt, 'OAuth expiresAt'), username: str(input.username, 'OAuth username', 200, true), scope: str(input.scope, 'OAuth scopes', 1000, true) };
}
export function validateBackupV2(input, encrypted = false) {
    if (!obj(input) || input.format !== BACKUP_FORMAT || input.version !== 2)
        throw new Error('Unsupported full-backup format');
    const feeds = limitArray(input.feeds, 'feeds', 5000).map(checkFeed), folders = limitArray(input.folders, 'folders', 5000).map(checkFolder);
    const posts = limitArray(input.posts, 'posts', 150000).map(checkPost), subscriptions = limitArray(input.subscriptions, 'subscriptions', 350000).map(checkSubscription);
    unique(feeds, 'feed ID', x => x.id);
    unique(feeds, 'subreddit', x => x.subreddit);
    unique(folders, 'folder ID', x => x.id);
    unique(posts, 'post ID', x => x.id);
    unique(subscriptions, 'subscription ID', x => x.id);
    const folderById = new Map(folders.map(f => [f.id, f]));
    const feedIds = new Set(feeds.map(f => f.id)), postIds = new Set(posts.map(p => p.id));
    for (const f of folders) {
        const seen = new Set([f.id]);
        let cursor = f.parentId;
        while (cursor) {
            if (seen.has(cursor))
                throw new Error('Circular folder relationship');
            seen.add(cursor);
            const parent = folderById.get(cursor);
            if (!parent)
                throw new Error('Unknown parent folder');
            cursor = parent.parentId;
        }
    }
    for (const f of feeds)
        if (f.folderId && !folderById.has(f.folderId))
            throw new Error('Feed references missing folder');
    for (const s of subscriptions)
        if (!feedIds.has(s.feedId) || !postIds.has(s.postId))
            throw new Error('Subscription references missing feed or post');
    if (!obj(input.restoredFlags))
        throw new Error('Missing restored read/star flags');
    const restoredFlags = { read: idList(input.restoredFlags.read, 'read IDs'), starred: idList(input.restoredFlags.starred, 'starred IDs') };
    // Legacy v2 files omitted credentials by default; v3 deliberately includes them.
    const settings = sanitizeSettings(input.settings, false);
    const credentials = input.credentials ? (() => {
        if (!obj(input.credentials) || !obj(input.credentials.settings))
            throw new Error('Invalid encrypted credential bundle');
        const secretSettings = sanitizeSettings(input.credentials.settings, true);
        return { settings: { oauthToken: secretSettings.oauthToken || '', providerToken: secretSettings.providerToken || '' }, redditOAuth: oauthRecord(input.credentials.redditOAuth) };
    })() : undefined;
    return { format: BACKUP_FORMAT, version: 2, exportedAt: str(input.exportedAt, 'export date', 80), appVersion: str(input.appVersion, 'app version', 100),
        feeds, folders, posts, subscriptions, restoredFlags, settings, driveSyncWasEnabled: !!input.driveSyncWasEnabled, ...(credentials ? { credentials } : {}) };
}
export function summarizeBackup(backup) {
    return { format: backup.version === 3 ? 'v3' : 'v2', feeds: backup.feeds.length, folders: backup.folders.length, posts: backup.posts.length,
        unread: backup.posts.filter(p => !p.read).length, starred: backup.posts.filter(p => p.starred).length, subscriptions: backup.subscriptions.length,
        settings: Object.keys(backup.settings).length, hasCredentials: !!(backup.credentials?.redditOAuth?.accessToken || backup.credentials?.settings?.oauthToken || backup.credentials?.settings?.providerToken), hasGoogleLocalTokens: !!(backup.localState?.rrGoogleDriveRefreshToken || backup.localState?.rrGoogleDrivePersistentAccessToken), driveReconnectRequired: backup.driveSyncWasEnabled, exportedAt: backup.exportedAt };
}
export function summarizeLegacyBackup(raw) {
    if (!obj(raw) || raw.format !== 'substream-backup-v1' || !Array.isArray(raw.feeds) || raw.feeds.length > 5000)
        throw new Error('Invalid legacy backup');
    for (const feed of raw.feeds) {
        if (!obj(feed) || typeof feed.subreddit !== 'string' || !normalizedFeedPath(feed.subreddit))
            throw new Error('Invalid legacy feed');
        if (feed.folderPath !== undefined && (!Array.isArray(feed.folderPath) || feed.folderPath.length > 12 || feed.folderPath.some((p) => typeof p !== 'string' || p.length > 75)))
            throw new Error('Invalid legacy folder path');
    }
    if (raw.settings !== undefined)
        sanitizeSettings(raw.settings);
    if (raw.readPosts !== undefined)
        idList(raw.readPosts, 'legacy read IDs', 50000);
    if (raw.starredPosts !== undefined)
        idList(raw.starredPosts, 'legacy starred IDs', 50000);
    return { format: 'v1', feeds: raw.feeds.length, folders: Array.isArray(raw.folders) ? raw.folders.length : 0, posts: 0, unread: 0, starred: Array.isArray(raw.starredPosts) ? raw.starredPosts.length : 0,
        subscriptions: 0, settings: obj(raw.settings) ? Object.keys(raw.settings).length : 0, hasCredentials: false, driveReconnectRequired: false, exportedAt: String(raw.exportedAt || 'Unknown') };
}
/** Optional local Chrome storage keys that hold configuration, OAuth grants and
 * sync journal data. Excludes image/icon caches, pending one-use auth state and
 * in-progress refresh jobs, which must never be revived from a foreign browser. */
export const PORTABLE_LOCAL_KEYS = Object.freeze([
    'rrGoogleWebClientId', 'rrGoogleWebClientSecret',
    'rrGoogleDriveRefreshToken', 'rrGoogleDrivePersistentAccessToken',
    'rrDriveSettings', 'rrDriveJournal', 'rrDriveRestoredAccountV1', 'rrSidebarOrderV1',
    'diagnostics', 'lastCleanup'
]);
/** Construct one complete plaintext archive; image binary/cache and image URLs
 * are intentionally omitted. Legacy invalid settings are repaired to safe
 * defaults for export rather than aborting the entire backup. */
export function buildPlainBackup(snap, store, appVersion, exportedAt = new Date().toISOString()) {
    const source = snap || {};
    const saved = store || {};
    const posts = (source.posts || []).map(p => ({ ...p,
        author: p.author ?? '', flair: p.flair ?? '', text: p.text ?? '',
        subreddit: p.subreddit ?? '', url: p.url ?? '', permalink: p.permalink ?? '',
        score: p.score ?? null, upvoteRatio: p.upvoteRatio ?? null, comments: p.comments ?? null,
        video: p.video ?? '', domain: p.domain ?? '',
        nsfw: !!p.nsfw, spoiler: !!p.spoiler, sticky: !!p.sticky,
        read: !!p.read, starred: !!p.starred,
        firstSeen: p.firstSeen || p.createdAt || 0,
        thumbnail: '', images: [] }));
    const folders = (source.folders || []).map(f => ({...f, refreshMinutes: validLegacyInterval(f.refreshMinutes)}));
    const feeds = (source.feeds || []).map(f => ({ ...f, iconUrl: '', iconFetchedAt: 0,
        refreshMinutes: validLegacyInterval(f.refreshMinutes),
        lastFetched: f.lastFetched || 0, nextDue: f.nextDue || 0, createdAt: f.createdAt || 0,
        lastError: f.lastError || '', failureCount: f.failureCount || 0,
        etag: f.etag || '', modified: f.modified || '' }));
    const flags = saved.restoredFlags || { read: [], starred: [] };
    const localState = Object.fromEntries(PORTABLE_LOCAL_KEYS.filter(key => Object.hasOwn(saved,key))
        .map(key => [key,saved[key]]));
    return validateBackupV3({
        format: PLAIN_BACKUP_FORMAT, version: 3, exportedAt, appVersion,
        feeds, folders, posts, subscriptions: source.subscriptions || [],
        settings: sanitizeSettings(source.settings, false, true),
        restoredFlags: {
            read: [...new Set([...(flags.read || []), ...posts.filter(x => x.read).map(x => x.id)])],
            starred: [...new Set([...(flags.starred || []), ...posts.filter(x => x.starred).map(x => x.id)])]
        },
        credentials: { settings: {oauthToken: source.settings?.oauthToken || '',providerToken:source.settings?.providerToken || ''},
            redditOAuth: saved.substreamUserOAuth || null },
        localState, driveSyncWasEnabled: Boolean(saved.rrDriveSettings?.enabled), mediaExcluded: true
    });
}
function validLegacyInterval(value) {
    if (value == null) return null;
    if (value === 0) return 0;
    if (!Number.isFinite(value)) return null;
    return Math.max(5, Math.min(1440, Math.round(value)));
}
export function validateBackupV3(input) {
    if (!obj(input) || input.format !== PLAIN_BACKUP_FORMAT || input.version !== 3)
        throw new Error('Unsupported plaintext backup format');
    // Reuse the strict feed/post/reference validator from earlier releases.
    const base = validateBackupV2({ ...input, format: BACKUP_FORMAT, version: 2 }, true);
    const extra = input.localState ?? {};
    if (!obj(extra)) throw new Error('Invalid local storage bundle');
    const localState = {};
    for (const key of PORTABLE_LOCAL_KEYS) {
        if (!Object.hasOwn(extra, key)) continue;
        const value = extra[key];
        const encoded = JSON.stringify(value);
        if (!encoded || encoded.length > 20_000_000)
            throw new Error('Unsupported or oversized local state: ' + key);
        localState[key] = JSON.parse(encoded);
    }
    return { ...base, format: PLAIN_BACKUP_FORMAT, version: 3,
        localState, mediaExcluded: true,
        privacyWarning: 'Contains unencrypted OAuth tokens, credentials and private reading history. Never share this file.' };
}
export async function readBackup(input) {
    if (!obj(input)) throw new Error('Not a Reddit Reader backup');
    if (input.format === PLAIN_BACKUP_FORMAT) {
        const data = validateBackupV3(input);
        return { data, legacy: null, summary: summarizeBackup(data) };
    }
    if (input.format === BACKUP_FORMAT) {
        const data = validateBackupV2(input);
        return { data, legacy: null, summary: summarizeBackup(data) };
    }
    if (input.format === 'reddit-reader-encrypted-v2')
        throw new Error('Old encrypted backups must be restored using Reddit Reader v1.0.62. New backups use plaintext JSON.');
    return { data: null, legacy: input, summary: summarizeLegacyBackup(input) };
}
