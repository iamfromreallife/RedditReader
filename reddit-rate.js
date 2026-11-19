/** Observed Reddit API response headers, not a fabricated daily quota. */
export function parseRedditRateLimit(headers, now = Date.now()) {
    if (!headers || typeof headers.get !== 'function') return null;
    const numeric = name => {
        const raw = headers.get(name);
        if (raw === null || String(raw).trim() === '') return null;
        const value = Number(raw);
        return Number.isFinite(value) && value >= 0 ? value : null;
    };
    const used = numeric('x-ratelimit-used');
    const remaining = numeric('x-ratelimit-remaining');
    const resetSeconds = numeric('x-ratelimit-reset');
    if (used === null && remaining === null && resetSeconds === null) return null;
    return { used, remaining,
        resetAt: resetSeconds === null ? null : now + resetSeconds * 1000,
        observedAt: now };
}
