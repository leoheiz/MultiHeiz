'use strict';

/**
 * Proxy por janela (partição persist:acc-*).
 * Senha só em safeStorage (encryptString → base64); nunca logada nem enviada ao renderer.
 */

const { session: electronSession } = require('electron');

const PROXY_TYPES = new Set(['none', 'http', 'https', 'socks5', 'socks4']);
const DEFAULT_BYPASS = '<local>';
const MAX_PROXY_AUTH_ATTEMPTS = 2;

/** @type {Map<string, number>} accountId → falhas de auth de proxy */
const authFailures = new Map();

/** Conta com auth pendente (ex.: session.fetch sem webContents). */
let pendingAuthAccountId = null;

/** @type {((payload: object) => void) | null} */
let emitToRenderer = null;

/** @type {(() => object) | null} */
let getStateFn = null;

/** @type {((fn: (s: object) => void) => void) | null} */
let updateStateFn = null;

/** @type {((accountId: string) => void) | null} */
let reloadPanelFn = null;

/** URL de teste em selftest (eco local); senão ipify */
function testUrl() {
  const env = process.env.MULTIHEIZ_PROXY_TEST_URL;
  if (env && /^https?:\/\//i.test(env)) return env;
  return 'https://api.ipify.org?format=json';
}

/**
 * @param {object} opts
 */
function initProxy(opts) {
  emitToRenderer = opts.emit || null;
  getStateFn = opts.getState || null;
  updateStateFn = opts.updateState || null;
  reloadPanelFn = opts.reloadPanel || null;
}

function getState() {
  return getStateFn ? getStateFn() : { accounts: [] };
}

/**
 * @param {unknown} host
 * @returns {string|null}
 */
function normalizeHost(host) {
  const h = String(host || '').trim();
  if (!h) return null;
  if (/\s/.test(h)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(h)) return null;
  if (h.includes('/') || h.includes('?') || h.includes('#')) return null;
  return h;
}

/**
 * @param {unknown} port
 * @returns {number|null}
 */
function normalizePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * @param {unknown} type
 * @returns {string|null}
 */
function normalizeType(type) {
  const t = String(type || 'none').toLowerCase();
  if (!PROXY_TYPES.has(t)) return null;
  return t;
}

/**
 * Valida e normaliza config de proxy (sem senha ainda).
 * @param {object} input
 * @returns {{ ok: true, config: object } | { ok: false, error: string }}
 */
function validateProxyInput(input) {
  const raw = input || {};
  const type = normalizeType(raw.type);
  if (!type) {
    return { ok: false, error: 'Tipo de proxy inválido.' };
  }
  if (type === 'none') {
    return {
      ok: true,
      config: {
        type: 'none',
        host: '',
        port: 0,
        username: '',
        bypass: DEFAULT_BYPASS,
      },
    };
  }
  const host = normalizeHost(raw.host);
  if (!host) {
    return { ok: false, error: 'Host inválido (sem espaços, sem esquema http://).' };
  }
  const port = normalizePort(raw.port);
  if (port == null) {
    return { ok: false, error: 'Porta inválida (1–65535).' };
  }
  const username = String(raw.username || '').trim();
  let bypass = String(raw.bypass != null ? raw.bypass : DEFAULT_BYPASS).trim();
  if (!bypass) bypass = DEFAULT_BYPASS;
  return {
    ok: true,
    config: { type, host, port, username, bypass },
  };
}

/**
 * @returns {{
 *   available: boolean,
 *   backend: string,
 *   encrypt: (s: string) => string|null,
 *   decrypt: (b64: string) => string|null
 * }}
 */
function safeStorageApi() {
  let safeStorage = null;
  try {
    safeStorage = require('electron').safeStorage;
  } catch {
    safeStorage = null;
  }
  let backend = 'unknown';
  try {
    if (safeStorage && typeof safeStorage.getSelectedStorageBackend === 'function') {
      backend = String(safeStorage.getSelectedStorageBackend() || 'unknown');
    }
  } catch {
    backend = 'unknown';
  }
  const encryptionFlag = !!(
    safeStorage &&
    typeof safeStorage.isEncryptionAvailable === 'function' &&
    safeStorage.isEncryptionAvailable()
  );
  // basic_text = Linux sem keyring — não serve para segredos.
  const available = encryptionFlag && backend !== 'basic_text';
  return {
    available,
    backend,
    encrypt(plain) {
      if (!available || plain == null || plain === '') return null;
      try {
        const buf = safeStorage.encryptString(String(plain));
        return Buffer.from(buf).toString('base64');
      } catch {
        return null;
      }
    },
    decrypt(b64) {
      if (!available || !b64) return null;
      try {
        const buf = Buffer.from(String(b64), 'base64');
        return safeStorage.decryptString(buf);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Vista pública (sem senha) para o renderer / publicState.
 * @param {object|null|undefined} proxy
 * @returns {object|null}
 */
function publicProxyView(proxy) {
  if (!proxy || typeof proxy !== 'object') return null;
  const type = normalizeType(proxy.type) || 'none';
  if (type === 'none') {
    return { type: 'none', host: '', port: 0, username: '', bypass: DEFAULT_BYPASS, passwordSaved: false, active: false };
  }
  const host = String(proxy.host || '');
  const port = Number(proxy.port) || 0;
  return {
    type,
    host,
    port,
    username: String(proxy.username || ''),
    bypass: String(proxy.bypass != null ? proxy.bypass : DEFAULT_BYPASS),
    passwordSaved: !!(proxy.passwordEnc && String(proxy.passwordEnc).length),
    active: !!(host && port),
  };
}

/**
 * @param {object} account
 * @returns {object}
 */
function sanitizeAccountProxyForPublic(account) {
  if (!account || typeof account !== 'object') return account;
  const out = { ...account };
  if (out.proxy) {
    out.proxy = publicProxyView(out.proxy);
  }
  delete out.proxyPassword;
  delete out.proxyPasswordEnc;
  return out;
}

/**
 * Remove senha em claro / ciphertext de exportações.
 * @param {object} state
 * @returns {object}
 */
function stripProxySecretsFromState(state) {
  const s = state || {};
  if (!Array.isArray(s.accounts)) return s;
  for (const a of s.accounts) {
    if (!a || typeof a !== 'object') continue;
    delete a.proxyPassword;
    if (a.proxy && typeof a.proxy === 'object') {
      delete a.proxy.password;
      delete a.proxy.passwordEnc;
      a.proxy.passwordSaved = false;
    }
  }
  return s;
}

/**
 * @param {object} proxy stored
 * @returns {string|null} proxyRules or null for direct
 */
function buildProxyRules(proxy) {
  const type = normalizeType(proxy && proxy.type);
  if (!type || type === 'none') return null;
  const host = normalizeHost(proxy.host);
  const port = normalizePort(proxy.port);
  if (!host || port == null) return null;
  return `${type}://${host}:${port}`;
}

/**
 * @param {string} accountId
 * @returns {object|null}
 */
function getStoredProxy(accountId) {
  const acc = (getState().accounts || []).find((a) => a.id === accountId);
  return acc && acc.proxy ? acc.proxy : null;
}

/**
 * @param {string} accountId
 * @param {import('electron').Session} [ses]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function applyProxyToSession(accountId, ses) {
  let session = ses;
  if (!session) {
    try {
      const partition = `persist:acc-${accountId}`;
      session = electronSession.fromPartition(partition);
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'Sessão indisponível' };
    }
  }
  const proxy = getStoredProxy(accountId);
  const rules = buildProxyRules(proxy);
  try {
    if (!rules) {
      await session.setProxy({ mode: 'direct' });
    } else {
      const bypass =
        proxy && proxy.bypass != null && String(proxy.bypass).trim()
          ? String(proxy.bypass).trim()
          : DEFAULT_BYPASS;
      await session.setProxy({
        proxyRules: rules,
        proxyBypassRules: bypass,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Falha ao aplicar proxy' };
  }
}

/**
 * Reaplica proxy de todas as contas (início do app).
 * @returns {Promise<void>}
 */
async function applyAllAccountProxies() {
  const accounts = getState().accounts || [];
  for (const acc of accounts) {
    if (!acc || !acc.id) continue;
    const view = publicProxyView(acc.proxy);
    if (!view || !view.active) continue;
    await applyProxyToSession(acc.id);
  }
}

/**
 * @param {import('electron').Session} ses
 */
async function closeSessionConnections(ses) {
  try {
    if (ses && typeof ses.clearAuthCache === 'function') {
      await ses.clearAuthCache();
    }
  } catch {
    /* ignore */
  }
  try {
    if (ses && typeof ses.closeAllConnections === 'function') {
      await ses.closeAllConnections();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Salva config (criptografa senha se fornecida).
 * @param {string} accountId
 * @param {object} input  { type, host, port, username, password?, clearPassword?, bypass }
 * @returns {Promise<{ ok: boolean, error?: string, passwordWarning?: string, state?: object, proxy?: object }>}
 */
async function setProxyForAccount(accountId, input) {
  const validated = validateProxyInput(input);
  if (!validated.ok) return { ok: false, error: validated.error };

  const acc = (getState().accounts || []).find((a) => a.id === accountId);
  if (!acc) return { ok: false, error: 'Janela não encontrada.' };

  const cfg = validated.config;
  const prev = acc.proxy && typeof acc.proxy === 'object' ? acc.proxy : {};
  let passwordEnc = prev.passwordEnc || null;
  let passwordWarning = '';

  const ss = safeStorageApi();
  const clearPassword = !!(input && input.clearPassword);
  const passwordProvided = input && Object.prototype.hasOwnProperty.call(input, 'password');
  const passwordValue = passwordProvided ? String(input.password ?? '') : null;

  if (cfg.type === 'none' || clearPassword) {
    passwordEnc = null;
  } else if (passwordProvided) {
    if (passwordValue === '') {
      passwordEnc = null;
    } else if (!ss.available) {
      passwordEnc = null;
      passwordWarning =
        'Criptografia do sistema indisponível: a senha do proxy não foi salva.';
    } else {
      const enc = ss.encrypt(passwordValue);
      if (!enc) {
        passwordEnc = null;
        passwordWarning =
          'Não foi possível criptografar a senha do proxy; ela não foi salva.';
      } else {
        passwordEnc = enc;
      }
    }
  }

  const stored =
    cfg.type === 'none'
      ? { type: 'none', host: '', port: 0, username: '', bypass: DEFAULT_BYPASS, passwordEnc: null }
      : {
          type: cfg.type,
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          bypass: cfg.bypass,
          passwordEnc,
        };

  if (updateStateFn) {
    updateStateFn((s) => {
      const a = (s.accounts || []).find((x) => x.id === accountId);
      if (a) a.proxy = stored;
    });
  }

  authFailures.delete(accountId);

  const partition = `persist:acc-${accountId}`;
  let ses;
  try {
    ses = electronSession.fromPartition(partition);
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Sessão indisponível' };
  }

  const applied = await applyProxyToSession(accountId, ses);
  if (!applied.ok) return applied;

  await closeSessionConnections(ses);
  if (reloadPanelFn) {
    try {
      reloadPanelFn(accountId);
    } catch {
      /* ignore */
    }
  }

  return {
    ok: true,
    passwordWarning: passwordWarning || undefined,
    proxy: publicProxyView(stored),
  };
}

/**
 * Remove proxy (volta a direto).
 * @param {string} accountId
 */
async function removeProxyForAccount(accountId) {
  return setProxyForAccount(accountId, { type: 'none' });
}

/**
 * Credenciais de proxy para a conta (nunca logar).
 * @param {string} accountId
 * @returns {{ username: string, password: string }|null}
 */
function getProxyCredentials(accountId) {
  const proxy = getStoredProxy(accountId);
  if (!proxy || normalizeType(proxy.type) === 'none') return null;
  const username = String(proxy.username || '');
  let password = '';
  if (proxy.passwordEnc) {
    const ss = safeStorageApi();
    password = ss.decrypt(proxy.passwordEnc) || '';
  }
  if (!username && !password) return null;
  return { username, password };
}

/**
 * Resolve accountId a partir do webContents (partição persist:acc-*).
 * @param {import('electron').WebContents} wc
 * @returns {string|null}
 */
function accountIdFromWebContents(wc) {
  if (!wc || wc.isDestroyed()) return null;
  try {
    const ses = wc.session;
    if (!ses) return null;
    // Match against known partitions
    for (const acc of getState().accounts || []) {
      if (!acc || !acc.id) continue;
      try {
        const expected = electronSession.fromPartition(`persist:acc-${acc.id}`);
        if (expected === ses) return acc.id;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Resolve conta pelo host:porta do desafio de proxy (útil em session.fetch).
 * @param {Electron.AuthInfo} authInfo
 * @returns {string|null}
 */
function accountIdFromAuthInfo(authInfo) {
  if (!authInfo || !authInfo.isProxy) return null;
  const host = String(authInfo.host || '').toLowerCase();
  const port = Number(authInfo.port) || 0;
  if (!host || !port) return null;
  for (const acc of getState().accounts || []) {
    if (!acc || !acc.proxy) continue;
    const p = acc.proxy;
    if (normalizeType(p.type) === 'none') continue;
    if (String(p.host || '').toLowerCase() === host && Number(p.port) === port) {
      return acc.id;
    }
  }
  return null;
}

/**
 * Handler de auth de proxy (login). Limita tentativas.
 * @param {Electron.Event} event
 * @param {import('electron').WebContents} webContents
 * @param {Electron.AuthenticationResponseDetails} _details
 * @param {Electron.AuthInfo} authInfo
 * @param {(username?: string, password?: string) => void} callback
 */
function handleProxyLogin(event, webContents, _details, authInfo, callback) {
  if (!authInfo || !authInfo.isProxy) {
    return false;
  }
  event.preventDefault();
  let accountId = accountIdFromWebContents(webContents);
  if (!accountId) accountId = accountIdFromAuthInfo(authInfo);
  if (!accountId && pendingAuthAccountId) accountId = pendingAuthAccountId;
  if (!accountId) {
    callback();
    return true;
  }
  const fails = authFailures.get(accountId) || 0;
  if (fails >= MAX_PROXY_AUTH_ATTEMPTS) {
    callback();
    if (emitToRenderer) {
      emitToRenderer({
        type: 'toast',
        message: 'Autenticação do proxy falhou. Verifique usuário e senha.',
        level: 'warn',
      });
      emitToRenderer({
        type: 'proxy:auth-failed',
        accountId,
      });
    }
    return true;
  }
  const creds = getProxyCredentials(accountId);
  if (!creds) {
    authFailures.set(accountId, fails + 1);
    callback();
    if (emitToRenderer) {
      emitToRenderer({
        type: 'toast',
        message: 'O proxy exige autenticação, mas não há credenciais salvas.',
        level: 'warn',
      });
    }
    return true;
  }
  // Passa credenciais; se estiverem erradas, Chromium chama de novo → conta falha
  authFailures.set(accountId, fails + 1);
  callback(creds.username, creds.password);
  return true;
}

/**
 * Instala listener app 'login' (uma vez).
 * @param {typeof import('electron').app} app
 */
function installLoginHandler(app) {
  if (!app || typeof app.on !== 'function') return;
  if (installLoginHandler._installed) return;
  installLoginHandler._installed = true;
  app.on('login', (event, webContents, details, authInfo, callback) => {
    try {
      handleProxyLogin(event, webContents, details, authInfo, callback);
    } catch {
      try {
        callback();
      } catch {
        /* ignore */
      }
    }
  });
}

/**
 * Testa o proxy da sessão (fetch). Em selftest usa MULTIHEIZ_PROXY_TEST_URL.
 * @param {string} accountId
 * @returns {Promise<{ ok: boolean, ip?: string, body?: string, error?: string, ms?: number }>}
 */
async function testProxyForAccount(accountId) {
  const acc = (getState().accounts || []).find((a) => a.id === accountId);
  if (!acc) return { ok: false, error: 'Janela não encontrada.' };

  let ses;
  try {
    ses = electronSession.fromPartition(`persist:acc-${accountId}`);
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Sessão indisponível' };
  }

  // Garante proxy aplicado (estado atual) e limpa auth em cache
  await applyProxyToSession(accountId, ses);
  await closeSessionConnections(ses);

  const url = testUrl();
  const started = Date.now();
  const timeoutMs = 10000;
  const prevPending = pendingAuthAccountId;
  pendingAuthAccountId = accountId;
  authFailures.delete(accountId);

  try {
    // Preferir net.request (dispara app 'login' p/ auth de proxy).
    // session.fetch nem sempre emite login → 407 sem credenciais.
    const text = await fetchViaSessionNet(ses, url, timeoutMs);
    const ms = Date.now() - started;
    let ip = '';
    try {
      const j = JSON.parse(text);
      ip = String(j.ip || j.origin || j.marker || '').trim();
    } catch {
      ip = String(text || '').trim().slice(0, 120);
    }
    authFailures.delete(accountId);
    return { ok: true, ip: ip || undefined, body: String(text || '').slice(0, 300), ms };
  } catch (err) {
    const msg =
      err && err.name === 'AbortError'
        ? 'Tempo esgotado (10 s).'
        : (err && err.message) || 'Falha no teste de proxy';
    return { ok: false, error: translateProxyError(msg), ms: Date.now() - started };
  } finally {
    pendingAuthAccountId = prevPending;
  }
}

/**
 * GET via electron.net + session (suporta proxy + login).
 * @param {import('electron').Session} ses
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function fetchViaSessionNet(ses, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(body);
    };
    const timer = setTimeout(() => {
      const e = new Error('Tempo esgotado (10 s).');
      e.name = 'AbortError';
      finish(e);
      try {
        if (req && typeof req.abort === 'function') req.abort();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    let req;
    try {
      const { net } = require('electron');
      req = net.request({ url, session: ses, method: 'GET', redirect: 'follow' });
    } catch (err) {
      // Fallback session.fetch
      if (typeof ses.fetch === 'function') {
        ses
          .fetch(url)
          .then(async (res) => {
            const t = await res.text();
            if (!res.ok) {
              const e = new Error(`Resposta HTTP ${res.status}`);
              finish(e);
              return;
            }
            finish(null, t);
          })
          .catch((e) => finish(e));
        return;
      }
      finish(err);
      return;
    }

    const chunks = [];
    req.on('response', (response) => {
      const status = response.statusCode || 0;
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (status >= 400) {
          finish(new Error(`Resposta HTTP ${status}`));
          return;
        }
        finish(null, body);
      });
      response.on('error', (err) => finish(err));
    });
    req.on('login', (authInfo, callback) => {
      // net.request também pode emitir login no próprio request
      if (!authInfo || !authInfo.isProxy) {
        callback();
        return;
      }
      let accountId = accountIdFromAuthInfo(authInfo) || pendingAuthAccountId;
      if (!accountId) {
        callback();
        return;
      }
      const fails = authFailures.get(accountId) || 0;
      if (fails >= MAX_PROXY_AUTH_ATTEMPTS) {
        callback();
        return;
      }
      const creds = getProxyCredentials(accountId);
      if (!creds) {
        authFailures.set(accountId, fails + 1);
        callback();
        return;
      }
      authFailures.set(accountId, fails + 1);
      callback(creds.username, creds.password);
    });
    req.on('error', (err) => finish(err));
    req.end();
  });
}

/**
 * @param {string} msg
 * @returns {string}
 */
function translateProxyError(msg) {
  const m = String(msg || '');
  if (/abort|timeout|timed out/i.test(m)) return 'Tempo esgotado ao testar o proxy (10 s).';
  if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'Não foi possível resolver o endereço do proxy.';
  if (/ECONNREFUSED/i.test(m)) return 'Conexão recusada pelo proxy.';
  if (/PROXY|ERR_PROXY/i.test(m)) return 'Erro de proxy: ' + m;
  return m || 'Falha ao testar o proxy.';
}

/**
 * Indica se a conta tem proxy ativo (para badge).
 * @param {object} account
 * @returns {boolean}
 */
function accountHasActiveProxy(account) {
  const v = publicProxyView(account && account.proxy);
  return !!(v && v.active);
}

/**
 * Tooltip do badge.
 * @param {object} account
 * @returns {string}
 */
function proxyBadgeTitle(account) {
  const v = publicProxyView(account && account.proxy);
  if (!v || !v.active) return '';
  return `Usando proxy ${v.host}:${v.port}`;
}

module.exports = {
  PROXY_TYPES,
  DEFAULT_BYPASS,
  initProxy,
  validateProxyInput,
  normalizeHost,
  normalizePort,
  normalizeType,
  publicProxyView,
  sanitizeAccountProxyForPublic,
  stripProxySecretsFromState,
  buildProxyRules,
  applyProxyToSession,
  applyAllAccountProxies,
  setProxyForAccount,
  removeProxyForAccount,
  getProxyCredentials,
  handleProxyLogin,
  installLoginHandler,
  testProxyForAccount,
  accountHasActiveProxy,
  proxyBadgeTitle,
  safeStorageApi,
  accountIdFromWebContents,
  accountIdFromAuthInfo,
  getStoredProxy,
};
