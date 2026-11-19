export const HIGHLIGHT_COLORS = ['#fff3a3', '#ffc4cc', '#b7efcd', '#cbd7ff'];
export function sanitizeHighlighters(value) {
    if (!Array.isArray(value) || value.length > 40)
        throw new Error('Invalid highlighters list');
    const seen = new Set();
    return value.map(item => {
        if (!item || typeof item !== 'object')
            throw new Error('Invalid highlighter');
        const row = item;
        if (typeof row.text !== 'string' || !row.text.trim() || row.text.length > 120)
            throw new Error('Highlighter text must be 1–120 characters');
        if (typeof row.color !== 'string' || !/^#[\da-f]{6}$/i.test(row.color))
            throw new Error('Invalid highlighter colour');
        if (typeof row.id !== 'string' || row.id.length < 1 || row.id.length > 100 || seen.has(row.id))
            throw new Error('Invalid highlighter ID');
        seen.add(row.id);
        return { id: row.id, text: row.text.trim(), color: row.color };
    });
}
/** Decorations operate on text nodes, never parse user-supplied markup, and preserve links. */
export function applyHighlighters(root, configured) {
    if (!root || !Array.isArray(configured) || !configured.length)
        return;
    const rules = configured.filter(rule => rule && typeof rule.text === 'string' && rule.text.length > 0 && typeof rule.color === 'string' && /^#[0-9a-f]{6}$/i.test(rule.color)).sort((a, b) => b.text.length - a.text.length);
    if (!rules.length)
        return;
    const pattern = new RegExp(rules.map(rule => rule.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) {
            const parent = node.parentElement;
            if (!parent || !node.textContent || node.textContent.length > 10000 || !node.textContent.trim() || parent.closest('script,style,textarea,input,select,option,code,pre,mark,[contenteditable="true"]'))
                return NodeFilter.FILTER_REJECT;
            // No match outside article titles, summaries and article body text.
            // In particular subreddit labels and sidebar feed names are excluded.
            if (parent.closest('.post-dialog-text.post-dialog-info'))
                return NodeFilter.FILTER_REJECT;
            if (!parent.closest('.post-title, .post-excerpt, .three-post-title, .preview-title, .post-dialog-scroll h2, .three-pane-detail-content h2, .reddit-markdown, .post-dialog-text'))
                return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        } });
    const targets = [];
    while (walker.nextNode())
        targets.push(walker.currentNode);
    for (const textNode of targets) {
        const text = textNode.textContent || '';
        pattern.lastIndex = 0;
        let match;
        let last = 0;
        let count = 0;
        const parts = [];
        while ((match = pattern.exec(text)) && count++ < 80) {
            if (match.index > last)
                parts.push(document.createTextNode(text.slice(last, match.index)));
            const rule = rules.find(candidate => candidate.text.toLocaleLowerCase() === match[0].toLocaleLowerCase());
            if (rule) {
                const mark = document.createElement('mark');
                mark.className = 'rr-user-highlight';
                mark.style.backgroundColor = rule.color;
                mark.textContent = match[0];
                parts.push(mark);
            }
            else
                parts.push(document.createTextNode(match[0]));
            last = match.index + match[0].length;
        }
        if (parts.length) {
            if (last < text.length)
                parts.push(document.createTextNode(text.slice(last)));
            textNode.replaceWith(...parts);
        }
    }
}
