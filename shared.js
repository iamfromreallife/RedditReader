export const DEFAULTS = { language: 'en', theme: 'system', accent: '#7766f0', density: 'comfortable', hoverZoomEnabled: true, hoverZoomImages: true, hoverZoomVideos: false, hoverZoomDelay: 500, hoverZoomDismissDistance: 200, sidebarCompactness: 50, sidebarFontSize: 12, keepUnreadOnTop: false, autoNextUnreadCategory: true, openReaderOnIconClick: false, readerRailCollapsed: false, readingFont: 'system', readingFontSize: 15, readingLineHeight: 1.65, notificationRules: [], font: 'system', fontSize: 14, lineHeight: 1.48, layout: 'magazine', sidebarWidth: 242, threePaneListWidth: 390, readerWidth: 1040, fullPopupWidthPct: 60, fullPopupHeightPct: 80, showThumbs: true, showSnippets: true, hideRead: false, markReadOnOpen: true, sidebarCollapsed: [], sidebarItemBg: '#eaf1ff', sidebarItemText: '#10141c', highlighters: [], popupLimit: 35, popupGrouping: 'feed', popupCollapsed: [], badgeMode: 'unread', badgeColor: '#6253e8', refreshMinutes: 30, keepDays: 30, maxPostsPerFeed: 300, providerMode: 'oauth', allowPageFallback: false, oauthToken: '', oauthConfigured: false, endpointTemplate: '', providerToken: '', notifyNew: false };
/** The settings UI, background message handler and backup validation share
 * one set of user-editable public keys; OAuth/provider credentials are excluded. */
export const UI_SETTINGS_KEYS = Object.freeze(["language", "theme", "accent", "density", "font", "fontSize", "lineHeight", "layout", "sidebarWidth", "readerWidth", "fullPopupWidthPct", "fullPopupHeightPct", "showThumbs", "showSnippets", "hideRead", "markReadOnOpen", "popupLimit", "popupGrouping", "popupCollapsed", "sidebarCollapsed", "badgeMode", "badgeColor", "refreshMinutes", "keepDays", "maxPostsPerFeed", "notifyNew", "sidebarItemBg", "sidebarItemText", "highlighters", "notificationRules", "hoverZoomEnabled", "hoverZoomImages", "hoverZoomVideos", "hoverZoomDelay", "hoverZoomDismissDistance", "sidebarCompactness", "sidebarFontSize", "keepUnreadOnTop", "autoNextUnreadCategory", "openReaderOnIconClick", "readerRailCollapsed", "readingFont", "readingFontSize", "readingLineHeight"]);
export const REFRESH_CHOICES = [0, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
/** The default layout is global, but each subscribed feed can override it.
 * Folder/aggregate sections intentionally continue to use the global layout. */
export function viewForSection(section, feeds, globalLayout) {
    if (!section.startsWith('feed:'))
        return ['list', 'small-list', 'magazine', 'cards', 'three-pane'].includes(globalLayout) ? globalLayout : 'list';
    const saved = feeds.find(f => f.id === section.slice(5))?.viewMode;
    if (saved === 'compact')
        return 'list';
    return saved && ['list', 'small-list', 'magazine', 'cards', 'three-pane'].includes(saved) ? saved : globalLayout === 'compact' ? 'list' : globalLayout;
}
/** Only HTTPS media URLs are eligible for the hover preview and downloads. */
export function safeMediaUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
    }
    catch {
        return '';
    }
}
/** Prefer the unresized Reddit-hosted original rather than a width-limited preview.
 * Some preview URLs do not map to i.redd.it, so keep the supplied URL as a
 * fallback: the media hover controller tries each candidate in order. */
export function fullResolutionMediaCandidates(value) {
    const original = safeMediaUrl(value);
    if (!original)
        return [];
    const url = new URL(original);
    // External-preview URLs may include the original third-party image in `url`.
    // Only a verified HTTPS URL is considered, and we retain the preview fallback.
    if (url.hostname === 'external-preview.redd.it') {
        const external = safeMediaUrl(url.searchParams.get('url') || '');
        if (external && external !== original)
            return [external, original];
    }
    const isRedditImage = /\.(?:jpe?g|png|gif|webp|avif)$/i.test(url.pathname);
    if (!isRedditImage)
        return [original];
    if (url.hostname === 'i.redd.it' && url.search) {
        const direct = new URL(url.href);
        direct.search = '';
        return [direct.href, original].filter((candidate, index, array) => array.indexOf(candidate) === index);
    }
    if (url.hostname === 'preview.redd.it') {
        // Reddit serves many (not all) previews under the same asset name on i.redd.it.
        const direct = new URL(url.href);
        direct.hostname = 'i.redd.it';
        direct.search = '';
        return [direct.href, original].filter((candidate, index, array) => array.indexOf(candidate) === index);
    }
    return [original];
}
/** Return a safe relative filename under Downloads, based on the post title. */
export function mediaDownloadName(title, url, kind = 'image') {
    const safe = title.normalize('NFKC').replace(/[<>:\"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[. ]+/, '').replace(/[. ]+$/, '').slice(0, 70) || 'reddit-media';
    let extension = '';
    try {
        extension = new URL(url).pathname.match(/\.(png|jpe?g|webp|gif|avif|bmp|mp4|webm|mov)$/i)?.[1]?.toLowerCase() || '';
    }
    catch { }
    if (!extension)
        extension = kind === 'video' ? 'mp4' : 'jpg';
    return `Reddit Reader/${safe}.${extension}`;
}
/** Refresh inheritance: individual feed > nearest containing folder > global default.
 * Cyclic or invalid folder references are ignored rather than hanging the scheduler. */
export function effectiveFeedRefreshMinutes(feed, folders, globalMinutes) {
    if (typeof feed.refreshMinutes === 'number')
        return feed.refreshMinutes;
    const byId = new Map(folders.map(f => [f.id, f]));
    const seen = new Set();
    let id = feed.folderId;
    while (id && !seen.has(id) && seen.size < 12) {
        seen.add(id);
        const folder = byId.get(id);
        if (!folder)
            break;
        if (typeof folder.refreshMinutes === 'number')
            return folder.refreshMinutes;
        id = folder.parentId;
    }
    return globalMinutes;
}
/** Valid persisted refresh override; null means inherit and 0 means adaptive. */
export function validRefreshOverride(value) {
    return value === null || value === 0 || (typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 1440);
}
/** Article label palette only. Legacy `sidebarBg/sidebarText` values from v1.0.16
 * are treated as subreddit-label preferences; they must NEVER recolour sidebar rows.
 * A feed override wins, then its nearest folder, then the shared label defaults.
 * Old untouched sidebar defaults are interpreted as "use the accent" for migration.
 */
export function articleLabelPalette(postId, subreddit, selectedSection, feeds, folders, subscriptions, settings) {
    const matchingIds = new Set(subscriptions.filter(s => s.postId === postId).map(s => s.feedId));
    const name = subreddit.toLowerCase();
    const matches = feeds.filter(f => matchingIds.has(f.id) || f.subreddit.toLowerCase().split('+').includes(name));
    const selectedId = selectedSection.startsWith('feed:') ? selectedSection.slice(5) : '';
    const ranked = matches.sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || a.order - b.order);
    const folderById = new Map(folders.map(f => [f.id, f]));
    const withOverride = (selectedId ? ranked.find(f => f.id === selectedId) : undefined) || ranked.find(f => Boolean(f.sidebarBg || f.sidebarText)) || ranked[0];
    let background = withOverride?.sidebarBg || '', text = withOverride?.sidebarText || '';
    let parent = withOverride?.folderId || null;
    const visited = new Set();
    while (parent && !visited.has(parent) && visited.size < 12) {
        visited.add(parent);
        const f = folderById.get(parent);
        if (!f)
            break;
        background ||= f.sidebarBg || '';
        text ||= f.sidebarText || '';
        parent = f.parentId;
    }
    // Preserve explicit custom shared choices, without imposing the old pale-blue sidebar default.
    background ||= settings.sidebarItemBg.toLowerCase() === '#eaf1ff' ? '' : settings.sidebarItemBg;
    text ||= settings.sidebarItemText.toLowerCase() === '#10141c' ? '' : settings.sidebarItemText;
    const safe = (v) => /^#[0-9a-f]{6}$/i.test(v) ? v : '';
    return { background: safe(background), text: safe(text) };
}
/** Percent is based only on completed fetch attempts; 100 requires all planned feeds done. */
export function refreshPercent(p) { return p.total > 0 ? Math.round(100 * Math.min(p.total, Math.max(0, p.completed)) / p.total) : 0; }
/** One canonical unread aggregate is shared by All Posts, Unread, the popup and the badge.
 * A post subscribed to multiple feeds is counted only once globally or per folder.
 */
export function calculateCounts(feeds, folders, posts, subscriptions, lastRun = 0) {
    const unread = posts.filter(p => !p.read), unreadIds = new Set(unread.map(p => p.id));
    const byFeed = {}, byFolder = {};
    const seenByFeed = new Map();
    for (const sub of subscriptions)
        if (unreadIds.has(sub.postId)) {
            let ids = seenByFeed.get(sub.feedId);
            if (!ids)
                seenByFeed.set(sub.feedId, ids = new Set());
            ids.add(sub.postId);
        }
    for (const feed of feeds)
        byFeed[feed.id] = seenByFeed.get(feed.id)?.size || 0;
    const parentById = new Map(folders.map(f => [f.id, f.parentId]));
    const folderSet = new Map();
    for (const feed of feeds) {
        const ids = seenByFeed.get(feed.id);
        if (!ids?.size)
            continue;
        const visited = new Set();
        let folderId = feed.folderId;
        for (let depth = 0; folderId && depth < 12 && !visited.has(folderId); depth++) {
            visited.add(folderId);
            let set = folderSet.get(folderId);
            if (!set)
                folderSet.set(folderId, set = new Set());
            for (const postId of ids)
                set.add(postId);
            folderId = parentById.get(folderId) || null;
        }
    }
    for (const folder of folders)
        byFolder[folder.id] = folderSet.get(folder.id)?.size || 0;
    return { total: posts.length, unread: unread.length, new: lastRun > 0 ? unread.filter(p => p.firstSeen >= lastRun).length : 0, byFeed, byFolder };
}
export function sidebarSiblings(feeds, folders, parentId) {
    const nodes = [
        ...folders.filter(f => f.parentId === parentId).map(f => ({ kind: 'folder', id: f.id, parentId: f.parentId, order: f.order })),
        ...feeds.filter(f => f.folderId === parentId).map(f => ({ kind: 'feed', id: f.id, parentId: f.folderId, order: f.order }))
    ];
    return nodes.sort((a, b) => a.order - b.order || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1));
}
/** Pure tree reordering; throws before any database mutation. Returns only changed records. */
export function planSidebarMove(feeds, folders, source, destination, placement) {
    const nodes = [...folders.map(f => ({ kind: 'folder', id: f.id, parentId: f.parentId, order: f.order })),
        ...feeds.map(f => ({ kind: 'feed', id: f.id, parentId: f.folderId, order: f.order }))];
    const asKey = (n) => n.kind + ':' + n.id;
    const sourceNode = nodes.find(n => asKey(n) === source);
    if (!sourceNode)
        throw new Error('Sidebar item no longer exists');
    let newParent;
    const target = nodes.find(n => asKey(n) === destination);
    if (placement === 'root') {
        newParent = null;
    }
    else {
        if (!target)
            throw new Error('Drop target not found');
        if (asKey(target) === source)
            throw new Error('Cannot move an item onto itself');
        if (placement === 'inside') {
            if (target.kind !== 'folder')
                throw new Error('Only folders can contain items');
            newParent = target.id;
        }
        else
            newParent = target.parentId;
    }
    if (sourceNode.kind === 'folder' && newParent) {
        const byId = new Map(folders.map(f => [f.id, f]));
        let parent = newParent;
        const seen = new Set();
        while (parent) {
            if (parent === sourceNode.id)
                throw new Error('Cannot move a folder into itself or a descendant');
            if (seen.has(parent))
                throw new Error('Circular folder hierarchy');
            seen.add(parent);
            parent = byId.get(parent)?.parentId ?? null;
        }
    }
    const oldParent = sourceNode.parentId;
    const siblings = (parent) => nodes.filter(n => n.parentId === parent && asKey(n) !== source).sort((a, b) => a.order - b.order || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1));
    const dest = siblings(newParent);
    let position = dest.length;
    if (placement === 'before' || placement === 'after') {
        const targetIndex = dest.findIndex(n => asKey(n) === destination);
        if (targetIndex < 0)
            throw new Error('Target is not in the destination folder');
        position = targetIndex + (placement === 'after' ? 1 : 0);
    }
    dest.splice(position, 0, { ...sourceNode, parentId: newParent });
    const resultFolders = folders.map(f => ({ ...f }));
    const resultFeeds = feeds.map(f => ({ ...f }));
    const foldersById = new Map(resultFolders.map(f => [f.id, f]));
    const feedsById = new Map(resultFeeds.map(f => [f.id, f]));
    const renumber = (parent, ordered) => ordered.forEach((node, index) => {
        if (node.kind === 'folder') {
            const f = foldersById.get(node.id);
            f.parentId = parent;
            f.order = index;
        }
        else {
            const f = feedsById.get(node.id);
            f.folderId = parent;
            f.order = index;
        }
    });
    renumber(newParent, dest);
    if (oldParent !== newParent)
        renumber(oldParent, siblings(oldParent));
    return { feeds: resultFeeds.filter(f => { const old = feeds.find(x => x.id === f.id); return old.order !== f.order || old.folderId !== f.folderId; }),
        folders: resultFolders.filter(f => { const old = folders.find(x => x.id === f.id); return old.order !== f.order || old.parentId !== f.parentId; }) };
}
/** Return the next section with unread items in sidebar navigation order.
 * Folder nodes precede their feeds/child folders; wrap when necessary.
 * This is computed from refreshed counts after the marking transaction.
 */
export function nextUnreadSection(current, feeds, folders, counts) {
    const order = [];
    const known = new Set();
    function visit(parent, depth) {
        if (depth > 12)
            return;
        for (const item of sidebarSiblings(feeds, folders, parent)) {
            if (item.kind === 'feed') {
                order.push('feed:' + item.id);
                continue;
            }
            if (known.has(item.id))
                continue;
            known.add(item.id);
            order.push('folder:' + item.id);
            visit(item.id, depth + 1);
        }
    }
    visit(null, 0);
    const currentIndex = order.indexOf(current);
    for (let offset = 1; offset <= order.length; offset++) {
        const candidate = order[(currentIndex + offset + order.length) % order.length];
        if (candidate === current)
            continue;
        const remaining = candidate.startsWith('folder:') ? counts.byFolder[candidate.slice(7)] : counts.byFeed[candidate.slice(5)];
        if ((remaining || 0) > 0)
            return candidate;
    }
    return null;
}
export const EMPTY_DIAG = { requestsToday: 0, requestDay: '', rateReset: 0, lastRun: 0, providerStatus: 'Not configured', lastError: '', iconPauseUntil: 0, iconRequestsToday: 0, requestMinuteBuckets: [], redditRateLimit: null };
export function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
/** User-facing label only: renaming never changes the underlying subscription path. */
export function cleanFeedTitle(value) {
    if (typeof value !== 'string')
        throw new Error('Feed title must be text');
    const title = value.trim().replace(/\s+/g, ' ');
    if (!title)
        throw new Error('Feed title cannot be empty');
    if ([...title].length > 75)
        throw new Error('Feed title cannot exceed 75 characters');
    if (/[\u0000-\u001f\u007f]/.test(title))
        throw new Error('Feed title contains unsupported characters');
    return title;
}
export const SEARCH_SORTS = ['relevance', 'new', 'hot', 'top', 'comments'];
export const SEARCH_SCOPES = ['everywhere', 'subscriptions'];
/** Search scope is part of the canonical ID so the same phrase can be followed twice. */
export function searchFeedKey(query, sort = 'new', scope = 'everywhere') {
    const clean = String(query || '').trim().replace(/\s+/g, ' ');
    if (!clean || clean.length > 180 || /[\x00-\x1f]/.test(clean) || !SEARCH_SORTS.includes(sort) || !SEARCH_SCOPES.includes(scope))
        return null;
    return 'search:' + encodeURIComponent(clean.toLocaleLowerCase('en-US')) + ':' + sort + (scope === 'subscriptions' ? ':subscriptions' : '');
}
export function searchFeedDetails(value) {
    const match = /^search:([^:]+):(relevance|new|hot|top|comments)(:subscriptions)?$/.exec(value);
    if (!match)
        return null;
    try {
        const query = decodeURIComponent(match[1]);
        const scope = match[3] ? 'subscriptions' : 'everywhere';
        return searchFeedKey(query, match[2], scope) === value ? { query, sort: match[2], scope } : null;
    }
    catch {
        return null;
    }
}
export function isSearchFeed(feed) { return !!searchFeedDetails(feed.subreddit); }
/** The subscribed communities are expanded dynamically, including combined feeds. */
export function subscribedCommunityNames(feeds) {
    const names = new Set();
    for (const feed of feeds) {
        if (searchFeedDetails(feed.subreddit))
            continue;
        for (const name of feed.subreddit.split('+'))
            if (validSubreddit(name))
                names.add(name.toLowerCase());
    }
    return [...names].sort();
}
/** The Reddit API supports subreddit-restricted searches, including r/a+b collections.
 * Fail explicitly rather than silently searching only a subset of subscriptions. */
export function searchEndpoint(feed, feeds, oauth) {
    const details = searchFeedDetails(feed.subreddit);
    if (!details)
        throw new Error('Not a search subscription');
    const scope = details.scope;
    let path = oauth ? 'https://oauth.reddit.com/search' : 'https://www.reddit.com/search.json';
    if (scope === 'subscriptions') {
        const communities = subscribedCommunityNames(feeds);
        if (!communities.length)
            throw new Error('Subscribe to at least one subreddit before searching Your subscriptions');
        if (communities.length > 100)
            throw new Error('Your subscriptions search supports up to 100 unique subreddits. Reduce the selection rather than silently omitting results.');
        path = (oauth ? 'https://oauth.reddit.com/r/' : 'https://www.reddit.com/r/') + feedUrlPath(communities.join('+')) + (oauth ? '/search' : '/search.json');
    }
    const url = new URL(path);
    url.searchParams.set('q', feed.searchQuery || details.query);
    url.searchParams.set('sort', feed.searchSort || details.sort);
    url.searchParams.set('type', 'link');
    url.searchParams.set('limit', '50');
    url.searchParams.set('raw_json', '1');
    url.searchParams.set('sr_detail', '1');
    if (scope === 'subscriptions')
        url.searchParams.set('restrict_sr', 'on');
    return url.href;
}
export function feedOpenUrl(feed, feeds = []) {
    const details = searchFeedDetails(feed.subreddit);
    if (details) {
        if (details.scope === 'subscriptions' && feeds.length) {
            try {
                const url = new URL(searchEndpoint(feed, feeds, false));
                url.pathname = url.pathname.replace(/\.json$/, '');
                url.searchParams.delete('limit');
                url.searchParams.delete('raw_json');
                url.searchParams.delete('sr_detail');
                url.searchParams.set('type', 'all');
                return url.href;
            }
            catch { }
        }
        const url = new URL('https://www.reddit.com/search/');
        url.searchParams.set('q', feed.searchQuery || details.query);
        url.searchParams.set('type', 'all');
        url.searchParams.set('sort', feed.searchSort || details.sort);
        if (details.scope === 'subscriptions')
            url.searchParams.set('rr_scope', 'subscriptions'); // Portable OPML round-trip marker, not sent to API.
        return url.href;
    }
    return 'https://www.reddit.com/r/' + feedUrlPath(feed.subreddit) + '/';
}
export function parseSearchUrl(input) {
    try {
        const url = new URL(input);
        if (!['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'oauth.reddit.com'].includes(url.hostname.toLowerCase()) || !/^\/search\/?$/i.test(url.pathname))
            return null;
        const query = (url.searchParams.get('q') || '').trim(), rawSort = url.searchParams.get('sort') || 'new';
        if (!SEARCH_SORTS.includes(rawSort))
            return null;
        const scope = url.searchParams.get('rr_scope') === 'subscriptions' ? 'subscriptions' : 'everywhere';
        const sort = rawSort, key = searchFeedKey(query, sort, scope);
        return key ? { key, query, sort, scope } : null;
    }
    catch {
        return null;
    }
}
export function validSubreddit(input) { return /^[a-zA-Z0-9_]{2,21}$/.test(input) && !/^__/.test(input); }
/** Combined subreddit listing such as science+technology. Canonicalize order for de-duplication. */
export function normalizedFeedPath(value) {
    const search = searchFeedDetails(value);
    if (search)
        return value;
    if (value.startsWith('search:'))
        return null;
    const parts = value.split('+');
    if (parts.length < 1 || parts.length > 100 || parts.some(x => !validSubreddit(x)))
        return null;
    const normalized = [...new Set(parts.map(p => p.toLowerCase()))].sort();
    return normalized.length === parts.length ? normalized.join('+') : null;
}
export function feedUrlPath(value) { return value.split('+').map(encodeURIComponent).join('+'); }
/** Compact display names keep very long combined subscriptions fully backup-safe. */
export function searchFeedTitle(query, sort) { const labels = { new: 'Newest', relevance: 'Relevance', hot: 'Hot', top: 'Top', comments: 'Most comments' }; return ('Search - ' + query + ' - ' + labels[sort]).slice(0, 75); }
export function defaultFeedTitle(subreddit) {
    const search = searchFeedDetails(subreddit);
    if (search)
        return searchFeedTitle(search.query, search.sort);
    const full = 'r/' + subreddit;
    if (full.length <= 75)
        return full;
    const parts = subreddit.split('+');
    return `r/${parts[0]} + ${parts.length - 1} more subreddits`;
}
export function parseSubreddit(input) {
    let s = String(input || '').trim().replace(/^<|>$/g, '');
    if (!s)
        return null;
    const preSearch = searchFeedDetails(s);
    if (preSearch)
        return s;
    if (/^r\//i.test(s))
        s = s.slice(2);
    else if (/^https?:\/\//i.test(s) || /^(www\.)?reddit\.com\//i.test(s)) {
        try {
            const url = new URL(/^https?:/i.test(s) ? s : 'https://' + s);
            if (!['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'oauth.reddit.com'].includes(url.hostname.toLowerCase()))
                return null;
            const search = parseSearchUrl(url.href);
            if (search)
                return search.key;
            const m = url.pathname.match(/^\/r\/([^/]+)(?:\/|$)/i);
            if (!m)
                return null;
            s = m[1];
        }
        catch {
            return null;
        }
    }
    else if (s.includes('/'))
        return null;
    s = s.replace(/\.(?:rss|xml|json)$/i, '').trim();
    try {
        s = decodeURIComponent(s);
    }
    catch {
        return null;
    }
    return normalizedFeedPath(s);
}
export function parseLines(text) {
    const items = [], errors = [];
    const seen = new Set();
    for (const raw of text.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean)) {
        const sub = parseSubreddit(raw);
        if (!sub) {
            errors.push(raw);
            continue;
        }
        if (seen.has(sub))
            continue;
        seen.add(sub);
        items.push({ subreddit: sub, name: parseSearchUrl(raw) ? searchFeedTitle(parseSearchUrl(raw).query, parseSearchUrl(raw).sort) : defaultFeedTitle(sub), folderPath: [], ...(searchFeedDetails(sub) ? { searchQuery: parseSearchUrl(raw)?.query || searchFeedDetails(sub).query, searchSort: searchFeedDetails(sub).sort, searchScope: searchFeedDetails(sub).scope } : {}) });
    }
    return { items, errors };
}
export function parseOPML(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror'))
        throw new Error('Invalid OPML/XML file');
    if (doc.documentElement.tagName.toLowerCase() !== 'opml')
        throw new Error('This is not an OPML file');
    const body = doc.querySelector('body');
    if (!body)
        throw new Error('OPML document has no body');
    const items = [], errors = [];
    const seen = new Set();
    function walk(node, path, depth) {
        if (depth > 12)
            return;
        const children = [...node.children].filter(e => e.tagName.toLowerCase() === 'outline');
        for (const child of children) {
            const label = (child.getAttribute('title') || child.getAttribute('text') || 'Folder').trim();
            const url = child.getAttribute('xmlUrl') || child.getAttribute('htmlUrl') || child.getAttribute('url') || '';
            if (url) {
                const sub = parseSubreddit(url);
                if (sub) {
                    if (!seen.has(sub)) {
                        seen.add(sub);
                        items.push({ subreddit: sub, name: parseSearchUrl(url) ? searchFeedTitle(parseSearchUrl(url).query, parseSearchUrl(url).sort) : defaultFeedTitle(sub), folderPath: path, ...(searchFeedDetails(sub) ? { searchQuery: parseSearchUrl(url)?.query || searchFeedDetails(sub).query, searchSort: searchFeedDetails(sub).sort, searchScope: searchFeedDetails(sub).scope } : {}) });
                    }
                }
                else
                    errors.push(url);
            }
            else if ([...child.children].some(e => e.tagName.toLowerCase() === 'outline'))
                walk(child, [...path, label], depth + 1);
            else {
                const sub = parseSubreddit(label);
                if (sub && !seen.has(sub)) {
                    seen.add(sub);
                    items.push({ subreddit: sub, name: parseSearchUrl(url) ? searchFeedTitle(parseSearchUrl(url).query, parseSearchUrl(url).sort) : defaultFeedTitle(sub), folderPath: path, ...(searchFeedDetails(sub) ? { searchQuery: parseSearchUrl(url)?.query || searchFeedDetails(sub).query, searchSort: searchFeedDetails(sub).sort, searchScope: searchFeedDetails(sub).scope } : {}) });
                }
            }
        }
    }
    walk(body, [], 0);
    return { items, errors };
}
/** Only permit subreddit artwork hosted by Reddit's image CDN. */
export function subredditIconUrl(value) {
    if (typeof value !== 'string' || value.length > 2048)
        return '';
    try {
        const url = new URL(value.replace(/&amp;/gi, '&'));
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || url.username || url.password || !['redditmedia.com', 'redditstatic.com'].some(d => host === d || host.endsWith('.' + d)))
            return '';
        return url.href;
    }
    catch {
        return '';
    }
}
/** Reddit may expose the community image through several metadata fields. */
export function iconFromCommunityMeta(info) {
    if (!info || typeof info !== 'object')
        return '';
    const obj = info;
    return subredditIconUrl(obj.community_icon) || subredditIconUrl(obj.communityIcon) || subredditIconUrl(obj.icon_img) || subredditIconUrl(obj.iconImg) || '';
}
/** `sr_detail=1` includes per-post subreddit metadata without additional API calls. */
export function iconsFromPostListing(children) {
    const found = {};
    if (!Array.isArray(children))
        return found;
    for (const entry of children.slice(0, 100)) {
        const p = entry?.data || entry;
        const name = String(p?.subreddit || '').trim().toLowerCase();
        if (!/^[a-z0-9_]{2,21}$/.test(name))
            continue;
        const url = iconFromCommunityMeta(p?.sr_detail) || iconFromCommunityMeta(p?.subreddit_detail) || iconFromCommunityMeta(p);
        if (url)
            found[name] = url;
    }
    return found;
}
/** The physical left Shift key is required; never consume keystrokes in editors. */
export function markAllReadShortcut(event, leftShiftHeld, isEditing = false) {
    return event.code === 'KeyA' && leftShiftHeld && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !isEditing;
}
export function dateLabel(timestamp) { const d = Date.now() - timestamp; if (d < 60000)
    return 'now'; if (d < 3600000)
    return Math.floor(d / 60000) + 'm'; if (d < 86400000)
    return Math.floor(d / 3600000) + 'h'; if (d < 604800000)
    return Math.floor(d / 86400000) + 'd'; return new Date(timestamp).toLocaleDateString(); }
export function numberLabel(value) { if (value == null)
    return '—'; if (Math.abs(value) >= 1e6)
    return (value / 1e6).toFixed(1) + 'm'; if (Math.abs(value) >= 1e3)
    return (value / 1e3).toFixed(1) + 'k'; return String(value); }
export function makeId() { return crypto.randomUUID(); }
export function icon(name, size = 18) {
    const paths = {
        'home': '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
        'rss': '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
        'menu': '<path d="M4 6h16M4 12h16M4 18h16"/>', 'settings': '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M10.3 2.5h3.4l.5 2a8 8 0 0 1 1.7.7l1.8-1 2.4 2.4-1 1.8c.3.5.5 1.1.7 1.7l2 .5v3.4l-2 .5a8 8 0 0 1-.7 1.7l1 1.8-2.4 2.4-1.8-1a8 8 0 0 1-1.7.7l-.5 2h-3.4l-.5-2a8 8 0 0 1-1.7-.7l-1.8 1-2.4-2.4 1-1.8a8 8 0 0 1-.7-1.7l-2-.5v-3.4l2-.5a8 8 0 0 1 .7-1.7l-1-1.8 2.4-2.4 1.8 1a8 8 0 0 1 1.7-.7z"/>',
        'refresh': '<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>', 'plus': '<path d="M12 5v14M5 12h14"/>', 'search': '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
        'check': '<path d="m4 12 5 5L20 6"/>', 'unread': '<circle cx="12" cy="12" r="8"/>', 'star': '<path d="m12 3 2.8 6 6.7.9-4.8 4.7 1.1 6.7-5.8-3.1-5.8 3.1 1.1-6.7-4.8-4.7 6.7-.9z"/>',
        'folder': '<path d="M3 6h7l2 2h9v12H3z"/>', 'list': '<path d="M9 6h12M9 12h12M9 18h12M3 6h2M3 12h2M3 18h2"/>', 'grid': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
        'three-pane': '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 4v16M14 4v16"/>', 'magazine': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M10 3v18M13 8h5M13 12h5M13 16h5"/>', 'compact': '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>', 'external': '<path d="M13 5h6v6M11 13l8-8M19 13v6H5V5h6"/>',
        'highlighter': '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-6-6a2.4 2.4 0 0 0-3.4 0L7 11.6a2.4 2.4 0 0 0 0 3.4l4 4a2.4 2.4 0 0 0 3.4 0l7.6-7Z"/>',
        'expand-vertical': '<path d="M12 3v6m-3-3 3-3 3 3M12 21v-6m-3 3 3 3 3-3M5 11h14M5 13h14"/>',
        'chevron': '<path d="m9 18 6-6-6-6"/>', 'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 'comment': '<path d="M20 16a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z"/>',
        'arrow': '<path d="M5 12h14m-6-6 6 6-6 6"/>', 'upload': '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>', 'download': '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
        'edit': '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4 10.5-10.5Z"/>', 'trash': '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>', 'image': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 6-6 5 5 3-3 4 4"/>',
        'warning': '<path d="M12 3 2 21h20zM12 9v5m0 3v1"/>', 'close': '<path d="M5 5l14 14M19 5 5 19"/>', 'moon': '<path d="M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10"/>',
        'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/>',
        'link': '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/>',
        'help': '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 1 1 4.2 1.8c-1.2 1-1.9 1.5-1.9 3.2m0 3v.2"/>',
        'copy': '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
        'x': '<path d="M5 5l14 14M19 5 5 19"/>',
        'more': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
    };
    return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.rss}</svg>`;
}
export async function send(type, payload = {}) { const r = await chrome.runtime.sendMessage({ type, ...payload }); if (!r?.ok)
    throw new Error(r?.error || 'Extension request failed'); return r.result; }
export function postToReddit(post) { return /^https:\/\/(www\.)?reddit\.com\//.test(post.permalink) ? post.permalink : 'https://www.reddit.com' + (post.permalink.startsWith('/') ? post.permalink : '/r/' + post.subreddit + '/'); }
export function publicSettings(s) { return { ...s, oauthToken: '', providerToken: '' }; }
/** A determinate indicator: the worker reports completed feed attempts, not elapsed time. */
export function refreshBarHtml(scope) {
    return `<div class="refresh-progress ${scope}-refresh" hidden role="status" aria-live="polite"><div class="refresh-progress-label"></div><div class="refresh-progress-track" role="progressbar" aria-label="Feed refresh progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="refresh-progress-fill"></div></div></div>`;
}
export function applyRefreshProgress(root, progress) {
    const bar = root.querySelector('.refresh-progress');
    if (!bar)
        return;
    bar.hidden = !progress.active || progress.total === 0;
    if (bar.hidden)
        return;
    const percent = refreshPercent(progress);
    const track = bar.querySelector('[role="progressbar"]');
    if (track)
        track.setAttribute('aria-valuenow', String(percent));
    const fill = bar.querySelector('.refresh-progress-fill');
    if (fill)
        fill.style.width = percent + '%';
    const label = bar.querySelector('.refresh-progress-label');
    if (label)
        label.textContent = `${document.documentElement.lang?.toLowerCase().startsWith('pt') ? 'A atualizar feeds' : 'Updating feeds'} ${progress.completed}/${progress.total}${progress.current ? ' · ' + progress.current : ''}${progress.added ? ' · ' + progress.added + (document.documentElement.lang?.toLowerCase().startsWith('pt') ? ' novas' : ' new') : ''}`;
}
