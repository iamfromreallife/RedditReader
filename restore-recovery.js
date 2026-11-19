/** Restore recovery is intentionally metadata-only. Image binaries are never cached
 * in the backup or downloaded into extension storage. Only authorised Reddit
 * detail requests are used to recover source URLs missing from older records. */
export const RESTORE_RECOVERY_KEY = 'rrPostRestoreRecoveryV1';
export const RESTORE_RECOVERY_LAST_KEY = 'rrPostRestoreRecoveryLastV1';
export const RESTORE_RECOVERY_ALARM = 'rr-post-restore-recovery';
export const RESTORE_MEDIA_BATCH = 8;

const IMAGE_EXTENSION = /\.(?:jpe?g|png|gif|webp|avif|bmp)(?:$|[?#])/i;
const IMAGE_LINK_IN_TEXT = /(?:https?:\/\/[^\s<>"']+\.(?:jpe?g|png|gif|webp|avif|bmp)(?:[?#]|$)|!\[[^\]]*\]\(https?:\/\/)/i;

/** Skip normal text-only posts and already-restored media, but retain gallery,
 * crosspost, link and inline-image candidates whose backing image URLs were
 * excluded from the backup. Do not pretend all image-free posts need media. */
export function mayNeedRestoredImages(post) {
    if (!post || typeof post !== 'object' || (Array.isArray(post.images) && post.images.length) || post.video)
        return false;
    const url = String(post.url || '');
    const domain = String(post.domain || '').toLowerCase();
    const text = String(post.text || '');
    if (IMAGE_LINK_IN_TEXT.test(text)) return true;
    if (/^self\./.test(domain)) return false;
    if (IMAGE_EXTENSION.test(url)) return true;
    if (/\/(?:gallery|media)\//i.test(url)) return true;
    if (/\b(?:i\.redd\.it|preview\.redd\.it|imgur\.com|i\.imgur\.com|redditmedia\.com)\b/i.test(url)) return true;
    // Reddit gallery/crosspost listings can be represented as Reddit permalinks.
    if (domain === 'reddit.com' && /\/comments\//i.test(url)) return true;
    // For an ordinary link post, Reddit may provide a preview image only in
    // the detail endpoint, even when the original site is not an image CDN.
    return /^https:\/\//i.test(url) && !!domain && domain !== 'v.redd.it' && !domain.startsWith('self.');
}

export function newRestoreRecovery(feedIds, now = Date.now()) {
    return { version: 2, id: crypto.randomUUID(), stage: 'feeds', feedIds: [...new Set(feedIds)],
        refreshId: '', lastPostId: '', scanned: 0, repaired: 0, checked: 0, totalCandidates: null,
        createdAt: now, updatedAt: now, retryAt: 0, lastError: '' };
}

/** URLs already stored in the post are not binary image data. Recovering a
 * direct image link needs no API call, saving rate capacity for galleries. */
export function directRestoredImage(post) {
    const candidate = String(post?.url || '');
    try {
        const url = new URL(candidate);
        if (url.protocol !== 'https:' || url.username || url.password) return '';
        return IMAGE_EXTENSION.test(url.pathname) ||
            (['i.redd.it', 'preview.redd.it'].includes(url.hostname) && url.pathname.length > 2)
            ? url.href : '';
    } catch { return ''; }
}
