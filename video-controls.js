/** Middle click toggles HTML5 video fullscreen; wheel directly over video seeks 2 s.
 * Never attach these actions to thumbnails, containers, iframes or the page.
 * Cross-origin embedded players cannot be controlled from a parent extension page.
 */
export function installVideoControls(root = document) {
    const findVideo = event => event.target instanceof Element ? event.target.closest('video') : null;
    const middleDown = event => {
        if (event.button === 1 && findVideo(event)) event.preventDefault();
    };
    const middleClick = event => {
        const video = findVideo(event);
        if (event.button !== 1 || !video) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (document.fullscreenElement === video || document.fullscreenElement?.contains(video)) {
            void document.exitFullscreen().catch(() => {});
        } else if (video.requestFullscreen) {
            void video.requestFullscreen().catch(() => {});
        }
    };
    const wheelSeek = event => {
        const video = findVideo(event);
        if (!video || !event.deltaY || (!video.seekable.length && video.readyState < HTMLMediaElement.HAVE_METADATA)) return;
        const current = Number(video.currentTime);
        if (!Number.isFinite(current)) return;
        let lower = 0, upper = Number.isFinite(video.duration) ? video.duration : Infinity;
        if (video.seekable.length) {
            const ranges = video.seekable;
            const i = ranges.length - 1;
            lower = ranges.start(i);
            upper = ranges.end(i);
        }
        const next = Math.max(lower, Math.min(upper, current + (event.deltaY > 0 ? 2 : -2)));
        if (next === current) { event.preventDefault(); return; }
        try {
            video.currentTime = next;
            event.preventDefault(); // Do not scroll the page while seeking a video.
            event.stopPropagation();
        } catch { /* Unseekable or unloaded stream: preserve normal page scrolling. */ }
    };
    root.addEventListener('mousedown', middleDown, true);
    root.addEventListener('auxclick', middleClick, true);
    root.addEventListener('wheel', wheelSeek, { capture: true, passive: false });
    return () => {
        root.removeEventListener('mousedown', middleDown, true);
        root.removeEventListener('auxclick', middleClick, true);
        root.removeEventListener('wheel', wheelSeek, true);
    };
}
