/** Serialize feed refresh scopes and deduplicate only identical pending scopes.
 * A request for feed B must never inherit the results of an in-flight feed A.
 */
export function createRefreshCoordinator(execute) {
    let tail = Promise.resolve();
    const pending = new Map();
    function request(manual = false, onlyFeed = '', scopedFeedIds = null, progressContext = null) {
        const ids = Array.isArray(scopedFeedIds) ? [...new Set(scopedFeedIds)].sort() : null;
        const key = JSON.stringify([Boolean(manual), onlyFeed, ids]);
        if (pending.has(key)) return pending.get(key);
        const task = tail.then(() => execute(Boolean(manual), onlyFeed, ids, progressContext));
        const completion = task.finally(() => pending.delete(key));
        pending.set(key, completion);
        tail = completion.catch(() => { });
        return completion;
    }
    return request;
}
