/** Append-only per-writer cloud shards. Each browser writes only its own file,
 * so simultaneous syncs from different browsers do not overwrite each other's
 * mutations. The previous shared file remains readable/writable for upgrades. */
export const SHARD_PREFIX = 'reddit-reader-sync-v2-';
export function shardName(writer) {
    if (typeof writer !== 'string' || !/^[a-f0-9-]{36}$/i.test(writer))
        throw new Error('Invalid device writer identifier');
    return `${SHARD_PREFIX}${writer}.json`;
}
export function ownWriterEntries(allEntries, writer) {
    const result = {};
    for (const [key, value] of Object.entries(allEntries || {})) {
        if (value && value.writer === writer && typeof value.at === 'number' && Number.isFinite(value.at))
            result[key] = value;
    }
    return result;
}
export function mergeShards(mergeRecords, ...shards) {
    let aggregate = {};
    for (const shard of shards) aggregate = mergeRecords(aggregate, shard || {});
    return aggregate;
}
