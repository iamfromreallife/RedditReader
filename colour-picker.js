/** Pure HSV/hex conversion for the subreddit-label colour picker. */
const clamp = (v, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Number(v) : min));
export function hsvToHex(hue, saturation, brightness) {
    const h = ((clamp(hue, -3600, 3600) % 360) + 360) % 360;
    const s = clamp(saturation, 0, 100) / 100;
    const v = clamp(brightness, 0, 100) / 100;
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    const values = h < 60 ? [c,x,0] : h < 120 ? [x,c,0] : h < 180 ? [0,c,x] : h < 240 ? [0,x,c] : h < 300 ? [x,0,c] : [c,0,x];
    return '#' + values.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
}
export function hexToHsv(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Invalid hex colour');
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let h = 0;
    if (delta !== 0) {
        if (max === r) h = 60 * (((g - b) / delta) % 6);
        else if (max === g) h = 60 * ((b - r) / delta + 2);
        else h = 60 * ((r - g) / delta + 4);
    }
    return { h: (h + 360) % 360, s: max === 0 ? 0 : delta / max * 100, v: max * 100 };
}
