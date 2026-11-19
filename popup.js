import { applyHighlighters } from './highlighters.js';
import { installRestoreRecoveryIndicator } from './restore-recovery-ui.js';
import { installLocalization, setLanguage, translate } from './locale.js';
import { send, icon, escapeHtml as e, dateLabel, numberLabel, postToReddit, sidebarSiblings, subredditIconUrl, refreshBarHtml, applyRefreshProgress, articleLabelPalette } from './shared.js';
const app = document.querySelector('#app');
let state;
let liveProgress = { active: false, total: 0, completed: 0, checked: 0, added: 0, current: '' };
let lastReportedRefreshFinish = 0;
function showRefreshError(message) {
    let el = document.querySelector('.popup-refresh-feedback');
    if (!el) { el = document.createElement('div'); el.className = 'popup-refresh-feedback'; el.setAttribute('role', 'status'); document.body.append(el); }
    el.textContent = message;
    clearTimeout(showRefreshError.timer);
    showRefreshError.timer = setTimeout(() => el?.remove(), 6000);
}
function updateProgressBar() {
    applyRefreshProgress(document, liveProgress);
    const button = document.querySelector('.popup-head [data-act="refresh"]');
    if (button) { const active = Boolean(liveProgress.active && liveProgress.total > 0); button.classList.toggle('is-refreshing', active); button.setAttribute('aria-busy', String(active)); button.disabled = active; }
    const finished = liveProgress.lastResult;
    if (finished?.finishedAt > lastReportedRefreshFinish) {
        lastReportedRefreshFinish = finished.finishedAt;
        if (finished.reason && finished.reason !== 'OK') showRefreshError(finished.reason);
    }
}
function apply() { setLanguage(state.settings.language); const s = state.settings; document.body.dataset.theme = s.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : s.theme; document.body.dataset.density = s.density || 'comfortable'; document.body.dataset.font = s.font; document.body.style.setProperty('--accent', s.accent); document.body.style.setProperty('--user-font', s.fontSize + 'px'); }
function communityIcon(name) {
    const sub = name.toLowerCase(), feed = state.feeds.find(f => f.subreddit.toLowerCase().split('+')[0] === sub);
    const url = subredditIconUrl(state.communityIcons?.[sub]) || subredditIconUrl(feed?.iconUrl);
    const fallback = `<img class="popup-community-fallback${url ? ' hidden-icon-fallback' : ''}" src="icons/16.png" width="14" height="14" alt="">`;
    return `<span class="popup-community-image">${url ? `<img class="subreddit-favicon" src="${e(url)}" alt="" width="14" height="14" referrerpolicy="no-referrer" loading="lazy">` : ''}${fallback}</span>`;
}
function preview(post, feed) {
    const palette = articleLabelPalette(post.id, post.subreddit, feed ? 'feed:' + feed.id : 'all', state.feeds, state.folders, state.subscriptions, state.settings);
    const labelStyle = `${palette.background ? `--community-bg:${palette.background};` : ''}${palette.text ? `--community-ink:${palette.text};` : ''}`;
    return `<div class="preview" data-open="${e(post.id)}"><span class="unread-dot"></span><div style="flex:1;min-width:0"><div class="preview-title">${e(post.title)}</div><div class="preview-sub">${communityIcon(post.subreddit)}<span style="${labelStyle}">r/${e(post.subreddit)}</span><span class="vote-up"><svg class="vote-arrow" aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2 2.5 12.5h5.8V22h7.4v-9.5h5.8L12 2Z"/></svg> ${numberLabel(post.score)}</span><span>${icon('comment', 12)} ${numberLabel(post.comments)}</span><span>${dateLabel(post.createdAt)}</span></div></div>${state.settings.showThumbs && post.thumbnail ? `<img class="popup-thumbnail" src="${e(post.thumbnail)}" alt="" loading="lazy">` : ''}</div>`;
}
/** Synchronized order is the exact mixed folder/feed order from the full reader. */
function feedPostMap() {
    const unread = new Map(state.posts.filter(p => !p.read).map(p => [p.id, p]));
    const byFeed = new Map();
    for (const feed of state.feeds)
        byFeed.set(feed.id, []);
    const seen = new Map();
    for (const sub of state.subscriptions) {
        const post = unread.get(sub.postId);
        const list = byFeed.get(sub.feedId);
        if (!post || !list)
            continue;
        if (!seen.has(sub.feedId))
            seen.set(sub.feedId, new Set());
        if (seen.get(sub.feedId).has(post.id))
            continue;
        seen.get(sub.feedId).add(post.id);
        list.push(post);
    }
    for (const list of byFeed.values())
        list.sort((a, b) => b.createdAt - a.createdAt);
    return byFeed;
}
function render() {
    apply();
    const unread = state.posts.filter(p => !p.read);
    let output = '';
    function section(key, title, total, content, subreddit, folder = false) {
        const collapsed = (state.settings.popupCollapsed || []).includes(key);
        return `<section class="popup-group${collapsed ? ' popup-group-collapsed' : ''}${folder ? ' popup-folder' : ''}">
   <button type="button" class="popup-group-head" data-collapse="${e(key)}" aria-expanded="${!collapsed}" title="${collapsed ? 'Expand' : 'Collapse'} ${e(title)}">
    ${icon('folder', 15)}${subreddit ? communityIcon(subreddit) : ''}<span class="popup-group-title">${e(title)}</span>
    <span class="count positive">${total}</span><span class="popup-collapse-chevron">${icon('arrow', 13)}</span>
   </button>${collapsed ? '' : `<div class="popup-group-body">${content}</div>`}</section>`;
    }
    if (state.settings.popupGrouping === 'time')
        output = unread.length ? `<div class="popup-chronological-posts">${unread.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, state.settings.popupLimit).map(post => preview(post)).join('')}</div>` : '';
    else {
        const byFeed = feedPostMap(), maxPreviews = Math.max(1, state.settings.popupLimit), allocations = new Map();
        // Round-robin allocation prevents a busy feed at the top hiding every other feed's posts.
        const ids = state.feeds.filter(f => byFeed.get(f.id)?.length).map(f => f.id);
        let remaining = maxPreviews;
        while (remaining > 0) {
            let progressed = false;
            for (const id of ids) {
                if (remaining === 0)
                    break;
                const count = allocations.get(id) || 0;
                if (count < (byFeed.get(id)?.length || 0)) {
                    allocations.set(id, count + 1);
                    remaining--;
                    progressed = true;
                }
            }
            if (!progressed)
                break;
        }
        const seen = new Set();
        const tree = (parent, depth) => {
            if (depth > 12)
                return '';
            return sidebarSiblings(state.feeds, state.folders, parent).map(node => {
                if (node.kind === 'feed') {
                    if (!(state.counts.byFeed[node.id] > 0))
                        return '';
                    const feed = state.feeds.find(f => f.id === node.id);
                    const rows = (byFeed.get(feed.id) || []).slice(0, allocations.get(feed.id) || 0);
                    const left = Math.max(0, (state.counts.byFeed[feed.id] || 0) - rows.length);
                    return section(feed.id, feed.name, state.counts.byFeed[feed.id] || 0, rows.map(post => preview(post, feed)).join('') + (left ? `<div class="popup-more">+${left} unread in full reader</div>` : ''), feed.subreddit.split('+')[0]);
                }
                if (!(state.counts.byFolder[node.id] > 0))
                    return '';
                const folder = state.folders.find(f => f.id === node.id);
                if (seen.has(folder.id))
                    return '';
                seen.add(folder.id);
                return section('folder:' + folder.id, folder.name, state.counts.byFolder[folder.id] || 0, `<div class="popup-folder-children">${tree(folder.id, depth + 1)}</div>`, undefined, true);
            }).join('');
        };
        output = tree(null, 0);
    }
    app.innerHTML = `<div class="popup-head"><div class="brand popup-brand-link" style="flex:1" data-act="reader" role="button" tabindex="0" title="Open full reader"><span class="brand-mark"><img src="icons/32.png" alt="" width="26" height="26"></span>Reddit Reader</div><span class="count positive">${state.counts.unread} unread</span><button class="icon-btn" data-act="refresh" title="Refresh feeds">${icon('refresh')}</button><button class="icon-btn" data-act="settings" title="Settings">${icon('settings')}</button></div>
 <div class="popup-subhead"><label class="popup-order-label">Order <select id="popup-order" aria-label="Popup post order"><option value="feed" ${state.settings.popupGrouping === 'feed' ? 'selected' : ''}>By feed · date</option><option value="time" ${state.settings.popupGrouping === 'time' ? 'selected' : ''}>By date</option></select></label><button class="btn small popup-markall" data-act="markAll" ${state.counts.unread ? '' : 'disabled'} title="Mark all unread posts as read">${icon('check', 14)} Mark all as read</button></div>
 <div class="popup-scroll">${state.feeds.length ? (output || '<div class="popup-no-unread">All caught up — no unread feeds.</div>') : `<div class="empty">${icon('rss', 37)}<h3>Your feeds, one beautiful place</h3><p>Import an OPML file or add a subreddit to begin.</p><button class="btn primary" data-act="settings">Set up Reddit Reader</button></div>`}</div><button class="popup-footer" data-act="reader"><span>${icon('magazine', 17)} &nbsp; Open Full Reader</span>${icon('arrow', 18)}</button>${refreshBarHtml('popup')}`;
    updateProgressBar();
    applyHighlighters(app, state.settings.highlighters);
}
async function reload() { try {
    state = await send('getPopupState');
    liveProgress = state.refreshProgress || liveProgress;
    render();
}
catch (err) {
    app.textContent = String(err);
} }
app.addEventListener('change', async (ev) => { const target = ev.target; if (!(target instanceof HTMLSelectElement) || target.id !== 'popup-order')
    return; try {
    await send('saveSettings', { patch: { popupGrouping: target.value === 'time' ? 'time' : 'feed' } });
    await reload();
}
catch (err) {
    alert(String(err));
} });
app.addEventListener('click', async (ev) => {
    const target = ev.target.closest('[data-open],[data-act],[data-collapse]');
    if (!target)
        return;
    const key = target.dataset.collapse;
    if (key !== undefined) {
        const collapsed = new Set(state.settings.popupCollapsed || []);
        if (collapsed.has(key))
            collapsed.delete(key);
        else
            collapsed.add(key);
        try {
            await send('saveSettings', { patch: { popupCollapsed: [...collapsed] } });
            await reload();
        }
        catch (err) {
            alert(String(err));
        }
        return;
    }
    const id = target.dataset.open;
    if (id) {
        const post = state.posts.find(p => p.id === id);
        if (!post)
            return;
        await chrome.tabs.create({ url: postToReddit(post), active: false });
        if (state.settings.markReadOnOpen && !post.read)
            await send('mark', { id, read: true });
        return;
    }
    try {
        switch (target.dataset.act) {
            case 'reader':
                await send('openReader');
                window.close();
                break;
            case 'settings':
                await send('openSettings');
                window.close();
                break;
            case 'refresh': {
                target.disabled = true;
                try {
                    const response = await send('refresh');
                    if (response?.alreadyRunning) showRefreshError(state.settings.language === 'pt-PT' ? 'Já está a decorrer uma atualização.' : 'An update is already running.');
                    else if (!response?.queued && response?.reason) showRefreshError(response.reason);
                    await reload();
                } finally { if (target.isConnected) target.disabled = false; }
                break;
            }
            case 'markAll':
                await send('markScope', { scope: 'all', id: '', read: true });
                await reload();
                break;
        }
    }
    catch (err) {
        alert(err.message);
    }
});
function middleClickedPreviewId(ev) {
    if (ev.button !== 1 || !state)
        return null;
    const target = ev.target;
    return target instanceof Element ? target.closest('.preview[data-open]')?.dataset.open || null : null;
}
app.addEventListener('mousedown', ev => { if (middleClickedPreviewId(ev))
    ev.preventDefault(); });
app.addEventListener('auxclick', async (ev) => {
    const id = middleClickedPreviewId(ev);
    if (!id)
        return;
    ev.preventDefault();
    ev.stopPropagation();
    const post = state.posts.find(p => p.id === id);
    if (!post)
        return;
    try {
        await chrome.tabs.create({ url: postToReddit(post), active: false });
        if (state.settings.markReadOnOpen && !post.read)
            await send('mark', { id, read: true });
    }
    catch (err) {
        alert(err.message);
    }
});
app.addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.closest('[data-act="reader"].popup-brand-link')) {
    ev.preventDefault();
    ev.target.click();
} });
app.addEventListener('error', ev => { const img = ev.target; if (img instanceof HTMLImageElement && img.classList.contains('subreddit-favicon')) {
    img.hidden = true;
    img.nextElementSibling?.classList.remove('hidden-icon-fallback');
} }, true);
chrome.runtime.onMessage.addListener((message) => { if (message?.type === 'stateChanged')
    reload();
else if (message?.type === 'refreshProgressChanged') {
    liveProgress = message.progress;
    updateProgressBar();
} });
reload();
installLocalization();
let progressPollBusy = false;
setInterval(async () => {
    if (document.hidden || progressPollBusy) return;
    progressPollBusy = true;
    try {
        const next = await send('getRefreshProgress');
        if (next && (next.active !== liveProgress.active || next.total !== liveProgress.total ||
            next.completed !== liveProgress.completed || next.lastResult?.finishedAt !== liveProgress.lastResult?.finishedAt)) {
            liveProgress = next;
            updateProgressBar();
        }
    } catch { /* A subsequent poll can recover when the worker wakes. */ }
    finally { progressPollBusy = false; }
}, 1000);

// A restore may continue after this page opens; display its persistent progress.
installRestoreRecoveryIndicator(() => state?.settings?.language || 'en');
