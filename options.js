import { HIGHLIGHT_COLORS, applyHighlighters } from './highlighters.js';
import { FONT_OPTIONS } from './font-options.js';
import { installRestoreRecoveryIndicator } from './restore-recovery-ui.js';
import { installLocalization, setLanguage } from './locale.js';
import { send, icon, escapeHtml as e, parseLines, parseOPML, feedOpenUrl, REFRESH_CHOICES } from './shared.js';
const app = document.querySelector('#app');
const embeddedOptions = new URLSearchParams(location.search).get('embedded') === '1';
if (embeddedOptions) {
    document.body.classList.add('embedded-options');
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !document.querySelector('.modal-backdrop')) {
            window.parent.postMessage({ type: 'reddit-reader-close-settings' }, location.origin);
        }
    });
}

let data;
let section = location.hash === '#highlighters' ? 'reading' : 'provider';
let toastId;
let chosenHighlightColor = HIGHLIGHT_COLORS[0];
let driveMeta = null;
let oauthMeta = null;
let diagnosticsMetrics = null, diagnosticsLoading = false, diagnosticsFailure = '';
let notificationOnboardingPending = false;
function apply() { setLanguage(data.settings.language); const s = data.settings; document.body.dataset.theme = s.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : s.theme; document.body.dataset.density = s.density || 'comfortable'; document.body.dataset.font = s.font; document.body.style.setProperty('--accent', s.accent); document.body.style.setProperty('--user-font', s.fontSize + 'px'); }
function toast(message) { let el = document.querySelector('.toast'); if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.append(el);
} el.textContent = message; clearTimeout(toastId); toastId = window.setTimeout(() => el?.remove(), 3300); }
function oauthFeedback(message) { const box = document.querySelector('#oauth-feedback'); if (box) {
    box.textContent = message;
    box.style.display = message ? 'block' : 'none';
} }
function selectSetting(key, label, values, help = '') { return `<label class="setting-row"><div><strong>${e(label)}</strong>${help ? `<small>${e(help)}</small>` : ''}</div><select data-key="${key}">${values.map(([value, title]) => `<option value="${e(value)}" ${String(data.settings[key]) === value ? 'selected' : ''}>${e(title)}</option>`).join('')}</select></label>`; }
function fieldSetting(key, label, type = 'number', min = 0, max = 1000, help = '') { return `<label class="setting-row"><div><strong>${e(label)}</strong>${help ? `<small>${e(help)}</small>` : ''}</div><input data-key="${key}" type="${type}" ${type === 'number' ? `min="${min}" max="${max}" ${key === 'readingLineHeight' || key === 'lineHeight' ? 'step="0.05"' : 'step="1"'}` : ''} value="${e(data.settings[key])}"></label>`; }
function toggleSetting(key, label, help = '') { return `<label class="setting-row"><div><strong>${e(label)}</strong>${help ? `<small>${e(help)}</small>` : ''}</div><input type="checkbox" data-key="${key}" ${data.settings[key] ? 'checked' : ''}></label>`; }
function sectionNav() { return `<nav class="settings-nav">${[['provider', 'rss', 'Data Source'], ['feeds', 'folder', 'Feeds & folders'], ['updates', 'refresh', 'Refresh & limits'], ['appearance', 'moon', 'Appearance'], ['reading', 'magazine', 'Reading'], ['drive', 'refresh', 'Google Drive sync'], ['storage', 'download', 'Storage & backup'], ['diagnostics', 'warning', 'Diagnostics']].map(([id, symbol, name]) => `<button class="${section === id ? 'active' : ''}" data-tab="${id}">${icon(symbol, 17)} ${name}</button>`).join('')}</nav>`; }
function provider() {
    const c = oauthMeta;
    const pt = data.settings.language === 'pt-PT';
    const expires = c?.expiresAt ? new Date(c.expiresAt).toLocaleString(pt ? 'pt-PT' : 'en-US') : (pt ? 'Desconhecido' : 'Unknown');
    const authorized = !!(c?.connected && (c.expiresAt > Date.now() || c.canRefresh));
    const appConfigured = !!c?.clientId;
    return `${appConfigured ? `<div class="connection-hero reddit-hero" role="status"><span class="connection-service-icon reddit-service-icon" aria-hidden="true">r/</span><div class="connection-hero-content"><div class="connection-eyebrow">${pt ? 'APLICAÇÃO REDDIT CONFIGURADA' : 'CONFIGURED REDDIT APP'}</div><div class="connection-name">${pt ? 'A minha aplicação Reddit' : 'My Reddit app'}</div><div class="connection-secondary">${pt ? 'ID de cliente' : 'Client ID'}: <code>${e(c.clientId)}</code></div><div class="connection-details">${pt ? 'URI de redirecionamento' : 'Redirect URI'}: <span>${e(c.redirectUri)}</span></div>${c.username ? `<div class="connection-details">${pt ? 'Utilizador autorizado' : 'Authorized user'}: <strong>u/${e(c.username)}</strong></div>` : ''}
 <h2>${pt ? 'Fonte de dados' : 'Data Source'}</h2><p>${pt ? 'Utiliza a tua aplicação Reddit autorizada para carregar os feeds. A autenticação é feita com um código único e os tokens são renovados quando possível.' : 'Use your own approved Reddit application to fetch feeds. Authorize with a one-time code; tokens renew automatically when supported.'}</p>
 <div class="connection-details">${pt ? 'Permissões' : 'Scopes'}: ${e(c.scope || '—')} · ${pt ? 'Expira' : 'Expires'}: ${e(expires)} · ${pt ? 'Renovação automática' : 'Automatic refresh'}: ${c.canRefresh ? (pt ? 'Sim' : 'Yes') : (pt ? 'Não' : 'No')}</div></div><span class="connection-status ${authorized ? 'connected' : 'needs-attention'}">${authorized ? (pt ? 'Ligada' : 'Connected') : (pt ? 'Autorização necessária' : 'Authorization needed')}</span></div>` : ''}
 <div class="flex" style="align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin:2px 0 15px"><h2 style="margin:0">${pt ? 'Fonte de dados Reddit' : 'Reddit data source'}</h2><button class="btn" type="button" data-act="redditHelp" aria-haspopup="dialog">${icon('help', 17)} ${pt ? 'Ajuda — configuração passo a passo' : 'Help — step-by-step setup'}</button></div>
 <div class="provider-note">${icon('rss', 17)} <strong>${pt ? 'Estado atual:' : 'Current status:'}</strong> ${e(data.diagnostics.providerStatus)}<br><span class="help">${pt ? 'O acesso à API do Reddit está sujeito a autorização e limites de pedidos.' : 'Reddit API access is subject to approval and rate limits.'}</span></div>
 <label class="field" style="margin:16px 0"><span>Reddit app Client ID</span><input id="oauth-client-id" autocomplete="off" spellcheck="false" value="${e(c?.clientId || '')}" placeholder="Reddit application ID"><small>Public installed-app client: do not enter a secret.</small></label>
 <label class="field" style="margin:16px 0"><span>Registered redirect URI</span><input id="oauth-redirect" autocomplete="off" spellcheck="false" value="${e(c?.redirectUri || 'http://localhost:53682/substream')}" placeholder="http://localhost:53682/substream"><small>The URI must exactly match the one registered with Reddit. A localhost redirect may produce a connection error; copy the final address, including code and state.</small></label>
 <div class="flex" style="margin:12px 0"><button class="btn" data-act="beginOAuth">${icon('external', 15)} 1. Generate authorization link</button></div>
 <label class="field" style="margin:16px 0"><span>2. Final callback URL or authorization code</span><textarea id="oauth-code" rows="3" spellcheck="false" autocomplete="off" placeholder="http://localhost:53682/substream?state=...&amp;code=..."></textarea><small>Paste the FINAL callback (or the code alone), not the URL of the authorization page. Codes and tokens must be kept private.</small></label>
 <div class="provider-note" style="margin:12px 0;display:none" id="oauth-feedback" role="alert"></div>
 <div class="flex" style="margin:12px 0 22px"><button class="btn primary" data-act="exchangeOAuth">${icon('check', 15)} 3. Connect</button><button class="btn danger" data-act="disconnectOAuth">Disconnect</button></div>
 <p class="help">This extension uses only your own Reddit app as its content provider. It cannot exchange authorization codes issued to another application.</p>`;
}
function feedsPanel() {
    return `<h2>Feeds & folders</h2><p>Organize subscriptions, change their refresh intervals and import existing OPML collections.</p>
 <div class="flex" style="flex-wrap:wrap;margin-bottom:18px"><button class="btn primary" data-act="import">${icon('plus', 16)} Add / import feeds</button><button class="btn" data-act="newFolder">${icon('folder', 16)} Create folder</button><button class="btn" data-act="exportFull">${icon('download', 16)} ${data.settings.language === 'pt-PT' ? 'Exportar tudo (JSON)' : 'Export everything (JSON)'}</button><button class="btn" data-act="exportOPML">${icon('download', 16)} Export OPML (feeds only)</button></div>
 <div class="eyebrow" style="margin-bottom:12px">${data.feeds.length} SUBSCRIPTIONS · ${data.folders.length} FOLDERS</div>
 ${data.folders.map(folder => `<div class="setting-row"><div>${icon('folder', 16)} <strong style="display:inline">${e(folder.name)}</strong></div><button class="icon-btn" title="New subfolder" data-act="newChildFolder" data-id="${e(folder.id)}">${icon('plus', 16)}</button><button class="icon-btn" title="Rename" data-act="renameFolder" data-id="${e(folder.id)}">✎</button><button class="icon-btn" title="Delete (moves children up)" data-act="removeFolder" data-id="${e(folder.id)}">${icon('trash', 16)}</button></div>`).join('')}
 ${data.feeds.map(f => `<div class="setting-row" style="align-items:flex-start"><div><strong>${e(f.name)}</strong><small>${f.lastFetched ? 'Updated ' + new Date(f.lastFetched).toLocaleString() : 'Not yet fetched'} ${f.lastError ? `· ${e(f.lastError)}` : ''}</small></div>
 <select class="feed-folder" data-feed="${e(f.id)}" title="Move to folder"><option value="">Uncategorized</option>${data.folders.map(folder => `<option value="${e(folder.id)}" ${f.folderId === folder.id ? 'selected' : ''}>${e(folder.name)}</option>`).join('')}</select>
 <select class="feed-frequency" data-feed="${e(f.id)}" title="Refresh frequency"><option value="inherit" ${f.refreshMinutes === null ? 'selected' : ''}>Global</option>${REFRESH_CHOICES.map(n => `<option value="${n}" ${f.refreshMinutes === n ? 'selected' : ''}>${n === 0 ? 'Adaptive' : n + ' min'}</option>`).join('')}</select>
 <button class="icon-btn" data-act="removeFeed" data-id="${e(f.id)}" title="Unsubscribe">${icon('trash', 16)}</button></div>`).join('')}
 ${data.feeds.length ? '' : '<div class="empty">No subscriptions yet. Import your OPML file to begin.</div>'}`;
}
function updates() {
    return `<h2>Refresh & rate limits</h2><p>Refresh scheduling respects Reddit rate-limit responses. Your selected intervals are preferences, not guarantees.</p>
 ${selectSetting('refreshMinutes', 'Default refresh frequency', REFRESH_CHOICES.map(n => [String(n), n === 0 ? 'Adaptive' : n === 1440 ? '24 hours' : n >= 60 ? n / 60 + ' hours' : n + ' minutes']))}
 ${fieldSetting('keepDays', 'Post retention (days)', 'number', 1, 365, 'Local cache only; subject to provider retention rules.')}
 ${fieldSetting('maxPostsPerFeed', 'Maximum posts cached per feed', 'number', 25, 2000, 'Old posts trimmed during daily maintenance.')}

 <div class="provider-note"><strong>Safety controls</strong><br>Paced requests, bounded refresh batches, Reddit HTTP 429 / Retry-After handling, exponential backoff and no CAPTCHA bypass.</div>`;
}
function appearance() {
    return `<h2>Appearance</h2><p>Customize themes, fonts and reading widths.</p>
 ${selectSetting('theme', 'Theme', [['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark'], ['oled', 'OLED Black'], ['sepia', 'Sepia'], ['slate', 'Slate'], ['solarized', 'Solarized']])}
 ${fieldSetting('accent', 'Accent colour', 'color')}
 <h3 class="group-title">Article subreddit label colours</h3><p>These colours affect only the subreddit name labels above articles and in post previews. They never change the sidebar feed or folder colours. Right-click a feed or folder to override. Existing untouched defaults continue using the app accent until you choose new colours.</p>
 ${fieldSetting('sidebarItemBg', 'Shared article label background', 'color')}
 ${fieldSetting('sidebarItemText', 'Shared article label text', 'color')}

 ${selectSetting('font', 'Typography', FONT_OPTIONS, 'Local fonts are used when available; otherwise the system fallback is used.')}
 ${fieldSetting('fontSize', 'Base font size (px)', 'number', 11, 20)}
 ${fieldSetting('lineHeight', 'Line height', 'number', 1.1, 2.1)}
 ${fieldSetting('sidebarFontSize', 'Main sidebar item font size (px)', 'number', 10, 20)}
 ${fieldSetting('sidebarWidth', 'Sidebar width (px)', 'number', 175, 450)}
 ${fieldSetting('readerWidth', 'Reader maximum width (px)', 'number', 560, 1700)}
 <h3 class="group-title">Full-content popup size</h3>
 <p>Set the expanded post popup dimensions as percentages of the browser viewport. These settings do not affect the three-pane reader.</p>
 ${fieldSetting('fullPopupWidthPct', 'Full-content popup width (%)', 'number', 20, 100)}
 ${fieldSetting('fullPopupHeightPct', 'Full-content popup height (%)', 'number', 20, 100)}`;
}
function reading() {
    return `<h2>Reading experience</h2><p>Control how posts display, open and transition between unread and read states.</p>
 ${selectSetting('layout', 'Default layout', [['list', 'List'], ['small-list', 'Small List'], ['magazine', 'Magazine'], ['cards', 'Cards'], ['three-pane', 'Three Pane']])}
 ${toggleSetting('showThumbs', 'Show thumbnails', 'Display preview images in the reader and popup.')}
 ${toggleSetting('showSnippets', 'Show post excerpts', 'Excerpts appear in Magazine, Cards and Small List; hidden in List.')}
 ${toggleSetting('hideRead', 'Hide read posts by default', 'Use the Unread filter in the reader to hide read items.')}
 ${toggleSetting('markReadOnOpen', 'Mark read when opening a post')}
 ${toggleSetting('autoNextUnreadCategory', 'Automatically go to the next unread category', 'After marking all posts in a feed or folder as read, switch to the next category with unread posts.')}
 ${toggleSetting('openReaderOnIconClick', 'Open full reader when clicking extension icon', 'If disabled, clicking the extension icon opens the usual unread-preview popup.')}
 <h3 class="group-title">Hover zoom</h3>
 ${toggleSetting('hoverZoomEnabled', 'Enable hover zoom', 'Show enlarged previews when hovering over supported media.')}
 ${toggleSetting('hoverZoomImages', 'Hover zoom for images')}
 ${toggleSetting('hoverZoomVideos', 'Hover zoom for videos', 'Video playback is optional and does not autoplay.')}
 ${fieldSetting('hoverZoomDelay', 'Hover activation delay (ms)', 'number', 100, 3000, 'Choose 100–3000 ms. Default is 500 ms.')}
 ${fieldSetting('hoverZoomDismissDistance', data.settings.language === 'pt-PT' ? 'Distância para fechar o HoverZoom (px)' : 'HoverZoom dismissal distance (px)', 'number', 50, 1000, data.settings.language === 'pt-PT' ? 'Fecha a pré-visualização quando o cursor se afasta mais do que esta distância do ponto de abertura. Predefinição: 200 px.' : 'Close the preview once the pointer moves this far from where it opened. Default: 200 px.')}
 <h3 class="group-title">Article text</h3>
 ${selectSetting('readingFont', 'Article font', FONT_OPTIONS)}
 ${fieldSetting('readingFontSize', 'Article font size (px)', 'number', 10, 36)}
 ${fieldSetting('readingLineHeight', 'Article line spacing', 'number', 1, 2.5)}
 ${selectSetting('badgeMode', 'Toolbar badge', [['unread', 'All unread'], ['new', 'Newly fetched in the latest update']])}
 ${fieldSetting('badgeColor', 'Badge colour', 'color')}
 ${fieldSetting('popupLimit', 'Maximum popup previews', 'number', 5, 150)}
 ${selectSetting('popupGrouping', 'Popup ordering', [['feed', 'Grouped by feed'], ['time', 'Chronological']])}
 <div class="highlight-settings" id="highlighters-settings" tabindex="-1"><h3 class="group-title">Text highlighters</h3><p>Highlight matching words or phrases only in article titles, excerpts and body text. Feed names, sidebar items and subreddit labels are excluded. Matching ignores case.</p>
 <div class="highlight-entry"><input id="highlight-term" type="text" maxlength="120" placeholder="Word or phrase to highlight" aria-label="Highlight word or phrase"><div class="highlight-palette" role="group" aria-label="Highlighter colour">${HIGHLIGHT_COLORS.map((color, i) => `<button type="button" class="highlight-swatch ${i === 0 ? 'selected' : ''}" data-highlight-swatch="${color}" style="--swatch:${color}" aria-label="Highlighter colour ${i + 1}" aria-pressed="${i === 0}"></button>`).join('')}<label class="highlight-custom-label">Custom <input id="highlight-custom" type="color" value="#ffda8b" aria-label="Custom highlighter colour"></label></div><button class="btn primary" type="button" data-act="addHighlighter">Add highlighter</button></div>
 <div class="highlight-rules">${(data.settings.highlighters || []).map(rule => `<div class="highlight-rule"><span class="highlight-example" style="background:${e(rule.color)}">${e(rule.text)}</span><button class="btn small" data-act="removeHighlighter" data-id="${e(rule.id)}" aria-label="Remove highlighter ${e(rule.text)}">Remove</button></div>`).join('') || '<p class="help">No highlighters yet.</p>'}</div></div>`;
}
function googleAccountBanner() { const status = driveMeta; const account = status?.account || null; if (!account)
    return ''; const pt = data.settings.language === 'pt-PT'; const initial = e(account.name.charAt(0).toLocaleUpperCase() || 'G'); return `<div class="connection-hero google-hero" role="status"><span class="connection-avatar" aria-label="${pt ? 'Conta Google' : 'Google account'}">${account.photo ? `<img src="${e(account.photo)}" alt="" referrerpolicy="no-referrer" loading="lazy" class="google-profile-photo">` : ''}<span class="avatar-initial">${initial}</span></span><div class="connection-hero-content"><div class="connection-eyebrow"><span class="google-g" aria-hidden="true">G</span> ${pt ? 'CONTA GOOGLE ASSOCIADA' : 'CONNECTED GOOGLE ACCOUNT'}</div><div class="connection-name">${e(account.name)}</div><div class="connection-email">${e(account.email)}</div><div class="connection-details">${status?.restoredPendingReview ? (pt ? 'Verificação anterior à cópia' : 'Verified before backup') : (pt ? 'Identidade verificada' : 'Identity verified')}: ${new Date(account.verifiedAt).toLocaleString(pt ? 'pt-PT' : 'en-US')}</div></div><span class="connection-status ${status?.lastError || status?.restoredPendingReview || !status?.enabled ? 'needs-attention' : 'connected'}">${status?.restoredPendingReview ? (pt ? 'Restaurada — em pausa' : 'Restored — paused') : status?.lastError ? (pt ? 'Verificar sincronização' : 'Check sync') : !status?.enabled ? (pt ? 'Guardada — não ligada' : 'Saved — not connected') : (pt ? 'Ligada' : 'Connected')}</span></div>`; }
function drive() {
    const status = driveMeta;
    const pt = data.settings.language === 'pt-PT';
    const redirect = status?.redirect || chrome.identity.getRedirectURL('google');
    return `${googleAccountBanner()}<div class="flex" style="align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><h2>${pt ? 'Sincronização Google Drive' : 'Google Drive sync'}</h2><button class="btn" data-act="driveHelp" aria-haspopup="dialog">${icon('help', 17)} ${pt ? 'Ajuda — configuração completa' : 'Help — step-by-step setup'}</button></div>
 <p>${pt ? 'Sincroniza automaticamente os teus feeds, pastas, ordem, favoritos e estados de leitura entre Chrome e Brave, através da mesma conta Google.' : 'Automatically sync your feeds, folders, ordering, stars and reading state between Chrome and Brave using the same Google account.'}</p>
 <div class="drive-redirect-card"><strong>${pt ? 'URI de redirecionamento para colar no Google Cloud' : 'Redirect URI to paste into Google Cloud'}</strong><div class="drive-redirect-line"><input readonly id="drive-redirect-visible" value="${e(redirect)}" title="${pt ? 'Clica para selecionar' : 'Click to select'}" aria-label="${pt ? 'URI de redirecionamento Google' : 'Google redirect URI'}"><button class="btn" data-act="driveCopyRedirect">${icon('copy', 15)} ${pt ? 'Copiar URI' : 'Copy URI'}</button></div><small>${pt ? 'No Google Cloud: Clients → Web application → Authorized redirect URIs → Add URI. Cola exatamente este endereço.' : 'In Google Cloud: Clients → Web application → Authorized redirect URIs → Add URI. Paste this exact address.'}</small></div>
 <div class="provider-note" role="status"><strong>${pt ? 'Estado:' : 'Status:'}</strong> ${e(status?.restoredPendingReview && pt ? 'Conta Google restaurada. A sincronização está em pausa até confirmares a conta.' : (status?.message || 'Checking Google Drive…'))}<br><span class="help">${status?.lastSync ? (pt ? 'Última sincronização: ' : 'Last sync: ') + new Date(status.lastSync).toLocaleString() : pt ? 'Ainda sem sincronização' : 'Not yet synchronized'}</span>${status?.lastError ? `<br><span class="statusline error">${e(status.lastError)}</span>` : ''}</div>
 <label class="field" style="margin:14px 0"><span class="drive-field-caption">${pt ? 'ID de cliente OAuth da Google (aplicação Web)' : 'Google OAuth Web application Client ID'} <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer" title="Google Cloud OAuth clients">${icon('external', 13)} ${pt ? 'Abrir na Google Cloud' : 'Open in Google Cloud'}</a></span><input id="drive-client-id" spellcheck="false" autocomplete="off" placeholder="1234567890-xxxx.apps.googleusercontent.com" value="${e(status?.clientId || '')}"><small>${pt ? 'Configura uma vez no Google Cloud e cola o ID aqui, sem editar ficheiros. Repete no segundo navegador.' : 'Create this once in Google Cloud and paste the ID here—no manifest edits. Reuse the same ID in the second browser.'}</small></label>
 <label class="field" style="margin:14px 0"><span class="drive-field-caption">${pt ? 'Client secret da aplicação Web (opcional, para sincronização contínua)' : 'Web application Client Secret (optional, for continuous background sync)'} <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer" title="Google Cloud OAuth clients">${icon('external', 13)} ${pt ? 'Abrir na Google Cloud' : 'Open in Google Cloud'}</a></span><input id="drive-client-secret" type="password" spellcheck="false" autocomplete="off" placeholder="${status?.refreshConfigured ? 'Configured — enter only to replace' : 'Optional'}"><small>${pt ? 'Para uso pessoal: guardado apenas neste navegador, não sincronizado. Permite obter e renovar tokens sem iniciar sessão após cada atualização. Pode ser extraído do perfil do navegador; nunca distribuas uma extensão com este segredo incluído.' : 'For personal use only: saved locally, never uploaded. Enables refresh tokens and avoids re-login after extension updates. Secrets in extensions can be extracted; do not distribute a build containing them.'}</small></label>
 <p class="help">${status?.refreshConfigured ? (pt ? 'Renovação automática configurada.' : 'Automatic refresh grant configured.') : (pt ? 'Sem renovação permanente: a Google poderá pedir nova autenticação após a expiração do token.' : 'Without a refresh grant, Google may require reconnection after the token expires.')}</p>
 ${status?.restoredPendingReview ? `<div class="provider-note drive-restored-review" role="status"><strong>${pt ? 'Conta restaurada — sincronização em pausa' : 'Restored account — sync paused'}</strong><p>${pt ? 'O nome, ID e tokens locais foram restaurados quando presentes. Confirma que esta é a conta correta e retoma a sincronização. A autenticação será verificada com a Google antes de a ativar.' : 'Saved account identity, client and local tokens were restored where available. Review the account and resume synchronization. Google will verify the identity before enabling it.'}<br><small>${pt ? 'Token de acesso ainda válido' : 'Access token still valid'}: ${status?.accessTokenAvailable ? (pt ? 'Sim' : 'Yes') : (pt ? 'Não' : 'No')} · ${pt ? 'Renovação guardada' : 'Saved refresh grant'}: ${status?.refreshConfigured ? (pt ? 'Sim' : 'Yes') : (pt ? 'Não' : 'No')}</small></p><button class="btn primary" data-act="driveResumeRestored">${icon('refresh', 15)} ${pt ? 'Verificar conta e retomar sincronização' : 'Verify account and resume sync'}</button></div>` : ''}
 <div class="flex" style="flex-wrap:wrap;margin:16px 0"><button class="btn primary" data-act="driveConnect">${icon('check', 16)} ${pt ? 'Iniciar sessão com a Google' : 'Sign in with Google'}</button><button class="btn" data-act="driveSync" ${status?.enabled ? '' : 'disabled'}>${icon('refresh', 15)} ${pt ? 'Sincronizar agora' : 'Sync now'}</button><button class="btn danger" data-act="driveDisconnect" ${status?.enabled ? '' : 'disabled'}>${pt ? 'Desligar' : 'Disconnect'}</button></div>
 <div class="provider-note"><strong>${pt ? 'Configuração inicial:' : 'One-time setup:'}</strong> ${pt ? 'Clica em Ajuda e segue os passos com ligações diretas. Usa o tipo de cliente <b>Aplicação Web</b> (não “Extensão do Chrome”) para a autenticação funcionar no Brave.' : 'Click Help for the complete linked setup. Choose the <b>Web application</b> client type (not “Chrome extension”) for Brave compatibility.'}<br><br><strong>${pt ? 'Incluído:' : 'Synced:'}</strong> ${pt ? 'Feeds, multireddits, pastas, ordem, lidos/não lidos, favoritos e apresentação.' : 'Feeds, multireddits, folders, ordering, read/unread, stars, and appearance.'}<br><strong>${pt ? 'Não incluído:' : 'Not synced:'}</strong> ${pt ? 'Publicações em cache, ficheiros multimédia e tokens Reddit.' : 'Cached posts, media files and Reddit tokens.'}</div>
 <p class="help">${pt ? 'A sincronização é automática depois da ligação. Os tokens da Google expiram e a aplicação tenta renovar a autorização silenciosamente; se a sessão expirar, pode ser necessário clicar novamente em Iniciar sessão.' : 'Once connected, sync runs in the background. Google tokens expire; the extension attempts silent reauthorization, but may occasionally ask you to sign in again.'}</p>`;
}
/** One-time Reddit OAuth setup guide; authorization codes must remain private. */
function redditHelpDialog() {
    document.querySelector('#reddit-help-overlay')?.remove();
    const pt = data.settings.language === 'pt-PT';
    const steps = pt ? [
        ['Regista a tua aplicação Reddit', 'Abre as preferências de aplicações do Reddit e cria uma aplicação autorizada do tipo installed app, se a plataforma permitir o registo na tua conta. O acesso à API pode exigir aprovação.', 'https://www.reddit.com/prefs/apps', 'Aplicações Reddit'],
        ['Configura o endereço de retorno', 'Define o Redirect URI igual ao que aparece em Registered redirect URI nas definições, por exemplo http://localhost:53682/substream. Tem de corresponder exatamente ao registado na aplicação.', '', ''],
        ['Copia o Client ID', 'Copia o identificador público da aplicação (não o segredo) para o campo Reddit app Client ID. Confirma que o redirect URI é igual nos dois lados.', '', ''],
        ['Gera a autorização', 'Fecha esta ajuda e clica em 1. Gerar ligação de autorização. Inicia sessão no Reddit, confirma o nome da aplicação e carrega em Allow, se concordares com as permissões.', '', ''],
        ['Encontra o URL final com F12', 'Se o Reddit redirecionar para localhost e a página não abrir, prime F12 para abrir as Ferramentas de Programador, antes de carregar em Allow se possível. No separador Network (Rede), ativa Preserve log (Preservar registo); depois de autorizar, procura o pedido localhost falhado e copia o Request URL completo, incluindo code= e state=. Em alguns navegadores, o URL pode também surgir na consola, mas Network é mais fiável. Nunca partilhes este URL ou código.', '', ''],
        ['Liga a conta', 'Cola o URL FINAL no campo 2. URL de retorno ou código de autorização (não coles a ligação inicial de autorização). Clica em 3. Ligar. Os códigos são de utilização única e expiram rapidamente.', '', ''],
        ['Confirma o estado', 'Verifica o estado da ligação no topo da página. Se falhar, confirma o Client ID, o redirect URI e se o código já foi utilizado ou expirou; volta a gerar a autorização quando necessário.', '', '']
    ] : [
        ['Register your Reddit application', 'Open Reddit app preferences and create an authorized installed app, if app registration is available to your account. API access may require approval.', 'https://www.reddit.com/prefs/apps', 'Reddit apps'],
        ['Set the redirect URI', 'Set the Redirect URI to exactly match Registered redirect URI in these settings, for example http://localhost:53682/substream.', '', ''],
        ['Copy the Client ID', 'Copy your application’s public Client ID (not a client secret) to the Reddit app Client ID field; verify the redirect URI matches.', '', ''],
        ['Generate authorization', 'Close this guide and click 1. Generate authorization link. Sign into Reddit, check the requested permissions and click Allow if you agree.', '', ''],
        ['Find the final URL with F12', 'If the localhost callback page fails to open, press F12 for Developer Tools (preferably before clicking Allow). In the Network tab, enable Preserve log, click Allow, find the failed localhost request, and copy the complete Request URL with code= and state=. The Console may show the redirect, but Network is more reliable. Never share the URL or code.', '', ''],
        ['Connect the account', 'Paste the FINAL callback URL into field 2. Final callback URL or authorization code—not the starting authorization link. Click 3. Connect. Codes are short-lived and one-use.', '', ''],
        ['Verify status', 'Check the connection status at the top. If connection fails, check the Client ID, redirect URI, and whether the code expired or was already used; regenerate the authorization if needed.', '', '']
    ];
    const node = document.createElement('div');
    node.id = 'reddit-help-overlay';
    node.className = 'modal-backdrop';
    node.innerHTML = `<div class="modal drive-help-modal" role="dialog" aria-modal="true" aria-labelledby="reddit-help-title"><div class="flex" style="align-items:center;justify-content:space-between"><h2 id="reddit-help-title">${pt ? 'Configurar o acesso Reddit — guia completo' : 'Set up Reddit access — complete guide'}</h2><button class="icon-btn" data-act="redditHelpClose" aria-label="Close">${icon('x', 19)}</button></div><p>${pt ? 'Segue os passos para autorizar a tua própria aplicação Reddit. A ligação depende das permissões que o Reddit conceder à aplicação.' : 'Follow these steps to authorize your own Reddit app. Access depends on permissions Reddit grants to the application.'}</p><ol class="drive-help-steps">${steps.map(([title, description, url, link]) => `<li><strong>${e(title)}</strong><p>${e(description)}</p>${url ? `<a class="drive-help-link" target="_blank" rel="noopener noreferrer" href="${e(url)}">${icon('external', 14)} ${e(link)}</a>` : ''}</li>`).join('')}</ol><p class="help" style="margin-top:18px">HINT: search google for Redreader redirectURI guide morphe - This will get you what you need.</p><div class="modal-controls"><button class="btn primary" data-act="redditHelpClose">${pt ? 'Fechar' : 'Close guide'}</button></div></div>`;
    document.body.append(node);
    node.addEventListener('click', ev => { if (ev.target === node) node.remove(); });
}
/** Fully self-contained, on-screen guide; addresses and steps follow current Google Auth Platform nomenclature. */
function driveHelpDialog() {
    const pt = data.settings.language === 'pt-PT', status = driveMeta;
    const steps = pt ? [
        ['Cria um projeto Google Cloud', 'Abre a consola e escolhe Criar projeto. Podes usar a tua conta Google pessoal.', 'https://console.cloud.google.com/projectcreate', 'Criar projeto'],
        ['Ativa a API Google Drive', 'Seleciona o projeto recém-criado e clica em Ativar na página da API Google Drive.', 'https://console.cloud.google.com/apis/library/drive.googleapis.com', 'Ativar API Drive'],
        ['Configura a página de consentimento', 'Em Google Auth Platform → Branding, escolhe um nome como Reddit Reader, email de suporte e email de contacto. Guarda as alterações.', 'https://console.cloud.google.com/auth/branding', 'Branding'],
        ['Define o público e o utilizador de teste', 'Em Audience escolhe External. Se a app estiver em Testing, adiciona o endereço Gmail que vais usar nos dois PCs à lista Test users.', 'https://console.cloud.google.com/auth/audience', 'Audience'],
        ['Confirma a permissão do Drive', 'Em Data access, adiciona o scope https://www.googleapis.com/auth/drive.appdata caso seja necessário. Só permite acesso aos dados próprios da aplicação.', 'https://console.cloud.google.com/auth/scopes', 'Data access'],
        ['Cria um cliente OAuth do tipo Aplicação Web', 'Em Clients → Create client, seleciona Web application (NÃO Chrome Extension). Em Authorized redirect URIs, cola o endereço da caixa ‘URI de redirecionamento’ que aparece acima dos passos e também no ecrã principal Google Drive Sync. Termina em /google. Não é preciso origem JavaScript.', 'https://console.cloud.google.com/auth/clients', 'Criar cliente OAuth'],
        ['Copia o Client ID e, se quiseres, o Client Secret', 'Cola o Client ID no campo da extensão. Para manter sincronização automática após expirar o token, podes também introduzir o Client Secret no campo opcional. Esse segredo fica apenas no perfil do navegador e pode ser extraído; usa esta opção só numa instalação privada.', 'https://console.cloud.google.com/auth/clients', 'Ver clientes'],
        ['Liga o primeiro navegador', 'Fecha esta janela, cola o Client ID no campo acima e clica Iniciar sessão com a Google. Escolhe a conta e autoriza o acesso à pasta privada da app.', '', ''],
        ['Liga o segundo navegador (Chrome ou Brave)', 'Instala o mesmo ZIP com o mesmo ID da extensão, cola o MESMO Client ID e inicia sessão com a MESMA conta Google. Os dados começam a sincronizar em segundo plano.', '', ''],
        ['Brave: se o login falhar', 'Verifica brave://settings/extensions → Allow Google login for extensions. Este método usa também a janela de autorização Web para funcionar nos dois navegadores.', '', '']
    ] : [
        ['Create a Google Cloud project', 'Open Google Cloud Console, choose Create project, and select that project for subsequent steps.', 'https://console.cloud.google.com/projectcreate', 'Create project'],
        ['Enable the Google Drive API', 'Select the new project, open the Google Drive API page, and click Enable.', 'https://console.cloud.google.com/apis/library/drive.googleapis.com', 'Enable Drive API'],
        ['Configure OAuth consent branding', 'Under Google Auth Platform → Branding, set an application name (e.g. Reddit Reader), support email and contact email, then save.', 'https://console.cloud.google.com/auth/branding', 'Branding'],
        ['Choose audience and add your test user', 'Under Audience choose External. While the app is in Testing, add the Google account you will use on both computers to Test users.', 'https://console.cloud.google.com/auth/audience', 'Audience'],
        ['Confirm the least-privilege Drive scope', 'Under Data access, add https://www.googleapis.com/auth/drive.appdata if the console requests the scope. This grants only access to the app’s own private data.', 'https://console.cloud.google.com/auth/scopes', 'Data access'],
        ['Create a Web application OAuth client', 'Under Clients → Create client, select Web application (NOT Chrome Extension). Paste the redirect URI from the labelled box ABOVE these steps (also displayed directly on the Google Drive settings page) into Authorized redirect URIs. It ends with /google. No JavaScript origin is needed.', 'https://console.cloud.google.com/auth/clients', 'Create OAuth client'],
        ['Copy Client ID and optionally Client Secret', 'Paste the public Client ID into the extension. To enable refresh tokens for persistent background sync, you can also enter your Web client secret in the optional local-only field. Treat extension storage as extractable and never distribute a customized package with your secret.', 'https://console.cloud.google.com/auth/clients', 'View OAuth clients'],
        ['Sign in on the first computer', 'Close Help, paste the Client ID in Settings, click Sign in with Google, choose the right account and allow access to private app data.', '', ''],
        ['Sign in on the second computer (Chrome or Brave)', 'Install the same extension ZIP to keep its stable extension ID, paste the SAME Client ID, and sign into the SAME Google account. Background sync starts automatically.', '', ''],
        ['Brave troubleshooting', 'If the login is blocked, check brave://settings/extensions → Allow Google login for extensions. The Web authorization window is used for cross-browser support.', '', '']
    ];
    const redirect = status?.redirect || chrome.identity.getRedirectURL('google');
    const extId = status?.extensionId || chrome.runtime.id;
    const node = document.createElement('div');
    node.id = 'drive-help-overlay';
    node.className = 'modal-backdrop';
    node.setAttribute('role', 'presentation');
    node.innerHTML = `<div class="modal drive-help-modal" role="dialog" aria-modal="true" aria-labelledby="drive-help-title"><div class="flex" style="align-items:center;justify-content:space-between"><h2 id="drive-help-title">${pt ? 'Configurar Google Drive — guia completo' : 'Set up Google Drive — complete guide'}</h2><button class="icon-btn" data-act="driveHelpClose" title="Close" aria-label="Close">${icon('x', 19)}</button></div><p>${pt ? 'Esta preparação faz-se uma única vez. Nos dois navegadores só precisas do mesmo ID de cliente e da mesma conta Google.' : 'Do the Cloud setup once. Both browsers only need the same Client ID and Google account.'}</p>
 <div class="drive-help-ids"><label>${pt ? 'ID da extensão (igual no Chrome e no Brave)' : 'Extension ID (same in Chrome and Brave)'}<input readonly value="${e(extId)}" data-copy-value="${e(extId)}" title="Select to copy"></label><label>${pt ? 'URI de redirecionamento exata' : 'Exact authorized redirect URI'}<input readonly value="${e(redirect)}" data-copy-value="${e(redirect)}" title="Select to copy"></label><button class="btn" data-act="driveCopyRedirect">${icon('copy', 15)} ${pt ? 'Copiar URI' : 'Copy redirect URI'}</button></div>
 <ol class="drive-help-steps">${steps.map(([title, description, url, link]) => `<li><strong>${e(title)}</strong><p>${e(description)}</p>${url ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer" class="drive-help-link">${icon('external', 14)} ${e(link)}</a>` : ''}</li>`).join('')}</ol>
 <div class="provider-note"><strong>${pt ? 'Autenticação contínua:' : 'Continuous authentication:'}</strong> ${pt ? 'O Client ID fica guardado localmente. Se adicionares o Client Secret opcional, a extensão pode guardar um refresh token no perfil local e renovar o acesso. Este segredo e os tokens podem ser extraídos por quem tenha acesso aos ficheiros ou ao perfil do navegador; nunca distribuas um ZIP personalizado com credenciais. A app Google Cloud em modo Testing pode limitar a duração dos refresh tokens a 7 dias; consulta o modo de publicação em Audience.' : 'The public Client ID is stored locally. When you optionally supply your own Web Client Secret, a refresh token can be stored in your browser profile for background renewal. Secrets and tokens in a browser profile can be extracted: never redistribute a customized ZIP containing credentials. A Google Cloud OAuth app in Testing may issue refresh tokens that expire after 7 days; see the Audience publishing status.'}<br><strong>${pt ? 'Se falhar:' : 'If sync fails:'}</strong> ${pt ? 'Confirma a API Drive, o URI exato, os utilizadores de teste e o estado da autorização. Poderá ser necessário voltar a iniciar sessão após revogação ou expiração de credenciais.' : 'Check the Drive API, redirect URI, test users and authorization status. Revoked or expired credentials may still require reconnection.'}</div>
 <div class="modal-controls"><button class="btn primary" data-act="driveHelpClose">${pt ? 'Fechar' : 'Close guide'}</button></div></div>`;
    document.body.append(node);
    node.querySelector('.drive-help-ids input')?.addEventListener('click', ev => ev.currentTarget.select());
    node.querySelectorAll('.drive-help-ids input').forEach(input => input.addEventListener('click', () => input.select()));
    node.addEventListener('click', ev => { if (ev.target === node)
        node.remove(); });
}
function storage() {
    const pt = data.settings.language === 'pt-PT';
    return `<h2>${pt ? 'Cópia de segurança e restauro' : 'Backup & restore'}</h2>
    <p>${pt ? 'Exporta uma cópia JSON completa dos feeds, pastas, definições, publicações em texto, histórico de leitura, favoritos e credenciais guardadas localmente. Não são incluídas imagens.' : 'Export one complete JSON file with feeds, folders, settings, text posts, reading history, starred items and locally stored credentials. Images are not included.'}</p>
    <div class="provider-note backup-private-warning" role="alert"><strong>${pt ? 'ATENÇÃO — CONTÉM INFORMAÇÃO PRIVADA' : 'WARNING — CONTAINS PRIVATE INFORMATION'}</strong><div>${pt ? 'O ficheiro NÃO é encriptado e inclui tokens de acesso e renovação Reddit/Google guardados localmente, segredos e histórico de leitura. Nunca o partilhes nem o carregues para serviços públicos. Os tokens geridos exclusivamente pelo navegador podem não ser exportáveis.' : 'This file is NOT encrypted. It includes locally stored Reddit/Google access and refresh tokens, secrets and reading history. Never share it or upload it to public services. Browser-managed tokens may not be exportable.'}</div></div>
    <h3>${pt ? 'Exportar' : 'Export'}</h3>
    <div class="flex" style="flex-wrap:wrap;margin:10px 0"><button class="btn primary" data-act="exportFull">${icon('download',16)} ${pt ? 'Exportar tudo (JSON)' : 'Export everything (JSON)'}</button><button class="btn" data-act="exportOPML">${icon('download',16)} ${pt ? 'Exportar feeds (OPML)' : 'Export feeds (OPML)'}</button><button class="btn" data-act="import">${icon('upload',16)} ${pt ? 'Importar feeds' : 'Import feeds'}</button></div>
    <h3 style="margin-top:24px">${pt ? 'Restaurar' : 'Restore'}</h3>
    <p class="help">${pt ? 'Valida antes de restaurar. Compatível com JSON v3, cópias antigas não encriptadas v2 e importações antigas v1. Cópias antigas encriptadas devem ser abertas na versão 1.0.62.' : 'Validated before restore. Supports JSON v3, older unencrypted v2 backups and legacy v1 imports. Old encrypted backups require version 1.0.62.'}</p>
    <label class="field" style="margin:12px 0"><span>${pt ? 'Selecionar ficheiro JSON' : 'Select JSON backup'}</span><input id="restore-file" type="file" accept=".json,application/json"></label>
    <label class="setting-row"><div><strong>${pt ? 'Modo de restauro' : 'Restore strategy'}</strong><small>${pt ? 'Substituir apaga a biblioteca atual; juntar preserva os feeds e artigos adicionais.' : 'Replace resets the current library; merge preserves additional feeds and posts.'}</small></div><select id="restore-mode"><option value="replace">${pt ? 'Substituir biblioteca' : 'Replace local library'}</option><option value="merge">${pt ? 'Juntar à biblioteca' : 'Merge into current library'}</option></select></label>
    <div class="flex" style="flex-wrap:wrap;margin-top:12px"><button class="btn primary" data-act="restoreFull">${icon('upload',16)} ${pt ? 'Validar e restaurar JSON' : 'Validate & restore JSON'}</button></div>
    <div class="provider-note" style="margin-top:14px">${pt ? 'O restauro pausa a sincronização Google Drive para evitar a reposição acidental de dados antigos. As credenciais guardadas no ficheiro são restauradas quando disponíveis, mas poderão precisar de nova autorização.' : 'Restoring pauses Google Drive sync to prevent stale cloud data from overwriting your library. Locally backed-up credentials are restored when available, but may require reauthorization.'}</div>
    <div class="provider-note" style="margin-top:10px">${pt
        ? 'Depois de um restauro, a extensão atualiza automaticamente todos os feeds e procura imagens em falta em publicações antigas. Este processo pode continuar após fechar as Definições e fica em pausa se a autorização ou os limites do Reddit não permitirem pedidos.'
        : 'After restoring, the extension automatically refreshes every feed and repairs missing images in older posts. Recovery continues after closing Settings and pauses when Reddit authorization or rate limits prevent requests.'}</div>
    <div id="backup-feedback" class="help" role="status" style="margin-top:10px"></div>
    <div class="danger-zone"><strong>${pt ? 'Apagar biblioteca local' : 'Delete local library'}</strong><p>${pt ? 'Apaga feeds, pastas, publicações e histórico de leitura, sem apagar tokens.' : 'Deletes feeds, folders, posts and reading history without deleting tokens.'}</p><button class="btn danger" data-act="reset">${icon('trash',16)} ${pt ? 'Apagar biblioteca' : 'Delete library data'}</button></div>`;
}
/** Diagnostics show real local counters, and Reddit-reported rate headers when
 * available. Missing/stale rate headers are not presented as a daily API cap. */
function diagnostics() {
    const pt = data.settings.language === 'pt-PT';
    const d = data.diagnostics || {};
    const m = diagnosticsMetrics;
    const locale = pt ? 'pt-PT' : 'en-US';
    const count = value => Number.isFinite(value) ? Number(value).toLocaleString(locale) : '—';
    const size = bytes => {
        if (!Number.isFinite(bytes)) return '—';
        if (bytes < 1024) return `${count(bytes)} B`;
        const exp = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
        return `${(bytes / 1024 ** exp).toLocaleString(locale, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB'][exp]}`;
    };
    const time = timestamp => Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp).toLocaleString(locale) : (pt ? 'Indisponível' : 'Unavailable');
    const metric = (label, value) => `<div class="diag-metric"><dt>${e(label)}</dt><dd>${e(String(value))}</dd></div>`;
    const group = (title, content, note = '') => `<section class="diag-group"><h3>${e(title)}</h3><dl class="diag-grid">${content}</dl>${note ? `<p class="diag-note">${e(note)}</p>` : ''}</section>`;
    const rate = m?.rateLimit ?? d.redditRateLimit;
    const hasRate = Boolean(rate && [rate.used, rate.remaining, rate.resetAt].some(Number.isFinite));
    const rateTotal = hasRate && Number.isFinite(rate.used) && Number.isFinite(rate.remaining)
        ? (rate.used + rate.remaining) : null;
    const rateExpired = hasRate && Number.isFinite(rate.resetAt) && rate.resetAt <= Date.now();
    const dataFeedCount = data.feeds?.length || 0;
    const live = m?.refresh || data.refreshProgress || {};
    const storage = m?.stores || {};
    const storageText = diagnosticsLoading ? (pt ? 'A calcular tamanhos da cache…' : 'Calculating cache sizes…')
        : diagnosticsFailure ? (pt ? 'Não foi possível obter os tamanhos: ' : 'Unable to load cache sizes: ') + diagnosticsFailure
        : (pt ? 'Os tamanhos detalhados são calculados ao abrir este separador.' : 'Detailed sizes are calculated when this tab opens.');
    const library = group(pt ? 'Biblioteca e cache' : 'Library & cache', [
        metric(pt ? 'Feeds subscritos' : 'Subscribed feeds', count(dataFeedCount)),
        metric(pt ? 'Pastas' : 'Folders', count(data.folders?.length || 0)),
        metric(pt ? 'Publicações em cache' : 'Cached articles', count(data.posts?.length || 0)),
        metric(pt ? 'Não lidas' : 'Unread articles', count(data.posts?.filter(p => !p.read).length || 0)),
        metric(pt ? 'Favoritos locais' : 'Locally starred', count(data.posts?.filter(p => p.starred).length || 0)),
        metric(pt ? 'Associações feed-publicação' : 'Feed–post associations', count(data.subscriptions?.length || 0)),
        metric(pt ? 'Ícones de comunidades em cache' : 'Cached community icons', count(m?.iconCacheEntries))
    ].join(''));
    const request = group(pt ? 'Pedidos e atualizações' : 'Requests & updates', [
        metric(pt ? 'Pedidos hoje (UTC)' : 'Requests today (UTC)', count(d.requestsToday || 0)),
        metric(pt ? 'Pedidos no minuto atual' : 'Requests this minute', count(m?.requestsLastMinute)),
        metric(pt ? 'Pedidos nos últimos 60 minutos' : 'Requests in the last 60 minutes', count(m?.requestsLastHour)),
        metric(pt ? 'Pedidos de ícones hoje' : 'Icon requests today', count(d.iconRequestsToday || 0)),
        metric(pt ? 'Última atualização de feeds' : 'Last feed refresh', time(d.lastRun)),
        metric(pt ? 'Atualização em curso' : 'Refresh currently running', live.active ? `${count(live.completed || 0)} / ${count(live.total || 0)}` : (pt ? 'Não' : 'No')),
        metric(pt ? 'Feeds com erro' : 'Feeds reporting errors', count(data.feeds?.filter(f => f.lastError).length || 0))
    ].join(''), pt ? 'Os contadores de pedidos são tentativas reservadas pela extensão, não um limite diário imposto por ela.' : 'Request counts represent attempts reserved by the extension, not an extension-enforced daily limit.');
    const serverRate = group(pt ? 'Limites reportados pelo Reddit' : 'Rate limits reported by Reddit', hasRate ? [
        metric(pt ? 'Pedidos utilizados na janela' : 'Used in reported window', count(rate.used)),
        metric(pt ? 'Pedidos restantes na janela' : 'Remaining in reported window', count(rate.remaining)),
        metric(pt ? 'Total aproximado da janela' : 'Approximate window total', count(rateTotal)),
        metric(pt ? 'Fim da janela reportado' : 'Reported window reset', time(rate.resetAt)),
        metric(pt ? 'Última observação' : 'Last observed', time(rate.observedAt)),
        metric(pt ? 'Validade da amostra' : 'Sample status', rateExpired ? (pt ? 'Janela já terminou — dados históricos' : 'Window ended — historical data') : (pt ? 'Última resposta recebida' : 'Most recent response'))
     ].join('') : metric(pt ? 'Estado' : 'Status', pt ? 'A aguardar cabeçalhos X-Ratelimit do Reddit' : 'Waiting for Reddit X-Ratelimit headers'),
    pt ? 'Os valores são aproximados e referem-se à janela comunicada pelo servidor; não equivalem necessariamente a limites por minuto, hora ou dia.' : 'These are approximate server-reported window values, not necessarily per-minute, hourly or daily limits.');
    const recovery = m?.restoreRecovery;
    const recoveryGroup = recovery ? group(pt ? 'Recuperação após restauro' : 'Post-restore recovery', [
        metric(pt ? 'Estado' : 'Stage', recovery.stage === 'complete'
            ? (pt ? 'Concluído' : 'Complete')
            : recovery.stage === 'feeds' ? (pt ? 'A atualizar feeds' : 'Refreshing feeds')
            : (pt ? 'A recuperar imagens' : 'Recovering images')),
        metric(pt ? 'Feeds a atualizar' : 'Feeds to refresh', count(recovery.feedIds?.length || 0)),
        metric(pt ? 'Publicações verificadas' : 'Posts checked for missing media', count(recovery.checked || 0)),
        metric(pt ? 'Imagens recuperadas' : 'Posts with recovered images', count(recovery.repaired || 0)),
        metric(pt ? 'Repetir depois de' : 'Retry after', time(recovery.retryAt)),
        metric(pt ? 'Último erro' : 'Last error', recovery.lastError || (pt ? 'Nenhum' : 'None'))
    ].join(''), pt ? 'As imagens são recuperadas como URLs. Não são descarregados ficheiros de imagem para a cache do backup.'
        : 'Only image URLs are recovered; no image binaries are downloaded into the backup cache.') : '';
    const storageGroup = group(pt ? 'Armazenamento local' : 'Local storage', [
        metric(pt ? 'Cache de publicações (JSON estimado)' : 'Article cache (estimated JSON)', size(storage.posts?.estimatedJsonBytes)),
        metric(pt ? 'Associações (JSON estimado)' : 'Associations (estimated JSON)', size(storage.subscriptions?.estimatedJsonBytes)),
        metric(pt ? 'Feeds (JSON estimado)' : 'Feeds (estimated JSON)', size(storage.feeds?.estimatedJsonBytes)),
        metric(pt ? 'Pastas (JSON estimado)' : 'Folders (estimated JSON)', size(storage.folders?.estimatedJsonBytes)),
        metric(pt ? 'Total IndexedDB (JSON estimado)' : 'IndexedDB total (estimated JSON)', size(m?.estimatedJsonBytes)),
        metric('chrome.storage.local', size(m?.localBytes)),
        metric(pt ? 'Utilização reportada pelo navegador' : 'Browser-reported origin usage', size(m?.originUsageBytes)),
        metric(pt ? 'Quota reportada pelo navegador' : 'Browser-reported origin quota', size(m?.originQuotaBytes))
    ].join(''), pt ? 'Os tamanhos JSON são estimativas da cache; a utilização real do IndexedDB pode diferir devido a índices, compressão e overhead.' : 'JSON sizes estimate cached records; actual IndexedDB disk usage may differ due to indexes, compression and overhead.');
    const health = group(pt ? 'Estado e erros' : 'Status & errors', [
        metric(pt ? 'Estado do fornecedor' : 'Provider status', String(d.providerStatus || '—')),
        metric(pt ? 'Pausa imposta por rate limiting' : 'Rate-limit backoff until', time(m?.blockedUntil ?? d.rateReset)),
        metric(pt ? 'Último erro' : 'Last error', String(d.lastError || (pt ? 'Nenhum' : 'None'))),
        metric(pt ? 'Inventário da cache calculado em' : 'Storage inventory measured at', time(m?.measuredAt))
    ].join(''));
    return `<h2>${pt ? 'Diagnósticos' : 'Diagnostics'}</h2>
      <p>${pt ? 'Estado da biblioteca, memória local, pedidos e limites realmente comunicados pelo Reddit.' : 'Library, local storage, requests, and limits actually reported by Reddit.'}</p>
      <div class="diag-controls"><button class="btn" type="button" data-act="refreshDiagnostics" ${diagnosticsLoading ? 'disabled' : ''}>${icon('refresh',16)} ${pt ? 'Recalcular métricas' : 'Recalculate metrics'}</button>
      <button class="btn" type="button" data-act="refresh">${icon('refresh',16)} ${pt ? 'Atualizar feeds' : 'Refresh feeds'}</button></div>
      ${(diagnosticsLoading || diagnosticsFailure || !m) ? `<p class="diag-note" role="status">${e(storageText)}</p>` : ''}
      ${library}${request}${serverRate}${recoveryGroup}${storageGroup}${health}
      <p class="diag-note">${pt ? 'Se o Reddit bloquear pedidos, abre reddit.com normalmente e segue as instruções. A extensão não contorna restrições.' : 'If Reddit blocks access, open reddit.com normally and follow its instructions. The extension does not bypass restrictions.'}</p>`;
}

function render() {
    apply();
    const pt = data.settings.language === 'pt-PT';
    const onboarding = notificationOnboardingPending ? `<section class="notification-onboarding" aria-label="${pt ? 'Ativar notificações' : 'Enable notifications'}"><div><strong>${pt ? 'Ativar notificações do Reddit Reader?' : 'Enable Reddit Reader notifications?'}</strong><p>${pt ? 'Para receber alertas das regras, autoriza as notificações. O Chrome mostrará o pedido quando clicares em Ativar.' : 'Allow notifications for your rules. Chrome will request permission when you click Enable.'}</p></div><button type="button" class="btn primary" data-act="requestNotificationsOnboarding">${pt ? 'Ativar notificações' : 'Enable notifications'}</button><button type="button" class="btn" data-act="skipNotificationsOnboarding">${pt ? 'Agora não' : 'Not now'}</button></section>` : '';
    const sections = { provider, feeds: feedsPanel, updates, appearance, reading, drive, storage, diagnostics };
    app.innerHTML = `<div class="options-shell"><div class="options-header"><span class="brand-mark" style="width:48px;height:48px;border-radius:13px"><img src="icons/48.png" width="45" height="45" alt=""></span><div><h1>Reddit Reader Settings</h1><div class="muted">Your Reddit feeds. Your reading experience.</div></div><span class="spacer"></span><label class="header-language"><span>Language</span><select data-key="language" aria-label="Language"><option value="en" ${data.settings.language === 'en' ? 'selected' : ''}>English</option><option value="pt-PT" ${data.settings.language === 'pt-PT' ? 'selected' : ''}>Português (Portugal)</option></select></label><button class="btn" data-act="reader">${icon('external', 16)} Open Reader</button></div>${onboarding}<div class="options-grid">${sectionNav()}<section class="settings-panel">${(sections[section] || provider)()}</section></div></div>`; applyHighlighters(app, data.settings.highlighters);
    const refreshButton = app.querySelector('[data-act="refresh"]');
    if (refreshButton) {
        const active = Boolean(data.refreshProgress?.active && data.refreshProgress?.total > 0);
        refreshButton.disabled = active;
        refreshButton.classList.toggle('is-refreshing', active);
        refreshButton.setAttribute('aria-busy', String(active));
    }
    if (location.hash === '#highlighters' && section === 'reading')
        requestAnimationFrame(() => document.querySelector('#highlighters-settings')?.scrollIntoView({ block: 'start' }));
}
async function refreshDiagnostics(force = false) {
    diagnosticsLoading = true;
    diagnosticsFailure = '';
    if (section === 'diagnostics') render();
    try { diagnosticsMetrics = await send('getDetailedDiagnostics', { force }); }
    catch (error) { diagnosticsFailure = String(error?.message || error); }
    finally { diagnosticsLoading = false; if (section === 'diagnostics') render(); }
}
async function load() { data = await send('getState');
    notificationOnboardingPending = Boolean((await chrome.storage.local.get('rrNotificationOnboardingPending')).rrNotificationOnboardingPending); if (section === 'provider') {
    try {
        oauthMeta = await send('oauthStatus');
    }
    catch {
        oauthMeta = null;
    }
} if (section === 'drive') {
    try {
        driveMeta = await send('driveStatus');
    }
    catch {
        driveMeta = null;
    }
} apply(); render(); if (section === 'diagnostics') void refreshDiagnostics(); }
async function action(type, payload = {}, msg = '') { try {
    const result = await send(type, payload);
    await load();
    if (msg)
        toast(msg);
    return result;
}
catch (err) {
    toast(err.message);
    return null;
} }
function feedPaths() { const map = new Map(data.folders.map(f => [f.id, f])); const folderPath = (id) => { const arr = []; const seen = new Set(); while (id && !seen.has(id)) {
    seen.add(id);
    const f = map.get(id);
    if (!f)
        break;
    arr.unshift(f.name);
    id = f.parentId;
} return arr; }; return data.feeds.map(f => ({ ...f, folderPath: folderPath(f.folderId) })); }
function downloadFile(output, filename, type = 'application/json') {
    const href = URL.createObjectURL(new Blob([output], { type }));
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
}
function exportFile() {
    const feedItems = feedPaths();
    const root = { children: new Map(), feeds: [] };
    for (const feed of feedItems) {
        let node = root;
        for (const name of feed.folderPath) {
            if (!node.children.has(name))
                node.children.set(name, { children: new Map(), feeds: [] });
            node = node.children.get(name);
        }
        node.feeds.push(feed);
    }
    const print = (node) => [...Array.from(node.children.entries()).map(([key, child]) => `<outline text="${e(key)}">${print(child)}</outline>`), ...node.feeds.map((f) => `<outline text="${e(f.name)}" type="rss" xmlUrl="${e(feedOpenUrl(f))}" htmlUrl="${e(feedOpenUrl(f))}"/>`)].join('');
    downloadFile(`<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>Reddit Reader feeds</title></head><body>${print(root)}</body></opml>`, 'reddit-reader-feeds.opml', 'application/xml');
    toast('Exported OPML subscription list');
}
function backupFeedback(message) { const el = document.querySelector('#backup-feedback'); if (el)
    el.textContent = message; }
function askImport() { document.querySelector('#import-overlay')?.remove(); const node = document.createElement('div'); node.className = 'modal-backdrop'; node.id = 'import-overlay'; node.innerHTML = `<div class="modal"><h2>Import subscriptions</h2><p>Paste subreddit names, combined feeds (science+technology), Reddit URLs or import OPML/TXT. Nested OPML folders are preserved. Existing feeds are never overwritten.</p><label class="field">Subreddits / URLs<textarea rows="5" id="import-urls" placeholder="r/science\nr/technology\nscience+technology"></textarea></label><label class="field" style="margin-top:12px">Choose file<input type="file" id="import-file" accept=".xml,.opml,.txt,.json"></label><div class="modal-controls"><button class="btn" data-act="cancelImport">Cancel</button><button class="btn primary" data-act="submitImport">Import</button></div></div>`; document.body.append(node); }
document.addEventListener('click', async (ev) => {
    const redirectInput = ev.target.closest('#drive-redirect-visible');
    if (redirectInput) {
        redirectInput.select();
        return;
    }
    const el = ev.target.closest('[data-tab],[data-act]');
    if (!el)
        return;
    if (el.dataset.tab) {
        section = el.dataset.tab;
        if (location.hash === '#highlighters') history.replaceState(null, '', location.pathname);
        render();
        if (section === 'diagnostics') void refreshDiagnostics();
        return;
    }
    const id = el.dataset.id || '';
    switch (el.dataset.act) {
        case 'refreshDiagnostics':
            await refreshDiagnostics(true);
            break;
        case 'addHighlighter': {
            const text = (document.querySelector('#highlight-term')?.value || '').trim();
            if (!text || text.length > 120) {
                toast('Enter a word or phrase (up to 120 characters)');
                break;
            }
            const current = data.settings.highlighters || [];
            if (current.some(rule => rule.text.toLowerCase() === text.toLowerCase())) {
                toast('That phrase is already highlighted');
                break;
            }
            await action('saveSettings', { patch: { highlighters: [...current, { id: crypto.randomUUID(), text, color: chosenHighlightColor }] } }, 'Highlighter added');
            break;
        }
        case 'removeHighlighter':
            await action('saveSettings', { patch: { highlighters: (data.settings.highlighters || []).filter(rule => rule.id !== id) } }, 'Highlighter removed');
            break;
        case 'redditHelp':
            redditHelpDialog();
            break;
        case 'redditHelpClose':
            document.querySelector('#reddit-help-overlay')?.remove();
            break;
        case 'requestNotificationsOnboarding': {
            // Trigger the optional permission request synchronously from the
            // user's click; awaiting anything beforehand loses the gesture.
            let allowed = false;
            try { allowed = await chrome.permissions.request({ permissions: ['notifications'] }); }
            catch (error) { toast(String(error?.message || error)); }
            await chrome.storage.local.remove('rrNotificationOnboardingPending');
            notificationOnboardingPending = false;
            render();
            toast(allowed ? (data.settings.language === 'pt-PT' ? 'Notificações autorizadas' : 'Notifications enabled') : (data.settings.language === 'pt-PT' ? 'Notificações não autorizadas. Podes ativá-las mais tarde nas Regras.' : 'Notifications not enabled. You can enable them later in Rules.'));
            break;
        }
        case 'skipNotificationsOnboarding':
            await chrome.storage.local.remove('rrNotificationOnboardingPending');
            notificationOnboardingPending = false;
            render();
            break;
        case 'driveHelp':
            driveHelpDialog();
            break;
        case 'driveHelpClose':
            document.querySelector('#drive-help-overlay')?.remove();
            break;
        case 'driveCopyRedirect': {
            const value = driveMeta?.redirect || chrome.identity.getRedirectURL('google');
            try {
                await navigator.clipboard.writeText(value);
                toast('Redirect URI copied');
            }
            catch {
                toast('Select and copy the URI shown in Help');
            }
            break;
        }
        case 'driveConnect': {
            const clientId = document.querySelector('#drive-client-id')?.value.trim() || '';
            await action('driveConnect', { clientId, ...(document.querySelector('#drive-client-secret')?.value.trim() ? { clientSecret: document.querySelector('#drive-client-secret').value.trim() } : {}) }, 'Google Drive connected and first sync completed');
            break;
        }
        case 'driveResumeRestored':
            await action('driveResumeRestored', {}, data.settings.language === 'pt-PT' ? 'Conta Google verificada. Sincronização retomada.' : 'Google account verified. Synchronization resumed.');
            break;
        case 'driveSync':
            await action('driveSync', {}, 'Google Drive synchronization completed');
            break;
        case 'driveDisconnect':
            if (confirm('Disconnect Google Drive sync on this device? Local feeds and reading history remain.'))
                await action('driveDisconnect', {}, 'Disconnected from Google Drive');
            break;
        case 'reader':
            await send('openReader');
            break;
        case 'import':
            askImport();
            break;
        case 'cancelImport':
            document.querySelector('#import-overlay')?.remove();
            break;
        case 'submitImport': {
            const raw = document.querySelector('#import-urls').value;
            const file = document.querySelector('#import-file').files?.[0];
            const result = parseLines(raw);
            try {
                if (file) {
                    const contents = await file.text();
                    if (/\.(opml|xml)$/i.test(file.name)) {
                        const parsed = parseOPML(contents);
                        result.items.push(...parsed.items);
                        result.errors.push(...parsed.errors);
                    }
                    else if (/\.json$/i.test(file.name)) {
                        const parsed = JSON.parse(contents);
                        if (parsed.format === 'substream-backup-v1')
                            result.items.push(...parsed.feeds.map((f) => ({ subreddit: f.subreddit, name: f.name, folderPath: f.folderPath || [] })));
                        else if (parsed.format === 'reddit-reader-complete-v2' || parsed.format === 'reddit-reader-complete-v3')
                            throw Error('This is a complete backup. Use Settings → Backup & restore to restore your feeds, settings, history and tokens.');
                        else if (Array.isArray(parsed))
                            result.items.push(...parseLines(parsed.join('\n')).items);
                        else
                            throw Error('Unsupported JSON format');
                    }
                    else
                        result.items.push(...parseLines(contents).items);
                }
                if (!result.items.length) {
                    toast('No valid feeds found');
                    break;
                }
                const outcome = await action('import', { items: result.items });
                document.querySelector('#import-overlay')?.remove();
                if (outcome)
                    toast(`Imported ${outcome.added} · duplicates ${outcome.duplicates} · invalid ${result.errors.length}`);
            }
            catch (error) {
                toast('Import failed: ' + String(error));
            }
            break;
        }
        case 'newFolder': {
            const name = prompt('New folder name');
            if (name?.trim())
                await action('addFolder', { name: name.trim(), parentId: null }, 'Folder created');
            break;
        }
        case 'newChildFolder': {
            const name = prompt('New subfolder name');
            if (name?.trim())
                await action('addFolder', { name: name.trim(), parentId: id }, 'Subfolder created');
            break;
        }
        case 'renameFolder': {
            const f = data.folders.find(f => f.id === id);
            if (!f)
                break;
            const name = prompt('Rename folder', f.name);
            if (name?.trim())
                await action('editFolder', { id, patch: { name: name.trim() } }, 'Renamed');
            break;
        }
        case 'removeFolder':
            if (confirm('Delete this folder? Subscriptions and child folders move up.'))
                await action('removeFolder', { id }, 'Folder removed');
            break;
        case 'removeFeed':
            if (confirm('Unsubscribe from this feed?'))
                await action('removeFeed', { id }, 'Feed removed');
            break;
        case 'refresh': {
            const r = await action('refresh');
            if (r)
                toast(r.alreadyRunning ? (data.settings.language === 'pt-PT' ? 'Já está a decorrer uma atualização.' : 'An update is already running.') : r.queued ? (data.settings.language === 'pt-PT' ? 'Atualização iniciada.' : 'Refresh started.') : (r.reason || 'No feeds to update.'));
            break;
        }
        case 'beginOAuth': {
            const clientId = document.querySelector('#oauth-client-id').value.trim();
            const redirectUri = document.querySelector('#oauth-redirect').value.trim();
            try {
                const result = await send('oauthBegin', { clientId, redirectUri });
                await chrome.tabs.create({ url: result.authorizationUrl });
                oauthFeedback('Authorization page opened. Click Allow in Reddit and copy the FINAL callback URL, containing code= and state=. Do not paste the original Reddit authorization link.');
                toast('Complete Reddit authorization, then copy the final redirect.');
            }
            catch (error) {
                oauthFeedback(error.message);
                toast(error.message);
            }
            break;
        }
        case 'exchangeOAuth': {
            const clientId = document.querySelector('#oauth-client-id').value.trim();
            const redirectUri = document.querySelector('#oauth-redirect').value.trim();
            const authorizationCode = document.querySelector('#oauth-code').value.trim();
            if (!authorizationCode) {
                oauthFeedback('Paste the one-use code or the final callback URL first; the original authorization URL is not a code.');
                break;
            }
            try {
                const result = await send('oauthExchange', { clientId, redirectUri, authorizationCode });
                await load();
                toast(result.username ? 'Connected to Reddit as u/' + result.username : 'OAuth token connected; Reddit identity could not be verified');
            }
            catch (error) {
                const message = error.message;
                oauthFeedback(message);
                toast('OAuth: see the explanation below the code field.');
            }
            break;
        }
        case 'disconnectOAuth':
            if (confirm('Disconnect your Reddit OAuth app and delete its saved tokens?'))
                await action('oauthDisconnect', {}, 'OAuth tokens removed');
            break;
        case 'exportOPML':
            exportFile();
            break;
        case 'exportFull': {
            const pt = data.settings.language === 'pt-PT';
            try {
                backupFeedback(pt ? 'A preparar ficheiro JSON…' : 'Preparing JSON backup…');
                const archive = await send('exportFullBackup');
                if (!archive || archive.format !== 'reddit-reader-complete-v3' || !archive.settings || !Array.isArray(archive.feeds) || !archive.credentials)
                    throw new Error('Backup is incomplete; nothing was saved.');
                const filename = 'reddit-reader-complete-v3-' + new Date().toISOString().slice(0,10) + '.json';
                downloadFile(JSON.stringify(archive, null, 2), filename);
                backupFeedback(pt ? 'Ficheiro exportado. Contém tokens e outros dados privados — não partilhar.' : 'Backup saved. Contains tokens and private data — do not share.');
                toast(pt ? 'Cópia de segurança exportada' : 'Complete backup exported');
            } catch(error) {
                backupFeedback((pt ? 'Falha na exportação: ' : 'Export failed: ') + error.message);
                toast((pt ? 'Falha na exportação: ' : 'Export failed: ') + error.message);
            }
            break;
        }
        case 'restoreFull': {
            const pt = data.settings.language === 'pt-PT';
            try {
                const file = document.querySelector('#restore-file').files?.[0];
                if (!file)
                    throw Error('Choose a JSON backup file first.');
                if (file.size > 100_000_000) throw Error('Backup exceeds the 100 MB safety limit.');
                const mode = document.querySelector('#restore-mode').value === 'merge' ? 'merge' : 'replace';
                backupFeedback('Checking the backup file...');
                const backup = JSON.parse(await file.text());
                const summary = await send('inspectFullBackup', { backup });
                const strategy = summary.format === 'v1' ? 'MERGE ONLY — old v1 format' : mode.toUpperCase();
                const description = pt ? `Cópia de ${summary.exportedAt}\n${summary.feeds} feeds, ${summary.folders} pastas, ${summary.posts} publicações, ${summary.settings} definições\n${summary.unread} não lidas, ${summary.starred} favoritos\nTokens Reddit: ${summary.hasCredentials ? 'sim (sem encriptação)' : 'não'}\nTokens Google guardados localmente: ${summary.hasGoogleLocalTokens ? 'sim' : 'não'}\n\nModo: ${strategy}\nA conta Google será restaurada quando existir no ficheiro. A sincronização ficará em pausa até confirmares a conta nas definições Google Drive.\n\nContinuar?` : `Backup from ${summary.exportedAt}\n${summary.feeds} feeds, ${summary.folders} folders, ${summary.posts} posts, ${summary.settings} settings\n${summary.unread} unread, ${summary.starred} starred\nReddit tokens: ${summary.hasCredentials ? 'yes (UNENCRYPTED)' : 'no'}\nLocally saved Google tokens: ${summary.hasGoogleLocalTokens ? 'yes' : 'no'}\n\nStrategy: ${strategy}\nThe saved Google account will be restored when present. Sync remains paused until you review the Google Drive settings.\n\nContinue?`;
                if (!confirm(description)) {
                    backupFeedback(pt ? 'Restauro cancelado: biblioteca mantida.' : 'Restore cancelled; current library unchanged.');
                    break;
                }
                if (summary.format !== 'v1' && mode === 'replace' && prompt('This REPLACES local feeds, cached posts, folders and settings. Type RESTORE to confirm:') !== 'RESTORE') {
                    backupFeedback(pt ? 'Restauro cancelado: biblioteca mantida.' : 'Restore cancelled; current library unchanged.');
                    break;
                }
                backupFeedback(pt ? 'A restaurar a cópia validada…' : 'Restoring verified backup…');
                const result = await send('restoreFullBackup', { backup, mode });
                await load();
                section = result.legacy ? 'storage' : 'drive';
                if (section === 'drive') { try { driveMeta = await send('driveStatus'); } catch { driveMeta = null; } }
                render();
                if (result.legacy) backupFeedback(result.message);
                else toast(pt ? 'Restauro concluído. Atualização geral dos feeds e recuperação de imagens iniciadas. Verifica a conta Google Drive.' : 'Restore completed. Full feed refresh and missing-image recovery queued. Review the Google Drive connection.');
                if (result.legacy) toast(pt ? 'Cópia de segurança restaurada' : 'Backup successfully restored');
            }
            catch (error) {
                backupFeedback((pt ? 'Falha no restauro: ' : 'Restore failed: ') + error.message + (pt ? '. Se houve um erro de armazenamento, verifica a biblioteca antes de repetir.' : '. If storage failed, check the library before retrying.'));
            }
            break;
        }
        case 'reset':
            if (prompt('Type RESET to delete the local library') === 'RESET')
                await action('reset', { confirm: 'RESET' }, 'Library cleared');
            break;
    }
});
app.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-highlight-swatch]') : null;
    if (!target)
        return;
    chosenHighlightColor = target.dataset.highlightSwatch || HIGHLIGHT_COLORS[0];
    document.querySelectorAll('[data-highlight-swatch]').forEach(button => { const chosen = button === target; button.classList.toggle('selected', chosen); button.setAttribute('aria-pressed', String(chosen)); });
});
app.addEventListener('change', async (ev) => {
    const t = ev.target;
    const key = t.dataset.key;
    if (key) {
        if (key === 'providerMode')
            return;
        let value = t.type === 'checkbox' ? t.checked : t.value;
        if (t.type === 'number') {
            value = Number(value);
            if (!Number.isFinite(value))
                return;
            if (key === 'hoverZoomDismissDistance') value = Math.round(Math.max(50, Math.min(1000, value)));
        }
        await action('saveSettings', { patch: { [key]: value } }, 'Setting saved');
        return;
    }
    if (t.id === 'highlight-custom') {
        chosenHighlightColor = t.value;
        document.querySelectorAll('[data-highlight-swatch]').forEach(button => button.classList.remove('selected'));
        return;
    }
    if (t.classList.contains('feed-folder'))
        await action('patchFeed', { id: t.dataset.feed, patch: { folderId: t.value || null } }, 'Feed moved');
    if (t.classList.contains('feed-frequency'))
        await action('patchFeed', { id: t.dataset.feed, patch: { refreshMinutes: t.value === 'inherit' ? null : Number(t.value) } }, 'Frequency updated');
});
app.addEventListener('error', ev => { const img = ev.target; if (img instanceof HTMLImageElement && img.classList.contains('google-profile-photo'))
    img.hidden = true; }, true);
window.addEventListener('hashchange', () => {
    if (location.hash === '#highlighters') {
        section = 'reading';
        if (data) render();
    }
});
let lastReportedRefreshFinish = 0;
chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'stateChanged') load();
    else if (message?.type === 'refreshProgressChanged') {
        const progress = message.progress || {};
        const button = document.querySelector('[data-act="refresh"]');
        if (button) { const active = Boolean(progress.active && progress.total > 0); button.classList.toggle('is-refreshing', active); button.setAttribute('aria-busy', String(active)); button.disabled = active; }
        const finished = progress.lastResult;
        if (finished?.finishedAt > lastReportedRefreshFinish) {
            lastReportedRefreshFinish = finished.finishedAt;
            if (finished.reason && finished.reason !== 'OK') toast(finished.reason);
        }
    }
});
load().catch(err => app.textContent = String(err));
installLocalization();

// A restore may continue after this page opens; display its persistent progress.
installRestoreRecoveryIndicator(() => data?.settings?.language || 'en');
