import { feedUrlPath, searchFeedDetails, searchEndpoint, iconFromCommunityMeta, iconsFromPostListing, postToReddit } from './shared.js';
import { parseRedditRateLimit } from './reddit-rate.js';
export class ProviderError extends Error {
    status;
    retryMs;
    rateLimit;
    constructor(message, status = 0, retryMs = 0, rateLimit = null) {
        super(message);
        this.status = status;
        this.retryMs = retryMs;
        this.rateLimit = rateLimit;
    }
}
function validHttpsUrl(value) { if (typeof value !== 'string')
    return ''; try {
    const url = new URL(value, 'https://www.reddit.com');
    return url.protocol === 'https:' ? url.href : '';
}
catch {
    return '';
} }
function safeMediaUrl(value) { if (typeof value !== 'string')
    return ''; const raw = value.replace(/&amp;/g, '&'); return /^https:\/\//i.test(raw) ? validHttpsUrl(raw) : ''; }
function safePostUrl(value, subreddit) {
    if (typeof value === 'string') {
        if (value.startsWith('/r/') || value.startsWith('/comments/'))
            return 'https://www.reddit.com' + value;
        const full = validHttpsUrl(value);
        if (full)
            return full;
    }
    return 'https://www.reddit.com/r/' + encodeURIComponent(subreddit) + '/';
}
function safeText(raw, max) { return String(raw ?? '').slice(0, max); }
/** Return only genuine image URLs, never a Reddit gallery/permalink or other page.
 * Handles the HTML-encoded URLs found in Reddit's preview and media metadata. */
function redditImageUrl(value, depth = 0) {
    if (depth > 2) return '';
    const url = safeMediaUrl(value);
    if (!url) return '';
    try {
        const parsed = new URL(url);
        // Reddit sometimes supplies a /media?url=... wrapper around the image.
        if (['www.reddit.com', 'reddit.com', 'old.reddit.com'].includes(parsed.hostname) &&
            parsed.pathname === '/media') return redditImageUrl(parsed.searchParams.get('url'), depth + 1);
        if (/\.(?:jpe?g|png|webp|gif|avif|bmp)(?:$)/i.test(parsed.pathname)) return url;
        // Images can also be served through Reddit's CDN using extensionless IDs.
        if (['i.redd.it', 'preview.redd.it', 'external-preview.redd.it'].includes(parsed.hostname) &&
            parsed.pathname.length > 2) return url;
    } catch { /* Ignore invalid external media URLs. */ }
    return '';
}
function mediaMetadataImage(media) {
    if (!media || typeof media !== 'object') return '';
    if (media.e && !['Image', 'AnimatedImage'].includes(media.e)) return '';
    // The source image is preferable to small preview resolutions.
    const source = [media.s?.u, media.s?.gif];
    const previews = Array.isArray(media.p) ? [...media.p].reverse().map(x => x?.u) : [];
    return [...source, ...previews].map(redditImageUrl).find(Boolean) || '';
}
/** Extract the highest quality media the Reddit listing actually supplies.
 * Handles galleries, rich-text inline images, preview-only posts and crossposts.
 * Never fabricate an i.redd.it file URL from an image ID or a permalink. */
export function extractRedditMedia(raw) {
    const p = raw?.data || raw || {};
    const parent = p.crosspost_parent_list?.[0];
    const fromOne = (item) => {
        if (!item || typeof item !== 'object') return { images: [], video: '', thumbnail: '' };
        const meta = item.media_metadata && typeof item.media_metadata === 'object' ? item.media_metadata : {};
        const gallery = Array.isArray(item.gallery_data?.items) ? item.gallery_data.items.slice(0, 30) : [];
        const mediaImages = [];
        const push = (src) => {
            const image = redditImageUrl(src);
            if (image && !mediaImages.includes(image) && mediaImages.length < 30) mediaImages.push(image);
        };
        // Reddit gallery_data specifies the order. Other media_metadata may
        // contain inline images even when gallery_data is absent.
        if (gallery.length) {
            for (const entry of gallery) push(mediaMetadataImage(meta[entry?.media_id]));
        } else {
            for (const itemMeta of Object.values(meta).slice(0, 30)) push(mediaMetadataImage(itemMeta));
        }
        const direct = redditImageUrl(item.url_overridden_by_dest) || redditImageUrl(item.url);
        const previewImages = Array.isArray(item.preview?.images) ? item.preview.images : [];
        const previews = previewImages.map(x => redditImageUrl(x?.source?.url) ||
            (Array.isArray(x?.resolutions) ? [...x.resolutions].reverse().map(r => redditImageUrl(r?.url)).find(Boolean) : '')).filter(Boolean);
        if (!gallery.length && direct) {
            // A self-post may contain inline media, but an ordinary image link
            // should show its original image rather than a preview thumbnail.
            if (!mediaImages.length) mediaImages.push(direct);
            else if (!mediaImages.includes(direct)) mediaImages.unshift(direct);
        }
        if (!mediaImages.length) previews.slice(0, 30).forEach(push);
        const thumbnail = redditImageUrl(item.thumbnail) || previews[0] || mediaImages[0] || '';
        const video = safeMediaUrl(item.secure_media?.reddit_video?.fallback_url) ||
            safeMediaUrl(item.media?.reddit_video?.fallback_url) ||
            safeMediaUrl(item.preview?.reddit_video_preview?.fallback_url) || '';
        return { images: mediaImages, thumbnail, video, structured: gallery.length > 0 || Object.keys(meta).length > 0 || !!direct };
    };
    const own = fromOne(p);
    const source = fromOne(parent);
    // Crosspost listings often have only a preview, whereas the source record
    // contains an ordered gallery or full-resolution image.
    const preferParent = parent && source.images.length && (!own.structured ||
        (source.images.length > own.images.length && !redditImageUrl(p.url_overridden_by_dest)));
    const selected = preferParent ? source : own;
    return {
        images: selected.images.length ? selected.images : source.images,
        thumbnail: own.thumbnail || source.thumbnail,
        video: own.video || source.video
    };
}
export function normalizeRedditPost(raw, subreddit, now = Date.now()) {
    const p = raw?.data || raw;
    if (!p || typeof p !== 'object' || !p.id || typeof p.title !== 'string')
        return null;
    const id = String(p.name || 't3_' + p.id).slice(0, 120);
    const sr = safeText(p.subreddit || subreddit, 80);
    const permalink = safePostUrl(p.permalink || p.url, sr);
    const { images, thumbnail, video } = extractRedditMedia(p);
    const created = Number(p.created_utc || 0) * 1000;
    const score = Number(p.score);
    const upRatio = Number(p.upvote_ratio);
    const comments = Number(p.num_comments);
    return { id, title: safeText(p.title, 1200), subreddit: sr, author: safeText(p.author || '[deleted]', 90), url: safePostUrl(p.url || permalink, sr), permalink, createdAt: Number.isFinite(created) && created > 0 ? created : now, firstSeen: now,
        score: Number.isFinite(score) ? score : null, upvoteRatio: Number.isFinite(upRatio) ? upRatio : null, comments: Number.isFinite(comments) ? comments : null,
        text: safeText(p.selftext || '', 16000), thumbnail, images, video, flair: safeText(p.link_flair_text || '', 120), nsfw: !!p.over_18, spoiler: !!p.spoiler, sticky: !!p.stickied, domain: safeText(p.domain || '', 128), read: false, starred: false };
}

export function normalizeProviderPost(raw, subreddit, now = Date.now()) {
    if (!raw || typeof raw !== 'object')
        return null;
    if (raw.data?.id && raw.data?.title)
        return normalizeRedditPost(raw, subreddit, now);
    if (!raw.id || typeof raw.title !== 'string')
        return null;
    const created = typeof raw.createdAt === 'number' ? raw.createdAt : /^\d{10,13}$/.test(String(raw.createdAt || '')) ? Number(raw.createdAt) * (String(raw.createdAt).length === 10 ? 1000 : 1) : Date.parse(raw.createdAt || raw.published || '');
    const sr = safeText(raw.subreddit || subreddit, 80);
    const permalink = safePostUrl(raw.permalink || raw.url, sr);
    const images = Array.isArray(raw.images) ? raw.images.slice(0, 30).map(safeMediaUrl).filter(Boolean) : [];
    const score = raw.score == null ? null : Number(raw.score), comments = raw.comments == null ? null : Number(raw.comments), ratio = raw.upvoteRatio == null ? null : Number(raw.upvoteRatio);
    return { id: safeText(raw.id, 120), title: safeText(raw.title, 1200), subreddit: sr, author: safeText(raw.author || '', 90), url: safePostUrl(raw.url || permalink, sr), permalink,
        createdAt: Number.isFinite(created) ? created : now, firstSeen: now, score: Number.isFinite(score) ? score : null, upvoteRatio: Number.isFinite(ratio) ? ratio : null, comments: Number.isFinite(comments) ? comments : null,
        text: safeText(raw.text || raw.snippet || '', 16000), thumbnail: safeMediaUrl(raw.thumbnail) || images[0] || '', images, video: safeMediaUrl(raw.video), flair: safeText(raw.flair || '', 120), nsfw: !!raw.nsfw, spoiler: !!raw.spoiler, sticky: !!raw.sticky, domain: safeText(raw.domain || '', 128), read: false, starred: false };
}
function retryAfterMs(value) { if (!value)
    return 0; const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, 86400000); const date = Date.parse(value); return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 86400000) : 0; }
export function providerReady(settings) {
    if (settings.providerMode === 'session')
        return { ready: true, message: 'Browser-session mode selected; Reddit sign-in not yet verified' };
    if (settings.providerMode === 'none')
        return { ready: false, message: 'No provider configured. Choose the browser session, OAuth, or a licensed provider in Settings.' };
    if (settings.providerMode === 'oauth')
        return (settings.oauthConfigured || settings.oauthToken.trim()) ? { ready: true, message: 'User-owned Reddit OAuth authorization configured' } : { ready: false, message: 'Connect your own approved Reddit installed app using an authorization code in Settings.' };
    try {
        const template = settings.endpointTemplate;
        const x = new URL(template.replaceAll('{{subreddit}}', 'test'));
        if (x.protocol !== 'https:' || !template.includes('{{subreddit}}') || x.username || x.password)
            throw Error();
        return { ready: true, message: 'Custom provider configured' };
    }
    catch {
        return { ready: false, message: 'Custom provider URL must be HTTPS and contain {{subreddit}}.' };
    }
}
/** Fetch up to 25 subreddit artwork URLs using one authorized Reddit metadata request. */
export async function fetchSubredditIcons(feeds, settings, oauthToken = '') {
    if (settings.providerMode !== 'session' && settings.providerMode !== 'oauth')
        throw new ProviderError('Subreddit icons require a Reddit session or approved OAuth provider');
    const names = [...new Set(feeds.flatMap(f => f.subreddit.toLowerCase().split('+')).slice(0, 25))];
    if (!names.length)
        return { icons: {}, remaining: null, resetMs: 0 };
    const base = settings.providerMode === 'oauth' ? 'https://oauth.reddit.com/api/info' : 'https://www.reddit.com/api/info.json';
    const url = new URL(base);
    url.searchParams.set('sr_name', names.join(','));
    url.searchParams.set('raw_json', '1');
    const headers = { Accept: 'application/json' };
    if (settings.providerMode === 'oauth') {
        const token = oauthToken || settings.oauthToken;
        if (!token)
            throw new ProviderError('OAuth token missing', 401);
        headers.Authorization = 'Bearer ' + token;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
        const response = await fetch(url.href, { method: 'GET', headers, credentials: settings.providerMode === 'session' ? 'include' : 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
        const rateLimit = parseRedditRateLimit(response.headers);
        const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
        const resetMs = response.headers.has('x-ratelimit-reset') && Number.isFinite(resetSeconds) ? Math.max(0, resetSeconds * 1000) : 0;
        if (!response.ok) {
            const wait = retryAfterMs(response.headers.get('retry-after')) || (response.status === 429 ? Math.max(300000, resetMs) : 0);
            throw new ProviderError('Subreddit icon metadata HTTP ' + response.status, response.status, wait, rateLimit);
        }
        const body = await response.text();
        if (body.length > 2000000)
            throw new ProviderError('Metadata response is too large', 413);
        let parsed;
        try {
            parsed = JSON.parse(body);
        }
        catch {
            throw new ProviderError('Invalid subreddit metadata JSON', 422);
        }
        if (!Array.isArray(parsed?.data?.children))
            throw new ProviderError('Unrecognized subreddit metadata listing', 422);
        const icons = {};
        for (const entry of parsed.data.children) {
            if (entry?.kind !== 't5')
                continue;
            const info = entry.data;
            const name = String(info?.display_name || '').toLowerCase();
            if (!names.includes(name))
                continue;
            icons[name] = iconFromCommunityMeta(info);
        }
        const remainingHeader = Number(response.headers.get('x-ratelimit-remaining'));
        return { icons, remaining: response.headers.has('x-ratelimit-remaining') && Number.isFinite(remainingHeader) ? remainingHeader : null, resetMs, rateLimit };
    }
    catch (error) {
        if (error instanceof ProviderError)
            throw error;
        throw new ProviderError('Unable to load subreddit artwork: ' + String(error.message || error));
    }
    finally {
        clearTimeout(timer);
    }
}
export async function fetchFeed(feed, settings, diagnostics, subscriptions = []) {
    const check = providerReady(settings);
    if (!check.ready)
        throw new ProviderError(check.message, 0, 0);
    let endpoint = '';
    let bearer = '';
    if (settings.providerMode === 'session') {
        endpoint = searchFeedDetails(feed.subreddit) ? searchEndpoint(feed, subscriptions, false) : `https://www.reddit.com/r/${feedUrlPath(feed.subreddit)}/new.json?limit=50&raw_json=1&sr_detail=1`;
    }
    else if (settings.providerMode === 'oauth') {
        endpoint = searchFeedDetails(feed.subreddit) ? searchEndpoint(feed, subscriptions, true) : `https://oauth.reddit.com/r/${feedUrlPath(feed.subreddit)}/new?limit=50&raw_json=1&sr_detail=1`;
        bearer = settings.oauthToken.trim();
    }
    else {
        endpoint = settings.endpointTemplate.replaceAll('{{subreddit}}', encodeURIComponent(feed.subreddit));
        bearer = settings.providerToken.trim();
    }
    const headers = { 'Accept': 'application/json' };
    if (bearer)
        headers.Authorization = `Bearer ${bearer}`;
    if (feed.etag)
        headers['If-None-Match'] = feed.etag;
    if (feed.modified)
        headers['If-Modified-Since'] = feed.modified;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);
    let res;
    try {
        res = await fetch(endpoint, { method: 'GET', headers, cache: 'no-store', redirect: 'error', credentials: settings.providerMode === 'session' ? 'include' : 'omit', signal: controller.signal });
    }
    catch (error) {
        throw new ProviderError(error.name === 'AbortError' ? 'Request timed out' : 'Network or host permission error: ' + String(error.message || error));
    }
    finally {
        clearTimeout(timeout);
    }
    const rateLimit = parseRedditRateLimit(res.headers);
    const remainingHeader = Number(res.headers.get('x-ratelimit-remaining'));
    const remaining = Number.isFinite(remainingHeader) && res.headers.has('x-ratelimit-remaining') ? remainingHeader : null;
    const resetSeconds = Number(res.headers.get('x-ratelimit-reset'));
    const resetMs = Number.isFinite(resetSeconds) && res.headers.has('x-ratelimit-reset') ? Math.max(0, resetSeconds * 1000) : 0;
    const etag = res.headers.get('etag') || feed.etag, modified = res.headers.get('last-modified') || feed.modified;
    if (res.status === 304)
        return { posts: [], status: 304, retryMs: 0, etag, modified, remaining, resetMs, rateLimit, notModified: true };
    if (!res.ok) {
        if (settings.providerMode === 'session' && res.status === 403 && res.headers.get('content-type')?.includes('text/html')) {
            try {
                const chunk = await res.body?.getReader().read();
                const sample = new TextDecoder().decode(chunk?.value || new Uint8Array()).slice(0, 18000);
                if (/captcha|challenge|verify.{0,50}human|security check|blocked by reddit|too many requests/i.test(sample))
                    throw new ProviderError('Reddit is showing a security check. Visit Reddit normally; the extension will not bypass it.', 403, 43200000);
            }
            catch (error) {
                if (error instanceof ProviderError)
                    throw error;
            }
        }
        const delay = retryAfterMs(res.headers.get('retry-after')) || ((res.status === 429) ? Math.max(resetMs, 300000) : 0);
        const message = res.status === 401 ? 'Authentication failed or token expired' : res.status === 403 ? 'Provider forbids this request' : res.status === 429 ? 'Rate limited — backing off' : `Provider returned HTTP ${res.status}`;
        throw new ProviderError(message, res.status, delay, rateLimit);
    }
    const length = Number(res.headers.get('content-length') || 0);
    if (length > 3000000)
        throw new ProviderError('Response is too large', 413);
    let payload;
    try {
        const raw = await res.text();
        if (raw.length > 3000000)
            throw new Error('Too large');
        if (settings.providerMode === 'session' && /<html|<!doctype html/i.test(raw.slice(0, 200)) && /captcha|challenge|verify.{0,50}human|security check|blocked by reddit/i.test(raw.slice(0, 30000)))
            throw new ProviderError('Reddit is showing a security check. Visit Reddit normally; no bypass is attempted.', 403, 43200000);
        payload = JSON.parse(raw);
    }
    catch (error) {
        if (error instanceof ProviderError)
            throw error;
        throw new ProviderError('Provider did not return valid, bounded JSON', 422);
    }
    const children = (settings.providerMode === 'oauth' || settings.providerMode === 'session') ? payload?.data?.children : (Array.isArray(payload) ? payload : payload?.posts || payload?.data?.children);
    if (!Array.isArray(children))
        throw new ProviderError('Unrecognized provider response. Expected {"posts":[]} or Reddit listing.', 422);
    const now = Date.now();
    const items = children.slice(0, 100).map((p) => (settings.providerMode === 'oauth' || settings.providerMode === 'session') ? normalizeRedditPost(p, searchFeedDetails(feed.subreddit) ? 'reddit' : feed.subreddit, now) : normalizeProviderPost(p, feed.subreddit, now)).filter((p) => !!p);
    return { posts: items, status: res.status, retryMs: 0, etag, modified, remaining, resetMs, notModified: false, icons: iconsFromPostListing(children), rateLimit };
}
/** Reliable single-community fallback for installations where bulk /api/info is empty. */
export async function fetchSubredditAboutIcon(name, settings, oauthToken = '') {
    if (!/^[a-z0-9_]{2,21}$/i.test(name))
        throw new ProviderError('Invalid subreddit name', 400);
    if (!['session', 'oauth'].includes(settings.providerMode))
        throw new ProviderError('Reddit session or OAuth required for community metadata');
    const oauth = settings.providerMode === 'oauth';
    const token = oauth ? (oauthToken || settings.oauthToken) : '';
    if (oauth && !token)
        throw new ProviderError('OAuth token missing', 401);
    const url = (oauth ? 'https://oauth.reddit.com/r/' : 'https://www.reddit.com/r/') + encodeURIComponent(name) + (oauth ? '/about?raw_json=1' : '/about.json?raw_json=1');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
        const res = await fetch(url, { headers: { Accept: 'application/json', ...(oauth ? { Authorization: 'Bearer ' + token } : {}) }, credentials: oauth ? 'omit' : 'include', cache: 'no-store', redirect: 'error', signal: controller.signal });
        const rateLimit = parseRedditRateLimit(res.headers);
        const remaining = res.headers.has('x-ratelimit-remaining') ? Number(res.headers.get('x-ratelimit-remaining')) : null;
        const resetMs = res.headers.has('x-ratelimit-reset') ? Math.max(0, Number(res.headers.get('x-ratelimit-reset')) * 1000) : 0;
        if (!res.ok)
            throw new ProviderError('Subreddit metadata HTTP ' + res.status, res.status, retryAfterMs(res.headers.get('retry-after')) || (res.status === 429 ? Math.max(300000, resetMs) : 0), rateLimit);
        const text = await res.text();
        if (text.length > 1_000_000)
            throw new ProviderError('Metadata is too large', 413);
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new ProviderError('Invalid community metadata JSON', 422);
        }
        if (parsed?.kind !== 't5' || !parsed?.data)
            throw new ProviderError('No community metadata returned', 422);
        return { icon: iconFromCommunityMeta(parsed.data), remaining: Number.isFinite(remaining) ? remaining : null, resetMs: Number.isFinite(resetMs) ? resetMs : 0, rateLimit };
    }
    catch (err) {
        if (err instanceof ProviderError)
            throw err;
        throw new ProviderError('Unable to retrieve subreddit icon: ' + String(err.message || err));
    }
    finally {
        clearTimeout(timeout);
    }
}
export function parseRedditComments(listing, limit = 30) {
    const results = [];
    const roots = Array.isArray(listing) ? listing[1]?.data?.children : [];
    function walk(nodes, depth, rootId = null) {
        if (!Array.isArray(nodes) || depth > 2)
            return;
        for (const child of nodes) {
            if (results.length >= limit)
                return;
            if (child?.kind !== 't1' || !child.data)
                continue; // Ignore `more` placeholders.
            const value = child.data;
            if (typeof value.id !== 'string' || typeof value.body !== 'string')
                continue;
            const score = Number(value.score), created = Number(value.created_utc) * 1000;
            results.push({ id: value.id.slice(0, 100), author: String(value.author || '[deleted]').slice(0, 80),
                body: value.body.slice(0, 8000), score: Number.isFinite(score) ? score : null,
                createdAt: Number.isFinite(created) && created > 0 ? created : 0, depth, rootId: rootId || value.id.slice(0, 100) });
            walk(value.replies?.data?.children, depth + 1, rootId || value.id.slice(0, 100));
        }
    }
    walk(roots, 0);
    return results;
}
/** Explicit, rate-budgeted user action: retrieve the full Reddit self-text of a cached post. */
export async function fetchRedditPostDetails(post, settings, oauthToken = '') {
    if (!['session', 'oauth'].includes(settings.providerMode))
        throw new ProviderError('Post detail retrieval requires Reddit session or authorized OAuth');
    const match = new URL(postToReddit(post)).pathname.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
    if (!match)
        throw new ProviderError('This post has no supported Reddit comments ID', 400);
    const oauth = settings.providerMode === 'oauth', token = oauth ? (oauthToken || settings.oauthToken) : '';
    if (oauth && !token)
        throw new ProviderError('OAuth token missing', 401);
    const endpoint = (oauth ? 'https://oauth.reddit.com/comments/' : 'https://www.reddit.com/comments/') + encodeURIComponent(match[1]) + (oauth ? '?' : '.json?') + 'raw_json=1&limit=25&depth=2';
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 14000);
    try {
        const res = await fetch(endpoint, { headers: { Accept: 'application/json', ...(oauth ? { Authorization: 'Bearer ' + token } : {}) }, credentials: oauth ? 'omit' : 'include', cache: 'no-store', redirect: 'error', signal: controller.signal });
        const rateLimit = parseRedditRateLimit(res.headers);
        if (!res.ok)
            throw new ProviderError('Post detail HTTP ' + res.status, res.status, retryAfterMs(res.headers.get('retry-after')) || (res.status === 429 ? 300000 : 0), rateLimit);
        const raw = await res.text();
        if (raw.length > 3_000_000)
            throw new ProviderError('Post detail is too large', 413);
        let listing;
        try {
            listing = JSON.parse(raw);
        }
        catch {
            throw new ProviderError('Post detail was not valid JSON', 422);
        }
        const payload = Array.isArray(listing) ? listing[0]?.data?.children?.[0] : listing?.data?.children?.[0];
        const matchPost = normalizeRedditPost(payload, post.subreddit);
        if (!matchPost || matchPost.id !== post.id)
            throw new ProviderError('Reddit did not return this post', 422);
        return { text: matchPost.text, images: matchPost.images, video: matchPost.video, comments: parseRedditComments(listing), rateLimit };
    }
    catch (err) {
        if (err instanceof ProviderError)
            throw err;
        throw new ProviderError('Cannot load additional post content: ' + String(err.message || err));
    }
    finally {
        clearTimeout(timeout);
    }
}
