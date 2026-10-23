'use strict';

/**
 * Corretor LanguageTool (API pública ou servidor próprio).
 * Pedidos só no processo main (net.fetch); painéis usam IPC validado.
 * Nunca lê/envia campos sensíveis (password, cc-*, OTP, etc.).
 *
 * Corretor nativo do Chromium: permanece ativo por padrão (os dois podem
 * coexistir). Opção disableNativeSpellcheck desliga o nativo quando o LT
 * está ligado.
 */

const { app, ipcMain, net } = require('electron');
const { envGet } = require('./config');

const PUBLIC_API = 'https://api.languagetool.org/v2/check';
const MAX_TEXT_BYTES = 20 * 1024;
const DEBOUNCE_HINT_MS = 1500;
/** ~20 pedidos/min → intervalo mínimo entre envios. */
const MIN_INTERVAL_MS = 3200;
const MAX_QUEUE = 24;
const DEFAULT_BACKOFF_MS = 5000;

/** Idiomas em que o LanguageTool é mais forte (padrão). */
const STRONG_LANGUAGES = Object.freeze([
  'pt-BR',
  'pt-PT',
  'en',
  'en-US',
  'en-GB',
  'es',
  'fr',
  'de',
  'it',
  'nl',
  'ca',
]);

const STRONG_SET = new Set(
  STRONG_LANGUAGES.map((l) => l.toLowerCase()).concat(['pt', 'en', 'es', 'fr', 'de', 'it', 'nl', 'ca'])
);

/** @type {((wc: import('electron').WebContents) => void) | null} */
let forEachPanelWc = null;
/** @type {(() => object) | null} */
let getSettings = null;
/** @type {((fn: (s: object) => void) => void) | null} */
let updateStateFn = null;
/** @type {((accountId: string) => import('electron').WebContents|null) | null} */
let getPanelWc = null;
/** @type {(() => string|null) | null} */
let getFocusedAccountId = null;

let ipcInstalled = false;

/** @type {Map<number, { matches: object[], text: string, language: string, at: number }>} */
const matchesByWc = new Map();

/** @type {Array<{ resolve: Function, reject: Function, payload: object, gen: number }>} */
const queue = [];
let busy = false;
let lastSentAt = 0;
let backoffUntil = 0;
let globalGen = 0;

/** Contadores só para selftest. */
const selftestStats = {
  requests: 0,
  sensitiveBlocked: 0,
  lastStatus: 0,
  lastBackoffMs: 0,
};

function defaultLanguageToolSettings() {
  return {
    /** Opt-in: texto dos campos é enviado ao servidor LT. */
    enabled: false,
    /** Lista vazia = todos os idiomas fortes. */
    languages: [...STRONG_LANGUAGES.filter((l) => !l.includes('-') || l === 'pt-BR' || l === 'pt-PT')],
    serverUrl: '',
    disabledOrigins: [],
    /** Se true e LT ligado, desliga spellcheck nativo do Chromium nas sessões. */
    disableNativeSpellcheck: false,
  };
}

/**
 * @param {unknown} url
 * @param {{ allowLoopbackHttp?: boolean }} [opts]
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function validateServerUrl(url, opts = {}) {
  const raw = String(url || '').trim();
  if (!raw) return { ok: true, url: '' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'URL do servidor LanguageTool inválida.' };
  }
  const allowHttp =
    !!opts.allowLoopbackHttp &&
    (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1');
  if (u.protocol === 'https:') {
    /* ok */
  } else if (u.protocol === 'http:' && allowHttp) {
    /* selftest / loopback */
  } else {
    return { ok: false, error: 'A URL do LanguageTool deve usar https.' };
  }
  if (!u.hostname) {
    return { ok: false, error: 'URL do LanguageTool sem host válido.' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'A URL do LanguageTool não pode incluir usuário ou senha.' };
  }
  // Endpoint base: aceita com ou sem /v2/check
  return { ok: true, url: u.toString().replace(/\/$/, '') };
}

/**
 * @param {unknown} input
 */
function normalizeLanguageTool(input) {
  const base = defaultLanguageToolSettings();
  const src = input && typeof input === 'object' ? input : {};
  const enabled = src.enabled === true;
  let languages = Array.isArray(src.languages)
    ? src.languages.map((l) => String(l || '').trim()).filter(Boolean)
    : base.languages;
  if (!languages.length) languages = [...base.languages];
  const serverUrl = typeof src.serverUrl === 'string' ? src.serverUrl.trim() : '';
  const disabledOrigins = Array.isArray(src.disabledOrigins)
    ? [
        ...new Set(
          src.disabledOrigins
            .map((o) => normalizeOrigin(o))
            .filter(Boolean)
        ),
      ]
    : [];
  const disableNativeSpellcheck = !!src.disableNativeSpellcheck;
  return { enabled, languages, serverUrl, disabledOrigins, disableNativeSpellcheck };
}

/**
 * @param {unknown} originOrUrl
 * @returns {string}
 */
function normalizeOrigin(originOrUrl) {
  const raw = String(originOrUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** Tokens sensíveis em name/id/autocomplete/aria-label/placeholder (após fold). */
const SENSITIVE_NAME_RE =
  /(?:^|[^a-z0-9])(?:senha|password|passwd|pass|pwd|token|otp|2fa|codigo|code|cpf|cnpj|rg|cartao|card|cc-|cvv|cvc|pin|iban|conta|secret|api[-_]?key|apikey)(?:[^a-z0-9]|$)/i;

/**
 * Remove acentos e normaliza para comparação case-insensitive.
 * @param {unknown} s
 * @returns {string}
 */
function foldAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/**
 * name/id/autocomplete/aria-label/placeholder com tokens sensíveis.
 * @param {object} elLike
 * @returns {boolean}
 */
function hasSensitiveNameAttrs(elLike) {
  if (!elLike || typeof elLike !== 'object') return false;
  const parts = [
    elLike.name,
    elLike.id,
    elLike.autocomplete,
    elLike.autoComplete,
    elLike.ariaLabel,
    elLike['aria-label'],
    elLike.placeholder,
  ];
  for (const p of parts) {
    const folded = foldAccents(p).replace(/[_./]+/g, '-');
    if (!folded) continue;
    if (SENSITIVE_NAME_RE.test(folded) || SENSITIVE_NAME_RE.test(' ' + folded + ' ')) {
      return true;
    }
  }
  return false;
}

/**
 * Campos que NUNCA devem ser lidos/enviados.
 * @param {object} elLike  atributos do campo (tag, type, autocomplete, …)
 * @returns {boolean}
 */
function isSensitiveField(elLike) {
  if (!elLike || typeof elLike !== 'object') return true;
  if (elLike.noSpell || elLike['data-mh-no-spell']) return true;
  const tag = String(elLike.tagName || elLike.tag || '').toUpperCase();
  const type = String(elLike.type || '').toLowerCase();
  const autocomplete = String(elLike.autocomplete || elLike.autoComplete || '')
    .toLowerCase()
    .trim();
  const inputMode = String(elLike.inputMode || elLike.inputmode || '').toLowerCase();
  const maxLength = Number(elLike.maxLength != null ? elLike.maxLength : elLike.maxlength);

  if (type === 'password') return true;
  if (type === 'email') return true;
  if (type === 'hidden' || type === 'file' || type === 'number' || type === 'tel') return true;

  if (
    autocomplete === 'one-time-code' ||
    autocomplete === 'current-password' ||
    autocomplete === 'new-password' ||
    autocomplete.startsWith('cc-') ||
    autocomplete === 'cc-number' ||
    autocomplete === 'cc-csc' ||
    autocomplete === 'cc-exp' ||
    autocomplete === 'cc-exp-month' ||
    autocomplete === 'cc-exp-year' ||
    autocomplete === 'cc-name' ||
    autocomplete === 'cc-type'
  ) {
    return true;
  }

  if (hasSensitiveNameAttrs(elLike)) return true;

  // OTP: inputmode numérico com maxlength curto
  if (
    (inputMode === 'numeric' || inputMode === 'decimal' || type === 'tel') &&
    Number.isFinite(maxLength) &&
    maxLength > 0 &&
    maxLength <= 8
  ) {
    return true;
  }

  if (tag === 'INPUT') {
    const allowed = !type || type === 'text' || type === 'search' || type === 'url';
    if (!allowed) return true;
  }
  return false;
}

/**
 * @param {string} lang
 * @returns {boolean}
 */
function isStrongLanguage(lang) {
  const l = String(lang || '')
    .trim()
    .toLowerCase();
  if (!l) return false;
  if (STRONG_SET.has(l)) return true;
  const base = l.split('-')[0];
  return STRONG_SET.has(base);
}

/**
 * Resolve idioma para a API (auto restrito à lista forte, ou código explícito).
 * @param {{ fieldLang?: string, pageLang?: string, appLang?: string, allowed?: string[] }} opts
 */
function resolveLanguage(opts = {}) {
  const allowed = Array.isArray(opts.allowed) && opts.allowed.length
    ? opts.allowed
    : defaultLanguageToolSettings().languages;
  const candidates = [opts.fieldLang, opts.pageLang, opts.appLang]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  for (const c of candidates) {
    if (!isStrongLanguage(c)) continue;
    const hit = allowed.find(
      (a) =>
        a.toLowerCase() === c.toLowerCase() ||
        a.toLowerCase().split('-')[0] === c.toLowerCase().split('-')[0]
    );
    if (hit) return hit;
    // pt → pt-BR se estiver na lista
    const base = c.split('-')[0].toLowerCase();
    const byBase = allowed.find((a) => a.toLowerCase().startsWith(base));
    if (byBase) return byBase;
  }
  return 'auto';
}

/**
 * URL efetiva do endpoint /v2/check.
 * @param {ReturnType<typeof normalizeLanguageTool>} cfg
 */
function resolveCheckUrl(cfg) {
  const selftestUrl = String(envGet('MULTIHEIZ_LT_SERVER') || '').trim();
  if (selftestUrl && String(envGet('MULTIHEIZ_SELFTEST') || '') === 'languagetool') {
    const v = validateServerUrl(selftestUrl, { allowLoopbackHttp: true });
    if (v.ok && v.url) {
      return v.url.endsWith('/v2/check') ? v.url : `${v.url.replace(/\/$/, '')}/v2/check`;
    }
  }
  const custom = String((cfg && cfg.serverUrl) || '').trim();
  if (custom) {
    const allowLoopback =
      String(envGet('MULTIHEIZ_SELFTEST') || '') === 'languagetool' ||
      /127\.0\.0\.1|localhost/i.test(custom);
    const v = validateServerUrl(custom, { allowLoopbackHttp: allowLoopback });
    if (v.ok && v.url) {
      return v.url.endsWith('/v2/check') ? v.url : `${v.url.replace(/\/$/, '')}/v2/check`;
    }
  }
  return PUBLIC_API;
}

/**
 * @param {string} text
 * @returns {string}
 */
function truncateText(text) {
  const s = String(text || '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= MAX_TEXT_BYTES) return s;
  return buf.subarray(0, MAX_TEXT_BYTES).toString('utf8');
}

/**
 * @param {object} payload
 * @returns {Promise<object>}
 */
async function fetchCheck(payload) {
  const cfg = normalizeLanguageTool(
    typeof getSettings === 'function' ? (getSettings().languageTool || {}) : {}
  );
  const endpoint = resolveCheckUrl(cfg);
  const text = truncateText(payload.text);
  if (!text.trim()) {
    return { matches: [], language: payload.language || 'auto', skipped: 'empty' };
  }

  const body = new URLSearchParams();
  body.set('text', text);
  body.set('language', String(payload.language || 'auto'));
  if (payload.language === 'auto' || !payload.language) {
    const prefs = (cfg.languages || []).join(',');
    if (prefs) body.set('preferredVariants', prefs);
  }

  if (!app.isReady()) await app.whenReady();

  selftestStats.requests += 1;
  const res = await net.fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  selftestStats.lastStatus = res.status;
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(60000, retryAfter * 1000)
        : DEFAULT_BACKOFF_MS;
    backoffUntil = Date.now() + waitMs;
    selftestStats.lastBackoffMs = waitMs;
    const err = new Error('languagetool-429');
    err.code = 429;
    err.backoffMs = waitMs;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('languagetool-http-' + res.status);
    err.code = res.status;
    throw err;
  }
  const data = await res.json();
  const matches = Array.isArray(data && data.matches) ? data.matches : [];
  return {
    matches: matches.map((m) => ({
      offset: Number(m.offset) || 0,
      length: Number(m.length) || 0,
      message: String((m && m.message) || ''),
      shortMessage: String((m && m.shortMessage) || ''),
      replacements: Array.isArray(m.replacements)
        ? m.replacements
            .slice(0, 5)
            .map((r) => String((r && r.value) || ''))
            .filter(Boolean)
        : [],
      context: m.context
        ? {
            text: String(m.context.text || ''),
            offset: Number(m.context.offset) || 0,
            length: Number(m.context.length) || 0,
          }
        : null,
    })),
    language:
      (data && data.language && (data.language.code || data.language.detectedLanguage)) ||
      payload.language ||
      'auto',
  };
}

function pumpQueue() {
  if (busy) return;
  const now = Date.now();
  if (now < backoffUntil) {
    setTimeout(pumpQueue, Math.max(50, backoffUntil - now));
    return;
  }
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastSentAt));
  if (wait > 0) {
    setTimeout(pumpQueue, wait);
    return;
  }
  const job = queue.shift();
  if (!job) return;
  busy = true;
  lastSentAt = Date.now();
  fetchCheck(job.payload)
    .then((result) => {
      busy = false;
      if (job.gen !== globalGen && job.payload.cancelGen != null) {
        /* still resolve — caller checks requestId */
      }
      job.resolve(result);
      pumpQueue();
    })
    .catch((err) => {
      busy = false;
      job.reject(err);
      pumpQueue();
    });
}

/**
 * Enfileira verificação (rate limit + backoff 429).
 * @param {object} payload
 * @returns {Promise<object>}
 */
function enqueueCheck(payload) {
  return new Promise((resolve, reject) => {
    while (queue.length >= MAX_QUEUE) {
      const dropped = queue.shift();
      if (dropped) dropped.reject(new Error('languagetool-queue-full'));
    }
    queue.push({
      resolve,
      reject,
      payload: payload || {},
      gen: ++globalGen,
    });
    pumpQueue();
  });
}

/**
 * Cancela pedidos pendentes (mudança de config / navegação).
 */
function cancelPending() {
  globalGen += 1;
  while (queue.length) {
    const j = queue.shift();
    if (j) j.reject(new Error('languagetool-cancelled'));
  }
}

/**
 * Config pública para o preload do painel.
 */
function publicConfig(settings) {
  const cfg = normalizeLanguageTool(
    (settings && settings.languageTool) ||
      (typeof getSettings === 'function' ? getSettings().languageTool : null)
  );
  const appLang =
    (settings && settings.language) ||
    (typeof getSettings === 'function' ? getSettings().language : null) ||
    'pt-BR';
  return {
    enabled: cfg.enabled,
    languages: cfg.languages,
    disabledOrigins: cfg.disabledOrigins,
    appLanguage: appLang,
    debounceMs: DEBOUNCE_HINT_MS,
    disableNativeSpellcheck: cfg.disableNativeSpellcheck,
  };
}

/**
 * @param {import('electron').WebContents} wc
 * @param {object} cfg
 */
function pushConfigToWc(wc, cfg) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
  try {
    wc.send('mh-languagetool-config', cfg);
  } catch {
    /* ignore */
  }
}

function broadcastConfig() {
  const cfg = publicConfig();
  if (typeof forEachPanelWc === 'function') {
    try {
      forEachPanelWc((wc) => pushConfigToWc(wc, cfg));
    } catch {
      /* ignore */
    }
  }
}

/**
 * Idiomas do corretor nativo: idioma do app + en-US (padrão pt-BR + en-US).
 * @param {object} [settings]
 * @returns {string[]}
 */
function nativeSpellcheckLanguages(settings) {
  const appLang = String((settings && settings.language) || 'pt-BR').trim() || 'pt-BR';
  const out = [appLang];
  if (!out.some((l) => String(l).toLowerCase() === 'en-us')) out.push('en-US');
  return out;
}

/**
 * Aplica (ou restaura) spellcheck nativo nas sessões de conta.
 * Ligado por padrão; só desliga quando LT está ON e disableNativeSpellcheck.
 * @param {import('electron').Session[]} sessions
 * @param {ReturnType<typeof normalizeLanguageTool>} cfg
 * @param {object} [settings]  settings completos (idioma do app)
 */
function applyNativeSpellcheckPolicy(sessions, cfg, settings) {
  const disable = !!(cfg && cfg.enabled && cfg.disableNativeSpellcheck);
  const langs = nativeSpellcheckLanguages(settings || (typeof getSettings === 'function' ? getSettings() : null));
  for (const ses of sessions || []) {
    if (!ses) continue;
    try {
      if (typeof ses.setSpellCheckerEnabled === 'function') {
        ses.setSpellCheckerEnabled(!disable);
      }
    } catch {
      /* ignore */
    }
    if (!disable && typeof ses.setSpellCheckerLanguages === 'function') {
      try {
        ses.setSpellCheckerLanguages(langs);
      } catch {
        try {
          ses.setSpellCheckerLanguages(['en-US']);
        } catch {
          /* OS pode não ter o dicionário */
        }
      }
    }
  }
}

/**
 * Sugestões LT para o menu de contexto (não interfere no corretor nativo).
 * @param {import('electron').WebContents} wc
 * @param {object} params
 */
function suggestionsForContextMenu(wc, params) {
  if (!wc) return [];
  const stored = matchesByWc.get(wc.id);
  if (!stored || !Array.isArray(stored.matches) || !stored.matches.length) return [];
  const sel = String((params && params.selectionText) || '').trim();
  const miss = String((params && params.misspelledWord) || '').trim();
  /** @type {Array<{ label: string, offset: number, length: number, replacement: string }>} */
  const items = [];
  for (const m of stored.matches) {
    const slice = stored.text.slice(m.offset, m.offset + m.length);
    const relevant =
      (sel && (slice === sel || sel.includes(slice) || slice.includes(sel))) ||
      (miss && (slice === miss || slice.includes(miss))) ||
      (!sel && !miss && m.replacements && m.replacements.length);
    if (!relevant && (sel || miss)) continue;
    for (const r of m.replacements || []) {
      items.push({
        label: r,
        offset: m.offset,
        length: m.length,
        replacement: r,
      });
      if (items.length >= 5) break;
    }
    if (items.length >= 5) break;
  }
  return items;
}

/**
 * @param {import('electron').WebContents} wc
 * @param {{ offset: number, length: number, replacement: string }} d
 */
async function applyReplacement(wc, d) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
  const offset = Number(d.offset);
  const length = Number(d.length);
  const replacement = String(d.replacement || '');
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length < 0) return;
  const code = `(function(){
    try {
      if (window.__mhLt && typeof window.__mhLt.applyReplacement === 'function') {
        return window.__mhLt.applyReplacement(${JSON.stringify(offset)}, ${JSON.stringify(length)}, ${JSON.stringify(replacement)});
      }
      return false;
    } catch (e) { return false; }
  })()`;
  try {
    await wc.executeJavaScript(code, true);
  } catch {
    /* ignore */
  }
}

function rememberMatches(wc, payload) {
  if (!wc) return;
  matchesByWc.set(wc.id, {
    matches: Array.isArray(payload.matches) ? payload.matches : [],
    text: String(payload.text || ''),
    language: String(payload.language || ''),
    at: Date.now(),
  });
}

function clearMatches(wc) {
  if (!wc) return;
  matchesByWc.delete(wc.id);
}

/**
 * Origem ativa (painel em foco) para “Desativar neste site”.
 * @returns {Promise<string>}
 */
async function getFocusedOrigin() {
  if (typeof getFocusedAccountId !== 'function' || typeof getPanelWc !== 'function') return '';
  const id = getFocusedAccountId();
  if (!id) return '';
  const wc = getPanelWc(id);
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return '';
  try {
    const url = wc.getURL();
    return normalizeOrigin(url);
  } catch {
    return '';
  }
}

/**
 * @param {{
 *   getSettings?: () => object,
 *   updateState?: (fn: (s: object) => void) => void,
 *   forEachPanelWebContents?: (cb: (wc: import('electron').WebContents) => void) => void,
 *   getPanelWebContents?: (accountId: string) => import('electron').WebContents|null,
 *   getFocusedAccountId?: () => string|null,
 * }} opts
 */
function installLanguageTool(opts = {}) {
  if (typeof opts.getSettings === 'function') getSettings = opts.getSettings;
  if (typeof opts.updateState === 'function') updateStateFn = opts.updateState;
  if (typeof opts.forEachPanelWebContents === 'function') forEachPanelWc = opts.forEachPanelWebContents;
  if (typeof opts.getPanelWebContents === 'function') getPanelWc = opts.getPanelWebContents;
  if (typeof opts.getFocusedAccountId === 'function') getFocusedAccountId = opts.getFocusedAccountId;

  if (ipcInstalled) return;
  ipcInstalled = true;

  ipcMain.on('panel:languagetool-sync', (event) => {
    try {
      event.returnValue = publicConfig();
    } catch {
      event.returnValue = publicConfig({ languageTool: defaultLanguageToolSettings() });
    }
  });

  ipcMain.handle('panel:languagetool-check', async (event, raw) => {
    const wc = event && event.sender;
    const cfg = normalizeLanguageTool(
      typeof getSettings === 'function' ? getSettings().languageTool : {}
    );
    if (!cfg.enabled) {
      return { matches: [], skipped: 'disabled' };
    }
    const payload = raw && typeof raw === 'object' ? raw : {};
    if (payload.sensitive) {
      selftestStats.sensitiveBlocked += 1;
      return { matches: [], skipped: 'sensitive' };
    }
    if (isSensitiveField(payload.field || {})) {
      selftestStats.sensitiveBlocked += 1;
      return { matches: [], skipped: 'sensitive' };
    }
    const origin = normalizeOrigin(payload.origin || '');
    if (origin && cfg.disabledOrigins.includes(origin)) {
      return { matches: [], skipped: 'origin-disabled' };
    }
    const settings = typeof getSettings === 'function' ? getSettings() : {};
    const language = resolveLanguage({
      fieldLang: payload.fieldLang,
      pageLang: payload.pageLang,
      appLang: settings.language || 'pt-BR',
      allowed: cfg.languages,
    });
    if (language !== 'auto' && !isStrongLanguage(language)) {
      return { matches: [], skipped: 'lang' };
    }
    const requestId = payload.requestId;
    try {
      const result = await enqueueCheck({
        text: payload.text,
        language,
        requestId,
      });
      if (wc) rememberMatches(wc, { ...result, text: truncateText(payload.text) });
      return { ...result, requestId, language };
    } catch (err) {
      const code = err && err.code;
      if (code === 429) {
        return {
          matches: [],
          error: '429',
          backoffMs: err.backoffMs || DEFAULT_BACKOFF_MS,
          requestId,
        };
      }
      if (err && /cancelled|queue-full/i.test(String(err.message || ''))) {
        return { matches: [], skipped: String(err.message), requestId };
      }
      return { matches: [], error: String((err && err.message) || err), requestId };
    }
  });

  ipcMain.on('panel:languagetool-matches', (event, raw) => {
    const wc = event && event.sender;
    if (!wc) return;
    const payload = raw && typeof raw === 'object' ? raw : {};
    rememberMatches(wc, payload);
  });

  ipcMain.handle('languagetool:focused-origin', async () => {
    return getFocusedOrigin();
  });

  ipcMain.handle('languagetool:selftest-stats', async () => {
    if (String(envGet('MULTIHEIZ_SELFTEST') || '') !== 'languagetool') {
      return null;
    }
    return {
      ...selftestStats,
      queueLength: queue.length,
      backoffUntil,
    };
  });
}

/**
 * Chamado após settings:update com languageTool alterado.
 * @param {object} settings
 * @param {import('electron').Session[]} [sessions]
 */
function onSettingsChanged(settings, sessions) {
  cancelPending();
  const cfg = normalizeLanguageTool(settings && settings.languageTool);
  broadcastConfig();
  if (sessions) applyNativeSpellcheckPolicy(sessions, cfg, settings);
}

function getSelftestStats() {
  return { ...selftestStats, queueLength: queue.length, backoffUntil };
}

function resetSelftestStats() {
  selftestStats.requests = 0;
  selftestStats.sensitiveBlocked = 0;
  selftestStats.lastStatus = 0;
  selftestStats.lastBackoffMs = 0;
}

module.exports = {
  PUBLIC_API,
  STRONG_LANGUAGES,
  MAX_TEXT_BYTES,
  DEBOUNCE_HINT_MS,
  defaultLanguageToolSettings,
  normalizeLanguageTool,
  validateServerUrl,
  isSensitiveField,
  isStrongLanguage,
  resolveLanguage,
  resolveCheckUrl,
  normalizeOrigin,
  publicConfig,
  installLanguageTool,
  onSettingsChanged,
  broadcastConfig,
  pushConfigToWc,
  applyNativeSpellcheckPolicy,
  suggestionsForContextMenu,
  applyReplacement,
  clearMatches,
  getFocusedOrigin,
  getSelftestStats,
  resetSelftestStats,
  enqueueCheck,
  cancelPending,
};
