"use strict";
/* Isolated content script. Runs only on www.reddit.com.
 * Does not access, copy, read or transmit cookies, CSRF tokens or page globals.
 * Only public post fields visible to the signed-in browser session are returned.
 */
(() => {
    const allowed = /^[a-z0-9_]{2,21}$/i;
    const validFeed = (s) => s.split('+').length <= 20 && s.split('+').every(v => allowed.test(v));
    function clean(s, length = 1200) { return String(s ?? '').trim().slice(0, length); }
    function safeUrl(url) { if (!url)
        return ''; try {
        const u = new URL(String(url), location.origin);
        return u.protocol === 'https:' ? u.href : '';
    }
    catch {
        return '';
    } }
    function count(value) {
        let text = clean(value, 100).replace(/,/g, '').toLowerCase();
        const match = text.match(/(-?\d+(?:\.\d+)?)\s*([kmb])?/);
        if (!match)
            return null;
        const n = Number(match[1]);
        return Number.isFinite(n) ? Math.round(n * ({ k: 1e3, m: 1e6, b: 1e9 }[match[2]] || 1)) : null;
    }
    function get(el, ...attrs) { for (const attr of attrs) {
        const x = el.getAttribute(attr);
        if (x)
            return x;
    } return ''; }
    function text(el, selectors) { return clean(el.querySelector(selectors)?.textContent); }
    function scrape(subreddit) {
        if (location.hostname !== 'www.reddit.com')
            return { posts: [], blocked: true, reason: 'Unsupported host' };
        const body = document.body?.innerText?.slice(0, 5000) || '';
        if (/verify (?:that )?you (?:are|’re|\'re) (?:a human|not a robot)|security check|complete the captcha|unusual traffic|access denied|you have been blocked/i.test((document.title || '') + ' ' + body))
            return { posts: [], blocked: true, reason: 'Reddit requires a login/security check. Open Reddit manually; no bypass is attempted.' };
        const nodes = [...document.querySelectorAll('shreddit-post, article[data-post-id],article[data-testid="post-container"],article[id^="t3_"]')].slice(0, 100);
        const seen = new Set();
        const posts = [];
        for (const node of nodes) {
            const permalinkNode = node.querySelector('a[slot="full-post-link"],a[slot="title"],a[href*="/comments/"]');
            const permalink = safeUrl(get(node, 'permalink') || permalinkNode?.getAttribute('href'));
            const match = permalink.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
            const id = clean(get(node, 'post-id', 'data-post-id', 'id') || match?.[1], 120).replace(/^t3_/i, '');
            if (!id || !/[a-z0-9]/i.test(id) || seen.has(id) || !permalink.includes('/comments/'))
                continue;
            const postTitle = clean(get(node, 'post-title', 'data-title') || text(node, 'h3, [slot="title"], a[slot="title"], [data-testid="post-title"]'));
            if (!postTitle)
                continue;
            const declaredSub = clean(get(node, 'subreddit-prefixed-name', 'data-subreddit') || subreddit, 80).replace(/^r\//i, '');
            const sr = allowed.test(declaredSub) ? declaredSub.toLowerCase() : subreddit.split('+')[0];
            if (!subreddit.toLowerCase().split('+').includes(sr.toLowerCase()))
                continue;
            seen.add(id);
            const media = [];
            const galleryImg = node.querySelectorAll('img[src*="i.redd.it"],img[src*="preview.redd.it"],img[slot*="post-media"],img[data-testid="post-image"]');
            for (const image of [...galleryImg].slice(0, 12)) {
                const url = safeUrl(image.getAttribute('src') || image.getAttribute('data-src'));
                if (url && !media.includes(url))
                    media.push(url);
            }
            const mediaAnchor = node.querySelector('a[href*="i.redd.it/"],a[href*="preview.redd.it/"]');
            const altUrl = safeUrl(mediaAnchor?.getAttribute('href'));
            if (altUrl && media.length === 0)
                media.push(altUrl);
            const video = node.querySelector('video');
            const datetime = get(node, 'created-timestamp') || get(node.querySelector('time') || node, 'datetime');
            const scoreText = get(node, 'score') || text(node, '[data-testid="vote-arrows"] faceplate-number, [data-testid="vote-arrows"], [slot="vote-button"] faceplate-number, [aria-label*="upvote"]');
            const commentsText = get(node, 'comment-count') || text(node, '[data-testid="comment-count"],a[slot="comments-button"],a[href*="/comments/"] faceplate-number');
            const bodyText = text(node, '[slot="text-body"], [data-testid="post-content"], div[slot="text-body"]');
            posts.push({ id: 't3_' + id, title: postTitle, subreddit: sr, author: clean(get(node, 'author') || text(node, 'a[href^="/user/"]'), 90).replace(/^u\//, ''),
                permalink, url: safeUrl(get(node, 'content-href') || mediaAnchor?.getAttribute('href')) || permalink,
                createdAt: datetime || Date.now(), score: count(scoreText), comments: count(commentsText), text: bodyText.slice(0, 16000), thumbnail: media[0] || '', images: media,
                video: safeUrl(video?.currentSrc || video?.getAttribute('src') || video?.querySelector('source')?.getAttribute('src')),
                flair: clean(text(node, '[slot="post-flair"]'), 120), nsfw: get(node, 'nsfw') === 'true' || node.hasAttribute('nsfw'), spoiler: node.hasAttribute('spoiler'), sticky: node.hasAttribute('stickied') });
        }
        return { posts, blocked: false, reason: posts.length ? `Extracted ${posts.length} visible posts` : 'No recognized post cards found on the current Reddit page' };
    }
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!['substream-session-scan', 'substream-session-json'].includes(message?.type))
            return false;
        const sub = String(message.subreddit || '');
        if (!validFeed(sub)) {
            sendResponse({ ok: false, error: 'Invalid subreddit or combined feed' });
            return false;
        }
        if (message.type === 'substream-session-scan') {
            try {
                sendResponse({ ok: true, ...scrape(sub) });
            }
            catch (e) {
                sendResponse({ ok: false, error: String(e) });
            }
            return false;
        }
        // Same-origin JSON request from the existing Reddit browser context. No cookies are
        // inspected or exported; the browser attaches them automatically when permitted.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        fetch(`/r/${sub.split('+').map(encodeURIComponent).join('+')}/new.json?limit=50&raw_json=1`, { credentials: 'include', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal })
            .then(async (response) => {
            if (!response.ok) {
                sendResponse({ ok: false, status: response.status, retryAfter: response.headers.get('retry-after') || '', error: 'Reddit returned HTTP ' + response.status });
                return;
            }
            const length = Number(response.headers.get('content-length') || 0);
            if (length > 2500000) {
                sendResponse({ ok: false, status: 413, error: 'JSON listing too large' });
                return;
            }
            const raw = await response.text();
            if (raw.length > 2500000) {
                sendResponse({ ok: false, status: 413, error: 'JSON listing too large' });
                return;
            }
            if (/captcha|challenge|verify.{0,50}human|security check/i.test(raw.slice(0, 400))) {
                sendResponse({ ok: false, status: 403, challenge: true, error: 'Reddit requested a security check' });
                return;
            }
            const json = JSON.parse(raw);
            const children = json?.data?.children;
            if (!Array.isArray(children)) {
                sendResponse({ ok: false, status: 422, error: 'Unrecognized JSON listing' });
                return;
            }
            sendResponse({ ok: true, posts: children.slice(0, 60) });
        }).catch(error => sendResponse({ ok: false, status: 0, error: String(error?.message || error) }))
            .finally(() => clearTimeout(timeout));
        return true;
    });
})();
