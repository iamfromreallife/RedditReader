// Notification rules v2. Legacy feedId/keyword rules remain valid.
const RULE_EVENTS = new Set(['all', 'folder', 'feed']);
const RULE_FIELDS = new Set(['both', 'title', 'text']);
const RULE_OPS = new Set(['contains', 'not_contains', 'matches', 'not_matches']);
const RULE_JOINS = new Set(['AND', 'OR']);
const RULE_ACTIONS = new Set(['desktop']);
const validId = id => typeof id === 'string' && /^[-a-z0-9_]{3,150}$/i.test(id);

export function sanitizeNotificationRules(input) {
    if (!Array.isArray(input) || input.length > 100) throw new Error('Too many notification rules');
    const ids = new Set();
    return input.map(v => {
        if (!v || typeof v !== 'object') throw new Error('Invalid notification rule');
        if (!validId(v.id) || ids.has(v.id)) throw new Error('Invalid or duplicate rule ID');
        ids.add(v.id);
        if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80) throw new Error('Invalid notification rule name');
        if (typeof v.enabled !== 'boolean') throw new Error('Invalid enabled state');
        const event = RULE_EVENTS.has(v.event) ? v.event : v.event === 'new_post' ? (v.feedId === '*' ? 'all' : 'feed') : null;
        if (!event) throw new Error('Unsupported notification event');
        const targetId = event === 'all' ? '' : (v.targetId ?? v.feedId);
        if (event !== 'all' && !validId(targetId)) throw new Error('Invalid rule target');
        if (v.action !== undefined && !RULE_ACTIONS.has(v.action)) throw new Error('Unsupported notification action');
        let conditions;
        if (Array.isArray(v.conditions)) conditions = v.conditions;
        else {
            if (typeof v.keyword !== 'string' || v.keyword.length > 120) throw new Error('Invalid legacy keyword');
            conditions = v.keyword.trim() ? [{ field:'both', operator:'contains', value:v.keyword.trim(), join:'AND', not:false }] : [];
        }
        if (conditions.length > 12) throw new Error('Too many conditions');
        conditions = conditions.map((c, i) => {
            if (!c || !RULE_FIELDS.has(c.field) || !RULE_OPS.has(c.operator) ||
                typeof c.value !== 'string' || !c.value.trim() || c.value.length > 160 ||
                /[\x00-\x08\x0e-\x1f]/.test(c.value) ||
                (i && !RULE_JOINS.has(c.join)) || typeof c.not !== 'boolean')
                throw new Error('Invalid rule condition');
            return { field:c.field, operator:c.operator, value:c.value.trim(), join:i ? c.join : 'AND', not:c.not };
        });
        return { id:v.id, name:v.name.trim(), enabled:v.enabled, event, targetId, action:'desktop', conditions };
    });
}

function withinFolder(feed, targetId, folders) {
    const parents = new Map((folders || []).map(folder => [folder.id, folder.parentId]));
    let at = feed.folderId;
    const visited = new Set();
    while (at && !visited.has(at)) {
        if (at === targetId) return true;
        visited.add(at);
        at = parents.get(at);
    }
    return false;
}
function evaluates(post, condition) {
    const title = String(post.title || '');
    const body = String(post.text || post.selftext || '');
    const values = condition.field === 'title' ? [title] : condition.field === 'text' ? [body] : [title, body];
    const needle = condition.value.toLocaleLowerCase();
    const hit = values.some(value => {
        const hay = value.toLocaleLowerCase();
        // 'Matches' means an exact case-insensitive phrase match, not executable regex.
        return condition.operator.endsWith('matches') ? hay.trim() === needle : hay.includes(needle);
    });
    const matched = condition.operator.startsWith('not_') ? !hit : hit;
    return condition.not ? !matched : matched;
}
function conditionsMatch(post, conditions) {
    if (!conditions.length) return true;
    // AND binds more tightly than OR. NOT applies to an individual condition.
    let group = evaluates(post, conditions[0]);
    let result = false;
    for (const c of conditions.slice(1)) {
        if (c.join === 'OR') { result ||= group; group = evaluates(post, c); }
        else group = group && evaluates(post, c);
    }
    return result || group;
}
export function matchingNotificationRules(post, feed, rules, folders = []) {
    return rules.filter(r => {
        if (!r.enabled) return false;
        const event = r.event === 'new_post' ? (r.feedId === '*' ? 'all' : 'feed') : r.event;
        const target = r.targetId ?? r.feedId;
        if (event === 'feed' && target !== feed.id) return false;
        if (event === 'folder' && !withinFolder(feed, target, folders)) return false;
        if (!['feed','folder','all'].includes(event)) return false;
        if (!Array.isArray(r.conditions)) {
            const legacy = String(r.keyword || '').toLocaleLowerCase();
            return !legacy || `${post.title || ''} ${post.text || ''}`.toLocaleLowerCase().includes(legacy);
        }
        return conditionsMatch(post, r.conditions);
    });
}
