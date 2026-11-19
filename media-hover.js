/** Reader-only Imagus-like media zoom. The full-size original is requested first,
 * falling back to the original preview URL if Reddit cannot serve the larger file.
 * The hover panel supports post lists, expanded post dialogs, and both three-pane areas.
 */
import { safeMediaUrl, mediaDownloadName, fullResolutionMediaCandidates } from './shared.js';
const MIN_WIDTH = 220;
const DEFAULT_HOVER_DELAY_MS = 500;
const clamp = (n, lo, hi) => Math.min(Math.max(lo, n), Math.max(lo, hi));
export function installMediaHover(notify) {
    let preferences = { enabled: true, images: true, videos: false, delay: DEFAULT_HOVER_DELAY_MS, dismissDistance: 200 };
    const syncPreferences = (v) => { if (v && typeof v === 'object') {
        preferences = { enabled: v.hoverZoomEnabled !== false, images: v.hoverZoomImages !== false, videos: v.hoverZoomVideos === true, delay: Number.isFinite(v.hoverZoomDelay) ? Math.max(100, Math.min(3000, v.hoverZoomDelay)) : DEFAULT_HOVER_DELAY_MS, dismissDistance: Number.isFinite(v.hoverZoomDismissDistance) ? clamp(v.hoverZoomDismissDistance, 50, 1000) : 200 };
        if (!preferences.enabled || (!preferences.images && !preferences.videos))
            hide();
    } };
    void chrome.storage.local.get('settings').then((result) => syncPreferences(result.settings)).catch(() => { });
    const onSettingsChanged = (changes, area) => { if (area === 'local' && changes.settings?.newValue)
        syncPreferences(changes.settings.newValue); };
    chrome.storage.onChanged.addListener(onSettingsChanged);
    let source = null;
    let panel = null;
    let stage = null;
    let media = null;
    let showTimer;
    let hideTimer;
    let pinned = false;
    let panelWidth = 0, panelHeight = 0;
    let aspectRatio = 4 / 3;
    let lastX = 0, lastY = 0;
    let openedX = 0, openedY = 0;
    let activeUrl = '';
    let originalWidth = 0, originalHeight = 0;
    let dimensions = null;
    const cancelShow = () => { if (showTimer !== undefined)
        clearTimeout(showTimer); showTimer = undefined; };
    const cancelHide = () => { if (hideTimer !== undefined)
        clearTimeout(hideTimer); hideTimer = undefined; };
    function hide() { cancelShow(); cancelHide(); source = null; pinned = false; if (panel) {
        const old = panel;
        old.classList.add('media-hover-leaving');
        old.style.pointerEvents = 'none';
        window.setTimeout(() => old.remove(), 100);
    } panel = null; stage = null; media = null; activeUrl = ''; dimensions = null; originalWidth = 0; originalHeight = 0; }
    function scheduleHide() { if (pinned)
        return; cancelHide(); hideTimer = window.setTimeout(hide, 220); }
    function applySize() {
        if (!panel || !stage || !media)
            return;
        const surround = 10; // 4px padding and 1px border on each side.
        const margin = 12;
        // Ordinary hover fits on screen; a right-click pinned image can zoom beyond
        // the viewport (up to 4x its dimensions) without clipping its media stage.
        const maxWidth = pinned ? Math.min(6400, Math.max(window.innerWidth * 4, originalWidth || 0)) :
            Math.max(MIN_WIDTH, window.innerWidth - 2 * margin - surround);
        const maxHeight = pinned ? Math.min(6400, Math.max(window.innerHeight * 4, originalHeight || 0)) :
            Math.max(135, window.innerHeight - 2 * margin - surround);
        // Preserve the actual media aspect ratio as both image and panel change size.
        // The popup no longer grows around an unchanged image when using the wheel.
        panelWidth = clamp(panelWidth, MIN_WIDTH, maxWidth);
        panelHeight = panelWidth / aspectRatio;
        if (panelHeight > maxHeight) {
            panelHeight = maxHeight;
            panelWidth = Math.max(1, panelHeight * aspectRatio);
        }
        panel.style.width = `${panelWidth + surround}px`;
        panel.style.height = `${panelHeight + surround}px`;
        panel.style.maxHeight = 'none';
        stage.style.width = `${panelWidth}px`;
        stage.style.height = `${panelHeight}px`;
        stage.style.flex = 'none';
        stage.style.maxHeight = 'none';
        media.style.width = '100%';
        media.style.height = '100%';
        media.style.maxWidth = 'none';
        media.style.maxHeight = 'none';
    }
    function anchorPanel(element) {
        if (!panel || pinned)
            return;
        const bounds = element.getBoundingClientRect();
        const margin = 12, gap = 14;
        let left = bounds.right + gap;
        if (left + panelWidth > window.innerWidth - margin)
            left = bounds.left - panelWidth - gap;
        if (left < margin)
            left = Math.min(window.innerWidth - panelWidth - margin, Math.max(margin, lastX - panelWidth / 2));
        const currentHeight = panel.getBoundingClientRect().height || panelHeight;
        const top = clamp(bounds.top + (bounds.height - currentHeight) / 2, margin, window.innerHeight - currentHeight - margin);
        panel.style.left = `${Math.max(margin, left)}px`;
        panel.style.top = `${top}px`;
    }
    function moveNearPointer() {
        if (!panel || pinned)
            return;
        const gap = 18, margin = 9;
        const width = panel.getBoundingClientRect().width || panelWidth;
        const height = panel.getBoundingClientRect().height || panelHeight + 10;
        let x = lastX + gap, y = lastY + gap;
        if (x + width > window.innerWidth - margin)
            x = lastX - width - gap;
        if (y + height > window.innerHeight - margin)
            y = lastY - height - gap;
        panel.style.left = `${clamp(x, margin, Math.max(margin, window.innerWidth - width - margin))}px`;
        panel.style.top = `${clamp(y, margin, Math.max(margin, window.innerHeight - height - margin))}px`;
    }
    function centerPanel() {
        if (!panel)
            return;
        pinned = true;
        cancelHide();
        cancelShow();
        panel.classList.add('media-hover-centered');
        panel.style.left = '50%';
        panel.style.top = '50%';
    }
    function resizePanel(event) {
        if (event.target instanceof HTMLVideoElement) return;
        if (!panel || !stage || !media)
            return;
        // Once centred, scrolling anywhere in the reader can resize the pinned preview.
        if (!pinned && (!(event.target instanceof Node) || !panel.contains(event.target)))
            return;
        event.preventDefault();
        event.stopPropagation();
        // Delta can represent pixels, lines, or pages; use a bounded one-notch factor.
        const step = event.deltaY < 0 ? 1.13 : event.deltaY > 0 ? 1 / 1.13 : 1;
        if (step === 1)
            return;
        panelWidth *= step;
        applySize();
        if (!pinned && source?.isConnected)
            moveNearPointer();
    }
    function show(element) {
        if (!element.isConnected || element !== source)
            return;
        if (!directlyOverMedia(element, lastX, lastY) && !pinned && !(element.classList?.contains('detail-media-magnifier') && document.activeElement === element)) return;
        const raw = safeMediaUrl(element.dataset.mediaZoom || '');
        if (!raw)
            return;
        const kind = element.dataset.mediaKind === 'video' ? 'video' : 'image';
        const title = element.dataset.mediaTitle || 'reddit-media';
        panel?.remove();
        panel = document.createElement('div');
        panel.className = 'media-hover-panel';
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', kind === 'image' ? 'Enlarged image preview' : 'Video preview');
        panel.addEventListener('pointerenter', cancelHide);
        panel.addEventListener('pointerleave', scheduleHide);
        panel.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); centerPanel(); });
        stage = document.createElement('div');
        stage.className = 'media-hover-stage';
        media = kind === 'video' ? document.createElement('video') : document.createElement('img');
        media.className = 'media-hover-content';
        const candidates = kind === 'image' ? fullResolutionMediaCandidates(raw) : [raw];
        let candidateIndex = 0;
        activeUrl = candidates[candidateIndex];
        if (media instanceof HTMLVideoElement) {
            media.controls = true;
            media.preload = 'metadata';
            media.playsInline = true;
            media.src = activeUrl;
        }
        else {
            const image = media;
            image.alt = title;
            image.decoding = 'async';
            image.addEventListener('load', () => {
                if (!panel?.contains(image) || !image.naturalWidth || !image.naturalHeight)
                    return;
                originalWidth = image.naturalWidth;
                originalHeight = image.naturalHeight;
                if (dimensions) {
                    dimensions.textContent = `${originalWidth} × ${originalHeight}`;
                    dimensions.hidden = false;
                }
                aspectRatio = originalWidth / originalHeight;
                applySize();
                if (!pinned && source?.isConnected)
                    moveNearPointer();
            });
            image.addEventListener('error', () => {
                if (!panel?.contains(image))
                    return;
                if (candidateIndex + 1 < candidates.length) {
                    activeUrl = candidates[++candidateIndex];
                    image.src = activeUrl;
                    return;
                }
                stage.textContent = 'The original image could not be loaded. Use Original to view it in another tab.';
                stage.classList.add('media-hover-error');
            });
            image.src = activeUrl;
        }
        if (media instanceof HTMLVideoElement) {
            media.addEventListener('loadedmetadata', () => { const video = media; if (video.videoWidth && video.videoHeight) {
                aspectRatio = video.videoWidth / video.videoHeight;
                applySize();
                if (!pinned && source?.isConnected)
                    moveNearPointer();
            } });
        }
        if (media instanceof HTMLVideoElement)
            media.addEventListener('error', () => {
                if (panel?.contains(media)) {
                    stage.textContent = 'This video could not be loaded. Use Original to view it in another tab.';
                    stage.classList.add('media-hover-error');
                }
            });
        stage.append(media);
        if (kind === 'image') {
            dimensions = document.createElement('span');
            dimensions.className = 'media-hover-dimensions';
            dimensions.hidden = true;
            dimensions.title = 'Loaded image dimensions in pixels';
            panel.append(dimensions);
        }
        const tools = document.createElement('div');
        tools.className = 'media-hover-tools';
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'media-hover-tool';
        download.textContent = '↓ Download';
        download.title = 'Download full-resolution media';
        download.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            cancelHide();
            try {
                const id = await chrome.downloads.download({ url: activeUrl, filename: mediaDownloadName(title, activeUrl, kind), saveAs: false, conflictAction: 'uniquify' });
                if (id == null)
                    throw new Error('Chrome rejected the download');
                notify('Download started');
            }
            catch (error) {
                notify('Download failed: ' + String(error.message || error));
            }
        });
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'media-hover-tool';
        open.textContent = '↗ Original';
        open.title = 'Open full-size media in a background tab';
        open.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            cancelHide();
            void chrome.tabs.create({ url: activeUrl, active: false }).catch((error) => notify(String(error.message || error)));
        });
        tools.append(download, open);
        panel.append(stage, tools);
        document.body.append(panel);
        panelWidth = Math.min(820, Math.max(280, window.innerWidth * .58));
        panelHeight = Math.min(window.innerHeight * .79, 690);
        aspectRatio = 4 / 3;
        pinned = false;
        openedX = lastX; openedY = lastY;
        applySize();
        moveNearPointer();
    }
    function directlyOverMedia(element, x, y) {
        const explicitDetailMagnifier = element instanceof HTMLButtonElement && element.classList.contains('detail-media-magnifier');
        if (!(explicitDetailMagnifier || element instanceof HTMLImageElement || element instanceof HTMLVideoElement)) return false;
        const r = element.getBoundingClientRect();
        if (x < r.left || x >= r.right || y < r.top || y >= r.bottom || !r.width || !r.height) return false;
        // object-fit: contain adds transparent/letterboxed space around media.
        const style = getComputedStyle(element);
        if (!explicitDetailMagnifier && style.objectFit === 'contain') {
            const w = element instanceof HTMLImageElement ? element.naturalWidth : element.videoWidth;
            const h = element instanceof HTMLImageElement ? element.naturalHeight : element.videoHeight;
            if (w > 0 && h > 0) {
                const scale = Math.min(r.width / w, r.height / h);
                const iw = w * scale, ih = h * scale;
                const ox = (r.width - iw) / 2, oy = (r.height - ih) / 2;
                if (x < r.left + ox || x > r.left + ox + iw || y < r.top + oy || y > r.top + oy + ih) return false;
            }
        }
        // Verify the actual element under the pointer, never just its ancestor.
        const hit = document.elementFromPoint(x, y);
        return hit === element || (explicitDetailMagnifier && hit instanceof Node && element.contains(hit));
    }
    function sourceFor(target) {
        const el = target instanceof Element ? target.closest('.post-list .post-card [data-media-zoom], .post-dialog-backdrop .post-dialog-gallery .detail-media-magnifier[data-media-zoom], .three-pane-list [data-media-zoom], .three-pane-detail .post-dialog-gallery .detail-media-magnifier[data-media-zoom]') : null;
        const isVideo = el?.dataset.mediaKind === 'video';
        const validSource = el instanceof HTMLImageElement || el instanceof HTMLVideoElement || (el instanceof HTMLButtonElement && el.classList.contains('detail-media-magnifier'));
        return preferences.enabled && validSource && (isVideo ? preferences.videos : preferences.images) && safeMediaUrl(el.dataset.mediaZoom || '') ? el : null;
    }
    function pointerOver(event) {
        if (event.pointerType === 'touch')
            return;
        lastX = event.clientX;
        lastY = event.clientY;
        if (event.target instanceof Element && panel?.contains(event.target)) {
            cancelHide();
            return;
        }
        if (pinned)
            return;
        const next = sourceFor(event.target);
        if (!next || !directlyOverMedia(next, event.clientX, event.clientY)) {
            if (source && !pinned) scheduleHide();
            return;
        }
        cancelHide();
        if (source === next) {
            if (panel)
                moveNearPointer();
            return;
        }
        cancelShow();
        panel?.remove();
        panel = null;
        source = next;
        showTimer = window.setTimeout(() => show(next), preferences.delay);
    }
    function pointerMove(event) { if (event.pointerType === 'touch')
        return; lastX = event.clientX; lastY = event.clientY;
        // A pinned, right-clicked preview stays open until explicitly dismissed.
        if (panel && !pinned && Math.hypot(lastX - openedX, lastY - openedY) > preferences.dismissDistance) {
            hide();
            return;
        }
        if (!pinned && source && !directlyOverMedia(source, lastX, lastY) && !(event.target instanceof Node && panel?.contains(event.target))) {
            cancelShow(); scheduleHide();
        }
        if (panel && !pinned && !(event.target instanceof Node && panel.contains(event.target)))
        moveNearPointer(); }
    function pointerOut(event) {
        if (!source || pinned)
            return;
        const target = event.target;
        if (!(target instanceof Element))
            return;
        const related = event.relatedTarget;
        if (panel?.contains(target)) {
            if (related instanceof Node && (panel.contains(related) || source.contains(related)))
                return;
            scheduleHide();
            return;
        }
        if (source.contains(target)) {
            if (related instanceof Node && (source.contains(related) || panel?.contains(related)))
                return;
            scheduleHide();
        }
    }
    function focusIn(event) { if (pinned)
        return; const next = sourceFor(event.target); if (next) {
        cancelHide();
        cancelShow();
        source = next;
        showTimer = window.setTimeout(() => show(next), preferences.delay);
    } }
    function keydown(event) { if (event.key === 'Escape' && panel) {
        event.stopPropagation();
        hide();
    } }
    function clickOutside(event) { if (event.button === 2)
        return; if (pinned && panel && event.target instanceof Node && !panel.contains(event.target))
        hide(); }
    function rightClickAnywhere(event) {
        if (!panel)
            return;
        event.preventDefault();
        event.stopPropagation();
        centerPanel();
    }
    function scroll(event) { if (!pinned && panel && !(event.target instanceof Node && panel.contains(event.target)))
        hide(); }
    function resizeWindow() { if (panel) {
        applySize();
        if (!pinned && source?.isConnected)
            moveNearPointer();
    } }
    document.addEventListener('pointerover', pointerOver);
    document.addEventListener('pointermove', pointerMove, { passive: true });
    document.addEventListener('pointerout', pointerOut);
    document.addEventListener('pointerdown', clickOutside, true);
    document.addEventListener('contextmenu', rightClickAnywhere, true);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('wheel', resizePanel, { passive: false, capture: true });
    document.addEventListener('reddit-reader:hide-hover', hide);
    window.addEventListener('resize', resizeWindow);
    window.addEventListener('blur', hide);
    return () => {
        hide();
        document.removeEventListener('pointerover', pointerOver);
        document.removeEventListener('pointermove', pointerMove);
        document.removeEventListener('pointerout', pointerOut);
        document.removeEventListener('pointerdown', clickOutside, true);
        document.removeEventListener('contextmenu', rightClickAnywhere, true);
        document.removeEventListener('focusin', focusIn);
        document.removeEventListener('keydown', keydown, true);
        document.removeEventListener('scroll', scroll, true);
        document.removeEventListener('wheel', resizePanel, true);
        document.removeEventListener('reddit-reader:hide-hover', hide);
        window.removeEventListener('resize', resizeWindow);
        window.removeEventListener('blur', hide);
        chrome.storage.onChanged.removeListener(onSettingsChanged);
    };
}
