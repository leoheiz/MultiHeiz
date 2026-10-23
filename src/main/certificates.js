'use strict';

/**
 * Certificados de cliente (e-CPF/e-CNPJ) + erros de certificado + info do site.
 *
 * - select-client-certificate → overlay in-app (não diálogo nativo)
 * - Lembrar por origem (state.clientCertChoices { origin: fingerprint })
 * - certificate-error → página pt-BR; «Continuar» só para hosts privados/locais
 * - Cadeado / info do site via cache de setCertificateVerifyProc (sem alterar verificação)
 */

const { app, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

/** @type {(() => import('electron').BrowserWindow|null) | null} */
let getMainWindow = null;
/** @type {((payload: object) => void) | null} */
let emitToRenderer = null;
/** @type {((wc: Electron.WebContents) => string|null) | null} */
let resolveAccountIdFromWebContents = null;
/** @type {(() => object) | null} */
let getState = null;
/** @type {((fn: (s: object) => void) => void) | null} */
let updateState = null;
/** @type {(() => void) | null} */
let flushSave = null;

/** @type {WeakSet<Electron.Session>} */
const attachedSessions = new WeakSet();
/** @type {WeakSet<Electron.WebContents>} */
const attachedContents = new WeakSet();

/** Cache de certificado do servidor por host (sem porta). */
/** @type {Map<string, { secure: boolean, http: boolean, certificate: object|null, verificationResult?: string, errorCode?: number, updatedAt: number }>} */
const hostCertCache = new Map();

/** Permitir certificado inválido só nesta sessão: host|fingerprint → true */
/** @type {Map<string, true>} */
const sessionCertAllow = new Map();

/** Pedidos de certificado cliente pendentes. */
/** @type {Map<string, { accountId: string, origin: string, url: string, list: object[], callback: (cert?: object) => void }>} */
const pendingClientPick = new Map();

/** Erros de certificado pendentes (após callback(false); continue → allow + reload). */
/** @type {Map<string, { accountId: string, url: string, host: string, error: string, certificate: object, allowContinue: boolean, webContents: Electron.WebContents|null }>} */
const pendingCertErrors = new Map();

let ipcRegistered = false;
let appHooksRegistered = false;
let nextId = 1;

/** Auto-resposta no selftest (sem GUI). */
let selftestClientCertHook = null;

function makeId(prefix) {
  return `${prefix}-${nextId++}-${Date.now().toString(36)}`;
}

function originOfUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch {
    /* ignore */
  }
  return '';
}

function hostOfUrl(url) {
  try {
    return new URL(String(url || '')).hostname || '';
  } catch {
    return '';
  }
}

/**
 * Fingerprint estável (sha256 se houver; senão serial+subject).
 * @param {Electron.Certificate|object|null} cert
 */
function fingerprintOf(cert) {
  if (!cert || typeof cert !== 'object') return '';
  const fp =
    cert.fingerprint ||
    cert.fingerprint256 ||
    (cert.fingerprintSHA256 ? String(cert.fingerprintSHA256) : '');
  if (fp) return String(fp).trim();
  const sub = (cert.subject && (cert.subject.commonName || cert.subjectName)) || '';
  const serial = cert.serialNumber || '';
  return `${sub}|${serial}`.trim();
}

/**
 * @param {Electron.Certificate|object|null} cert
 */
function summarizeCert(cert) {
  if (!cert || typeof cert !== 'object') return null;
  const subject =
    (cert.subject && (cert.subject.commonName || cert.subject.organizations)) ||
    cert.subjectName ||
    '';
  const issuer =
    (cert.issuer && (cert.issuer.commonName || cert.issuer.organizations)) ||
    cert.issuerName ||
    '';
  const validStart = cert.validStart != null ? Number(cert.validStart) : null;
  const validExpiry = cert.validExpiry != null ? Number(cert.validExpiry) : null;
  const now = Date.now() / 1000;
  const expired =
    validExpiry != null && Number.isFinite(validExpiry) ? validExpiry < now : false;
  return {
    subject: String(subject || '—'),
    issuer: String(issuer || '—'),
    validStart,
    validExpiry,
    expired,
    fingerprint: fingerprintOf(cert),
    serialNumber: cert.serialNumber ? String(cert.serialNumber) : '',
  };
}

/**
 * Host privado/local (RFC1918, loopback, ULA, localhost, *.local).
 * Avalia o NOME (ou literal IP), não o IP resolvido — hosts públicos mapeados
 * para 127.0.0.1 continuam públicos.
 * @param {string} hostname
 */
function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === 'localhost.') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map((x) => Number(x));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
    const [a, b] = parts;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    // fc00::/7 unique local; fe80::/10 link-local; ::1 already handled
    const compact = h.replace(/:/g, '');
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
      return true;
    }
    void compact;
    return false;
  }

  return false;
}

/**
 * @param {string} error Chromium net error string / name
 */
function certErrorReasonPt(error) {
  const e = String(error || '').toLowerCase();
  if (/expired|cert_date_invalid|ERR_CERT_DATE_INVALID/i.test(e)) {
    return 'O certificado está expirado ou ainda não é válido.';
  }
  if (/authority_invalid|ERR_CERT_AUTHORITY_INVALID|untrusted|unknown.?ca/i.test(e)) {
    return 'O emissor do certificado não é confiável.';
  }
  if (/common_name|ERR_CERT_COMMON_NAME_INVALID|name.?mismatch|hostname/i.test(e)) {
    return 'O nome no certificado não confere com o endereço do site.';
  }
  if (/self.?signed|ERR_CERT_AUTHORITY_INVALID/i.test(e)) {
    return 'O certificado é autoassinado ou de uma autoridade não reconhecida.';
  }
  if (/revoked|ERR_CERT_REVOKED/i.test(e)) {
    return 'O certificado foi revogado.';
  }
  if (/weak|ERR_CERT_WEAK/i.test(e)) {
    return 'O certificado usa criptografia fraca.';
  }
  if (/invalid|ERR_CERT/i.test(e)) {
    return 'Há um problema com o certificado do site.';
  }
  return 'Não foi possível validar o certificado do site.';
}

function getClientCertChoices() {
  const st = getState ? getState() : null;
  const map = (st && st.clientCertChoices) || {};
  return map && typeof map === 'object' ? map : {};
}

function setClientCertChoice(origin, fingerprint) {
  if (!updateState || !origin) return;
  updateState((s) => {
    if (!s.clientCertChoices || typeof s.clientCertChoices !== 'object') {
      s.clientCertChoices = {};
    }
    if (fingerprint) s.clientCertChoices[origin] = String(fingerprint);
    else delete s.clientCertChoices[origin];
  });
  if (flushSave) flushSave();
}

function clearClientCertChoices() {
  if (!updateState) return { ok: true, cleared: 0 };
  let cleared = 0;
  updateState((s) => {
    const prev = s.clientCertChoices && typeof s.clientCertChoices === 'object' ? s.clientCertChoices : {};
    cleared = Object.keys(prev).length;
    s.clientCertChoices = {};
  });
  if (flushSave) flushSave();
  return { ok: true, cleared };
}

function cacheHostCert(hostname, info) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!h) return;
  hostCertCache.set(h, { ...info, updatedAt: Date.now() });
}

function getCachedHostCert(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!h) return null;
  return hostCertCache.get(h) || null;
}

function sessionAllowKey(host, fingerprint) {
  return `${String(host || '').toLowerCase()}|${String(fingerprint || '')}`;
}

function isSessionAllowed(host, fingerprint) {
  return sessionCertAllow.has(sessionAllowKey(host, fingerprint));
}

function allowForSession(host, fingerprint) {
  sessionCertAllow.set(sessionAllowKey(host, fingerprint), true);
}

/**
 * @param {Electron.Session} ses
 */
function attachToSession(ses) {
  if (!ses || attachedSessions.has(ses)) return;
  attachedSessions.add(ses);
  try {
    ses.setCertificateVerifyProc((request, callback) => {
      try {
        const hostname = String((request && request.hostname) || '');
        const certificate = request && request.certificate;
        const errorCode = request && request.errorCode;
        const verificationResult = request && request.verificationResult;
        const fp = fingerprintOf(certificate);
        const allowed = isSessionAllowed(hostname, fp);
        cacheHostCert(hostname, {
          secure: !errorCode || allowed,
          http: false,
          certificate: certificate || null,
          verificationResult: verificationResult || '',
          errorCode: errorCode || 0,
        });
        if (allowed) {
          callback(0);
          return;
        }
        // -3 = manter o resultado do Chromium (não alterar verificação)
        callback(-3);
      } catch {
        try {
          callback(-3);
        } catch {
          /* ignore */
        }
      }
    });
  } catch (err) {
    console.warn('[certificates] setCertificateVerifyProc', err && err.message);
  }
}

/**
 * @param {Electron.WebContents} wc
 * @param {string} accountId
 */
function attachToWebContents(wc, accountId) {
  if (!wc || attachedContents.has(wc)) return;
  attachedContents.add(wc);

  const onNav = (_e, url) => {
    try {
      const u = new URL(String(url || ''));
      if (u.protocol === 'http:') {
        cacheHostCert(u.hostname, {
          secure: false,
          http: true,
          certificate: null,
        });
      }
    } catch {
      /* ignore */
    }
  };
  try {
    wc.on('did-navigate', onNav);
    wc.on('did-navigate-in-page', onNav);
  } catch {
    /* ignore */
  }

  void accountId;
}

function listCertsForUi(certificateList) {
  return (certificateList || []).map((c) => summarizeCert(c)).filter(Boolean);
}

/**
 * @param {Electron.WebContents} webContents
 * @param {string} url
 * @param {Electron.Certificate[]} certificateList
 * @param {(cert?: Electron.Certificate) => void} callback
 */
function handleSelectClientCertificate(webContents, url, certificateList, callback) {
  const accountId =
    (resolveAccountIdFromWebContents && resolveAccountIdFromWebContents(webContents)) ||
    'unknown';
  const origin = originOfUrl(url) || url;
  const list = Array.isArray(certificateList) ? certificateList : [];
  const remembered = getClientCertChoices()[origin];

  if (remembered) {
    const match = list.find((c) => fingerprintOf(c) === remembered);
    if (match) {
      try {
        callback(match);
      } catch {
        callback();
      }
      return;
    }
  }

  if (typeof selftestClientCertHook === 'function') {
    try {
      const decision = selftestClientCertHook({
        accountId,
        origin,
        url,
        list: listCertsForUi(list),
        certificates: list,
      });
      if (decision && decision.action === 'cancel') {
        callback();
        return;
      }
      if (decision && decision.fingerprint) {
        const match = list.find((c) => fingerprintOf(c) === decision.fingerprint);
        if (decision.remember) setClientCertChoice(origin, decision.fingerprint);
        callback(match || undefined);
        return;
      }
      if (decision && decision.index != null && list[decision.index]) {
        const chosen = list[decision.index];
        if (decision.remember) setClientCertChoice(origin, fingerprintOf(chosen));
        callback(chosen);
        return;
      }
    } catch (err) {
      console.warn('[certificates] selftest hook', err && err.message);
    }
  }

  if (process.env.MULTIHEIZ_SELFTEST && !selftestClientCertHook) {
    // Selftest sem hook: cancela (evita diálogo nativo / travar)
    callback();
    return;
  }

  const requestId = makeId('clientcert');
  pendingClientPick.set(requestId, {
    accountId,
    origin,
    url: String(url || ''),
    list,
    callback,
  });

  if (emitToRenderer) {
    emitToRenderer({
      type: 'certificates:client-pick',
      requestId,
      accountId,
      origin,
      url: String(url || ''),
      certificates: listCertsForUi(list),
    });
  } else {
    callback();
    pendingClientPick.delete(requestId);
  }
}

/**
 * @param {Electron.WebContents} webContents
 * @param {string} url
 * @param {string} error
 * @param {Electron.Certificate} certificate
 * @param {(trust: boolean) => void} callback
 */
function handleCertificateError(webContents, url, error, certificate, callback) {
  const accountId =
    (resolveAccountIdFromWebContents && resolveAccountIdFromWebContents(webContents)) ||
    'unknown';
  const host = hostOfUrl(url);
  const fp = fingerprintOf(certificate);
  const allowContinue = isPrivateOrLocalHost(host);

  cacheHostCert(host, {
    secure: false,
    http: false,
    certificate: certificate || null,
    verificationResult: String(error || ''),
    errorCode: -1,
  });

  if (isSessionAllowed(host, fp)) {
    callback(true);
    return;
  }

  // Rejeita a carga original e mostra página de erro própria.
  try {
    callback(false);
  } catch {
    /* ignore */
  }

  const requestId = makeId('certerr');
  pendingCertErrors.set(requestId, {
    accountId,
    url: String(url || ''),
    host,
    error: String(error || ''),
    certificate,
    allowContinue,
    webContents: webContents && !webContents.isDestroyed() ? webContents : null,
  });

  const summary = summarizeCert(certificate);
  const reason = certErrorReasonPt(error);

  const continueBtn = allowContinue
    ? `<button type="button" id="mh-cert-continue" class="primary" data-role="cert-continue">Continuar mesmo assim</button>`
    : '';
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Conexão não segura</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family:Segoe UI,system-ui,sans-serif; background:#1a1d23; color:#e8eaed;
    display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .card { max-width:520px; width:100%; }
  h1 { font-size:1.35rem; margin:0 0 12px; }
  p { line-height:1.45; color:#b8bdc7; margin:0 0 10px; }
  .host { color:#f0c674; word-break:break-all; }
  .meta { font-size:0.85rem; color:#8b919a; margin-top:16px; }
  .actions { margin-top:22px; display:flex; gap:10px; flex-wrap:wrap; }
  button { font:inherit; padding:10px 16px; border-radius:8px; border:1px solid #3a3f4b; background:#2a2f3a; color:#e8eaed; cursor:pointer; }
  button.primary { background:#3d6df0; border-color:#3d6df0; }
</style></head><body>
<main class="card" data-role="cert-error-page" data-host="${escapeHtml(host)}" data-allow-continue="${allowContinue ? '1' : '0'}">
  <h1>Conexão não segura</h1>
  <p>${escapeHtml(reason)}</p>
  <p>Site: <span class="host">${escapeHtml(host || url)}</span></p>
  <div class="meta">
    <div>Assunto: ${escapeHtml((summary && summary.subject) || '—')}</div>
    <div>Emissor: ${escapeHtml((summary && summary.issuer) || '—')}</div>
    <div>Impressão digital: ${escapeHtml((summary && summary.fingerprint) || '—')}</div>
  </div>
  <div class="actions">
    <button type="button" id="mh-cert-back" data-role="cert-back">Voltar</button>
    ${continueBtn}
  </div>
  <p class="meta" id="mh-cert-note">${
    allowContinue
      ? 'Este endereço parece local/privado. Continuar só vale para esta sessão.'
      : 'Por segurança, não é possível ignorar o erro em sites da internet pública.'
  }</p>
</main>
<script>
(function(){
  var rid = ${JSON.stringify(requestId)};
  function go(action) {
    location.href = 'https://multiheiz.invalid/cert-error/' + action + '?rid=' + encodeURIComponent(rid);
  }
  var b = document.getElementById('mh-cert-back');
  if (b) b.onclick = function(){ go('cancel'); };
  var c = document.getElementById('mh-cert-continue');
  if (c) c.onclick = function(){ go('continue'); };
  window.__mhCertError = { requestId: rid, host: ${JSON.stringify(host)}, allowContinue: ${
    allowContinue ? 'true' : 'false'
  }, reason: ${JSON.stringify(reason)} };
})();
</script>
</body></html>`;

  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  setImmediate(() => {
    try {
      if (webContents && !webContents.isDestroyed()) {
        webContents.loadURL(dataUrl).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  });

  if (emitToRenderer) {
    emitToRenderer({
      type: 'certificates:error',
      requestId,
      accountId,
      url: String(url || ''),
      host,
      error: String(error || ''),
      reason,
      allowContinue,
      certificate: summary,
    });
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Intercepta navegação da página de erro de certificado.
 * @param {Electron.WebContents} wc
 * @param {string} url
 * @returns {boolean} true se consumiu
 */
function maybeHandleCertErrorNavigation(wc, url) {
  const u = String(url || '');
  if (!u.includes('multiheiz.invalid/cert-error/')) return false;
  let action = '';
  let rid = '';
  try {
    const parsed = new URL(u);
    const parts = parsed.pathname.split('/').filter(Boolean);
    // cert-error / continue|cancel
    action = parts[1] || '';
    rid = parsed.searchParams.get('rid') || '';
  } catch {
    return true;
  }
  respondCertError(rid, action === 'continue' ? 'continue' : 'cancel');
  void wc;
  return true;
}

function respondClientPick(requestId, action, fingerprint, remember) {
  const pending = pendingClientPick.get(requestId);
  if (!pending) return { ok: false, reason: 'missing' };
  pendingClientPick.delete(requestId);
  const { list, callback, origin } = pending;
  if (action === 'cancel' || !fingerprint) {
    try {
      callback();
    } catch {
      /* ignore */
    }
    if (emitToRenderer) {
      emitToRenderer({ type: 'certificates:client-pick-closed', requestId, accountId: pending.accountId });
    }
    return { ok: true };
  }
  const match = list.find((c) => fingerprintOf(c) === fingerprint);
  if (remember && fingerprint) setClientCertChoice(origin, fingerprint);
  try {
    callback(match || undefined);
  } catch {
    try {
      callback();
    } catch {
      /* ignore */
    }
  }
  if (emitToRenderer) {
    emitToRenderer({ type: 'certificates:client-pick-closed', requestId, accountId: pending.accountId });
  }
  return { ok: true };
}

function respondCertError(requestId, action) {
  const pending = pendingCertErrors.get(requestId);
  if (!pending) return { ok: false, reason: 'missing' };
  pendingCertErrors.delete(requestId);
  const { host, certificate, allowContinue, url, accountId, webContents } = pending;
  const fp = fingerprintOf(certificate);
  let trust = false;
  if (action === 'continue' && allowContinue) {
    allowForSession(host, fp);
    trust = true;
    try {
      if (webContents && !webContents.isDestroyed() && url) {
        webContents.loadURL(url).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }
  if (emitToRenderer) {
    emitToRenderer({
      type: 'certificates:error-resolved',
      requestId,
      accountId,
      trust,
      url,
      host,
    });
  }
  return { ok: true, trust };
}

/**
 * Site info para o cadeado / popover.
 * @param {string} accountId
 * @param {string} urlOrOrigin
 */
function getSiteSecurityInfo(accountId, urlOrOrigin) {
  void accountId;
  let url = String(urlOrOrigin || '');
  let host = '';
  let protocol = '';
  try {
    const u = new URL(url.includes('://') ? url : 'https://' + url);
    host = u.hostname;
    protocol = u.protocol;
    url = u.href;
  } catch {
    host = hostOfUrl(url);
  }
  if (protocol === 'http:') {
    return {
      secure: false,
      http: true,
      label: 'Conexão não segura',
      host,
      certificate: null,
    };
  }
  const cached = getCachedHostCert(host);
  if (cached && cached.http) {
    return {
      secure: false,
      http: true,
      label: 'Conexão não segura',
      host,
      certificate: null,
    };
  }
  if (cached && cached.certificate) {
    const ok = !!cached.secure && !cached.errorCode;
    return {
      secure: ok,
      http: false,
      label: ok ? 'Conexão segura' : 'Conexão não segura',
      host,
      certificate: summarizeCert(cached.certificate),
      verificationResult: cached.verificationResult || '',
    };
  }
  if (protocol === 'https:') {
    return {
      secure: true,
      http: false,
      label: 'Conexão segura',
      host,
      certificate: null,
    };
  }
  return {
    secure: false,
    http: false,
    label: 'Conexão não segura',
    host,
    certificate: null,
  };
}

function openWindowsCertManager() {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      reason: 'platform',
      message: 'O gerenciador de certificados do Windows só está disponível no Windows.',
    };
  }
  try {
    // certmgr.msc via shell — abre o MMC de certificados do usuário
    const r = shell.openPath('certmgr.msc');
    if (r && typeof r.then === 'function') {
      r.then((errMsg) => {
        if (errMsg) {
          spawn('certmgr.msc', [], { detached: true, stdio: 'ignore' }).unref();
        }
      }).catch(() => {
        spawn('certmgr.msc', [], { detached: true, stdio: 'ignore' }).unref();
      });
    }
    return { ok: true };
  } catch (err) {
    try {
      spawn('certmgr.msc', [], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    } catch (err2) {
      return {
        ok: false,
        reason: 'spawn',
        message: (err2 && err2.message) || (err && err.message) || 'Falha ao abrir',
      };
    }
  }
}

function registerAppHooks() {
  if (appHooksRegistered) return;
  appHooksRegistered = true;

  app.on('select-client-certificate', (event, webContents, url, certificateList, callback) => {
    event.preventDefault();
    handleSelectClientCertificate(webContents, url, certificateList, callback);
  });

  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    handleCertificateError(webContents, url, error, certificate, callback);
  });
}

function registerIpcHandlers() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('certificates:client-respond', (_e, payload) => {
    const requestId = payload && payload.requestId;
    const action = payload && payload.action;
    const fingerprint = payload && payload.fingerprint;
    const remember = !!(payload && payload.remember);
    return respondClientPick(requestId, action, fingerprint, remember);
  });

  ipcMain.handle('certificates:error-respond', (_e, payload) => {
    const requestId = payload && payload.requestId;
    const action = payload && payload.action;
    return respondCertError(requestId, action === 'continue' ? 'continue' : 'cancel');
  });

  ipcMain.handle('certificates:site-info', (_e, payload) => {
    return getSiteSecurityInfo(
      payload && payload.accountId,
      (payload && (payload.url || payload.origin)) || ''
    );
  });

  ipcMain.handle('certificates:open-windows-manager', () => openWindowsCertManager());

  ipcMain.handle('certificates:forget-remembered', () => clearClientCertChoices());

  ipcMain.handle('certificates:list-remembered', () => {
    const map = getClientCertChoices();
    return { choices: { ...map } };
  });
}

/**
 * @param {object} opts
 */
function initCertificates(opts) {
  getMainWindow = opts.getMainWindow || null;
  emitToRenderer = opts.emit || null;
  resolveAccountIdFromWebContents = opts.resolveAccountIdFromWebContents || null;
  getState = opts.getState || null;
  updateState = opts.updateState || null;
  flushSave = opts.flushSave || null;
  registerAppHooks();
  registerIpcHandlers();
}

/** ——— Selftest hooks ——— */

function setSelftestClientCertHook(fn) {
  selftestClientCertHook = typeof fn === 'function' ? fn : null;
}

function selftestPeekClientPick(accountId) {
  for (const [id, p] of pendingClientPick) {
    if (!accountId || p.accountId === accountId) return { requestId: id, ...p, list: listCertsForUi(p.list) };
  }
  return null;
}

function selftestPeekCertError(accountId) {
  for (const [id, p] of pendingCertErrors) {
    if (!accountId || p.accountId === accountId) {
      return {
        requestId: id,
        accountId: p.accountId,
        url: p.url,
        host: p.host,
        error: p.error,
        reason: certErrorReasonPt(p.error),
        allowContinue: p.allowContinue,
        certificate: summarizeCert(p.certificate),
      };
    }
  }
  return null;
}

/**
 * Emite seletor sintético (mesmo caminho da UI).
 * @param {Electron.WebContents} webContents
 * @param {string} url
 * @param {object[]} fakeCerts minimal Certificate-like objects
 * @returns {Promise<{ fingerprint?: string, cancelled?: boolean }>}
 */
function selftestEmitClientCertPicker(webContents, url, fakeCerts) {
  return new Promise((resolve) => {
    const list = (fakeCerts || []).map((c, i) => ({
      data: '',
      issuerName: c.issuerName || c.issuer || 'Issuer Test',
      subjectName: c.subjectName || c.subject || `Subject ${i + 1}`,
      serialNumber: c.serialNumber || `SN-${i + 1}`,
      validStart: c.validStart != null ? c.validStart : Math.floor(Date.now() / 1000) - 86400,
      validExpiry: c.validExpiry != null ? c.validExpiry : Math.floor(Date.now() / 1000) + 86400 * 365,
      fingerprint: c.fingerprint || `FAKEFP${i + 1}`,
      issuer: { commonName: c.issuerName || c.issuer || 'Issuer Test' },
      subject: { commonName: c.subjectName || c.subject || `Subject ${i + 1}` },
    }));
    handleSelectClientCertificate(webContents, url, list, (chosen) => {
      if (!chosen) resolve({ cancelled: true });
      else resolve({ fingerprint: fingerprintOf(chosen), cancelled: false });
    });
  });
}

function clearSessionAllowancesForTest() {
  sessionCertAllow.clear();
}

function clearHostCertCacheForTest() {
  hostCertCache.clear();
}

module.exports = {
  initCertificates,
  attachToSession,
  attachToWebContents,
  maybeHandleCertErrorNavigation,
  isPrivateOrLocalHost,
  certErrorReasonPt,
  fingerprintOf,
  summarizeCert,
  getSiteSecurityInfo,
  getClientCertChoices,
  clearClientCertChoices,
  setClientCertChoice,
  openWindowsCertManager,
  setSelftestClientCertHook,
  selftestPeekClientPick,
  selftestPeekCertError,
  selftestEmitClientCertPicker,
  respondClientPick,
  respondCertError,
  clearSessionAllowancesForTest,
  clearHostCertCacheForTest,
  allowForSession,
  hostCertCache,
};
