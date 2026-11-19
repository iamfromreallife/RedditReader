/** Bounded concurrency with one shared, paced request lane.
 *
 * Parallelism improves throughput on high latency connections. The spacing
 * applies to request *starts* across all workers; never per worker. Keeping
 * that limit separate from concurrency avoids multiplying Reddit API usage.
 */
export const MAX_PARALLEL_FEEDS = 4;
export const REQUEST_SPACING_MS = 750; // At most 80 starts/minute (below 100 QPM).
export const AUTO_BATCH_LIMIT = 16;
export const MANUAL_BATCH_LIMIT = 48;
/** Stable, bounded manual refresh chunks. Never silently truncate a large
 * "all feeds" or folder request to the first MANUAL_BATCH_LIMIT entries. */
export function chunkFeedIds(ids, chunkSize = MANUAL_BATCH_LIMIT) {
    const clean = [...new Set((ids || []).filter(id => typeof id === 'string' && id))];
    const size = Math.max(1, Math.floor(chunkSize));
    const chunks = [];
    for (let index = 0; index < clean.length; index += size)
        chunks.push(clean.slice(index, index + size));
    return chunks;
}

export class SharedRequestBudget {
    requestLimit;
    onReserve;
    spacingMs;
    usedCount;
    nextStartAt = 0;
    serial = Promise.resolve();
    haltedReason = '';
    constructor(initialUsed, dailyLimit, onReserve, spacingMs = REQUEST_SPACING_MS) {
        this.requestLimit = dailyLimit;
        this.onReserve = onReserve;
        this.spacingMs = spacingMs;
        this.usedCount = Math.max(0, initialUsed);
    }
    get used() { return this.usedCount; }
    get stopped() { return !!this.haltedReason; }
    get reason() { return this.haltedReason; }
    stop(reason) { if (!this.haltedReason)
        this.haltedReason = reason || 'Refresh paused'; }
    /** Reserve *before* issuing a request. Reservations are serialized even when
     * four workers call this method at the same instant. */
    async reserve(label, weight = 1) {
        if (!Number.isInteger(weight) || weight < 1)
            throw new Error('Invalid request cost');
        const previous = this.serial;
        let release;
        this.serial = new Promise(resolve => { release = resolve; });
        await previous;
        let delay = 0;
        try {
            if (this.stopped)
                return false;
            if (this.usedCount + weight > this.requestLimit) {
                this.stop('Request limit reached');
                return false;
            }
            const start = Math.max(Date.now(), this.nextStartAt);
            this.usedCount += weight;
            // An external shared allocator can reject a stale local counter
            // when auxiliary requests have consumed the remaining allowance.
            const accepted = await this.onReserve(this.usedCount, label, weight);
            if (accepted === false) {
                this.usedCount -= weight;
                this.stop('Reddit rate limit active');
                return false;
            }
            // Pace actual fetch starts, not the beginning of a potentially slow
            // chrome.storage write. The shared lock prevents parallel reservations
            // from calculating an overlapping start time.
            this.nextStartAt = Math.max(start, Date.now()) + weight * this.spacingMs;
            delay = Math.max(0, start - Date.now());
        }
        finally {
            release();
        }
        if (delay)
            await new Promise(resolve => setTimeout(resolve, delay));
        return !this.stopped;
    }
}
/** Workers take unique feed indices, finishing the in-flight jobs after a
 * pause. Unstarted jobs remain due for the next scheduled alarm. */
export async function runParallelQueue(items, concurrency, worker, isStopped = () => false) {
    let next = 0, started = 0;
    const work = async () => {
        while (!isStopped()) {
            const index = next++;
            if (index >= items.length)
                return;
            started++;
            await worker(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, Math.floor(concurrency))) }, work));
    return started;
}
/** Serialize post merges so simultaneous feed responses cannot overwrite each
 * other's read/star flags or count a cross-post as two new posts. */
export function serialExecutor() {
    let tail = Promise.resolve();
    return function enqueue(operation) {
        const task = tail.then(operation);
        tail = task.then(() => { }, () => { });
        return task;
    };
}
