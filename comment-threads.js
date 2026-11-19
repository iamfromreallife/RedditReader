import { escapeHtml as e, dateLabel, numberLabel } from './shared.js';
import { renderCommentMarkdown } from './reading-format.js';

/** Stable, visually distinct line per top-level thread. Nested replies inherit it. */
export function renderCommentThreads(comments, language = 'en') {
    const roots = new Map();
    let lastRoot = null;
    return comments.map(comment => {
        const depth = Math.max(0, Math.min(2, Number(comment.depth) || 0));
        if (depth === 0) lastRoot = comment.id;
        const root = String(comment.rootId || lastRoot || comment.id);
        if (!roots.has(root)) roots.set(root, roots.size);
        // Golden-angle hue sequence: distinct and balanced across up to 30 threads.
        const hue = (42 + roots.get(root) * 137.508) % 360;
        const threadColour = `hsl(${hue.toFixed(2)} 72% 52%)`;
        return `<article class="reader-comment" style="--comment-depth:${depth};--comment-thread-colour:${threadColour}" data-comment-id="${e(comment.id)}">
   <div class="reader-comment-head"><strong>u/${e(comment.author)}</strong><span class="vote-up"><svg class="vote-arrow" aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2 2.5 12.5h5.8V22h7.4v-9.5h5.8L12 2Z"/></svg> ${numberLabel(comment.score)}</span>${comment.createdAt ? `<time>${dateLabel(comment.createdAt)}</time>` : ''}</div>
   <div class="reader-comment-body reddit-markdown">${renderCommentMarkdown(comment.body, language)}</div></article>`;
    }).join('');
}
