/** Compact, theme-aware progress indicator for the backup's unread-media pass.
 * Shared by the popup, the reader and Settings. This UI does not read images or
 * credentials, and it never starts an update merely by being displayed. */
import { send } from './shared.js';

export function installRestoreRecoveryIndicator(language = () => 'en', initial = null) {
    let last = initial;
    const element = document.createElement('div');
    element.className = 'restore-media-indicator';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    element.hidden = true;
    element.innerHTML = '<div class="restore-media-indicator-heading"></div><div class="restore-media-indicator-message"></div><div class="refresh-progress-track" role="progressbar" aria-label="Restoring unread images" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="refresh-progress-fill"></div></div>';
    document.body.append(element);
    const title = element.querySelector('.restore-media-indicator-heading');
    const message = element.querySelector('.restore-media-indicator-message');
    const track = element.querySelector('.refresh-progress-track');
    const fill = element.querySelector('.refresh-progress-fill');
    let busy = false;
    let lastRendered = '';
    function render(status) {
        if (!status?.active && !(status?.finishedAt && Date.now() - status.finishedAt < 16000)) {
            element.hidden = true;
            return;
        }
        const pt = language() === 'pt-PT';
        const media = status.stage === 'media' || status.stage === 'complete';
        title.textContent = pt ? 'A restaurar imagens das publicações não lidas' : 'Restoring images for unread posts';
        if (status.stage === 'complete') {
            message.textContent = pt ? `Concluído · ${status.repaired || 0} imagens recuperadas` : `Complete · ${status.repaired || 0} images recovered`;
        } else if (!media) {
            message.textContent = pt ? 'A atualizar os feeds antes de recuperar imagens…' : 'Refreshing feeds before recovering images…';
        } else {
            const hasTotal = Number.isFinite(status.total);
            const done = Math.max(0, Number(status.checked) || 0);
            const count = hasTotal ? `${Math.min(done,status.total)} / ${status.total}` : `${done}`;
            message.textContent = pt
                ? `${count} verificadas · ${status.repaired || 0} recuperadas`
                : `${count} checked · ${status.repaired || 0} recovered`;
            if (status.retryAt > Date.now()) message.textContent += pt ? ' · À espera de nova tentativa' : ' · Waiting to retry';
        }
        const hasTotal = media && Number.isFinite(status.total);
        const percent = status.stage === 'complete' ? 100 : hasTotal
            ? Math.min(100, Math.round(100 * Math.max(0, Number(status.checked) || 0) / Math.max(1, status.total))) : 0;
        fill.style.width = `${percent}%`;
        track.setAttribute('aria-valuenow', String(percent));
        track.setAttribute('aria-valuetext', `${message.textContent}`);
        track.classList.toggle('is-indeterminate', !hasTotal && status.stage !== 'complete');
        // Avoid displaying raw OAuth errors or exposing any token material.
        if (status.error && status.retryAt > Date.now()) title.title = pt ? 'A aguardar ligação ao Reddit ou limite de pedidos' : 'Waiting for Reddit access or rate limit';
        else title.removeAttribute('title');
        element.hidden = false;
    }
    async function poll() {
        if (busy || document.hidden) return;
        busy = true;
        // Keep the recovery notice above the ordinary full-width refresh
        // progress indicator rather than stacking both labels in one place.
        const refreshBar = document.querySelector('.refresh-progress:not([hidden])');
        element.style.bottom = refreshBar && !refreshBar.contains(element) ? '44px' : '16px';
        try {
            last = await send('getRestoreRecoveryProgress');
            const serialized = JSON.stringify([last, language()]);
            if (serialized !== lastRendered) { render(last); lastRendered = serialized; }
            else if (last?.finishedAt && Date.now() - last.finishedAt >= 16000) render(last);
        } catch { /* The next poll can recover after worker restart. */ }
        finally { busy = false; }
    }
    if (last) render(last);
    void poll();
    const timer = setInterval(poll, 1400);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    return { poll, destroy: () => { clearInterval(timer); element.remove(); } };
}
