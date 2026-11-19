/** Portable, least-privilege Google OAuth for Chrome AND Brave. No embedded client secret.
 * An explicit Web application OAuth client must authorize chrome.identity.getRedirectURL('google').
 * Google implicit access tokens expire; renew silently when possible and require reconnection when not.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
export const GOOGLE_SESSION_TOKEN = 'rrGoogleDriveAccessToken';
export function validGoogleClientId(value) {
    return /^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/.test(value.trim());
}
export function googleOAuthUrl(clientId, redirect, state, interactive) {
    if (!validGoogleClientId(clientId))
        throw new Error('Enter a valid Google OAuth Web application Client ID. Open Help for setup.');
    const expected = new URL(redirect);
    if (expected.protocol !== 'https:' || !expected.hostname.endsWith('.chromiumapp.org'))
        throw new Error('Invalid extension redirect URL');
    const params = new URLSearchParams({ client_id: clientId, response_type: 'token', redirect_uri: redirect, scope: DRIVE_SCOPE, state, prompt: interactive ? 'select_account' : 'none', include_granted_scopes: 'false' });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}
export function parseGoogleOAuthResponse(callback, redirect, state, now = Date.now()) {
    const actual = new URL(callback), expected = new URL(redirect);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname)
        throw new Error('Google OAuth callback URL mismatch');
    const values = new URLSearchParams(actual.hash.startsWith('#') ? actual.hash.slice(1) : actual.search);
    if (values.get('state') !== state)
        throw new Error('Google OAuth state mismatch. Please try connecting again.');
    const error = values.get('error');
    if (error)
        throw new Error('Google authorization: ' + error + (values.get('error_description') ? ' — ' + values.get('error_description') : ''));
    const token = values.get('access_token') || '';
    const duration = Number(values.get('expires_in'));
    if (!token || !Number.isFinite(duration) || duration <= 0 || duration > 86400)
        throw new Error('Google did not return a valid access token');
    return { token, expiresAt: now + duration * 1000 };
}
/** Google Web-application OAuth authorization-code flow. PKCE protects the code.
 * Only users who supply their own Web client secret can enable offline renewal.
 * Treat the client secret as extractable from a locally installed extension.
 */
export async function createPkceChallenge() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const encode = (v) => btoa(String.fromCharCode(...v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const verifier = encode(bytes);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: encode(new Uint8Array(digest)) };
}
export function googleCodeUrl(clientId, redirect, state, challenge) {
    if (!validGoogleClientId(clientId) || !challenge || !/^[a-zA-Z0-9_-]+$/.test(challenge))
        throw new Error('Invalid Google OAuth configuration');
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: DRIVE_SCOPE, state, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256' });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
}
async function exchangeToken(body) {
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), cache: 'no-store' });
    const value = await response.json();
    if (!response.ok || typeof value.access_token !== 'string')
        throw new Error('Google token endpoint: ' + String(value.error || response.status).slice(0, 130));
    const ttl = Number(value.expires_in);
    if (!Number.isFinite(ttl) || ttl < 30)
        throw new Error('Google token response has an invalid expiry');
    return { token: value.access_token, expiresAt: Date.now() + ttl * 1000, refreshToken: typeof value.refresh_token === 'string' ? value.refresh_token : '' };
}
export async function exchangeGoogleCode(clientId, secret, code, verifier, redirect) {
    return exchangeToken(new URLSearchParams({ client_id: clientId, client_secret: secret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }));
}
export async function renewGoogleToken(clientId, secret, refreshToken) {
    return exchangeToken(new URLSearchParams({ client_id: clientId, client_secret: secret, refresh_token: refreshToken, grant_type: 'refresh_token' }));
}
