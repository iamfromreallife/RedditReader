import { hsvToHex, hexToHsv } from './colour-picker.js';
import { FONT_OPTIONS } from './font-options.js';
import { installLocalization, setLanguage, translate } from './locale.js';
import { send, escapeHtml as e, icon, dateLabel, numberLabel, parseLines, parseOPML, postToReddit, subredditIconUrl, markAllReadShortcut, nextUnreadSection, cleanFeedTitle, searchFeedKey, searchFeedTitle, searchFeedDetails, feedOpenUrl, sidebarSiblings, refreshBarHtml, applyRefreshProgress, viewForSection, safeMediaUrl, articleLabelPalette, REFRESH_CHOICES, effectiveFeedRefreshMinutes } from './shared.js';
import { installMediaHover } from './media-hover.js';
import { installDialogFocus } from './dialog-focus.js';
import { installVideoControls } from './video-controls.js';
import { embedsFromPost } from './embeds.js';
import { renderRedditMarkdown } from './reading-format.js';
import { renderCommentThreads } from './comment-threads.js';
import { applyHighlighters } from './highlighters.js';
import { installRestoreRecoveryIndicator } from './restore-recovery-ui.js';
let keyboardSelectedPostId = null;
let threePaneResizing = false;
let data;
let selected = 'all';
// Folder clicks are tracked across renders: selecting a folder replaces its DOM node.
let lastFolderClick = null;
let filter = 'all';
let reorderSnapshot = null;
const rowSelector = '.post-card[data-post], .three-post-row[data-three-post]';
function rowId(node) { return node.dataset.post || node.dataset.threePost; }
function captureRowPositions() { const result = new Map(); document.querySelectorAll(rowSelector).forEach(node => { const rect = node.getBoundingClientRect(); result.set(rowId(node), { top: rect.top, left: rect.left }); }); return result; }
function animateReorderedRows(before) {
    if (!before || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let count = 0;
    document.querySelectorAll(rowSelector).forEach(node => {
        const earlier = before.get(rowId(node));
        if (!earlier || count > 150) return;
        const rect = node.getBoundingClientRect();
        const dx = earlier.left - rect.left, dy = earlier.top - rect.top;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        count++;
        node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
}

let layout = 'magazine';
let selectedThreePanePostId = null;
let threePaneDetailsRequest = 0;
const threePaneDetailsCache = new Map();
let search = '';
let limit = 120;
let busy = false;
let drawer = false;
// Ephemeral: the vertical sidebar compactness control opens only when requested.
let sidebarDensityOpen = false;
let expanded = new Set();
let toastTimeout;
let liveProgress = { active: false, total: 0, completed: 0, checked: 0, added: 0, current: '' };
let currentViewRefreshPending = false;
let refreshProgressWatch = null;
let lastReportedRefreshFinish = 0;
// Match the spinner to the progress bar itself, never to an outstanding
// promise (the promise can outlive the visible refresh).
function refreshBarVisible() {
    return !!liveProgress.active && Number(liveProgress.total) > 0;
}
function keepRefreshProgressInSync() {
    if (refreshProgressWatch === null) {
        // Recover from missed extension messages, e.g. after a worker restart.
        refreshProgressWatch = setInterval(async () => {
            try {
                const latest = await send('getRefreshProgress');
                if (latest && typeof latest.active === 'boolean' &&
                    (latest.active !== liveProgress.active || latest.completed !== liveProgress.completed ||
                     latest.total !== liveProgress.total || latest.lastResult?.finishedAt !== liveProgress.lastResult?.finishedAt)) {
                    liveProgress = latest;
                    updateProgressBar();
                }
            } catch { /* The next worker event / poll can recover. */ }
        }, 650);
    }
}
/** One local, browser-specific width shared by every three-pane feed and folder view.
 * Migrate a previous per-section value, if available, without Drive-syncing layout dimensions. */
const PANE_WIDTH_KEY = 'reddit-reader-three-pane-global-width-v2';
const LEGACY_PANE_WIDTH_KEY = 'reddit-reader-three-pane-widths-v1';
function clampPaneWidth(width) { return Math.max(230, Math.min(950, Math.round(width))); }
function paneWidthFor() {
    const saved = localStorage.getItem(PANE_WIDTH_KEY);
    if (saved !== null && saved.trim() !== '' && Number.isFinite(Number(saved)))
        return clampPaneWidth(Number(saved));
    try {
        const old = JSON.parse(localStorage.getItem(LEGACY_PANE_WIDTH_KEY) || '{}');
        if (old && typeof old === 'object' && !Array.isArray(old)) {
            const candidate = Number(old[selected] ?? Object.values(old).find(value => Number.isFinite(Number(value))));
            if (Number.isFinite(candidate) && candidate > 0) {
                const migrated = clampPaneWidth(candidate);
                localStorage.setItem(PANE_WIDTH_KEY, String(migrated));
                return migrated;
            }
        }
    } catch { /* No legacy dimensions to migrate. */ }
    return clampPaneWidth(Number(data?.settings?.threePaneListWidth) || 390);
}
function applyPaneWidth() { document.body.style.setProperty('--three-list-width', paneWidthFor() + 'px'); }
function persistPaneWidth(width) {
    const next = clampPaneWidth(width);
    localStorage.setItem(PANE_WIDTH_KEY, String(next));
    applyPaneWidth();
}
const app = document.querySelector('#app');
function updateProgressBar() {
    applyRefreshProgress(document, liveProgress);
    const finished = liveProgress.lastResult;
    if (finished?.finishedAt > lastReportedRefreshFinish) {
        lastReportedRefreshFinish = finished.finishedAt;
        if (finished.reason && finished.reason !== 'OK') toast(finished.reason);
    }
    keepRefreshProgressInSync();
    const refreshButton = document.querySelector('.reader-view-refresh');
    if (refreshButton) {
        const refreshing = refreshBarVisible();
        refreshButton.classList.toggle('is-refreshing', refreshing);
        refreshButton.setAttribute('aria-busy', String(refreshing));
        refreshButton.disabled = refreshing || currentViewRefreshPending;
    }
    // The sidebar action is outside the header, so both indicators must be
    // updated when a refresh finishes (including early exits and failures).
    const allFeedsRefresh = document.querySelector('.sidebar-all-refresh');
    if (allFeedsRefresh) {
        const refreshing = refreshBarVisible();
        allFeedsRefresh.classList.toggle('is-refreshing', refreshing);
        allFeedsRefresh.setAttribute('aria-busy', String(refreshing));
        allFeedsRefresh.disabled = refreshing || currentViewRefreshPending;
    }
    // The compact progress label in the progress bar is the sole refresh popup.
}
// Preserve the existing 0..100 preference and its direction (0 = spacious,
// 100 = compact). The middle position keeps the previous row spacing, while
// the two endpoints now allow substantially more or less vertical space.
function sidebarDensityMetrics(value) {
    const n = Math.max(0, Math.min(100, Number(value) || 0));
    const compact = n >= 50;
    const t = compact ? (n - 50) / 50 : n / 50;
    const mix = (from, to) => from + (to - from) * t;
    // The 8px extreme is the row-height TARGET. Actual rows expand as needed
    // for the configured text size, badges and icons so nothing overlaps.
    // A single sibling gap is used by the root feed list and every nested folder.
    return compact
        ? { row: mix(23, 8), padding: mix(3.25, 0), section: mix(7, 0), folder: mix(4, 0), gap: mix(2, 0), icon: mix(18, 14) }
        : { row: mix(54, 23), padding: mix(16, 3.25), section: mix(24, 7), folder: mix(16, 4), gap: mix(14, 2), icon: 18 };
}
function applySidebarDensity(value) {
    const d = sidebarDensityMetrics(value);
    document.body.style.setProperty('--sidebar-row-height', `${d.row}px`);
    document.body.style.setProperty('--sidebar-row-padding', `${d.padding}px`);
    document.body.style.setProperty('--sidebar-section-padding', `${d.section}px`);
    document.body.style.setProperty('--sidebar-folder-margin', `${d.folder}px`);
    document.body.style.setProperty('--sidebar-item-gap', `${d.gap}px`);
    document.body.style.setProperty('--sidebar-icon-size', `${d.icon}px`);
}
export function boundedPopupPercent(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 20 && number <= 100 ? Math.round(number) : fallback;
}
function sizeExpandedDialog(root = document) {
    const dialog = root.matches?.('.post-dialog-backdrop')
        ? root.querySelector(':scope > .post-dialog')
        : root.querySelector('.post-dialog-backdrop > .post-dialog');
    if (!dialog || !data?.settings) return;
    const width = boundedPopupPercent(data.settings.fullPopupWidthPct, 60);
    const height = boundedPopupPercent(data.settings.fullPopupHeightPct, 80);
    dialog.style.setProperty('width', `min(${width}vw, calc(100vw - 16px))`);
    dialog.style.setProperty('height', `min(${height}vh, calc(100dvh - 16px))`);
    dialog.style.setProperty('max-width', 'none');
    dialog.style.setProperty('max-height', 'calc(100dvh - 16px)');
    dialog.dataset.popupWidthPct = String(width);
    dialog.dataset.popupHeightPct = String(height);
}
function apply() { setLanguage(data.settings.language); const s = data.settings; const system = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; document.body.dataset.theme = s.theme === 'system' ? system : s.theme; document.body.dataset.density = s.density || 'comfortable'; document.body.dataset.railCollapsed = String(Boolean(s.readerRailCollapsed)); document.body.dataset.font = s.font; document.body.style.setProperty('--accent', s.accent); document.body.style.setProperty('--user-font', s.fontSize + 'px'); document.body.style.setProperty('--line', String(s.lineHeight)); document.body.dataset.readingFont = s.readingFont; document.body.style.setProperty('--reading-size', s.readingFontSize + 'px'); document.body.style.setProperty('--reading-line', String(s.readingLineHeight)); document.body.style.setProperty('--sidebar-width', s.sidebarWidth + 'px'); document.body.style.setProperty('--sidebar-font-size', `${Math.max(10, Math.min(20, Number(s.sidebarFontSize ?? 12) || 12))}px`); applySidebarDensity(s.sidebarCompactness ?? 50); applyPaneWidth(); document.body.style.setProperty('--reader-width', s.readerWidth + 'px'); document.body.style.setProperty('--post-dialog-width', `${Math.max(20, Math.min(100, Number(s.fullPopupWidthPct ?? 60) || 60))}vw`); document.body.style.setProperty('--post-dialog-height', `${Math.max(20, Math.min(100, Number(s.fullPopupHeightPct ?? 80) || 80))}vh`); document.body.style.setProperty('--sidebar-item-bg', s.sidebarItemBg || '#eaf1ff'); document.body.style.setProperty('--sidebar-item-text', s.sidebarItemText || '#10141c'); sizeExpandedDialog(); }
function toast(message) { let el = document.querySelector('.toast'); if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.append(el);
} el.textContent = message; clearTimeout(toastTimeout); toastTimeout = window.setTimeout(() => el?.remove(), 3300); }
async function reload() { if (busy)
    return; try {
    data = await send('getState');
    liveProgress = data.refreshProgress || liveProgress;
    layout = viewForSection(selected, data.feeds, data.settings.layout);
    apply();
    render();
}
catch (err) {
    toast(String(err));
} }
async function action(type, payload = {}, message = '') { try {
    busy = true;
    const before = data?.settings?.keepUnreadOnTop ? captureRowPositions() : null;
    const result = await send(type, payload);
    busy = false;
    await reload();
    animateReorderedRows(before);
    if (message)
        toast(message);
    return result;
}
catch (err) {
    busy = false;
    toast(err.message);
    return null;
} }
const count = (id, folder = false) => data.counts[folder ? 'byFolder' : 'byFeed'][id] || 0;
function resolveSubredditIcon(name) {
    const sub = name.toLowerCase();
    const cache = subredditIconUrl(data.communityIcons?.[sub]);
    if (cache)
        return cache;
    const feed = data.feeds.find(f => f.subreddit.toLowerCase() === sub || f.subreddit.toLowerCase().split('+')[0] === sub);
    return subredditIconUrl(feed?.iconUrl);
}
function communityGlyph(name, extraClass = '') {
    const url = resolveSubredditIcon(name);
    const fallback = `<span class="subreddit-icon-fallback${url ? ' hidden-icon-fallback' : ''}" title="Community icon unavailable"><img src="icons/16.png" alt="" width="16" height="16"></span>`;
    return `<span class="nav-glyph ${extraClass}">${url ? `<img class="subreddit-favicon" src="${e(url)}" alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async">` : ''}${fallback}</span>`;
}
function feedSymbol(feed) {
    const first = feed.subreddit.toLowerCase().split('+')[0];
    return searchFeedDetails(feed.subreddit) ? `<span class="nav-glyph">${icon('search', 17)}</span>` : communityGlyph(first);
}
/** Inline CSS variables are placed only on labels that identify the article's subreddit. */
function postLabelStyle(post) {
    const palette = articleLabelPalette(post.id, post.subreddit, selected, data.feeds, data.folders, data.subscriptions, data.settings);
    return `${palette.background ? `--community-bg:${palette.background};` : ''}${palette.text ? `--community-ink:${palette.text};` : ''}`;
}
function navItem(id, name, symbol, n, cls = '', indent = 0, feed) {
    const glyph = feed ? feedSymbol(feed) : `<span class="nav-glyph">${icon(symbol, 17)}</span>`;
    const isFolder = id.startsWith('folder:');
    const pt = data.settings.language === 'pt-PT';
    const title = isFolder
        ? `${name} — ${pt ? 'Duplo clique para expandir ou recolher' : 'Double-click to expand or collapse'}`
        : feed ? `Right-click to manage ${name}` : name;
    const expanded = isFolder ? ` aria-expanded="${!(data.settings.sidebarCollapsed || []).includes(id.slice(7))}"` : '';
    return `<button title="${e(title)}" draggable="${id.startsWith('feed:') || isFolder}" class="nav-item ${selected === id ? 'active' : ''} ${n > 0 ? 'has-unread' : ''} ${cls}" data-select="${e(id)}"${expanded} style="padding-left:${8 + indent * 12}px">${glyph}<span class="nav-name">${e(name)}</span>${n ? `<span class="count positive">${n}</span>` : ''}</button>`;
}
/** Render feeds and folders in the same user-defined order at every level. */
function sidebarChildren(parent, depth = 0, visited = new Set()) {
    if (depth > 12)
        return '';
    const nodes = sidebarSiblings(data.feeds, data.folders, parent);
    return nodes.map(node => {
        if (node.kind === 'feed') {
            const feed = data.feeds.find(f => f.id === node.id);
            return `<div class="sidebar-node feed-node" data-sidebar-node="feed:${e(feed.id)}">${navItem('feed:' + feed.id, feed.name, 'rss', count(feed.id), 'nav-sub', depth, feed)}</div>`;
        }
        if (visited.has(node.id))
            return '';
        const folder = data.folders.find(f => f.id === node.id);
        const next = new Set(visited);
        next.add(folder.id);
        const isCollapsed = (data.settings.sidebarCollapsed || []).includes(folder.id);
        return `<div class="sidebar-node folder-node${isCollapsed ? ' folder-collapsed' : ''}" data-sidebar-node="folder:${e(folder.id)}"><div class="folder-header">${navItem('folder:' + folder.id, folder.name, 'folder', count(folder.id, true), 'nav-folder', depth)}</div>${isCollapsed ? '' : `<div class="folder-children" data-sidebar-parent="${e(folder.id)}">${sidebarChildren(folder.id, depth + 1, next)}</div>`}</div>`;
    }).join('');
}
// The settings UI stays on the reader's own tab as a same-extension iframe.
// Keep it outside #app so reader rerenders do not destroy an in-progress form.
let settingsReturnFocus = null;
function closeReaderSettings() {
    document.querySelector('#reader-settings-backdrop')?.remove();
    if (settingsReturnFocus?.isConnected) settingsReturnFocus.focus();
    settingsReturnFocus = null;
}
function openReaderSettings(focus = '') {
    closeReaderSettings();
    settingsReturnFocus = document.activeElement;
    const pt = data.settings.language === 'pt-PT';
    const backdrop = document.createElement('div');
    backdrop.id = 'reader-settings-backdrop';
    backdrop.className = 'reader-settings-backdrop';
    backdrop.innerHTML = `<div class="reader-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="reader-settings-title"><div class="reader-settings-dialog-head"><strong class="reader-settings-dialog-title" id="reader-settings-title">${pt ? 'Definições' : 'Settings'}</strong><button type="button" class="icon-btn reader-settings-close" data-reader-settings-close aria-label="${pt ? 'Fechar definições' : 'Close settings'}" title="${pt ? 'Fechar' : 'Close'}">${icon('x',19)}</button></div><iframe class="reader-settings-frame" id="reader-settings-frame" title="${pt ? 'Definições do Reddit Reader' : 'Reddit Reader settings'}" src="${chrome.runtime.getURL('options.html')}?embedded=1${focus === 'highlighters' ? '#highlighters' : ''}"></iframe></div>`;
    document.body.append(backdrop);
    installDialogFocus(backdrop, { initialSelector: '[data-reader-settings-close]', restoreFocus: false });
}
document.addEventListener('click', event => {
    const backdrop = document.querySelector('#reader-settings-backdrop');
    if (!backdrop) return;
    if (event.target === backdrop || (event.target instanceof Element && event.target.closest('[data-reader-settings-close]'))) {
        event.preventDefault();
        closeReaderSettings();
    }
}, true);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.querySelector('#reader-settings-backdrop')) {
        event.preventDefault();
        closeReaderSettings();
    }
}, true);
window.addEventListener('message', event => {
    const frame = document.querySelector('#reader-settings-frame');
    if (event.origin === location.origin && event.source === frame?.contentWindow && event.data?.type === 'reddit-reader-close-settings') {
        closeReaderSettings();
    }
});
function sidebar() {
    const pt = data.settings.language === 'pt-PT';
    const addLabel = pt ? 'Adicionar feed' : 'Add feed';
    const homeLabel = pt ? 'Início — todas as publicações' : 'Home — all posts';
    const rulesLabel = pt ? 'Regras' : 'Rules';
    const starredLabel = pt ? 'Favoritos' : 'Starred';
    // Use the deduplicated global unread count, not a sum of feed counts:
    // a post may belong to several feeds or MultiReddits.
    const unreadCount = Math.max(0, Number(data.counts?.unread) || 0);
    const starredCount = data.posts.reduce((total, post) => total + (post.starred ? 1 : 0), 0);
    const countLabel = (value) => String(value);
    const railBadge = (value) => value > 0
        ? `<span class="reader-rail-count" aria-hidden="true" title="${value}">${countLabel(value)}</span>`
        : '';
    const unreadLabel = pt ? `${unreadCount} ${unreadCount === 1 ? 'publicação por ler' : 'publicações por ler'}` : `${unreadCount} unread ${unreadCount === 1 ? 'post' : 'posts'}`;
    const starredCountLabel = pt ? `${starredCount} ${starredCount === 1 ? 'publicação favorita' : 'publicações favoritas'}` : `${starredCount} starred ${starredCount === 1 ? 'post' : 'posts'}`;
    const highlightersLabel = pt ? 'Realçadores de texto' : 'Text highlighters';
    const settingsLabel = pt ? 'Definições' : 'Settings';
    const densityLabel = pt ? 'Compactação vertical da barra de feeds' : 'Feed sidebar vertical compactness';
    const densityToggleLabel = pt ? 'Controlo da densidade da barra lateral' : 'Sidebar density control';
    const collapseLabel = pt ? 'Recolher barra de ícones' : 'Collapse icon sidebar';
    const expandLabel = pt ? 'Expandir barra de ícones' : 'Expand icon sidebar';
    return `<nav class="reader-action-rail" aria-label="${pt ? 'Ações do leitor' : 'Reader actions'}">
      <button type="button" class="reader-rail-expand" data-act="expandRail" aria-label="${expandLabel}" title="${expandLabel}" aria-expanded="false"></button>
      <div class="reader-rail-top">
        <button type="button" class="reader-rail-action reader-rail-collapse" data-act="collapseRail" aria-label="${collapseLabel}" data-tooltip="${collapseLabel}" aria-expanded="true">${icon('chevron', 16)}</button>
        <button type="button" class="reader-rail-action reader-rail-home ${selected === 'all' ? 'active' : ''}" data-select="all" aria-label="${homeLabel} — ${unreadLabel}" data-tooltip="${homeLabel} — ${unreadLabel}" ${selected === 'all' ? 'aria-current="page"' : ''}>${icon('home', 20)}${railBadge(unreadCount)}</button>
        <button type="button" class="reader-rail-action reader-rail-starred ${selected === 'starred' ? 'active' : ''}" data-select="starred" aria-label="${starredLabel} — ${starredCountLabel}" data-tooltip="${starredLabel} — ${starredCountLabel}" ${selected === 'starred' ? 'aria-current="page"' : ''}>${icon('star', 20)}${railBadge(starredCount)}</button>
      </div>
      <div class="reader-rail-bottom">
        <div class="reader-rail-density-panel" id="reader-rail-density-panel" ${sidebarDensityOpen ? '' : 'hidden'}>
          <label class="reader-rail-density-label" title="${densityLabel}">
            <input type="range" class="reader-rail-density-slider" min="0" max="100" step="1" value="${Math.max(0, Math.min(100, Number(data.settings.sidebarCompactness ?? 50)))}" data-sidebar-density aria-label="${densityLabel}" title="${densityLabel}">
          </label>
        </div>
        <button type="button" class="reader-rail-action reader-rail-density-toggle ${sidebarDensityOpen ? 'active' : ''}" data-act="toggleSidebarDensity" aria-controls="reader-rail-density-panel" aria-expanded="${sidebarDensityOpen}" aria-label="${densityToggleLabel}" data-tooltip="${densityToggleLabel}">${icon('expand-vertical', 18)}</button>
        <button type="button" class="reader-rail-action reader-rail-highlighters" data-act="highlighters" aria-label="${highlightersLabel}" data-tooltip="${highlightersLabel}">${icon('highlighter', 20)}</button>
        <button type="button" class="reader-rail-action" data-act="rules" aria-label="${rulesLabel}" data-tooltip="${rulesLabel}">${icon('bell', 20)}</button>
        <button type="button" class="reader-rail-action reader-rail-add" data-act="add" aria-label="${addLabel}" data-tooltip="${addLabel}">${icon('plus', 22)}</button>
        <button type="button" class="reader-rail-action" data-act="settings" aria-label="${settingsLabel}" data-tooltip="${settingsLabel}">${icon('settings', 20)}</button>
      </div>
    </nav><aside class="sidebar"><div class="side-list"><div class="eyebrow" style="padding:0 12px 11px">LIBRARY</div>
 <div class="sidebar-all-row">${navItem('all', 'All posts', 'list', 0)}<button type="button" class="icon-btn sidebar-all-refresh ${refreshBarVisible() ? 'is-refreshing' : ''}" data-act="refreshAllSidebar" title="Refresh all feeds" aria-label="Refresh all feeds" aria-busy="${refreshBarVisible()}" ${(currentViewRefreshPending || refreshBarVisible()) ? 'disabled' : ''}>${icon('refresh', 13)}</button>${data.counts.total ? `<span class="count positive sidebar-all-count" title="${e(String(data.counts.total))} posts">${data.counts.total}</span>` : ''}</div>${navItem('unread', 'Unread', 'unread', data.counts.unread)}
 <div class="side-section"><span class="eyebrow">YOUR FEEDS</span><button class="icon-btn" data-act="newFolder" title="New folder">${icon('plus', 16)}</button></div><div class="sidebar-tree" data-sidebar-parent="">${sidebarChildren(null)}</div>
 ${data.feeds.length ? '' : `<p class="help" style="padding:12px">No feeds yet. Import OPML or add a subreddit to begin.</p>`}
 </div></aside>`;
}
function currentName() { if (selected === 'all')
    return 'All posts'; if (selected === 'unread')
    return 'Unread posts'; if (selected === 'starred')
    return 'Starred posts'; if (selected.startsWith('feed:'))
    return data.feeds.find(f => f.id === selected.slice(5))?.name || 'Feed'; if (selected.startsWith('folder:'))
    return data.folders.find(f => f.id === selected.slice(7))?.name || 'Folder'; return 'Reader'; }
function filteredPosts() {
    const feedIds = new Set();
    if (selected.startsWith('feed:'))
        feedIds.add(selected.slice(5));
    if (selected.startsWith('folder:')) {
        const id = selected.slice(7);
        const dirs = new Set([id]);
        for (let k = 0; k < 12; k++) {
            let n = 0;
            for (const f of data.folders)
                if (f.parentId && dirs.has(f.parentId) && !dirs.has(f.id)) {
                    dirs.add(f.id);
                    n++;
                }
            if (!n)
                break;
        }
        for (const f of data.feeds)
            if (f.folderId && dirs.has(f.folderId))
                feedIds.add(f.id);
    }
    let allowed = null;
    if (selected.startsWith('feed:') || selected.startsWith('folder:'))
        allowed = new Set(data.subscriptions.filter(s => feedIds.has(s.feedId)).map(s => s.postId));
    let posts = data.posts.filter(p => (allowed === null || allowed.has(p.id)) && (selected !== 'unread' || !p.read) && (selected !== 'starred' || p.starred));
    if (filter === 'unread')
        posts = posts.filter(p => !p.read);
    if (filter === 'star')
        posts = posts.filter(p => p.starred);
    if (search) {
        const q = search.toLowerCase();
        posts = posts.filter(p => (p.title + ' ' + p.text + ' ' + p.subreddit + ' ' + p.author).toLowerCase().includes(q));
    }
    if (data.settings.keepUnreadOnTop) posts.sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt - a.createdAt);
    return posts;
}
/** Resolve the current reader scope without accidentally requesting a global refresh.
 * A folder includes descendant folders; filtered/aggregate views only include
 * subscriptions represented by matching visible articles. */
function currentViewRefreshFeedIds() {
    if (selected.startsWith('feed:')) {
        const id = selected.slice(5);
        return data.feeds.some(feed => feed.id === id) ? [id] : [];
    }
    if (selected.startsWith('folder:')) {
        const ids = new Set([selected.slice(7)]);
        for (let step = 0; step < 12; step++) {
            let changed = false;
            for (const folder of data.folders) {
                if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
                    ids.add(folder.id);
                    changed = true;
                }
            }
            if (!changed) break;
        }
        return data.feeds.filter(feed => ids.has(feed.folderId)).map(feed => feed.id);
    }
    if (selected === 'all' && filter === 'all' && !search.trim()) {
        return data.feeds.map(feed => feed.id);
    }
    const postIds = new Set(filteredPosts().map(post => post.id));
    const ids = new Set(data.subscriptions.filter(sub => postIds.has(sub.postId)).map(sub => sub.feedId));
    return data.feeds.filter(feed => ids.has(feed.id)).map(feed => feed.id);
}
/** Shared article typography controls. Settings are reflected live in both reading surfaces. */
function articleTypographyControls() {
    const s = data.settings;
    return `<div class="reading-type-controls" aria-label="Article typography">
 <label title="Article font">${icon('type', 13)} <select data-reading-setting="readingFont" aria-label="Article font">${FONT_OPTIONS.map(([value, label]) => `<option value="${value}" ${s.readingFont === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
 <label title="Article font size"><input type="number" data-reading-setting="readingFontSize" min="10" max="36" step="1" value="${s.readingFontSize}" aria-label="Article font size in pixels">px</label>
 <label title="Article line spacing"><input type="number" data-reading-setting="readingLineHeight" aria-label="Article line spacing" min="1" max="2.5" step="0.05" value="${s.readingLineHeight}">×</label>
 </div>`;
}
// The header describes exactly the articles shown by the selected section,
// filter and search, not the global subscription totals.
function currentViewCountsLabel(posts) {
    const unread = posts.reduce((n, post) => n + (post.read ? 0 : 1), 0);
    return translate(`${posts.length} posts in this view · ${unread} unread`);
}
function updateCurrentViewCounts(posts) {
    const label = document.querySelector('.reader-view-counts');
    if (label) label.textContent = currentViewCountsLabel(posts);
}
function titleButtons() {
    const markAllLabel = translate('Mark all posts in this view as read (Left Shift + A)');
    const unreadFirstLabel = translate('Keep unread on top');
    // Title and refresh stay left; all view controls are collected on the right.
    return `<div class="topbar"><div class="topbar-inner"><div class="reader-view-heading"><div class="title-block"><h1>${e(currentName())}</h1><div class="muted reader-view-counts" style="font-size:11px">${currentViewCountsLabel(filteredPosts())}</div></div><button class="icon-btn reader-view-refresh ${refreshBarVisible() ? 'is-refreshing' : ''}" data-act="refresh" title="${e(translate('Refresh feeds in current view'))}" aria-label="${e(translate('Refresh feeds in current view'))}" aria-busy="${refreshBarVisible()}" ${(currentViewRefreshPending || refreshBarVisible()) ? 'disabled' : ''}>${icon('refresh')}</button>
 <div class="searchbox">${icon('search', 15)}<input id="search" placeholder="Search posts" aria-label="Search posts" value="${e(search)}"></div></div>
 <div class="top-controls"><div class="reader-heading-filters"><select id="filter" class="btn small reader-header-filter" aria-label="${e(translate('Filter articles'))}" title="${e(translate('Filter articles'))}"><option value="all" ${filter === 'all' ? 'selected' : ''}>${e(translate('All'))}</option><option value="unread" ${filter === 'unread' ? 'selected' : ''}>${e(translate('Unread only'))}</option><option value="star" ${filter === 'star' ? 'selected' : ''}>${e(translate('Starred only'))}</option></select>
 <label class="unread-first-toggle" title="${e(unreadFirstLabel)}"><input id="unread-first" type="checkbox" role="switch" aria-label="${e(unreadFirstLabel)}" ${data.settings.keepUnreadOnTop ? 'checked' : ''}><span class="unread-first-track" aria-hidden="true"></span><span>${e(unreadFirstLabel)}</span></label></div>
 <div class="segmented" aria-label="Reader layout">${[['small-list', 'Small List', 'compact'], ['list', 'List', 'list'], ['magazine', 'Magazine', 'magazine'], ['cards', 'Cards', 'grid'], ['three-pane', 'Three Pane', 'three-pane']].map(([id, name, symbol]) => { const label = translate(name + ' view'); return `<button type="button" title="${e(label)}" aria-label="${e(label)}" aria-pressed="${layout === id}" class="${layout === id ? 'selected' : ''}" data-layout="${id}">${icon(symbol, 16)}</button>`; }).join('')}</div>
 <button type="button" class="icon-btn reader-header-markall" data-act="markAll" title="${e(markAllLabel)}" aria-label="${e(markAllLabel)}" aria-keyshortcuts="Shift+A">${icon('check', 17)}<span>${e(translate('Mark all as read'))}</span></button>
 </div></div></div>`;
}
/** Plain-text preview for the one-line layout. Never interpret post-supplied HTML. */
function smallListExcerpt(value) {
    const clean = String(value || '')
        .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
        .replace(/<[^>]*>/g, ' ')
        .replace(/(?:^|\n)\s{0,3}#{1,6}\s+/g, ' ')
        .replace(/(?:^|\n)\s*>\s?/g, ' ')
        .replace(/[\*_~`]+/g, '')
        .replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const pieces = clean.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [clean];
    const excerpt = pieces.slice(0, 3).join(' ').trim();
    return excerpt.length <= 360 ? excerpt : excerpt.slice(0, 359).replace(/\s+\S*$/, '').trimEnd() + '…';
}
function smallListPostHtml(post) {
    const pt = data.settings.language === 'pt-PT';
    const excerpt = data.settings.showSnippets ? smallListExcerpt(post.text) : '';
    const community = `r/${post.subreddit}`;
    return `<article class="post-card small-list-row ${post.read ? 'is-read' : ''} ${keyboardSelectedPostId === post.id ? 'keyboard-selected' : ''}" data-post="${e(post.id)}" data-act="preview" data-id="${e(post.id)}" role="button" tabindex="0" aria-label="${e((pt ? 'Pré-visualizar publicação: ' : 'Preview post: ') + post.title)}" title="${e(post.title)}">
      <span class="small-list-feed" title="${e(community)}">${communityGlyph(post.subreddit, 'small-list-community-icon')}<span class="small-list-feed-name">${e(community)}</span></span>
      <span class="small-list-content"><strong class="post-title">${e(post.title)}</strong>${excerpt ? `<span class="post-excerpt small-list-excerpt"> ${e(excerpt)}</span>` : ''}</span>
    </article>`;
}
function postHtml(post) {
    const s = data.settings;
    const media = safeMediaUrl(post.video || post.images[0] || post.thumbnail);
    const img = s.showThumbs && (post.thumbnail || post.images[0]) ? `<img class="post-thumbnail" src="${e(post.thumbnail || post.images[0])}" alt="" loading="lazy" data-act="preview" data-id="${e(post.id)}" ${media ? `data-media-zoom="${e(media)}" ${post.video ? 'data-media-kind="video"' : ''} data-media-title="${e(post.title)}" tabindex="0" aria-label="Enlarge image"` : ''}>` : '';
    const preview = post.text || '';
    const readLabel = post.read ? 'Mark unread' : 'Mark read';
    const external = post.url !== post.permalink;
    const expandedMedia = expanded.has(post.id) ? `<div class="post-media-expand">${post.video ? `<video src="${e(post.video)}" controls preload="none" playsinline data-media-zoom="${e(post.video)}" data-media-kind="video" data-media-title="${e(post.title)}"></video>` : post.images.length ? post.images.slice(0, 8).map(url => `<img src="${e(url)}" alt="Post image" loading="lazy" data-media-zoom="${e(url)}" data-media-title="${e(post.title)}" tabindex="0">`).join('') : ''}${post.text ? `<div class="reddit-markdown">${renderRedditMarkdown(post.text)}</div>` : ''}</div>` : '';
    return `<article class="post-card ${keyboardSelectedPostId === post.id ? 'keyboard-selected' : ''} ${post.read ? 'is-read' : ''}" data-post="${e(post.id)}"><div class="post-main"><div class="post-body">
  <div class="post-meta"><span class="sub-label" style="${postLabelStyle(post)}">${communityGlyph(post.subreddit, 'post-community')}<span>r/${e(post.subreddit)}</span></span><span>•</span><span>${dateLabel(post.createdAt)}</span>${post.author ? `<span>by u/${e(post.author)}</span>` : ''}${post.flair ? `<span class="pill">${e(post.flair)}</span>` : ''}${post.nsfw ? '<span class="pill danger-text">NSFW</span>' : ''}${post.spoiler ? '<span class="pill">Spoiler</span>' : ''}</div>
  <div class="post-title" role="button" tabindex="0" aria-label="Preview post" data-act="preview" data-id="${e(post.id)}">${!post.read ? '<span style="color:var(--accent)">• </span>' : ''}${e(post.title)}</div>
  ${layout !== 'list' && s.showSnippets && preview ? `<div class="post-excerpt">${e(preview).slice(0, 1500)}</div>` : ''}
 </div>${img}</div>
 <div class="post-foot"><span title="Net score (not separate votes)"><span class="vote-up"><svg class="vote-arrow" aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2 2.5 12.5h5.8V22h7.4v-9.5h5.8L12 2Z"/></svg> ${numberLabel(post.score)}</span></span>${post.upvoteRatio != null ? `<span title="Upvote ratio">${Math.round(post.upvoteRatio * 100)}%</span>` : ''}<span class="comments">${icon('comment', 14)} ${numberLabel(post.comments)}</span>
 <div class="post-actions"><button class="icon-btn ${post.starred ? 'active' : ''}" title="${post.starred ? 'Unstar' : 'Star'}" data-act="star" data-id="${e(post.id)}">${icon('star', 16)}</button><button class="icon-btn" title="${readLabel}" data-act="read" data-id="${e(post.id)}">${icon(post.read ? 'unread' : 'check', 16)}</button><button class="icon-btn" title="Expand inline media" data-act="expand" data-id="${e(post.id)}">${icon('image', 16)}</button><button class="icon-btn" title="Open on Reddit" data-act="open" data-id="${e(post.id)}">${icon('external', 16)}</button></div></div>${expandedMedia}</article>`;
}
function threePaneRow(post) {
    const url = subredditIconUrl(data.communityIcons?.[post.subreddit.toLowerCase()]);
    const thumb = data.settings.showThumbs && (post.thumbnail || post.images[0]);
    return `<button type="button" class="three-post-row ${post.read ? 'is-read' : ''} ${selectedThreePanePostId === post.id ? 'selected' : ''}" data-three-post="${e(post.id)}" aria-selected="${selectedThreePanePostId === post.id}" title="${e(post.title)}">
 <span class="three-post-head">${url ? `<img src="${e(url)}" alt="" class="three-community-icon" loading="lazy">` : communityGlyph(post.subreddit, 'three-community-glyph')}<span style="${postLabelStyle(post)}">r/${e(post.subreddit)}</span><time>${dateLabel(post.createdAt)}</time></span>
 <span class="three-post-middle"><span class="three-post-title">${!post.read ? '<i class="three-unread-dot" aria-hidden="true"></i>' : ''}${e(post.title)}</span>${thumb ? `<img class="three-post-thumb" src="${e(post.thumbnail || post.images[0])}" alt="" loading="lazy" data-media-zoom="${e(post.video || post.images[0] || post.thumbnail)}" ${post.video ? 'data-media-kind="video"' : ''} data-media-title="${e(post.title)}">` : ''}</span>
 <span class="three-post-stats"><span class="vote-up"><svg class="vote-arrow" aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2 2.5 12.5h5.8V22h7.4v-9.5h5.8L12 2Z"/></svg> ${numberLabel(post.score)}</span> <span>${icon('comment', 12)} ${numberLabel(post.comments)}</span></span></button>`;
}
function commentsHtml(comments, loading = false, note = '') {
    const pt = data.settings.language === 'pt-PT';
    const title = pt ? 'Comentários' : 'Comments';
    const inner = loading ? `<p class="reader-comments-status">${pt ? 'A carregar comentários…' : 'Loading comments…'}</p>` :
        !comments?.length ? `<p class="reader-comments-status">${note && /requires|budget|rate limit|unavailable|http|authorization|permission|network|request/i.test(note) ? e((pt ? 'Não foi possível carregar comentários: ' : 'Comments unavailable: ') + note.slice(0, 190)) : (pt ? 'Sem comentários disponíveis nesta pré-visualização.' : 'No comments available in this preview.')}</p>` :
            renderCommentThreads(comments.slice(0, 30), data.settings.language);
    return `<section class="reader-comments" aria-label="${title}"><h3 class="reader-comments-heading">${title}</h3><div class="reader-comments-list">${inner}</div></section>`;
}
function setComments(target, comments, note = '') {
    const section = target.querySelector('.reader-comments');
    if (!section)
        return;
    section.outerHTML = commentsHtml(comments, false, note);
    applyHighlighters(target, data.settings.highlighters);
}
/** Consistent vote and post metadata alignment in full-content views. */
function detailMetadata(post) {
    const author = post.author ? `<span class="post-dialog-author">u/${e(post.author)}</span><span class="post-dialog-separator">·</span>` : '';
    const votes = `<span class="vote-up"><svg class="vote-arrow" aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2 2.5 12.5h5.8V22h7.4v-9.5h5.8L12 2Z"/></svg><span>${numberLabel(post.score)}</span></span>`;
    const comments = `<span class="post-dialog-separator">·</span><span class="post-dialog-comments">${numberLabel(post.comments)} comments</span>`;
    const flair = post.flair ? `<span class="post-dialog-separator">·</span><span class="post-dialog-flair">${e(post.flair)}</span>` : '';
    return `<div class="post-dialog-sub">${author}${votes}${comments}${flair}</div>`;
}
function threePaneDetailMarkup(post) {
    return `<div class="three-pane-detail-card" data-detail-id="${e(post.id)}">
 <div class="three-pane-detail-head">${communityGlyph(post.subreddit, 'post-community')}<strong style="${postLabelStyle(post)}">r/${e(post.subreddit)}</strong><span>· ${dateLabel(post.createdAt)}</span><span class="spacer"></span>${articleTypographyControls()}</div>
 <div class="three-pane-detail-content"><h2 data-post-title-background="${e(post.id)}" role="link" tabindex="0" title="${e(data.settings.language === 'pt-PT' ? 'Clique para abrir no Reddit; botão do meio para segundo plano' : 'Click to open on Reddit; middle-click for background')}">${e(post.title)}</h2>${detailMetadata(post)}
 ${postDialogMedia(post)}${postDialogEmbeds(post)}<div class="post-dialog-text" aria-live="polite" ${post.text ? '' : 'hidden'}>${post.text ? `<div class="reddit-markdown">${renderRedditMarkdown(post.text)}</div>` : ''}</div>
 ${commentsHtml(threePaneDetailsCache.get(post.id)?.comments, !threePaneDetailsCache.has(post.id), threePaneDetailsCache.get(post.id)?.note)}<p class="post-dialog-hint">${post.url !== post.permalink ? 'External link post · Full article text may only be available on the linked website.' : 'Reddit post preview · Full comments are on Reddit.'}</p></div>
 <footer class="three-pane-actions"><button class="btn ${post.starred ? 'active' : ''}" data-act="threePaneStar" data-id="${e(post.id)}">${icon('star', 15)} ${post.starred ? 'Unstar' : 'Star'}</button><button class="btn" data-act="threePaneRead" data-id="${e(post.id)}">${icon(post.read ? 'unread' : 'check', 15)} ${post.read ? 'Mark unread' : 'Mark read'}</button><button class="btn" data-act="threePaneBackground" data-id="${e(post.id)}">${icon('external', 15)} Background</button><button class="btn primary" data-act="threePaneForeground" data-id="${e(post.id)}">${icon('external', 15)} Open on Reddit</button></footer>
 </div>`;
}
/** Select a post inside the permanent detail pane. This never opens the modal. */
function showThreePanePost(id, markRead = false, fetchExtra = markRead) {
    if (layout !== 'three-pane' || !data)
        return;
    const post = data.posts.find(p => p.id === id);
    const detail = document.querySelector('.three-pane-detail');
    if (!detail || !post)
        return;
    selectedThreePanePostId = id;
    for (const row of document.querySelectorAll('.three-post-row')) {
        const active = row.dataset.threePost === id;
        row.classList.toggle('selected', active);
        row.setAttribute('aria-selected', String(active));
    }
    const cached = threePaneDetailsCache.get(id);
    detail.innerHTML = threePaneDetailMarkup(cached ? { ...post, text: cached.text || post.text, images: cached.images?.length ? cached.images : post.images, video: cached.video || post.video } : post);
    detail.scrollTop = 0;
    applyHighlighters(detail, data.settings.highlighters);
    const request = ++threePaneDetailsRequest;
    if (markRead && data.settings.markReadOnOpen && !post.read) {
        const position = document.querySelector('.three-pane-list')?.scrollTop || 0;
        void send('mark', { id, read: true }).then(() => {
            if (layout === 'three-pane' && selectedThreePanePostId === id)
                void reload().then(() => { const list = document.querySelector('.three-pane-list'); if (list)
                    list.scrollTop = position; });
        }).catch(err => toast(String(err)));
    }
    if (!fetchExtra || threePaneDetailsCache.has(id))
        return;
    void send('getPostDetails', { id }).then(details => {
        threePaneDetailsCache.set(id, details);
        if (selectedThreePanePostId !== id || layout !== 'three-pane')
            return;
        const liveDetail = document.querySelector('.three-pane-detail');
        if (!liveDetail)
            return;
        const textBox = liveDetail.querySelector('.post-dialog-text');
        if (textBox) {
            if (details.text) {
                textBox.innerHTML = '<div class="reddit-markdown">' + renderRedditMarkdown(details.text) + '</div>';
            }
            else if (!post.text) {
                textBox.textContent = '';
            }
            applyHighlighters(textBox, data.settings.highlighters);
            textBox.hidden = !(details.text || post.text);
        }
        const content = liveDetail.querySelector('.three-pane-detail-content');
        if (content) {
            if (detailMediaChanged(post, details)) {
                const holder = document.createElement('div');
                holder.innerHTML = postDialogMedia({ ...post,
                    images: details.images?.length ? details.images : post.images,
                    video: details.video || post.video });
                const gallery = holder.firstElementChild;
                if (gallery) {
                    content.querySelector('.post-dialog-gallery')?.remove();
                    content.insertBefore(gallery, content.querySelector('.post-dialog-embeds, .post-dialog-text'));
                }
            }
            const markup = postDialogEmbeds(post, details.text || post.text);
            content.querySelector('.post-dialog-embeds')?.remove();
            if (markup) {
                const holder = document.createElement('div');
                holder.innerHTML = markup;
                const embeds = holder.firstElementChild;
                if (embeds)
                    content.insertBefore(embeds, content.querySelector('.post-dialog-text'));
            }
        }
        setComments(liveDetail, details.comments, details.note);
        applyHighlighters(liveDetail, data.settings.highlighters);
    }).catch(err => { const liveDetail = document.querySelector('.three-pane-detail'); if (request === threePaneDetailsRequest && liveDetail?.isConnected) {
        const el = liveDetail.querySelector('.post-dialog-text');
        if (el) {
            el.textContent = '';
            el.hidden = true;
        }
    } });
}
function renderPosts() {
    const posts = filteredPosts();
    updateCurrentViewCounts(posts);
    const visible = posts.slice(0, limit);
    const area = document.querySelector('#feed-content');
    if (!area)
        return;
    const status = data.settings.providerMode === 'none' ? '<div class="provider-note">⚠ No content provider configured. You can import and organize subscriptions now, then connect your own Reddit OAuth app in Settings.</div>' : '';
    area.innerHTML = `${status}${layout === 'three-pane' && visible.length ? `<div class="three-pane-layout"><div class="three-pane-list" role="listbox" aria-label="Post titles">${visible.map(threePaneRow).join('')}${posts.length > limit ? `<button class="btn loadmore" data-act="more">Show more (${posts.length - limit})</button>` : ''}</div><div class="three-pane-resizer" role="separator" aria-orientation="vertical" tabindex="0" title="Drag to resize the article list" aria-label="Resize article list"></div><section class="three-pane-detail" aria-label="Article preview"></section></div>` : visible.length ? `<div class="post-list ${layout}">${visible.map(layout === 'small-list' ? smallListPostHtml : postHtml).join('')}</div>${posts.length > limit ? `<button class="btn loadmore" data-act="more">Show more (${posts.length - limit})</button>` : ''}` : `<div class="empty">${icon(data.feeds.length ? 'rss' : 'plus', 38)}<h3>${data.feeds.length ? 'Nothing to read here yet' : 'Create your personal Reddit reader'}</h3><p>${data.feeds.length ? 'Try changing the filter or updating your feeds.' : 'Add subreddits individually, paste a list, or import an OPML file with folders.'}</p><button class="btn primary" data-act="${data.feeds.length ? 'refreshAllSidebar' : 'add'}" ${data.feeds.length && currentViewRefreshPending ? 'disabled' : ''}>${data.feeds.length ? 'Update all feeds' : 'Add feeds'}</button></div>`}`;
    if (layout === 'three-pane' && visible.length) {
        if (!visible.some(p => p.id === selectedThreePanePostId))
            selectedThreePanePostId = visible[0].id;
        showThreePanePost(selectedThreePanePostId, false, true);
    }
    applyHighlighters(area, data.settings.highlighters);
}
let readerHeaderResizeObserver = null;
/** Keep the scrollable content below the header at rest, but allow it to move
 * behind the translucent header when scrolling. A wrapped toolbar can be
 * taller than the default 67px; observe its actual height to prevent overlap. */
function trackReaderHeaderHeight() {
    readerHeaderResizeObserver?.disconnect();
    readerHeaderResizeObserver = null;
    const main = app.querySelector('.main');
    const header = main?.querySelector('.topbar');
    if (!main || !header) return;
    const setHeight = () => {
        if (!main.isConnected || !header.isConnected) return;
        main.style.setProperty('--reader-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    };
    setHeight();
    if (typeof ResizeObserver === 'function') {
        readerHeaderResizeObserver = new ResizeObserver(setHeight);
        readerHeaderResizeObserver.observe(header);
    }
}
function render() { applyPaneWidth(); closeFeedContextMenu(); document.dispatchEvent(new Event('reddit-reader:hide-hover')); document.body.classList.toggle('three-pane-mode', layout === 'three-pane'); app.innerHTML = `${sidebar()}<div class="sidebar-resizer" title="Resize sidebar"></div><main class="main">${titleButtons()}<div class="reader-scroller"><div class="reader-inner" id="feed-content"></div></div></main>${refreshBarHtml('reader')}`; trackReaderHeaderHeight(); renderPosts(); applyHighlighters(app, data.settings.highlighters); updateProgressBar(); }
function modal(title, content, buttons) { document.querySelector('.modal-backdrop')?.remove(); const overlay = document.createElement('div'); overlay.className = 'modal-backdrop'; overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><div class="flex"><h2 style="flex:1">${e(title)}</h2><button class="icon-btn" data-act="closeModal">${icon('close')}</button></div>${content}<div class="modal-controls">${buttons}</div></div>`; document.body.append(overlay); installDialogFocus(overlay, { initialSelector: '[data-act="closeModal"]' }); }
function importModal() {
    modal('Add Reddit feeds', `<div class="segmented add-type-tabs"><button type="button" class="selected" data-act="feedAddMode" data-mode="subreddit">${icon('rss', 15)} Subreddits / URLs</button><button type="button" data-act="feedAddMode" data-mode="search">${icon('search', 15)} ${data.settings.language === 'pt-PT' ? 'Pesquisa Reddit' : 'Reddit search'}</button></div>
 <div id="add-sub-list"><p>Paste subreddit names, combined feeds, search URLs or import OPML/TXT/JSON.</p><label class="field">Subreddits / URLs<textarea id="add-urls" rows="6" placeholder="r/technology\nhttps://www.reddit.com/r/science/\nhttps://www.reddit.com/search/?q=Mark+Knopfler&amp;sort=new"></textarea></label><div class="flex" style="margin-top:12px"><input id="import-file" type="file" accept=".opml,.xml,.txt,.json"><span class="help">OPML folders are preserved</span></div></div>
 <div id="add-search-list" hidden><p>Create a continually refreshed search subscription. Posts only; Reddit's own ranking and access restrictions apply.</p><label class="field">Search term<input id="add-search-term" type="search" maxlength="180" placeholder=""></label><label class="field" style="margin-top:12px">Sort results<select id="add-search-sort"><option value="new">Newest</option><option value="relevance">Relevance</option><option value="hot">Hot</option><option value="top">Top</option><option value="comments">Most comments</option></select></label><label class="field" style="margin-top:12px">Where to search<select id="add-search-scope"><option value="everywhere">Everywhere</option><option value="subscriptions">Your subscriptions</option></select></label></div>`, `<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="import">${icon('plus', 16)} Add feed</button>`);
}
function ruleI18n(en, pt) { return data.settings.language === 'pt-PT' ? pt : en; }
function conditionRow(index = 0) {
    const t = ruleI18n;
    return `<div class="rule-condition" data-rule-condition>
      <div class="rule-condition-top"><label class="rule-join-wrap" ${index ? '' : 'hidden'}><span>${t('Combine', 'Combinar')}</span><select data-rule-join><option value="AND">AND</option><option value="OR">OR</option></select></label>
      <label class="rule-not"><input type="checkbox" data-rule-not> NOT</label>
      <button type="button" class="icon-btn rule-remove" data-act="removeRuleCondition" title="${t('Remove condition','Remover condição')}">${icon('trash',15)}</button></div>
      <div class="rule-condition-grid"><label class="field">${t('Title or text','Título ou texto')}<select data-rule-field><option value="both">${t('Title and text','Título e texto')}</option><option value="title">${t('Only title','Apenas título')}</option><option value="text">${t('Only text','Apenas texto')}</option></select></label>
      <label class="field">${t('Operator','Operador')}<select data-rule-operator><option value="contains">${t('Contains','Contém')}</option><option value="not_contains">${t("Doesn't contain",'Não contém')}</option><option value="matches">${t('Matches (exact)','Corresponde (exato)')}</option><option value="not_matches">${t("Doesn't match (exact)",'Não corresponde (exato)')}</option></select></label></div>
      <label class="field">${t('Words or phrases','Palavras ou expressões')}<input data-rule-value maxlength="160" placeholder="${t('Enter words or phrases','Introduz palavras ou expressões')}"></label>
    </div>`;
}
function updateRuleTarget() {
    const event = document.querySelector('#rule-event')?.value;
    const wrapper = document.querySelector('#rule-target-wrap');
    const target = document.querySelector('#rule-target');
    if (!wrapper || !target) return;
    wrapper.hidden = event === 'all';
    const items = event === 'folder' ? data.folders : data.feeds;
    target.innerHTML = items.map(item => `<option value="${e(item.id)}">${e(item.name)}</option>`).join('');
    target.disabled = !items.length && event !== 'all';
    document.querySelector('#rule-target-empty')?.remove();
    if (event !== 'all' && !items.length) wrapper.insertAdjacentHTML('beforeend', `<p class="help" id="rule-target-empty">${ruleI18n('Create a folder or feed first.','Cria primeiro uma pasta ou um feed.')}</p>`);
}
function rulesModal(editId = null) {
    const t = ruleI18n;
    const existing = data.settings.notificationRules || [];
    const editing = existing.find(rule => rule.id === editId) || null;
    const desc = rule => {
        const event = rule.event === 'new_post' ? (rule.feedId === '*' ? 'all' : 'feed') : rule.event;
        const target = rule.targetId ?? rule.feedId;
        const scope = event === 'all' ? t('All feeds', 'Todos os feeds') :
            event === 'folder' ? (data.folders.find(f => f.id === target)?.name || t('Deleted folder','Pasta eliminada')) :
            (data.feeds.find(f => f.id === target)?.name || t('Deleted feed','Feed eliminado'));
        const cs = rule.conditions || (rule.keyword ? [{value:rule.keyword}] : []);
        return `${e(scope)} · ${cs.length} ${t('conditions','condições')}`;
    };
    modal(t('Notification rules','Regras de notificações'), `<p>${t('Show desktop notifications when new posts are discovered. Older items do not generate repeated alerts.', 'Envia notificações quando forem descobertas novas publicações. As publicações antigas não geram alertas repetidos.')}</p>
      <div class="rule-list">${existing.map(rule => `<div class="rule-row"><label><input type="checkbox" data-rule-enable="${e(rule.id)}" ${rule.enabled ? 'checked' : ''}><strong>${e(rule.name)}</strong><small>${desc(rule)}</small></label><div class="rule-row-buttons"><button type="button" class="btn small" data-act="editRule" data-id="${e(rule.id)}">${icon('edit',14)} ${t('Edit','Editar')}</button><button type="button" class="btn small" data-act="testRule" data-id="${e(rule.id)}">${icon('check',14)} ${t('Test','Testar')}</button><button type="button" class="btn small" data-act="deleteRule" data-id="${e(rule.id)}">${icon('trash',14)} ${t('Remove','Remover')}</button></div></div>`).join('') || `<p class="help">${t('No notification rules configured.','Ainda não existem regras de notificações.')}</p>`}</div>
      <h3>${editing ? t('Edit notification rule','Editar regra de notificação') : t('Add notification rule','Adicionar regra de notificação')}</h3>
      <label class="field">${t('Rule name','Nome da regra')}<input id="rule-name" maxlength="80" placeholder="${t('New article notification','Notificação de nova publicação')}"></label>
      <div class="rule-section-title">EVENT</div>
      <label class="field">${t('When','Quando')}<select id="rule-event"><option value="all">${t('New article in all feeds','Nova publicação em todos os feeds')}</option><option value="folder">${t('New article in a folder','Nova publicação numa pasta')}</option><option value="feed">${t('New article in a feed','Nova publicação num feed')}</option></select></label>
      <label class="field" id="rule-target-wrap" hidden>${t('Choose:','Escolher:')}<select id="rule-target"></select></label>
      <div class="rule-section-title">THEN</div>
      <p class="help">${t('Optional text conditions. AND is evaluated before OR; NOT reverses an individual condition. “Matches” compares an entire field exactly.', 'Condições de texto opcionais. AND tem prioridade sobre OR; NOT inverte uma condição. «Corresponde» compara exatamente o campo completo.')}</p>
      <div id="rule-conditions"></div><button type="button" class="btn small rule-add" data-act="addRuleCondition">${icon('plus',15)} ${t('Add condition (AND / OR / NOT)','Adicionar condição (AND / OR / NOT)')}</button>
      <div class="rule-section-title">ACTION</div>
      <label class="rule-action"><input type="checkbox" id="rule-action-desktop" checked> ${t('Send desktop notification','Enviar notificação no ambiente de trabalho')}</label>
      <p class="help">${t('The browser may ask for notification permission. Up to three notifications are sent per refresh cycle.','O navegador poderá pedir autorização para notificações. São enviadas até três notificações por atualização.')}</p>`,
      `<button class="btn" data-act="closeModal">${t('Close','Fechar')}</button><button class="btn primary" data-act="${editing ? 'saveRule' : 'createRule'}" ${editing ? `data-id="${e(editing.id)}"` : ''}>${icon('bell',15)} ${editing ? t('Save changes','Guardar alterações') : t('Create rule','Criar regra')}</button>`);
    updateRuleTarget();
    if (editing) {
        document.querySelector('#rule-name').value = editing.name;
        const event = editing.event === 'new_post' ? (editing.feedId === '*' ? 'all' : 'feed') : editing.event;
        document.querySelector('#rule-event').value = event;
        updateRuleTarget();
        if (event !== 'all') document.querySelector('#rule-target').value = editing.targetId ?? editing.feedId ?? '';
        document.querySelector('#rule-action-desktop').checked = editing.action !== 'none';
        const conditions = editing.conditions || (editing.keyword ? [{field:'both', operator:'contains', value:editing.keyword, join:'AND', not:false}] : []);
        const list = document.querySelector('#rule-conditions');
        list.innerHTML = conditions.map((_,i) => conditionRow(i)).join('');
        conditions.forEach((c,i) => {
            const row = list.children[i];
            row.querySelector('[data-rule-field]').value = c.field || 'both';
            row.querySelector('[data-rule-operator]').value = c.operator || 'contains';
            row.querySelector('[data-rule-value]').value = c.value || '';
            row.querySelector('[data-rule-join]').value = c.join || 'AND';
            row.querySelector('[data-rule-not]').checked = !!c.not;
        });
    }
}
async function importFiles(file) { const content = await file.text(); if (/\.(opml|xml)$/i.test(file.name))
    return parseOPML(content); if (/\.json$/i.test(file.name)) {
    const j = JSON.parse(content);
    if (j.format === 'substream-backup-v1' && Array.isArray(j.feeds))
        return { items: j.feeds.map((f) => ({ subreddit: f.subreddit, name: f.name || 'r/' + f.subreddit, folderPath: Array.isArray(f.folderPath) ? f.folderPath : [] })), errors: [] };
    if (Array.isArray(j))
        return parseLines(j.join('\n'));
    if (j.format === 'reddit-reader-complete-v3' || j.format === 'reddit-reader-complete-v2' || j.format === 'reddit-reader-encrypted-v2')
        throw new Error(data?.settings?.language === 'pt-PT' ? 'Esta é uma cópia completa. Restaura-a em Definições → Cópia de segurança e restauro.' : 'This is a complete backup. Restore it in Settings → Backup & restore.');
    throw new Error('JSON must contain a list of feed URLs or a legacy feed-only backup');
} return parseLines(content); }
function allFolderPaths() { const map = new Map(data.folders.map(f => [f.id, f])); const path = (id) => { const nodes = []; const seen = new Set(); let curr = id; while (curr && !seen.has(curr)) {
    seen.add(curr);
    const folder = map.get(curr);
    if (!folder)
        break;
    nodes.unshift(folder.name);
    curr = folder.parentId;
} return nodes; }; return data.feeds.map(f => ({ ...f, folderPath: path(f.folderId) })); }
async function exportFile(opml = false) {
    const feeds = allFolderPaths();
    let value = '', type = '', filename = '';
    if (opml) {
        const nest = { feeds: [], dirs: new Map() };
        for (const feed of feeds) {
            let dest = nest;
            for (const name of feed.folderPath) {
                if (!dest.dirs.has(name))
                    dest.dirs.set(name, { feeds: [], dirs: new Map() });
                dest = dest.dirs.get(name);
            }
            dest.feeds.push(feed);
        }
        const encode = (v) => e(v);
        const walk = (node, level = 2) => [...Array.from(node.dirs.entries()).map(([name, child]) => `${' '.repeat(level)}<outline text="${encode(name)}" title="${encode(name)}">\n${walk(child, level + 2)}${' '.repeat(level)}</outline>\n`), ...node.feeds.map((f) => `${' '.repeat(level)}<outline text="${encode(f.name)}" type="rss" xmlUrl="${e(feedOpenUrl(f))}" htmlUrl="${e(feedOpenUrl(f))}" />\n`)].join('');
        value = `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>Reddit Reader subscriptions</title></head><body>\n${walk(nest)}</body></opml>`;
        type = 'text/xml';
        filename = 'reddit-reader-feeds.opml';
    }
    else {
        try {
            const archive = await send('exportFullBackup');
            if (archive?.format !== 'reddit-reader-complete-v3' || !archive.settings || !archive.credentials)
                throw new Error('Incomplete backup');
            value = JSON.stringify(archive, null, 2);
            type = 'application/json';
            filename = 'reddit-reader-complete-v3-' + new Date().toISOString().slice(0,10) + '.json';
            toast(data.settings.language === 'pt-PT' ? 'Atenção: inclui tokens privados sem encriptação. Não partilhar.' : 'Warning: contains private tokens without encryption. Do not share.');
        } catch(err) { toast(String(err?.message || err)); return; }
    }
    const href = URL.createObjectURL(new Blob([value], { type }));
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    toast('Exported ' + filename);
}
/** Click opens a native-feeling overlay without navigating or replacing reader contents. */
function closePostPreview() {
    document.querySelector('.post-dialog-backdrop')?.remove();
    document.dispatchEvent(new Event('reddit-reader:hide-hover'));
    document.body.classList.remove('post-dialog-open');
}
/** A detail response can contain a full gallery even when the original feed
 * listing contained just a thumbnail or one preview image. */
function detailMediaChanged(post, details) {
    if (details.video && details.video !== post.video) return true;
    const newer = Array.isArray(details.images) ? details.images : [];
    const older = Array.isArray(post.images) ? post.images : [];
    return newer.length > 0 && (newer.length !== older.length || newer.some((url, i) => url !== older[i]));
}
function postDialogMedia(post) {
    const video = post.video ? `<video src="${e(post.video)}" ${post.thumbnail ? `poster="${e(post.thumbnail)}"` : ''} controls preload="metadata" playsinline></video>` : '';
    // Expanded details require an explicit magnifier hover. The image itself
    // does NOT carry data-media-zoom, so ordinary movement never starts HoverZoom.
    const imageFrame = (src, alt, fallback = '') => `<div class="detail-media-frame"><img src="${e(src)}" alt="${e(alt)}" loading="lazy" referrerpolicy="no-referrer" ${fallback && fallback !== src ? `data-image-fallback="${e(fallback)}"` : ''}><button type="button" class="detail-media-magnifier" data-media-zoom="${e(src)}" data-media-title="${e(post.title)}" aria-label="${e(data.settings?.language === 'pt-PT' ? 'Ampliar imagem' : 'Enlarge image')}" title="${e(data.settings?.language === 'pt-PT' ? 'Ampliar imagem' : 'Enlarge image')}"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button></div>`;
    const images = post.video ? '' : post.images.length ? post.images.slice(0, 30).map((src, index) => imageFrame(src, 'Post image', index === 0 ? post.thumbnail : '')).join('') : post.thumbnail ? imageFrame(post.thumbnail, 'Post thumbnail') : '';
    // An external/link post gets an integrated dark link footer below its media.
    // Never treat Reddit self-posts or invalid protocols as outbound links.
    let external = '';
    try {
        const href = new URL(post.url || '');
        const permalink = new URL(post.permalink || '', 'https://www.reddit.com');
        if (['https:', 'http:'].includes(href.protocol) && href.href.replace(/\/$/, '') !== permalink.href.replace(/\/$/, '') && !(['www.reddit.com', 'reddit.com', 'old.reddit.com'].includes(href.hostname) && href.pathname === permalink.pathname)) {
            const readable = href.hostname.replace(/^www\./, '') + href.pathname + href.search;
            external = `<a class="post-media-link-footer" href="${e(href.href)}" target="_blank" rel="noopener noreferrer" title="${e(post.title || readable)}"><span class="post-media-link-name">${e(post.title || readable)}</span><span class="post-media-link-url">${e(readable)}</span>${icon('external', 16)}</a>`;
        }
    } catch { /* Invalid provider URLs must not be rendered as clickable links. */ }
    return video || images ? `<div class="post-dialog-gallery">${video}${images}${external}</div>` : external ? `<div class="post-dialog-gallery post-dialog-link-only">${external}</div>` : '';
}
/** Provider-controlled iframes; no arbitrary HTML/iframe markup from Reddit. */
function postDialogEmbeds(post, text = post.text) {
    const embeds = embedsFromPost(post.url, text);
    if (!embeds.length)
        return '';
    return `<div class="post-dialog-embeds">${embeds.map(embed => `<div class="post-dialog-embed" data-provider="${e(embed.provider)}"><div class="post-dialog-embed-head"><strong>Embedded ${e(embed.provider)}</strong><a href="${e(embed.watchUrl)}" target="_blank" rel="noopener noreferrer">Open original ↗</a></div><iframe src="${e(embed.embedUrl)}" title="${e(embed.provider)} embedded media" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation" allow="encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope" allowfullscreen></iframe>${embed.provider === 'YouTube' ? `<div class="youtube-help">${data.settings.language === 'pt-PT' ? 'Se surgir o erro 153, o navegador está a bloquear a identificação do leitor do YouTube.' : 'If this video shows Error 153, your browser is blocking YouTube player identification.'} <a href="${e(embed.watchUrl)}" target="_blank" rel="noopener noreferrer">${data.settings.language === 'pt-PT' ? 'Ver no YouTube' : 'Play on YouTube'} ↗</a></div>` : ''}</div>`).join('')}</div>`;
}
function showPostPreview(id) {
    if (layout === 'three-pane') {
        showThreePanePost(id, true);
        return;
    }
    const post = data.posts.find(p => p.id === id);
    if (!post)
        return;
    closePostPreview();
    closeFeedContextMenu();
    const box = document.createElement('div');
    box.className = 'post-dialog-backdrop';
    box.dataset.postId = id;
    box.innerHTML = `<section class="post-dialog" role="dialog" aria-modal="true" aria-labelledby="post-dialog-heading" tabindex="-1">
  <header class="post-dialog-top"><div class="post-dialog-community">${communityGlyph(post.subreddit, 'post-community')}<b style="${postLabelStyle(post)}">r/${e(post.subreddit)}</b><span>· ${dateLabel(post.createdAt)}</span></div>${articleTypographyControls()}<button class="icon-btn" title="Close preview (Esc)" data-preview-close>${icon('close', 20)}</button></header>
  <div class="post-dialog-scroll"><h2 id="post-dialog-heading" data-post-title-background="${e(post.id)}" role="link" tabindex="0" title="${e(data.settings.language === 'pt-PT' ? 'Clique para abrir no Reddit; botão do meio para segundo plano' : 'Click to open on Reddit; middle-click for background')}">${e(post.title)}</h2>
  ${detailMetadata(post)}
  ${postDialogMedia(post)}${postDialogEmbeds(post)}<div class="post-dialog-text" aria-live="polite" ${post.text ? '' : 'hidden'}>${post.text ? `<div class="reddit-markdown">${renderRedditMarkdown(post.text)}</div>` : ''}</div>
  ${commentsHtml(threePaneDetailsCache.get(id)?.comments, !threePaneDetailsCache.has(id), threePaneDetailsCache.get(id)?.note)}<p class="post-dialog-hint">${post.url !== post.permalink ? 'External link post · Full article text may only be available on the linked website.' : 'Reddit post preview · Full comments are on Reddit.'}</p></div>
  <footer class="post-dialog-actions"><button class="btn" data-preview-close>Close</button><button class="btn" data-preview-open>${icon('external', 15)} Open on Reddit in background</button><button class="btn primary" data-preview-foreground>${icon('external', 15)} Open on Reddit</button></footer>
 </section>`;
    document.body.append(box);
    sizeExpandedDialog(box);
    document.body.classList.add('post-dialog-open');
    installDialogFocus(box, { initialSelector: '[data-preview-close]' });
    applyHighlighters(box, data.settings.highlighters);
    // Opening the local preview counts as opening a post only if enabled.
    if (data.settings.markReadOnOpen && !post.read)
        void send('mark', { id, read: true }).catch(err => toast(err.message));
    // Fetch comments on explicit open, even when cached self-text and images are complete.
    const savedDetails = threePaneDetailsCache.get(id);
    void (savedDetails ? Promise.resolve(savedDetails) : send('getPostDetails', { id })).then(details => {
        threePaneDetailsCache.set(id, details);
        if (box.dataset.postId !== id || !box.isConnected)
            return;
        const textBox = box.querySelector('.post-dialog-text');
        if (textBox) {
            if (details.text) {
                textBox.innerHTML = '<div class="reddit-markdown">' + renderRedditMarkdown(details.text) + '</div>';
            }
            else if (!post.text) {
                textBox.textContent = '';
            }
            applyHighlighters(textBox, data.settings.highlighters);
            textBox.hidden = !(details.text || post.text);
        }
        const scroll = box.querySelector('.post-dialog-scroll');
        if (scroll && detailMediaChanged(post, details)) {
            const galleryMarkup = postDialogMedia({ ...post,
                images: details.images?.length ? details.images : post.images,
                video: details.video || post.video });
            const holder = document.createElement('div');
            holder.innerHTML = galleryMarkup;
            const gallery = holder.firstElementChild;
            if (gallery) {
                scroll.querySelector('.post-dialog-gallery')?.remove();
                scroll.insertBefore(gallery, scroll.querySelector('.post-dialog-embeds, .post-dialog-text'));
            }
        }
        if (scroll) {
            // Self-post text might link to media not present in the cached post.
            const markup = postDialogEmbeds(post, details.text || post.text);
            scroll.querySelector('.post-dialog-embeds')?.remove();
            if (markup) {
                const holder = document.createElement('div');
                holder.innerHTML = markup;
                const embeds = holder.firstElementChild;
                if (embeds)
                    scroll.insertBefore(embeds, scroll.querySelector('.post-dialog-text'));
            }
        }
        setComments(box, details.comments, details.note);
        applyHighlighters(box, data.settings.highlighters);
    }).catch(err => { if (box.isConnected) {
        const textBox = box.querySelector('.post-dialog-text');
        if (textBox) {
            textBox.textContent = 'Additional text unavailable: ' + String(err.message || err);
            textBox.classList.add('post-dialog-info');
        }
    } });
}
async function openPost(id, forceBackground = false, forceForeground = false) {
    const post = data.posts.find(p => p.id === id);
    if (!post)
        return;
    try {
        await chrome.tabs.create({ url: postToReddit(post), active: !forceBackground });
        if (data.settings.markReadOnOpen && !post.read)
            await action('mark', { id, read: true });
    }
    catch (err) {
        toast(err.message);
    }
}
/** Handle middle clicks on *any* part of a rendered post, not only its title.
 * The listener is delegated so it also works after filtering/layout changes.
 */
function middleClickedPostId(ev) {
    if (ev.button !== 1 || !data)
        return null;
    const target = ev.target;
    if (!(target instanceof Element) || target.closest('video')) return null;
    return target.closest('[data-post-title-background]')?.dataset.postTitleBackground || target.closest('.post-card[data-post]')?.dataset.post || target.closest('[data-three-post]')?.dataset.threePost || null;
}
document.addEventListener('mousedown', ev => { if (middleClickedPostId(ev))
    ev.preventDefault(); });
document.addEventListener('auxclick', ev => {
    const id = middleClickedPostId(ev);
    if (!id)
        return;
    ev.preventDefault();
    ev.stopPropagation();
    void openPost(id, true);
});
async function markCurrentViewRead() {
    if (!data || busy)
        return;
    const fromSection = selected;
    const remaining = filteredPosts().filter(post => !post.read);
    if (!remaining.length) {
        toast('No unread posts in this view');
        return;
    }
    let result;
    // Search and starred filters intentionally mark only the visible subset.
    if (selected === 'starred' || search || filter === 'star') {
        result = await action('markMany', { ids: remaining.map(post => post.id), read: true }, `Marked ${remaining.length} post(s) as read`);
    }
    else {
        const scope = selected.startsWith('feed:') ? 'feed' : selected.startsWith('folder:') ? 'folder' : 'all';
        const id = scope === 'feed' ? selected.slice(5) : scope === 'folder' ? selected.slice(7) : '';
        result = await action('markScope', { scope, id, read: true }, `Marked ${remaining.length} post(s) as read`);
    }
    // Only advance after the request succeeds and the fresh snapshot was loaded.
    if (result !== null && data.settings.autoNextUnreadCategory !== false && !search && filter !== 'star' && selected === fromSection && (fromSection.startsWith('feed:') || fromSection.startsWith('folder:'))) {
        const next = nextUnreadSection(fromSection, data.feeds, data.folders, data.counts);
        if (next) {
            selected = next;
            layout = viewForSection(selected, data.feeds, data.settings.layout);
            filter = 'unread';
            search = '';
            limit = 120;
            render();
        }
    }
}
/** A themed, keyboard-accessible menu, intentionally limited to sidebar feeds. */
function closeFeedContextMenu() { document.querySelector('#feed-context-menu')?.remove(); }
function showFeedContextMenu(feedId, x, y) {
    const feed = data.feeds.find(f => f.id === feedId);
    if (!feed)
        return;
    closeFeedContextMenu();
    const menu = document.createElement('div');
    menu.id = 'feed-context-menu';
    menu.className = 'feed-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `Actions for ${feed.name}`);
    menu.dataset.feedId = feedId;
    menu.innerHTML = `<div class="feed-menu-heading" title="${e(feedOpenUrl(feed, data.feeds))}">${icon('rss', 15)}<span>${e(feed.name)}</span></div>
 <button type="button" role="menuitem" data-feed-action="rename">${icon('more', 16)} Rename feed<span class="feed-menu-hint">F2</span></button>
 <div class="feed-menu-divider"></div>
 <button type="button" role="menuitem" data-feed-action="open">${icon('external', 16)} Open on Reddit</button>
 <button type="button" role="menuitem" data-feed-action="copy">${icon('link', 16)} Copy feed URL</button>
 <button type="button" role="menuitem" data-feed-action="colors">${icon('image', 16)} Subreddit label colours</button>
 <button type="button" role="menuitem" data-feed-action="frequency">${icon('refresh', 16)} Custom refresh interval</button>
 <div class="feed-menu-divider"></div>
 <button type="button" role="menuitem" class="feed-menu-delete" data-feed-action="delete">${icon('trash', 16)} Delete feed</button>
 <div class="feed-menu-divider"></div>
 <button type="button" role="menuitem" data-feed-action="properties">${icon('info', 16)} Feed properties</button>`;
    document.body.append(menu);
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - bounds.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - bounds.height - 8)) + 'px';
    menu.querySelector('[data-feed-action]')?.focus({ preventScroll: true });
}
function showFolderContextMenu(id, x, y) {
    const folder = data.folders.find(f => f.id === id);
    if (!folder)
        return;
    closeFeedContextMenu();
    const menu = document.createElement('div');
    menu.id = 'feed-context-menu';
    menu.className = 'feed-context-menu';
    menu.dataset.itemId = 'folder:' + id;
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `<div class="feed-menu-heading">${icon('folder', 15)} ${e(folder.name)}</div><button role="menuitem" data-feed-action="colors">${icon('image', 16)} Subreddit label colours</button><button role="menuitem" data-feed-action="frequency">${icon('refresh', 16)} Custom refresh interval</button>`;
    document.body.append(menu);
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - bounds.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - bounds.height - 8)) + 'px';
}
/** Read-only feed information for a single or combined subreddit subscription. */
function feedPropertiesModal(id) {
    const feed = data.feeds.find(f => f.id === id);
    if (!feed) return;
    closeFeedContextMenu();
    const url = feedOpenUrl(feed, data.feeds);
    const details = searchFeedDetails(feed.subreddit);
    let communities = [];
    if (details?.scope === 'subscriptions') {
        for (const subscribed of data.feeds) {
            if (!searchFeedDetails(subscribed.subreddit))
                communities.push(...subscribed.subreddit.split('+'));
        }
    } else if (!details) {
        communities = feed.subreddit.split('+');
    }
    communities = [...new Set(communities.map(value => value.trim()).filter(Boolean))];
    const pt = data.settings.language === 'pt-PT';
    const title = pt ? 'Propriedades do feed' : 'Feed properties';
    const body = `<div class="feed-properties">
      <div class="feed-property"><strong>${pt ? 'Título' : 'Title'}</strong><span>${e(feed.name)}</span></div>
      <div class="feed-property"><strong>${pt ? 'Ligação' : 'Link'}</strong><a class="feed-property-link" href="${e(url)}" target="_blank" rel="noopener noreferrer" title="${e(url)}">${e(url)}</a></div>
      <div class="feed-property"><strong>${pt ? 'Subreddits incluídos' : 'Subreddits included'}</strong>
        ${communities.length ? `<div class="feed-property-subreddits">${communities.map(name => `<span class="feed-property-chip">r/${e(name)}</span>`).join('')}</div>` : `<span class="muted">${pt ? 'Este feed é uma pesquisa Reddit, não uma lista fixa de subreddits.' : 'This is a Reddit search feed, not a fixed list of subreddits.'}</span>`}</div>
      ${details ? `<div class="feed-property"><strong>${pt ? 'Pesquisa' : 'Search'}</strong><span>${e(feed.searchQuery || details.query)}</span></div>` : ''}
    </div>`;
    modal(title, body, `<button class="btn" data-act="closeModal">${pt ? 'Fechar' : 'Close'}</button><a class="btn primary" href="${e(url)}" target="_blank" rel="noopener noreferrer">${icon('external', 16)} ${pt ? 'Abrir no Reddit' : 'Open on Reddit'}</a>`);
}
/** Per-feed and per-folder scheduler overrides; feed overrides always take priority. */
function refreshIntervalModal(itemId) {
    const pt = data.settings.language === 'pt-PT';
    const isFeed = itemId.startsWith('feed:');
    const item = isFeed ? data.feeds.find(f => f.id === itemId.slice(5)) : data.folders.find(f => f.id === itemId.slice(7));
    if (!item)
        return;
    closeFeedContextMenu();
    const own = item.refreshMinutes ?? null;
    const inherited = isFeed ?
        effectiveFeedRefreshMinutes({ ...item, refreshMinutes: null }, data.folders, data.settings.refreshMinutes) :
        effectiveFeedRefreshMinutes({ folderId: item.parentId, refreshMinutes: null }, data.folders, data.settings.refreshMinutes);
    const label = (v) => v === 0 ? (pt ? 'Adaptativo' : 'Adaptive') : v >= 60 && v % 60 === 0 ? `${v / 60} ${pt ? 'h' : 'h'}` : `${v} min`;
    modal(pt ? 'Intervalo de atualização' : 'Refresh interval', `<p>${pt ? 'Define a frequência com que este feed ou pasta é atualizado. As definições individuais dos feeds têm prioridade sobre as pastas.' : 'Choose how often this feed or folder refreshes. A feed-specific interval always takes priority over any folder setting.'}</p>
 <label class="field">${pt ? 'Frequência de atualização' : 'Refresh frequency'}<select id="item-refresh-minutes"><option value="inherit" ${own === null ? 'selected' : ''}>${pt ? 'Herdar intervalo' : 'Inherit interval'} (${label(inherited)})</option>${REFRESH_CHOICES.map(value => `<option value="${value}" ${value === own ? 'selected' : ''}>${label(value)}</option>`).join('')}<option value="custom" ${own !== null && !REFRESH_CHOICES.includes(own) ? 'selected' : ''}>${pt ? 'Personalizado…' : 'Custom…'}</option></select></label>
 <label class="field" id="item-custom-refresh-field" ${own === null || REFRESH_CHOICES.includes(own) ? 'hidden' : ''}>${pt ? 'Intervalo personalizado (minutos)' : 'Custom interval (minutes)'}<input type="number" id="item-custom-refresh" min="5" max="1440" step="1" value="${own !== null && !REFRESH_CHOICES.includes(own) ? own : 45}" inputmode="numeric"></label>
 <p class="help">${pt ? 'As atualizações respeitam os limites e os períodos de espera da API do Reddit.' : 'Actual refreshes respect Reddit API limits and retry delays.'}</p>`, `<button class="btn" data-act="closeModal">${pt ? 'Cancelar' : 'Cancel'}</button><button class="btn primary" data-act="saveItemRefresh">${pt ? 'Guardar intervalo' : 'Save interval'}</button>`);
    document.querySelector('.modal-backdrop').dataset.itemId = itemId;
}
async function saveItemRefresh() {
    const overlay = document.querySelector('.modal-backdrop');
    const itemId = overlay?.dataset.itemId;
    const raw = overlay?.querySelector('#item-refresh-minutes')?.value;
    if (!itemId || raw === undefined)
        return;
    const custom = overlay?.querySelector('#item-custom-refresh')?.value || '';
    const refreshMinutes = raw === 'inherit' ? null : Number(raw === 'custom' ? custom : raw);
    if (raw === 'custom' && (!custom.trim() || !Number.isInteger(Number(custom)) || Number(custom) < 5)) {
        toast('Custom interval must be at least 5 minutes');
        return;
    }
    if (refreshMinutes !== null && !(refreshMinutes === 0 || (Number.isInteger(refreshMinutes) && refreshMinutes >= 5 && refreshMinutes <= 1440))) {
        toast('Interval must be a whole number between 5 and 1440 minutes');
        return;
    }
    const result = itemId.startsWith('feed:') ?
        await action('patchFeed', { id: itemId.slice(5), patch: { refreshMinutes } }) :
        await action('editFolder', { id: itemId.slice(7), patch: { refreshMinutes } });
    if (result !== null)
        overlay?.remove();
}
/** Custom in-extension picker: unlike the OS <input type=color> dialog it reliably
 * closes when clicking elsewhere and works consistently across Chrome and Brave. */
const LABEL_PRESETS = ['#ffddac', '#eaf1ff', '#f5e8ff', '#d9f6e5', '#ffe1e8', '#fff2ae', '#d8f1f7', '#e8e8e8', '#ffa783', '#9fcaff', '#c7eb99', '#dabaff', '#ffa6cd', '#fcde93', '#bdede0', '#f9f9f9'];
function colourField(key, label, value) {
    return `<div class="article-colour-field" data-colour-field="${key}"><label>${label}</label>
  <button type="button" class="article-colour-trigger" data-colour-open="${key}" aria-haspopup="true" aria-expanded="false"><span class="article-colour-sample" style="background:${e(value)}"></span><span class="article-colour-value">${e(value.toUpperCase())}</span>${icon('arrow', 14)}</button>
  <input type="hidden" id="${key}" value="${e(value)}">
  <div class="article-colour-picker" data-colour-panel="${key}" hidden role="group" aria-label="Choose ${e(label.toLowerCase())}">
   <div class="article-colour-swatches">${LABEL_PRESETS.map(c => `<button type="button" class="article-colour-swatch" data-colour-preset="${key}" data-colour-value="${c}" style="--swatch:${c}" title="${c}" aria-label="${c}"></button>`).join('')}<button type="button" class="article-colour-swatch article-colour-custom" data-colour-custom="${key}" title="${data.settings.language === 'pt-PT' ? 'Escolher cor personalizada' : 'Pick a custom colour'}" aria-label="${data.settings.language === 'pt-PT' ? 'Escolher cor personalizada' : 'Pick a custom colour'}" aria-expanded="false" aria-controls="article-custom-${key}">${icon('plus', 16)}</button></div>
   <div class="article-custom-editor" id="article-custom-${key}" hidden>
     <div class="article-colour-plane" data-colour-plane="${key}" tabindex="0" role="slider" aria-label="${data.settings.language === 'pt-PT' ? 'Saturação e luminosidade; utiliza as setas para ajustar' : 'Saturation and brightness; use arrow keys to adjust'}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><span class="article-colour-point" aria-hidden="true"></span></div>
     <label class="article-colour-hue-label">${data.settings.language === 'pt-PT' ? 'Tonalidade' : 'Hue'}<input type="range" data-colour-hue="${key}" min="0" max="359" step="1" value="210"></label>
     <div class="article-colour-bottom"><span class="article-colour-preview" aria-hidden="true"></span><input class="article-colour-hex" data-colour-hex="${key}" value="${e(value)}" maxlength="7" spellcheck="false" inputmode="text" aria-label="${data.settings.language === 'pt-PT' ? 'Cor hexadecimal' : 'Hexadecimal colour'}" placeholder="#RRGGBB"><button type="button" class="article-colour-done" data-colour-done="${key}">${data.settings.language === 'pt-PT' ? 'Concluído' : 'Done'}</button></div>
   </div>
  </div>
 </div>`;
}
function closeArticleColourPickers() {
    document.querySelectorAll('.article-colour-picker').forEach(el => el.hidden = true);
    document.querySelectorAll('[data-colour-open]').forEach(el => el.setAttribute('aria-expanded', 'false'));
}
function setArticleColourValue(id, value) {
    if (!/^#[0-9a-f]{6}$/i.test(value))
        return;
    const field = document.querySelector(`[data-colour-field="${id}"]`);
    if (!field)
        return;
    const input = field.querySelector(`#${id}`);
    if (input)
        input.value = value;
    const sample = field.querySelector('.article-colour-sample');
    if (sample)
        sample.style.backgroundColor = value;
    const text = field.querySelector('.article-colour-value');
    if (text)
        text.textContent = value.toUpperCase();
    const hex = field.querySelector('[data-colour-hex]');
    if (hex)
        hex.value = value.toUpperCase();
    syncArticleColourPicker(id, value);
}
function syncArticleColourPicker(id, value) {
    const panel = document.querySelector(`[data-colour-panel="${id}"]`);
    if (!panel || !/^#[0-9a-f]{6}$/i.test(value)) return;
    const { h, s, v } = hexToHsv(value);
    panel.dataset.hue = String(h);
    panel.dataset.saturation = String(s);
    panel.dataset.brightness = String(v);
    paintArticleColourPicker(panel);
}
function paintArticleColourPicker(panel) {
    const h = Number(panel.dataset.hue || 0);
    const s = Number(panel.dataset.saturation ?? 100);
    const v = Number(panel.dataset.brightness ?? 100);
    panel.querySelector('.article-colour-plane')?.style.setProperty('--picker-hue', `hsl(${h} 100% 50%)`);
    const point = panel.querySelector('.article-colour-point');
    if (point) { point.style.left = `${s}%`; point.style.top = `${100 - v}%`; }
    const hue = panel.querySelector('[data-colour-hue]');
    if (hue) hue.value = String(Math.round(h));
    const preview = panel.querySelector('.article-colour-preview');
    if (preview) preview.style.background = hsvToHex(h,s,v);
    const plane = panel.querySelector('.article-colour-plane');
    if (plane) { plane.setAttribute('aria-valuenow', String(Math.round(v))); plane.setAttribute('aria-valuetext', `Saturation ${Math.round(s)}%, brightness ${Math.round(v)}%`); }
}
function updateArticleColourFromPicker(panel, keepCoordinates = true) {
    const id = panel?.dataset.colourPanel || '';
    if (!id) return;
    const h = Number(panel.dataset.hue || 0), s = Number(panel.dataset.saturation ?? 100), v = Number(panel.dataset.brightness ?? 100);
    const hex = hsvToHex(h, s, v);
    // Update preview/hex/hidden form fields; retain the chosen HSV geometry.
    setArticleColourValue(id, hex);
    if (keepCoordinates) {
        panel.dataset.hue = String(h); panel.dataset.saturation = String(s); panel.dataset.brightness = String(v);
        paintArticleColourPicker(panel);
    }
}
function itemColorsModal(itemId) {
    const pt = data.settings.language === 'pt-PT';
    const item = itemId.startsWith('feed:') ? data.feeds.find(f => f.id === itemId.slice(5)) : data.folders.find(f => f.id === itemId.slice(7));
    if (!item)
        return;
    closeFeedContextMenu();
    const bg = item.sidebarBg || data.settings.sidebarItemBg || '#eaf1ff', ink = item.sidebarText || data.settings.sidebarItemText || '#10141c';
    modal('Article label colours', `<p>${pt ? 'Escolhe as cores de fundo e de texto dos nomes de subreddits nas publicações e respetivas pré-visualizações. <strong>As cores dos feeds e pastas da barra lateral não serão alteradas.</strong> As cores das pastas aplicam-se aos feeds contidos, exceto quando existe uma personalização individual.' : 'Choose the background and text colours for subreddit labels on article lists and previews. <strong>Sidebar feeds and folders will not change colour.</strong> Folder colours apply to feeds inside that folder unless individually overridden.'}</p>
 ${colourField('item-bg', 'Subreddit label background', bg)}
 ${colourField('item-ink', 'Subreddit label text', ink)}
 <label class="field" style="margin-top:13px;display:flex;flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="item-default-colors"> Use shared article label colours</label>`, `<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="saveItemColors">Save colours</button>`);
    document.querySelector('.modal-backdrop').dataset.itemId = itemId;
}
async function saveItemColors() {
    const overlay = document.querySelector('.modal-backdrop'), id = overlay?.dataset.itemId;
    if (!id)
        return;
    const reset = !!overlay?.querySelector('#item-default-colors')?.checked;
    const bg = reset ? '' : overlay?.querySelector('#item-bg')?.value || '';
    const ink = reset ? '' : overlay?.querySelector('#item-ink')?.value || '';
    const result = id.startsWith('feed:') ? await action('patchFeed', { id: id.slice(5), patch: { sidebarBg: bg, sidebarText: ink } }) : await action('editFolder', { id: id.slice(7), patch: { sidebarBg: bg, sidebarText: ink } });
    if (result !== null)
        overlay?.remove();
}
function renameFeedModal(id) {
    const feed = data.feeds.find(f => f.id === id);
    if (!feed)
        return;
    closeFeedContextMenu();
    modal('Rename feed', `<p>Choose the title shown in the sidebar and popup. The actual subreddit subscription stays unchanged.</p>
  <label class="field" for="rename-feed-title">Feed title<input id="rename-feed-title" type="text" maxlength="75" autocomplete="off" spellcheck="false" value="${e(feed.name)}" required></label>
  <p class="help">${searchFeedDetails(feed.subreddit) ? e(feedOpenUrl(feed, data.feeds)) : 'Subreddit: r/' + e(feed.subreddit)}</p>`, `<button class="btn" data-act="closeModal">Cancel</button><button class="btn primary" data-act="saveRename">${icon('check', 16)} Save title</button>`);
    const overlay = document.querySelector('.modal-backdrop');
    overlay.dataset.feedId = id;
    const input = overlay.querySelector('#rename-feed-title');
    input.focus();
    input.select();
}
async function saveRenamedFeed() {
    const overlay = document.querySelector('.modal-backdrop');
    const id = overlay?.dataset.feedId || '';
    const field = overlay?.querySelector('#rename-feed-title');
    if (!id || !field)
        return;
    let name;
    try {
        name = cleanFeedTitle(field.value);
    }
    catch (err) {
        toast(err.message);
        field.focus();
        return;
    }
    const original = data.feeds.find(f => f.id === id);
    if (!original)
        return;
    if (name !== original.name) {
        const saved = await action('patchFeed', { id, patch: { name } }, 'Feed title updated');
        if (saved === null)
            return;
    }
    overlay?.remove();
}
/** Deleting a subscription is confirmed in the same styled dialog as renaming. */
function deleteFeedModal(id) {
    const feed = data.feeds.find(f => f.id === id);
    if (!feed)
        return;
    closeFeedContextMenu();
    modal('Delete feed', `<p>Remove <strong>${e(feed.name)}</strong> (r/${e(feed.subreddit)}) from your subscriptions?</p>
  <p class="help">Posts shared with another feed and starred posts will remain in your reader. This also removes the feed from synchronized subscriptions.</p>`, `<button class="btn" data-act="closeModal">Cancel</button><button class="btn danger" data-act="confirmDeleteFeed">${icon('trash', 16)} Delete feed</button>`);
    const overlay = document.querySelector('.modal-backdrop');
    overlay.dataset.feedId = id;
    overlay.querySelector('[data-act="closeModal"]')?.focus();
}
async function confirmDeleteFeed() {
    const overlay = document.querySelector('.modal-backdrop');
    const id = overlay?.dataset.feedId || '';
    const feed = data.feeds.find(f => f.id === id);
    if (!feed)
        return;
    const removed = await action('removeFeed', { id }, 'Feed deleted');
    if (removed === null)
        return;
    overlay?.remove();
    if (selected === 'feed:' + id) {
        selected = 'all';
        filter = 'all';
        search = '';
        limit = 120;
        layout = viewForSection(selected, data.feeds, data.settings.layout);
        render();
    }
}
async function handleFeedMenuAction(command) {
    const menu = document.querySelector('#feed-context-menu');
    const id = menu?.dataset.feedId || '';
    const feed = data.feeds.find(f => f.id === id);
    const itemId = menu?.dataset.itemId || 'feed:' + id;
    if (command === 'colors')
        return itemColorsModal(itemId);
    if (command === 'frequency')
        return refreshIntervalModal(itemId);
    if (!feed)
        return;
    closeFeedContextMenu();
    if (command === 'rename')
        return renameFeedModal(id);
    if (command === 'properties')
        return feedPropertiesModal(id);
    if (command === 'delete')
        return deleteFeedModal(id);
    const url = feedOpenUrl(feed, data.feeds);
    if (command === 'open')
        await chrome.tabs.create({ url, active: false });
    if (command === 'copy') {
        try {
            await navigator.clipboard.writeText(url);
            toast('Feed URL copied');
        }
        catch {
            toast('Could not copy feed URL');
        }
    }
}
document.addEventListener('contextmenu', ev => {
    const target = ev.target instanceof Element ? ev.target.closest('.sidebar [data-select^="feed:"], .sidebar [data-select^="folder:"]') : null;
    if (!target) {
        closeFeedContextMenu();
        return;
    }
    ev.preventDefault();
    if (target.dataset.select.startsWith("folder:"))
        showFolderContextMenu(target.dataset.select.slice(7), ev.clientX, ev.clientY);
    else
        showFeedContextMenu(target.dataset.select.slice(5), ev.clientX, ev.clientY);
});
document.addEventListener('pointerdown', ev => {
    if (!(ev.target instanceof Element) || !ev.target.closest('#feed-context-menu'))
        closeFeedContextMenu();
});
document.addEventListener('scroll', ev => {
    if (ev.target instanceof Element && ev.target.closest('.sidebar'))
        closeFeedContextMenu();
}, true);
async function onClick(ev) {
    if (ev.button !== 0 || !(ev.target instanceof Element))
        return;
    // Left-clicking expanded titles opens the Reddit post in the foreground.
    // Keep the existing delegated middle-click action for background tabs.
    const expandedTitle = ev.target.closest('[data-post-title-background]');
    if (expandedTitle) {
        ev.preventDefault();
        await openPost(expandedTitle.dataset.postTitleBackground, false, true);
        return;
    }
    const previewClose = ev.target.closest('[data-preview-close]');
    if (previewClose) {
        ev.preventDefault();
        closePostPreview();
        return;
    }
    const previewForeground = ev.target.closest('[data-preview-foreground]');
    if (previewForeground) {
        ev.preventDefault();
        const id = document.querySelector('.post-dialog-backdrop')?.dataset.postId || '';
        if (id)
            await openPost(id, false, true);
        return;
    }
    const previewOpen = ev.target.closest('[data-preview-open]');
    if (previewOpen) {
        ev.preventDefault();
        const id = document.querySelector('.post-dialog-backdrop')?.dataset.postId || '';
        if (id)
            await openPost(id, true);
        return;
    }
    const pickerToggle = ev.target.closest('[data-colour-open]');
    if (pickerToggle) {
        ev.preventDefault();
        const key = pickerToggle.dataset.colourOpen || '';
        const panel = document.querySelector(`[data-colour-panel="${key}"]`);
        const shouldOpen = Boolean(panel?.hidden);
        closeArticleColourPickers();
        if (panel) {
            panel.hidden = !shouldOpen;
            pickerToggle.setAttribute('aria-expanded', String(shouldOpen));
        }
        return;
    }
    const pickerCustom = ev.target.closest('[data-colour-custom]');
    if (pickerCustom) {
        ev.preventDefault();
        const picker = pickerCustom.closest('.article-colour-picker');
        const custom = picker?.querySelector('.article-custom-editor');
        if (custom) {
            custom.hidden = !custom.hidden;
            pickerCustom.setAttribute('aria-expanded', String(!custom.hidden));
            if (!custom.hidden) {
                syncArticleColourPicker(picker.dataset.colourPanel, picker.closest('.article-colour-field')?.querySelector('input[type="hidden"]')?.value || '#ffddac');
                custom.querySelector('.article-colour-plane')?.focus({ preventScroll: true });
            }
        }
        return;
    }
    const pickerDone = ev.target.closest('[data-colour-done]');
    if (pickerDone) { ev.preventDefault(); closeArticleColourPickers(); return; }
    const pickerSwatch = ev.target.closest('[data-colour-preset]');
    if (pickerSwatch) {
        ev.preventDefault();
        setArticleColourValue(pickerSwatch.dataset.colourPreset || '', pickerSwatch.dataset.colourValue || '');
        closeArticleColourPickers();
        return;
    }
    if (!ev.target.closest('.article-colour-picker'))
        closeArticleColourPickers();
    if (ev.target.classList.contains('post-dialog-backdrop')) {
        closePostPreview();
        return;
    }
    const menuAction = ev.target.closest('[data-feed-action]');
    if (menuAction) {
        ev.preventDefault();
        await handleFeedMenuAction(menuAction.dataset.feedAction || '');
        return;
    }
    const title = ev.target.closest('[data-three-post]');
    if (title?.dataset.threePost) {
        ev.preventDefault();
        showThreePanePost(title.dataset.threePost, true);
        return;
    }
    const target = ev.target.closest('[data-act],[data-select],[data-layout]');
    if (!target) {
        const card = ev.target.closest('.post-card[data-post]');
        if (card && !ev.target.closest('button, a, video, audio, input, textarea, select, [contenteditable="true"]')) {
            ev.preventDefault();
            showPostPreview(card.dataset.post);
        }
        return;
    }
    if (target.dataset.select) {
        const folderId = target.dataset.select.startsWith('folder:') ? target.dataset.select.slice(7) : null;
        if (folderId) {
            const now = performance.now();
            const doubleClick = lastFolderClick?.id === folderId && now - lastFolderClick.time < 550;
            lastFolderClick = doubleClick ? null : { id: folderId, time: now };
            if (doubleClick) {
                const collapsed = new Set(data.settings.sidebarCollapsed || []);
                if (collapsed.has(folderId)) collapsed.delete(folderId);
                else collapsed.add(folderId);
                data.settings.sidebarCollapsed = [...collapsed];
                render();
                try {
                    await send('saveSettings', { patch: { sidebarCollapsed: [...collapsed] } });
                } catch (err) {
                    toast(err.message);
                    await reload();
                }
                return;
            }
        } else {
            lastFolderClick = null;
        }
        keyboardSelectedPostId = null;
        selected = target.dataset.select;
        selectedThreePanePostId = null;
        layout = viewForSection(selected, data.feeds, data.settings.layout);
        filter = 'all';
        limit = 120;
        applyPaneWidth();
        render();
        return;
    }
    if (target.dataset.layout) {
        layout = target.dataset.layout;
        selectedThreePanePostId = null;
        if (selected.startsWith('feed:'))
            await action('patchFeed', { id: selected.slice(5), patch: { viewMode: layout } });
        else
            await action('saveSettings', { patch: { layout } });
        return;
    }
    const act = target.dataset.act, id = target.dataset.id || '';
    switch (act) {
        case 'toggleSidebarDensity': {
            sidebarDensityOpen = !sidebarDensityOpen;
            const panel = document.querySelector('#reader-rail-density-panel');
            if (panel) panel.hidden = !sidebarDensityOpen;
            target.classList.toggle('active', sidebarDensityOpen);
            target.setAttribute('aria-expanded', String(sidebarDensityOpen));
            if (sidebarDensityOpen) panel?.querySelector('input')?.focus({ preventScroll: true });
            break;
        }
        case 'expandRail':
        case 'collapseRail': {
            const collapsed = act === 'collapseRail';
            const previous = Boolean(data.settings.readerRailCollapsed);
            if (previous === collapsed) break;
            if (collapsed) sidebarDensityOpen = false;
            data.settings.readerRailCollapsed = collapsed;
            document.body.dataset.railCollapsed = String(collapsed);
            try {
                await send('saveSettings', { patch: { readerRailCollapsed: collapsed } });
            } catch (error) {
                data.settings.readerRailCollapsed = previous;
                document.body.dataset.railCollapsed = String(previous);
                toast(String(error?.message || error));
            }
            break;
        }
        case 'settings':
        case 'manage':
            openReaderSettings();
            break;
        case 'highlighters':
            openReaderSettings('highlighters');
            break;
        case 'add':
            importModal();
            break;
        case 'rules':
            rulesModal();
            break;
        case 'feedAddMode': {
            const search = target.dataset.mode === 'search';
            document.querySelector('#add-sub-list').hidden = search;
            document.querySelector('#add-search-list').hidden = !search;
            document.querySelectorAll('.add-type-tabs button').forEach(button => button.classList.toggle('selected', button === target));
            break;
        }
        case 'addRuleCondition': {
            const list = document.querySelector('#rule-conditions');
            if (list && list.children.length < 12) list.insertAdjacentHTML('beforeend', conditionRow(list.children.length));
            else toast('Maximum 12 conditions');
            break;
        }
        case 'removeRuleCondition': {
            target.closest('[data-rule-condition]')?.remove();
            document.querySelectorAll('[data-rule-condition]').forEach((el, i) => {
                el.querySelector('.rule-join-wrap').hidden = i === 0;
            });
            break;
        }
        case 'createRule':
        case 'saveRule': {
            const name = (document.querySelector('#rule-name')?.value || '').trim();
            const event = document.querySelector('#rule-event')?.value || 'all';
            const targetId = event === 'all' ? '' : document.querySelector('#rule-target')?.value || '';
            if (!name) { toast(ruleI18n('Enter a rule name','Introduz o nome da regra')); break; }
            if (event !== 'all' && !targetId) { toast(ruleI18n('Choose a feed or folder','Escolhe um feed ou uma pasta')); break; }
            if (!document.querySelector('#rule-action-desktop')?.checked) { toast(ruleI18n('Choose an action','Escolhe uma ação')); break; }
            const conditions = [];
            let valid = true;
            document.querySelectorAll('[data-rule-condition]').forEach((row, i) => {
                const value = (row.querySelector('[data-rule-value]')?.value || '').trim();
                if (!value) { valid = false; return; }
                conditions.push({
                    field: row.querySelector('[data-rule-field]').value,
                    operator: row.querySelector('[data-rule-operator]').value,
                    value,
                    join: i ? row.querySelector('[data-rule-join]').value : 'AND',
                    not: row.querySelector('[data-rule-not]').checked
                });
            });
            if (!valid) { toast(ruleI18n('Complete or remove empty conditions','Preenche ou remove as condições vazias')); break; }
            try {
                // Permission request is triggered directly by the Create rule click.
                const granted = await chrome.permissions.request({ permissions: ['notifications'] });
                if (!granted) { toast(ruleI18n('Notification permission is required','É necessária autorização para notificações')); break; }
            } catch (err) { toast(String(err)); break; }
            const current = data.settings.notificationRules || [];
            const editId = act === 'saveRule' ? target.dataset.id : null;
            const previous = editId ? current.find(rule => rule.id === editId) : null;
            if (editId && !previous) { toast(ruleI18n('Rule not found','Regra não encontrada')); break; }
            const replacement = { id: previous?.id || crypto.randomUUID(), name,
                enabled: previous?.enabled ?? true, event, targetId, conditions, action: 'desktop' };
            const next = previous ? current.map(rule => rule.id === editId ? replacement : rule) : [...current, replacement];
            const saved = await action('saveSettings', { patch: { notificationRules: next } }, previous ? 'Rule updated' : 'Notification rule added');
            if (saved !== null) rulesModal();
            break;
        }
        case 'editRule': {
            rulesModal(id);
            break;
        }
        case 'testRule': {
            const rule = (data.settings.notificationRules || []).find(r => r.id === id);
            if (!rule) { toast(ruleI18n('Rule not found','Regra não encontrada')); break; }
            try {
                const granted = await chrome.permissions.request({ permissions: ['notifications'] });
                if (!granted) { toast(ruleI18n('Notification permission is required','É necessária autorização para notificações')); break; }
                target.disabled = true;
                const result = await send('testNotificationRule', { ruleId: id });
                const pt = data.settings.language === 'pt-PT';
                toast(pt ? `${result.matches} correspondências; ${result.sent} notificações enviadas${result.capped ? ' (limite de 50 notificações por teste)' : ''}${result.failed ? `; ${result.failed} falharam` : ''}.` :
                    `${result.matches} matches; ${result.sent} notifications sent${result.capped ? ' (50 notification test limit)' : ''}${result.failed ? `; ${result.failed} failed` : ''}.`);
            } catch(err) { toast(String(err?.message || err)); }
            finally { target.disabled = false; }
            break;
        }
        case 'deleteRule': {
            const saved = await action('saveSettings', { patch: { notificationRules: (data.settings.notificationRules || []).filter(r => r.id !== id) } }, 'Rule removed');
            if (saved !== null)
                rulesModal();
            break;
        }
        case 'saveRename':
            await saveRenamedFeed();
            break;
        case 'saveItemColors':
            await saveItemColors();
            break;
        case 'confirmDeleteFeed':
            await confirmDeleteFeed();
            break;
        case 'closeModal':
            document.querySelector('.modal-backdrop')?.remove();
            break;
        case 'saveItemRefresh':
            await saveItemRefresh();
            break;
        case 'import': {
            const searchMode = !!document.querySelector('#add-search-list') && !document.querySelector('#add-search-list').hidden;
            const txt = document.querySelector('#add-urls')?.value || '';
            const file = document.querySelector('#import-file')?.files?.[0];
            const lineResult = parseLines(searchMode ? '' : txt);
            if (searchMode) {
                const term = (document.querySelector('#add-search-term')?.value || '').trim();
                const sort = document.querySelector('#add-search-sort')?.value || 'new';
                const scope = document.querySelector('#add-search-scope')?.value || 'everywhere';
                const key = searchFeedKey(term, sort, scope);
                if (!key) {
                    toast('Enter a valid search term and sorting option');
                    break;
                }
                lineResult.items.push({ subreddit: key, searchQuery: term, searchSort: sort, searchScope: scope, name: searchFeedTitle(term, sort), folderPath: [] });
            }
            try {
                if (file) {
                    const fileResult = await importFiles(file);
                    lineResult.items.push(...fileResult.items);
                    lineResult.errors.push(...fileResult.errors);
                }
                if (!lineResult.items.length) {
                    toast('No valid feeds or searches found');
                    break;
                }
                const result = await action('import', { items: lineResult.items });
                document.querySelector('.modal-backdrop')?.remove();
                if (result)
                    toast(`Added ${result.added} feed(s), ${result.duplicates} already subscribed; ${lineResult.errors.length} unsupported`);
            }
            catch (err) {
                toast(String(err));
            }
            break;
        }
        case 'newFolder': {
            const name = prompt('Folder name');
            if (name?.trim())
                await action('addFolder', { name: name.trim(), parentId: null }, 'Folder added');
            break;
        }
        case 'refreshAllSidebar': {
            if (currentViewRefreshPending || refreshBarVisible()) break;
            const feedIds = data.feeds.map(feed => feed.id);
            if (!feedIds.length) break;
            currentViewRefreshPending = true;
            updateProgressBar();
            try {
                const result = await action('refreshView', { feedIds });
                if (result?.alreadyRunning) toast(data.settings.language === 'pt-PT' ? 'Já está a decorrer uma atualização.' : 'An update is already running.');
                else if (result && !result.queued && result.reason) toast(result.reason);
            } finally {
                currentViewRefreshPending = false;
                updateProgressBar();
            }
            break;
        }
        case 'refresh': {
            const feedIds = currentViewRefreshFeedIds();
            if (!feedIds.length) {
                toast(data.settings.language === 'pt-PT' ? 'Não há feeds para atualizar nesta vista.' : 'No feeds to refresh in this view.');
                break;
            }
            if (currentViewRefreshPending || refreshBarVisible()) break;
            currentViewRefreshPending = true;
            updateProgressBar();
            try {
                const result = await action('refreshView', { feedIds });
                if (result?.alreadyRunning) toast(data.settings.language === 'pt-PT' ? 'Já está a decorrer uma atualização.' : 'An update is already running.');
                else if (result && !result.queued && result.reason) toast(result.reason);
            } finally {
                currentViewRefreshPending = false;
                updateProgressBar();
            }
            break;
        }
        case 'markAll':
            await markCurrentViewRead();
            break;
        case 'read': {
            const post = data.posts.find(p => p.id === id);
            if (post)
                await action('mark', { id, read: !post.read });
            break;
        }
        case 'star': {
            const post = data.posts.find(p => p.id === id);
            if (post)
                await action('star', { id, starred: !post.starred });
            break;
        }
        case 'expand':
            expanded.has(id) ? expanded.delete(id) : expanded.add(id);
            renderPosts();
            break;
        case 'open':
            await openPost(id, false, true);
            break;
        case 'threePaneBackground':
            await openPost(id, true);
            break;
        case 'threePaneForeground':
            await openPost(id, false, true);
            break;
        case 'threePaneRead': {
            const post = data.posts.find(p => p.id === id);
            if (post)
                await action('mark', { id, read: !post.read });
            break;
        }
        case 'threePaneStar': {
            const post = data.posts.find(p => p.id === id);
            if (post)
                await action('star', { id, starred: !post.starred });
            break;
        }
        case 'preview':
            showPostPreview(id);
            break;
        case 'more':
            limit += 120;
            renderPosts();
            break;
        case 'exportOPML':
            exportFile(true);
            break;
        case 'exportJSON':
            exportFile(false);
            break;
    }
}
document.addEventListener('change', ev => {
    if (!(ev.target instanceof HTMLSelectElement) || ev.target.id !== 'item-refresh-minutes')
        return;
    const field = document.querySelector('#item-custom-refresh-field');
    if (field)
        field.hidden = ev.target.value !== 'custom';
});
/** Pointer-based saturation/brightness palette. Only the active plane captures moves. */
function updateArticlePlane(pointer, plane) {
    const bounds = plane.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pct = (coordinate, start, length) => Math.max(0, Math.min(100, (coordinate - start) / length * 100));
    const panel = plane.closest('.article-colour-picker');
    panel.dataset.saturation = String(pct(pointer.clientX, bounds.left, bounds.width));
    panel.dataset.brightness = String(100 - pct(pointer.clientY, bounds.top, bounds.height));
    updateArticleColourFromPicker(panel);
}
document.addEventListener('pointerdown', ev => {
    const plane = ev.target.closest?.('[data-colour-plane]');
    if (!plane || ev.button !== 0) return;
    ev.preventDefault();
    plane.setPointerCapture(ev.pointerId);
    updateArticlePlane(ev, plane);
});
document.addEventListener('pointermove', ev => {
    const plane = ev.target.closest?.('[data-colour-plane]');
    if (plane?.hasPointerCapture(ev.pointerId)) updateArticlePlane(ev, plane);
});
document.addEventListener('pointerup', ev => {
    const plane = ev.target.closest?.('[data-colour-plane]');
    if (plane?.hasPointerCapture(ev.pointerId)) plane.releasePointerCapture(ev.pointerId);
});
document.addEventListener('input', ev => {
    const hue = ev.target.closest?.('[data-colour-hue]');
    if (!hue) return;
    const panel = hue.closest('.article-colour-picker');
    panel.dataset.hue = String(Number(hue.value));
    updateArticleColourFromPicker(panel);
});
document.addEventListener('keydown', ev => {
    const plane = ev.target.closest?.('[data-colour-plane]');
    if (!plane || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(ev.key)) return;
    ev.preventDefault();
    const panel = plane.closest('.article-colour-picker');
    const step = ev.shiftKey ? 10 : 2;
    const bounded = n => Math.max(0, Math.min(100, n));
    if (ev.key === 'ArrowLeft') panel.dataset.saturation = String(bounded(Number(panel.dataset.saturation || 0) - step));
    if (ev.key === 'ArrowRight') panel.dataset.saturation = String(bounded(Number(panel.dataset.saturation || 0) + step));
    if (ev.key === 'ArrowUp') panel.dataset.brightness = String(bounded(Number(panel.dataset.brightness || 0) + step));
    if (ev.key === 'ArrowDown') panel.dataset.brightness = String(bounded(Number(panel.dataset.brightness || 0) - step));
    updateArticleColourFromPicker(panel);
});
document.addEventListener('input', ev => {
    if (!(ev.target instanceof HTMLInputElement) || !ev.target.matches('[data-colour-hex]'))
        return;
    const value = ev.target.value.trim();
    if (/^#[0-9a-f]{6}$/i.test(value))
        setArticleColourValue(ev.target.dataset.colourHex || '', value);
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape')
    closeArticleColourPickers(); });
document.addEventListener('click', onClick);
document.addEventListener('keydown', event => {
    if (!(event.target instanceof Element) || !event.target.matches('[data-post-title-background]')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void openPost(event.target.dataset.postTitleBackground, false, true);
});
let dragging = null;
let dragSourceNode = null;
let previewMove = null;
let lastPreviewKey = '';
let dropped = false;
function allSidebarNodes() { return [...document.querySelectorAll('.sidebar .sidebar-node[data-sidebar-node]')]; }
function animateSidebarShuffle(before) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches)
        return;
    for (const node of allSidebarNodes()) {
        if (node === dragSourceNode)
            continue;
        const old = before.get(node);
        if (!old)
            continue;
        const now = node.getBoundingClientRect(), dx = old.left - now.left, dy = old.top - now.top;
        if (Math.abs(dx) + Math.abs(dy) < 1)
            continue;
        node.getAnimations().forEach(animation => animation.cancel());
        node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 190, easing: 'cubic-bezier(.2,.75,.24,1)' });
    }
}
function sidebarDropCandidate(ev) {
    if (!dragging || !dragSourceNode || !(ev.target instanceof Element))
        return null;
    const element = ev.target;
    const target = element.closest('.sidebar-node[data-sidebar-node]');
    if (!target) {
        if (element.closest('.sidebar-tree, .side-section'))
            return { destination: '', placement: 'root', target: null };
        return null;
    }
    if (target === dragSourceNode || dragSourceNode.contains(target))
        return null;
    const destination = target.dataset.sidebarNode || '';
    if (!destination.startsWith('feed:') && !destination.startsWith('folder:'))
        return null;
    const header = target.querySelector(':scope > .folder-header > .nav-item, :scope > .nav-item');
    const box = (header || target).getBoundingClientRect();
    const relative = (ev.clientY - box.top) / Math.max(1, box.height);
    const inside = destination.startsWith('folder:') && relative >= .32 && relative <= .68 && ev.clientX > box.left + 20;
    return { destination, placement: inside ? 'inside' : relative < .5 ? 'before' : 'after', target };
}
function liveSidebarMove(candidate) {
    if (!dragSourceNode)
        return;
    const key = `${candidate.destination}|${candidate.placement}`;
    if (key === lastPreviewKey)
        return;
    let container = null;
    let reference = null;
    if (candidate.placement === 'root')
        container = document.querySelector('.sidebar-tree');
    else if (candidate.placement === 'inside') {
        container = candidate.target?.querySelector(':scope > .folder-children') || null;
    }
    else {
        container = candidate.target?.parentElement || null;
        reference = candidate.placement === 'before' ? candidate.target : candidate.target?.nextElementSibling || null;
    }
    if (!container || dragSourceNode.contains(container) || dragSourceNode === reference) {
        previewMove = candidate;
        lastPreviewKey = key;
        return;
    }
    const before = new Map(allSidebarNodes().map(node => [node, node.getBoundingClientRect()]));
    container.insertBefore(dragSourceNode, reference);
    animateSidebarShuffle(before);
    previewMove = candidate;
    lastPreviewKey = key;
}
function clearSidebarDrag() {
    dragSourceNode?.classList.remove('is-dragging');
    document.querySelector('.sidebar')?.classList.remove('sidebar-reordering');
    dragging = null;
    dragSourceNode = null;
    lastPreviewKey = '';
    previewMove = null;
}
document.addEventListener('dragstart', ev => {
    const target = ev.target instanceof Element ? ev.target.closest('.sidebar .nav-item[data-select]') : null;
    const id = target?.dataset.select || '';
    if (!id.startsWith('feed:') && !id.startsWith('folder:'))
        return;
    dragging = id;
    dropped = false;
    lastPreviewKey = '';
    previewMove = null;
    dragSourceNode = target?.closest('[data-sidebar-node]') || null;
    dragSourceNode?.classList.add('is-dragging');
    document.querySelector('.sidebar')?.classList.add('sidebar-reordering');
    if (ev.dataTransfer) {
        ev.dataTransfer.setData('text/plain', id);
        ev.dataTransfer.effectAllowed = 'move';
    }
});
document.addEventListener('dragover', ev => {
    if (!dragging || !(ev.target instanceof Element) || !ev.target.closest('.sidebar'))
        return;
    ev.preventDefault();
    if (ev.dataTransfer)
        ev.dataTransfer.dropEffect = 'move';
    const position = sidebarDropCandidate(ev);
    if (!position)
        return;
    liveSidebarMove(position);
});
document.addEventListener('drop', async (ev) => {
    if (!dragging)
        return;
    if (!(ev.target instanceof Element) || !ev.target.closest('.sidebar')) {
        clearSidebarDrag();
        render();
        return;
    }
    // Read the final visual DOM placement before clearing drag state.
    // Recomputing the hover candidate after moving the DOM selected the wrong row
    // and caused visually moved items to jump back after the next reload.
    const node = dragSourceNode;
    const source = dragging;
    let final = null;
    if (node) {
        const container = node.parentElement, previous = node.previousElementSibling?.closest('.sidebar-node[data-sidebar-node]'), next = node.nextElementSibling?.closest('.sidebar-node[data-sidebar-node]');
        const parentId = container?.closest('.folder-node[data-sidebar-node]')?.dataset.sidebarNode;
        if (previous?.dataset.sidebarNode)
            final = { destination: previous.dataset.sidebarNode, placement: 'after', target: previous };
        else if (next?.dataset.sidebarNode)
            final = { destination: next.dataset.sidebarNode, placement: 'before', target: next };
        else if (parentId)
            final = { destination: parentId, placement: 'inside', target: null };
        else
            final = { destination: '', placement: 'root', target: null };
    }
    dropped = true;
    ev.preventDefault();
    clearSidebarDrag();
    if (!final) {
        render();
        return;
    }
    const result = await action('moveSidebar', { source, destination: final.destination, placement: final.placement });
    if (result === null)
        await reload();
});
document.addEventListener('dragend', () => {
    if (!dragging)
        return;
    clearSidebarDrag();
    if (!dropped)
        render();
    dropped = false;
});
/** J / Down: next post; K / Up: previous post. Never hijack text input,
 * modal dialogs, or a popup over the reader. Three Pane updates the detail
 * preview; other layouts scroll to and visually select the post. */
function navigateArticle(direction) {
    const posts = filteredPosts().slice(0, limit);
    if (!posts.length)
        return;
    const current = layout === 'three-pane' ? selectedThreePanePostId : keyboardSelectedPostId;
    const at = posts.findIndex(post => post.id === current);
    const index = at < 0 ? (direction > 0 ? 0 : posts.length - 1) : Math.max(0, Math.min(posts.length - 1, at + direction));
    const post = posts[index];
    if (!post)
        return;
    keyboardSelectedPostId = post.id;
    if (layout === 'three-pane') {
        showThreePanePost(post.id, true, true);
        const row = [...document.querySelectorAll('.three-post-row')].find(item => item.dataset.threePost === post.id);
        row?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: 'nearest' });
    }
    else {
        document.querySelectorAll('.post-card.keyboard-selected').forEach(card => card.classList.remove('keyboard-selected'));
        const card = [...document.querySelectorAll('.post-card[data-post]')].find(item => item.dataset.post === post.id);
        if (card) {
            card.classList.add('keyboard-selected');
            card.setAttribute('tabindex', '-1');
            card.focus({ preventScroll: true });
            card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }
}
let leftShiftHeld = false;
window.addEventListener('blur', () => { leftShiftHeld = false; });
document.addEventListener('keyup', ev => { if (ev.code === 'ShiftLeft')
    leftShiftHeld = false; });
document.addEventListener('keydown', ev => {
    if (ev.code === 'ShiftLeft')
        leftShiftHeld = true;
    if (ev.key === 'Escape') {
        closePostPreview();
        closeFeedContextMenu();
        document.querySelector('.modal-backdrop')?.remove();
    }
    const activeFeed = (ev.target instanceof Element ? ev.target.closest('.sidebar [data-select^="feed:"]') : null);
    if (activeFeed && (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10'))) {
        ev.preventDefault();
        const r = activeFeed.getBoundingClientRect();
        showFeedContextMenu(activeFeed.dataset.select.slice(5), r.left + 22, r.bottom - 2);
        return;
    }
    if (activeFeed && ev.key === 'F2') {
        ev.preventDefault();
        renameFeedModal(activeFeed.dataset.select.slice(5));
        return;
    }
    const menu = document.querySelector('#feed-context-menu');
    if (menu && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && menu.contains(ev.target)) {
        ev.preventDefault();
        const buttons = [...menu.querySelectorAll('[data-feed-action]')];
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (ev.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        return;
    }
    if (ev.key === 'Enter' && ev.target.id === 'rename-feed-title') {
        ev.preventDefault();
        void saveRenamedFeed();
        return;
    }
    const target = ev.target;
    const editing = !!target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') || !!document.querySelector('.modal-backdrop, .post-dialog-backdrop');
    if (!editing && !target.closest('.three-pane-resizer') && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        const key = ev.key.toLowerCase();
        if (key === 'arrowdown' || key === 'j' || key === 'arrowup' || key === 'k') {
            ev.preventDefault();
            navigateArticle(key === 'arrowdown' || key === 'j' ? 1 : -1);
            return;
        }
    }
    if (markAllReadShortcut(ev, leftShiftHeld, editing)) {
        ev.preventDefault();
        ev.stopPropagation();
        void markCurrentViewRead();
        return;
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && target.dataset?.threePost) {
        ev.preventDefault();
        target.click();
        return;
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && target?.classList?.contains('small-list-row')) {
        ev.preventDefault();
        target.click();
        return;
    }
    if (ev.key === 'Enter' && target.dataset?.act === 'preview')
        target.click();
});
document.addEventListener('error', ev => {
    const image = ev.target;
    // A full-resolution URL may occasionally be unavailable from Reddit's
    // CDN even though its lower-resolution thumbnail is still valid.
    if (image instanceof HTMLImageElement && image.closest('.post-dialog-gallery') && image.dataset.imageFallback) {
        const fallback = safeMediaUrl(image.dataset.imageFallback);
        delete image.dataset.imageFallback; // Prevent a retry loop on failure.
        if (fallback && fallback !== image.src) {
            image.src = fallback;
            const magnifier = image.closest('.detail-media-frame')?.querySelector('.detail-media-magnifier');
            if (magnifier) magnifier.dataset.mediaZoom = fallback;
            return;
        }
    }
    if (image instanceof HTMLImageElement && image.classList.contains('subreddit-favicon')) {
        image.hidden = true;
        image.nextElementSibling?.classList.remove('hidden-icon-fallback');
    }
}, true);
// Debounce expensive full-list filtering while the user is typing. The input
// itself updates immediately and retains focus; only rendering is deferred.
let searchRenderTimer = null;
app.addEventListener('input', ev => { const target = ev.target; if (target.id === 'search') {
    search = target.value;
    clearTimeout(searchRenderTimer);
    searchRenderTimer = setTimeout(() => { limit = 120; renderPosts(); }, 140);
} });
let ignoreNextReadingBroadcast = false;
document.addEventListener('change', ev => { const target = ev.target; if (target.id === 'rule-event') { updateRuleTarget(); return; } if (target.dataset.readingSetting) {
    const key = target.dataset.readingSetting;
    const value = key === 'readingFont' ? target.value : Number(target.value);
    if (typeof value === 'number' && (!Number.isFinite(value) || (key === 'readingFontSize' && (value < 10 || value > 36)) || (key === 'readingLineHeight' && (value < 1 || value > 2.5)))) {
        toast('Invalid reading setting');
        return;
    }
    const patch = { [key]: value };
    Object.assign(data.settings, patch);
    apply();
    document.querySelectorAll(`[data-reading-setting="${key}"]`).forEach(el => { el.value = String(value); });
    ignoreNextReadingBroadcast = true;
    void send('saveSettings', { patch }).catch(err => { ignoreNextReadingBroadcast = false; toast(String(err)); });
    return;
} if (target.id === 'filter') {
    filter = target.value;
    renderPosts();
} if (target.dataset.ruleEnable) {
    const changed = (data.settings.notificationRules || []).map(r => r.id === target.dataset.ruleEnable ? { ...r, enabled: target.checked } : r);
    void action('saveSettings', { patch: { notificationRules: changed } }).then(() => rulesModal());
} });
let threeResizeOrigin = 0;
document.addEventListener('pointerdown', event => {
    const handle = event.target instanceof Element ? event.target.closest('.three-pane-resizer') : null;
    if (!handle || event.button !== 0)
        return;
    threePaneResizing = true;
    threeResizeOrigin = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
});
document.addEventListener('pointermove', event => {
    if (!threePaneResizing || event.pointerId !== threeResizeOrigin)
        return;
    const grid = document.querySelector('.three-pane-layout');
    if (!grid)
        return;
    const rect = grid.getBoundingClientRect();
    const width = Math.round(Math.max(230, Math.min(rect.width - 300, event.clientX - rect.left)));
    document.body.style.setProperty('--three-list-width', width + 'px');
});
document.addEventListener('pointerup', event => {
    if (!threePaneResizing || event.pointerId !== threeResizeOrigin)
        return;
    threePaneResizing = false;
    const grid = document.querySelector('.three-pane-layout');
    if (!grid)
        return;
    const width = Math.round(Math.max(230, Math.min(grid.getBoundingClientRect().width - 300, event.clientX - grid.getBoundingClientRect().left)));
    persistPaneWidth(width);
});
document.addEventListener('keydown', event => {
    if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('three-pane-resizer'))
        return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
        return;
    event.preventDefault();
    const width = paneWidthFor() + (event.key === 'ArrowRight' ? 24 : -24);
    persistPaneWidth(width);
});
app.addEventListener('input', event => {
    const slider = event.target.closest?.('[data-sidebar-density]');
    if (slider) applySidebarDensity(slider.value);
});
app.addEventListener('change', async event => {
    if (event.target.id === 'unread-first') {
        const before = captureRowPositions();
        const enabled = event.target.checked;
        data.settings.keepUnreadOnTop = enabled;
        renderPosts();
        animateReorderedRows(before);
        try { await send('saveSettings', { patch: { keepUnreadOnTop: enabled } }); }
        catch (err) { toast(String(err)); await reload(); }
        return;
    }
    const slider = event.target.closest?.('[data-sidebar-density]');
    if (slider) await action('saveSettings', { patch: { sidebarCompactness: Number(slider.value) } });
});
let resizing = false;
document.addEventListener('pointerdown', ev => { if (ev.target.classList.contains('sidebar-resizer')) {
    resizing = true;
    ev.target.setPointerCapture(ev.pointerId);
} });
document.addEventListener('pointermove', ev => { if (resizing) {
    const width = Math.max(175, Math.min(450, ev.clientX - (document.querySelector('.reader-action-rail')?.getBoundingClientRect().width || 0))); 
    document.body.style.setProperty('--sidebar-width', width + 'px');
} });
document.addEventListener('pointerup', async (ev) => { if (resizing) {
    resizing = false;
    const width = Math.max(175, Math.min(450, ev.clientX - (document.querySelector('.reader-action-rail')?.getBoundingClientRect().width || 0))); 
    await action('saveSettings', { patch: { sidebarWidth: width } });
} });
chrome.runtime.onMessage.addListener((message) => { if (message?.type === 'stateChanged') {
    if (ignoreNextReadingBroadcast) {
        ignoreNextReadingBroadcast = false;
        return;
    }
    reload();
}
else if (message?.type === 'refreshProgressChanged') {
    liveProgress = message.progress;
    updateProgressBar();
} });
installMediaHover(toast);
installVideoControls(document);
(async () => { try {
    data = await send('getState');
    liveProgress = data.refreshProgress || liveProgress;
    layout = viewForSection(selected, data.feeds, data.settings.layout);
    filter = data.settings.hideRead ? 'unread' : 'all';
    apply();
    render();
    if (new URLSearchParams(location.search).get('add') === '1')
        importModal();
}
catch (err) {
    app.textContent = String(err);
} })();
installLocalization();

// A restore may continue after this page opens; display its persistent progress.
installRestoreRecoveryIndicator(() => data?.settings?.language || 'en');
