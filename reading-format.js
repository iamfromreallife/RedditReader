/** Safe Reddit-flavoured Markdown rendering. Never inserts Reddit-supplied HTML.
 * Links are restricted to HTTP(S), escaped and opened in isolated tabs.
 */
import { escapeHtml } from './shared.js';
export function safeLink(value) {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : '';
    }
    catch {
        return '';
    }
}
function inline(text) {
    const protectedParts = [];
    const hold = (html) => { const key = `\u0001${protectedParts.length}\u0002`; protectedParts.push(html); return key; };
    const tokens = /(\\[\\`*_~\[\]()^]|`[^`\n]+`|\[[^\]\n]{1,500}\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+)/gi;
    let output = '', offset = 0;
    const stylize = (value) => {
        let result = escapeHtml(value);
        result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
            .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
            .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
            .replace(/&gt;!([\s\S]+?)!&lt;/g, '<span class="reddit-spoiler" tabindex="0" title="Spoiler">$1</span>');
        return result;
    };
    for (const match of text.matchAll(tokens)) {
        const start = match.index || 0;
        output += stylize(text.slice(offset, start));
        const token = match[0];
        if (token.startsWith('\\'))
            output += escapeHtml(token.slice(1));
        else if (token.startsWith('`'))
            output += hold(`<code>${escapeHtml(token.slice(1, -1))}</code>`);
        else if (token.startsWith('[')) {
            const labelEnd = token.indexOf(']('), label = token.slice(1, labelEnd), href = safeLink(token.slice(labelEnd + 2, -1));
            output += href ? hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`) : escapeHtml(token);
        }
        else {
            const matchUrl = token.match(/^(.*?)([.,;!?]+)$/);
            const address = matchUrl ? matchUrl[1] : token;
            const suffix = matchUrl ? matchUrl[2] : '';
            const href = safeLink(address);
            output += href ? hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(address)}</a>`) + escapeHtml(suffix) : escapeHtml(token);
        }
        offset = start + token.length;
    }
    output += stylize(text.slice(offset));
    return output.replace(/\u0001(\d+)\u0002/g, (_, index) => protectedParts[Number(index)] || '');
}
export function renderRedditMarkdown(source) {
    if (!source)
        return '';
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let index = 0;
    const append = (value) => output.push(value);
    while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
            index++;
            continue;
        }
        const fence = line.match(/^\s*(```|~~~)([\w-]*)\s*$/);
        if (fence) {
            const segment = [];
            index++;
            while (index < lines.length && !new RegExp('^\\s*' + fence[1] + '\\s*$').test(lines[index]))
                segment.push(lines[index++]);
            if (index < lines.length)
                index++;
            append(`<pre><code>${escapeHtml(segment.join('\n'))}</code></pre>`);
            continue;
        }
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            append('<hr>');
            index++;
            continue;
        }
        const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
        if (heading) {
            const level = heading[1].length;
            append(`<h${level}>${inline(heading[2])}</h${level}>`);
            index++;
            continue;
        }
        if (/^\s*>!.*!<\s*$/.test(line)) {
            append(`<p>${inline(line.trim())}</p>`);
            index++;
            continue;
        }
        const tableSeparator = lines[index + 1]?.trim();
        if (line.includes('|') && tableSeparator && /^\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?$/.test(tableSeparator)) {
            const splitRow = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
            const headers = splitRow(line), head = `<thead><tr>${headers.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`;
            index += 2;
            const body = [];
            while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
                const cells = splitRow(lines[index++]);
                body.push(`<tr>${headers.map((_, i) => `<td>${inline(cells[i] || '')}</td>`).join('')}</tr>`);
            }
            append(`<table>${head}<tbody>${body.join('')}</tbody></table>`);
            continue;
        }
        if (/^\s*>\s?/.test(line)) {
            const block = [];
            while (index < lines.length && /^\s*>\s?/.test(lines[index]))
                block.push(lines[index++].replace(/^\s*>\s?/, ''));
            append(`<blockquote>${renderRedditMarkdown(block.join('\n'))}</blockquote>`);
            continue;
        }
        const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/), ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
        if (unordered || ordered) {
            const orderedList = !!ordered, items = [];
            const pattern = orderedList ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
            while (index < lines.length) {
                const item = lines[index].match(pattern);
                if (!item)
                    break;
                items.push(`<li>${inline(item[1])}</li>`);
                index++;
            }
            append(`<${orderedList ? 'ol' : 'ul'}>${items.join('')}</${orderedList ? 'ol' : 'ul'}>`);
            continue;
        }
        // Reddit's four-space code indentation.
        if (/^ {4}\S/.test(line)) {
            const fragment = [];
            while (index < lines.length && /^ {4}/.test(lines[index]))
                fragment.push(lines[index++].slice(4));
            append(`<pre><code>${escapeHtml(fragment.join('\n'))}</code></pre>`);
            continue;
        }
        const paragraph = [];
        while (index < lines.length && lines[index].trim() && !/^\s*(?:#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|```|~~~)/.test(lines[index]))
            paragraph.push(lines[index++].trim());
        if (!paragraph.length) {
            paragraph.push(lines[index++]);
        }
        append(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    }
    return output.join('');
}


/** Render comment markdown, converting only direct HTTPS image links to lazy images.
 * No Reddit-provided HTML is trusted: rendering and URLs are escaped first.
 * Links without a verifiable image URL remain standard safe links.
 */
export function commentImageUrl(raw) {
    const normalized = String(raw || '').replace(/&amp;/g, '&');
    const safe = safeLink(normalized);
    if (!safe) return '';
    try {
        const url = new URL(safe);
        if (url.protocol !== 'https:') return '';
        if (!/\.(?:jpe?g|png|webp|gif|avif)$/i.test(url.pathname)) return '';
        const host = url.hostname.toLowerCase();
        if (host === 'localhost' || host.startsWith('[') || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
            /^(?:0|127|10|192\.168|169\.254)\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return '';
        return safe;
    } catch { return ''; }
}
export function renderCommentMarkdown(source, language = 'en') {
    const html = renderRedditMarkdown(source);
    return html.replace(/<a href="([^"]+)" target="_blank" rel="noopener noreferrer">[\s\S]*?<\/a>/g, (anchor, href) => {
        const imageUrl = commentImageUrl(href);
        if (!imageUrl) return anchor;
        const escaped = escapeHtml(imageUrl);
        const pt = language === 'pt-PT';
        return `<a class="comment-media-link" href="${escaped}" target="_blank" rel="noopener noreferrer" aria-label="${pt ? 'Abrir imagem' : 'Open image'}"><img src="${escaped}" alt="${pt ? 'Imagem associada ao comentário' : 'Image linked in Reddit comment'}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>`;
    });
}
