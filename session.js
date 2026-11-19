import { feedUrlPath } from './shared.js';
import { normalizeProviderPost, normalizeRedditPost, ProviderError } from './provider.js';
// Reads visible posts in the browser's existing Reddit login. Never reads cookies.
// The DOM fallback does not bypass blocked requests, login/security challenges or rate limits.
export const canUsePageFallback = (settings, error) => settings.providerMode === 'session' && settings.allowPageFallback && error.status !== 429 && error.status !== 401 && error.retryMs === 0;
const PAGE_LOAD_TIMEOUT = 18000;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitLoaded(tabId) {
    const existing = await chrome.tabs.get(tabId);
    if (existing.status === 'complete')
        return;
    await new Promise((resolve, reject) => {
        let settled = false;
        const done = (error) => { if (settled)
            return; settled = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onChange); chrome.tabs.onRemoved.removeListener(onRemove); error ? reject(error) : resolve(); };
        const onChange = (id, change) => { if (id === tabId && change.status === 'complete')
            done(); };
        const onRemove = (id) => { if (id === tabId)
            done(new Error('Reddit tab was closed')); };
        const timer = setTimeout(() => done(new Error('Reddit page load timed out')), PAGE_LOAD_TIMEOUT);
        chrome.tabs.onUpdated.addListener(onChange);
        chrome.tabs.onRemoved.addListener(onRemove);
        chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete')
            done(); }).catch(() => { });
    });
}
async function scan(tabId, subreddit, type = 'substream-session-scan') {
    try {
        return await chrome.tabs.sendMessage(tabId, { type, subreddit });
    }
    catch (error) {
        throw new ProviderError('Unable to inspect the Reddit tab: ' + String(error.message || error));
    }
}
function isTarget(url, sub) {
    if (!url)
        return false;
    try {
        const u = new URL(url);
        return u.hostname === 'www.reddit.com' && decodeURIComponent(u.pathname).toLowerCase().replace(/\/$/, '') === '/r/' + sub.toLowerCase() + '/new';
    }
    catch {
        return false;
    }
}
export async function fetchSessionPage(feed) {
    const address = `https://www.reddit.com/r/${feedUrlPath(feed.subreddit)}/new/`;
    const tabs = await chrome.tabs.query({ url: 'https://www.reddit.com/*' });
    let tab = tabs.find((t) => isTarget(t.url, feed.subreddit));
    let created = false;
    // A temporary inactive tab is necessary only when no suitable subreddit page is already open.
    if (!tab) {
        tab = await chrome.tabs.create({ url: address, active: false });
        created = true;
    }
    const tabId = tab?.id;
    if (tabId === undefined)
        throw new ProviderError('Could not create or identify a Reddit tab');
    try {
        await waitLoaded(tabId);
        // First retry the JSON feed from a first-party Reddit tab. This preserves the
        // user's existing login context and is less fragile than reading page markup.
        const firstParty = await scan(tabId, feed.subreddit, 'substream-session-json');
        if (firstParty?.ok && Array.isArray(firstParty.posts)) {
            const now = Date.now();
            const posts = firstParty.posts.slice(0, 60).map((raw) => normalizeRedditPost(raw, feed.subreddit, now)).filter((p) => !!p);
            return { posts, status: 200, retryMs: 0, etag: '', modified: '', remaining: null, resetMs: 0, notModified: false };
        }
        if (firstParty?.challenge || firstParty?.status === 429 || firstParty?.status === 401) {
            throw new ProviderError(firstParty.error || 'Reddit denied first-party JSON access', firstParty.status || 403, firstParty.status === 429 ? Math.max(900000, (Number(firstParty.retryAfter) || 0) * 1000) : 43200000);
        }
        let response;
        for (let attempt = 0; attempt < 4; attempt++) {
            if (attempt)
                await sleep(1100);
            response = await scan(tabId, feed.subreddit);
            if (response?.blocked)
                throw new ProviderError(response.reason || 'Reddit requested a security check', 403, 43200000);
            if (response?.ok && Array.isArray(response.posts) && response.posts.length)
                break;
            if (!response?.ok)
                throw new ProviderError(response?.error || 'Reddit page scan failed');
        }
        if (!response?.posts?.length)
            throw new ProviderError('No recognizable Reddit posts were rendered. Try visiting Reddit manually, ensure you are logged in, and refresh.', 422);
        const now = Date.now(), posts = [];
        for (const raw of response.posts.slice(0, 60)) {
            const p = normalizeProviderPost(raw, feed.subreddit, now);
            if (p && feed.subreddit.toLowerCase().split('+').includes(p.subreddit.toLowerCase()))
                posts.push(p);
        }
        if (!posts.length)
            throw new ProviderError('No valid post data could be extracted from the rendered page', 422);
        return { posts, status: 200, retryMs: 0, etag: '', modified: '', remaining: null, resetMs: 0, notModified: false };
    }
    finally {
        if (created)
            try {
                await chrome.tabs.remove(tabId);
            }
            catch { /* tab already closed */ }
    }
}
/** Checks whether the browser is authenticated without ever reading cookies. */
export async function checkRedditSession() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch('https://www.reddit.com/api/me.json?raw_json=1', {
            method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal
        });
        if (response.status === 401)
            return { loggedIn: false, username: '', message: 'Not signed in. Log in on reddit.com in this Chrome profile.' };
        if (!response.ok)
            return { loggedIn: false, username: '', message: `Session could not be verified (HTTP ${response.status}). Chrome may still display Reddit normally.` };
        const body = await response.text();
        if (body.length > 200000)
            return { loggedIn: false, username: '', message: 'Unrecognized session response' };
        const data = JSON.parse(body);
        const username = String(data?.data?.name || data?.name || '');
        if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username))
            return { loggedIn: false, username: '', message: 'No verified Reddit account found. Open reddit.com and sign in.' };
        return { loggedIn: true, username, message: 'Signed in as u/' + username };
    }
    catch {
        return { loggedIn: false, username: '', message: 'Could not verify Reddit session; check reddit.com manually.' };
    }
    finally {
        clearTimeout(timer);
    }
}
