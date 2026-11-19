/** Keyboard focus containment for reader-owned dialogs. No dependencies or
 * dynamically generated executable content. Restores the opener on close. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
export function installDialogFocus(overlay, { initialSelector = '', restoreFocus = true } = {}) {
    const opener = document.activeElement;
    const dialog = overlay.querySelector('[role="dialog"]') || overlay;
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    let disposed = false;
    const visible = () => [...dialog.querySelectorAll(FOCUSABLE)].filter(el =>
        el.isConnected && !el.hidden && !el.closest('[hidden], [inert]') &&
        el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    const keydown = event => {
        if (event.key !== 'Tab' || !overlay.isConnected) return;
        const items = visible();
        if (!items.length) { event.preventDefault(); dialog.focus({ preventScroll: true }); return; }
        const current = document.activeElement;
        if (!overlay.contains(current)) { event.preventDefault(); items[0].focus(); return; }
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (current === first || current === dialog)) {
            event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (current === last || current === dialog)) {
            event.preventDefault(); first.focus();
        }
    };
    let observer;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        overlay.removeEventListener('keydown', keydown, true);
        observer?.disconnect();
        // Do not steal focus from a newer dialog opened in the same turn.
        const another = document.querySelector('.modal-backdrop, .post-dialog-backdrop, #reader-settings-backdrop');
        if (restoreFocus && !another && opener?.isConnected && typeof opener.focus === 'function')
            opener.focus({ preventScroll: true });
    };
    observer = new MutationObserver(() => { if (!overlay.isConnected) dispose(); });
    observer.observe(document.body, { childList: true });
    overlay.addEventListener('keydown', keydown, true);
    queueMicrotask(() => {
        if (!disposed && overlay.isConnected) {
            const target = initialSelector ? dialog.querySelector(initialSelector) : visible()[0];
            (target || dialog).focus({ preventScroll: true });
        }
    });
    return dispose;
}
