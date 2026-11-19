const id11 = /^[a-zA-Z0-9_-]{11}$/;
const numeric = /^\d{6,20}$/;
const shortId = /^[a-zA-Z0-9_-]{4,32}$/;
export function embedFromUrl(input) {
    let u;
    try {
        u = new URL(input);
    }
    catch {
        return null;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443')
        return null;
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be']);
    if (youtubeHosts.has(host)) {
        let id = '';
        if (host === 'youtu.be' || host === 'www.youtu.be')
            id = path.split('/')[1] || '';
        else if (path === '/watch')
            id = u.searchParams.get('v') || '';
        else
            id = path.match(/^\/(?:shorts|live|embed)\/([a-zA-Z0-9_-]{11})(?:\/|$)/)?.[1] || '';
        if (id11.test(id))
            return { provider: 'YouTube', embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0`, watchUrl: `https://www.youtube.com/watch?v=${id}` };
    }
    if (host === 'tiktok.com' || host === 'www.tiktok.com' || host === 'm.tiktok.com') {
        const id = path.match(/^\/(?:@[^/]+\/video|player\/v1)\/(\d{8,25})(?:\/|$)/)?.[1];
        if (id)
            return { provider: 'TikTok', embedUrl: `https://www.tiktok.com/player/v1/${id}`, watchUrl: `https://www.tiktok.com/player/v1/${id}` };
    }
    if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
        const id = path.match(/^\/(?:video\/)?(\d{6,20})(?:\/|$)/)?.[1];
        if (id && numeric.test(id))
            return { provider: 'Vimeo', embedUrl: `https://player.vimeo.com/video/${id}`, watchUrl: `https://vimeo.com/${id}` };
    }
    if (host === 'dailymotion.com' || host === 'www.dailymotion.com' || host === 'dai.ly') {
        const id = path.match(/^\/(?:video\/)?([a-zA-Z0-9]{5,16})(?:_|\/|$)/)?.[1];
        if (id)
            return { provider: 'Dailymotion', embedUrl: `https://www.dailymotion.com/embed/video/${id}`, watchUrl: `https://www.dailymotion.com/video/${id}` };
    }
    if (host === 'streamable.com' || host === 'www.streamable.com') {
        const id = path.match(/^\/(?:e\/)?([a-zA-Z0-9]{4,16})(?:\/|$)/)?.[1];
        if (id)
            return { provider: 'Streamable', embedUrl: `https://streamable.com/e/${id}`, watchUrl: `https://streamable.com/${id}` };
    }
    if (host === 'instagram.com' || host === 'www.instagram.com') {
        const parsed = path.match(/^\/(p|reel|tv)\/([a-zA-Z0-9_-]{5,32})(?:\/|$)/);
        if (parsed && shortId.test(parsed[2]))
            return { provider: 'Instagram', embedUrl: `https://www.instagram.com/${parsed[1]}/${parsed[2]}/embed/`, watchUrl: `https://www.instagram.com/${parsed[1]}/${parsed[2]}/` };
    }
    if (host === 'open.spotify.com') {
        const match = path.match(/^\/(track|episode|show|album|playlist)\/([a-zA-Z0-9]{15,30})(?:\/|$)/);
        if (match)
            return { provider: 'Spotify', embedUrl: `https://open.spotify.com/embed/${match[1]}/${match[2]}`, watchUrl: `https://open.spotify.com/${match[1]}/${match[2]}` };
    }
    return null;
}
/** A Reddit self-post may contain an ordinary Markdown link to media. */
export function embedsFromPost(url, text, max = 2) {
    const candidates = [url];
    for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
        candidates.push(match[0].replace(/[.,;!?\])}]+$/g, ''));
        if (candidates.length > 32)
            break;
    }
    const found = [], seen = new Set();
    for (const candidate of candidates) {
        const embed = embedFromUrl(candidate);
        if (embed && !seen.has(embed.embedUrl)) {
            found.push(embed);
            seen.add(embed.embedUrl);
        }
        if (found.length >= max)
            break;
    }
    return found;
}
