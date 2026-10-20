'use strict';

/**
 * Módulo de IA experimental (escrita) — desligado por padrão.
 * Pedidos só no main (net.fetch); chaves só via safeStorage; nunca em logs.
 */

const { app, ipcMain, net, clipboard } = require('electron');
const { envGet } = require('./config');
const { safeStorageApi } = require('./proxy');

const MAX_TEXT_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 45000;
const SELFTEST_MODE = 'ai';

const PROVIDERS = Object.freeze({
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    defaultBase: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.0-flash',
    needsKey: true,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    defaultBase: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.1-8b-instant',
    needsKey: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    defaultBase: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    needsKey: true,
  },
  'openai-compat': {
    id: 'openai-compat',
    label: 'Compatível com OpenAI',
    kind: 'openai',
    defaultBase: '',
    defaultModel: '',
    needsKey: true,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    defaultBase: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:1.5b-instruct',
    needsKey: false,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai',
    defaultBase: 'http://127.0.0.1:1234/v1',
    defaultModel: '',
    needsKey: false,
  },
});

const ACTIONS = Object.freeze({
  corrigir: {
    id: 'corrigir',
    label: 'Corrigir',
    system:
      'Você é um assistente de escrita em português do Brasil. Corrija ortografia, gramática e pontuação do texto do usuário. Preserve o idioma original do texto. Não acrescente explicações — devolva somente o texto corrigido.',
  },
  melhorar: {
    id: 'melhorar',
    label: 'Melhorar',
    system:
      'Você é um assistente de escrita em português do Brasil. Melhore clareza, fluidez e naturalidade do texto do usuário, sem mudar o sentido. Preserve o idioma original. Devolva somente o texto melhorado.',
  },
  reformular: {
    id: 'reformular',
    label: 'Reformular',
    system:
      'Você é um assistente de escrita em português do Brasil. Reformule o texto do usuário com outras palavras, mantendo o mesmo sentido. Preserve o idioma original. Devolva somente o texto reformulado.',
  },
  'mais-formal': {
    id: 'mais-formal',
    label: 'Mais formal',
    system:
      'Você é um assistente de escrita em português do Brasil. Deixe o texto mais formal e profissional, sem alterar o sentido. Preserve o idioma original. Devolva somente o texto formalizado.',
  },
  'mais-curto': {
    id: 'mais-curto',
    label: 'Mais curto',
    system:
      'Você é um assistente de escrita em português do Brasil. Encurte o texto do usuário, mantendo as informações essenciais. Preserve o idioma original. Devolva somente o texto encurtado.',
  },
});

const LOCAL_MODEL_DOCS = Object.freeze([
  {
    id: 'qwen2.5:1.5b-instruct',
    name: 'Qwen2.5 1.5B Instruct',
    sizeHint: '~1 GB',
    note: 'Recomendado',
    ollamaPull: 'ollama pull qwen2.5:1.5b-instruct',
  },
  {
    id: 'gemma3:1b',
    name: 'Gemma 3 1B',
    sizeHint: '~800 MB',
    note: 'Leve',
    ollamaPull: 'ollama pull gemma3:1b',
  },
  {
    id: 'gemma3:4b',
    name: 'Gemma 3 4B',
    sizeHint: '~2,5 GB',
    note: 'Qualidade — pede cerca de 6–8 GB de RAM livres',
    ollamaPull: 'ollama pull gemma3:4b',
  },
]);

const TRAINING_WARNING =
  'Nos planos gratuitos, o texto enviado pode ser usado para treinar o modelo. Evite dados sensíveis. Nenhuma chave embutida no app.';

/** @type {(() => object) | null} */
let getSettings = null;
/** @type {((fn: (s: object) => void) => void) | null} */
let updateStateFn = null;
/** @type {((cb: (wc: import('electron').WebContents) => void) => void) | null} */
let forEachPanelWc = null;
/** @type {((accountId: string) => import('electron').WebContents|null) | null} */
let getPanelWc = null;
/** @type {(() => string|null) | null} */
let getFocusedAccountId = null;
/** @type {((accountId: string) => { x: number, y: number, width?: number, height?: number } | null) | null} */
let getPanelViewBounds = null;
/** @type {((opts: object) => Promise<object>|object) | null} */
let showPopoverFn = null;
/** @type {((reason?: string) => void) | null} */
let hidePopoverFn = null;
/** @type {((data: object) => void) | null} */
let updatePopoverFn = null;

let ipcInstalled = false;

/** @type {AbortController | null} */
let activeAbort = null;
let activeRequestId = 0;

const selftestStats = {
  requests: 0,
  blocked: 0,
  lastStatus: 0,
  lastError: '',
  lastAction: '',
  logsWithKey: 0,
};

function defaultAiWriteSettings() {
  return {
    enabled: false,
    provider: 'gemini',
    model: PROVIDERS.gemini.defaultModel,
    baseUrl: '',
    apiKeyEnc: null,
  };
}

/**
 * @param {unknown} input
 */
function normalizeAiWrite(input) {
  const base = defaultAiWriteSettings();
  const src = input && typeof input === 'object' ? input : {};
  const providerRaw = String(src.provider || base.provider).trim().toLowerCase();
  const provider = PROVIDERS[providerRaw] ? providerRaw : base.provider;
  const model =
    typeof src.model === 'string' && src.model.trim()
      ? src.model.trim()
      : PROVIDERS[provider].defaultModel || '';
  const baseUrl = typeof src.baseUrl === 'string' ? src.baseUrl.trim() : '';
  let apiKeyEnc = null;
  if (typeof src.apiKeyEnc === 'string' && src.apiKeyEnc) {
    apiKeyEnc = src.apiKeyEnc;
  } else if (src.apiKeyEnc == null) {
    apiKeyEnc = null;
  }
  return {
    enabled: !!src.enabled,
    provider,
    model,
    baseUrl,
    apiKeyEnc,
  };
}

/**
 * Vista pública embutida em settings (sem chave / sem apiKeyEnc).
 * Só campos de config — sem catálogos extras (evita falso diff no autosave).
 * @param {unknown} input
 */
function publicSettings(input) {
  const cfg = normalizeAiWrite(input);
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKeySaved: !!(cfg.apiKeyEnc && String(cfg.apiKeyEnc).length),
  };
}

/**
 * Metadados para a UI (aviso, provedores, modelos locais).
 * @param {unknown} [input]
 */
function publicMeta(input) {
  const pub = publicSettings(input);
  return {
    ...pub,
    trainingWarning: TRAINING_WARNING,
    localModels: LOCAL_MODEL_DOCS,
    providers: Object.keys(PROVIDERS).map((id) => ({
      id,
      label: PROVIDERS[id].label,
      needsKey: PROVIDERS[id].needsKey,
      defaultModel: PROVIDERS[id].defaultModel,
      defaultBase: PROVIDERS[id].defaultBase,
    })),
  };
}

/**
 * @param {object} settings
 */
function sanitizeSettingsObject(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (!settings.aiWrite) return settings;
  return {
    ...settings,
    aiWrite: publicSettings(settings.aiWrite),
  };
}

/**
 * @param {unknown} url
 * @param {{ allowLoopbackHttp?: boolean, provider?: string }} [opts]
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function validateBaseUrl(url, opts = {}) {
  const raw = String(url || '').trim();
  if (!raw) {
    if (opts.provider === 'openai-compat') {
      return { ok: false, error: 'Informe a URL base https do provedor compatível com OpenAI.' };
    }
    return { ok: true, url: '' };
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'URL base inválida.' };
  }
  const host = String(u.hostname || '').toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const allowHttp = !!opts.allowLoopbackHttp || loopback;
  if (u.protocol === 'https:') {
    /* ok */
  } else if (u.protocol === 'http:' && allowHttp) {
    /* local / selftest */
  } else {
    return { ok: false, error: 'A URL base deve usar https (ou http só em 127.0.0.1).' };
  }
  if (!u.hostname) return { ok: false, error: 'URL base sem host válido.' };
  if (u.username || u.password) {
    return { ok: false, error: 'A URL base não pode incluir usuário ou senha.' };
  }
  return { ok: true, url: u.toString().replace(/\/$/, '') };
}

/**
 * Campos bloqueados para IA (mais restritos que LT: só segredos / OTP / opt-out).
 * @param {object} elLike
 * @returns {boolean}
 */
function isAiBlockedField(elLike) {
  if (!elLike || typeof elLike !== 'object') return true;
  if (elLike.noAi || elLike['data-mh-no-ai'] || elLike.mhNoAi) return true;
  const type = String(elLike.type || '').toLowerCase();
  if (type === 'password') return true;
  const autocomplete = String(elLike.autocomplete || elLike.autoComplete || '')
    .toLowerCase()
    .trim();
  if (
    autocomplete === 'one-time-code' ||
    autocomplete === 'current-password' ||
    autocomplete === 'new-password' ||
    autocomplete.endsWith('-password') ||
    autocomplete.startsWith('cc-')
  ) {
    return true;
  }
  const inputMode = String(elLike.inputMode || elLike.inputmode || '').toLowerCase();
  const maxLength = Number(elLike.maxLength != null ? elLike.maxLength : elLike.maxlength);
  if (
    (inputMode === 'numeric' || inputMode === 'decimal' || type === 'tel') &&
    Number.isFinite(maxLength) &&
    maxLength > 0 &&
    maxLength <= 8
  ) {
    return true;
  }
  return false;
}

function currentConfig() {
  const settings = typeof getSettings === 'function' ? getSettings() : {};
  return normalizeAiWrite(settings && settings.aiWrite);
}

function decryptApiKey(cfg) {
  if (!cfg || !cfg.apiKeyEnc) return '';
  const ss = safeStorageApi();
  if (!ss.available) return '';
  return ss.decrypt(cfg.apiKeyEnc) || '';
}

/**
 * @param {string} plain
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function setApiKey(plain) {
  const key = String(plain || '');
  if (!key) {
    if (typeof updateStateFn === 'function') {
      updateStateFn((s) => {
        const prev = normalizeAiWrite(s.settings.aiWrite);
        s.settings.aiWrite = { ...prev, apiKeyEnc: null };
      });
    }
    broadcastConfig();
    return { ok: true };
  }
  const ss = safeStorageApi();
  if (!ss.available) {
    return {
      ok: false,
      error: 'Armazenamento seguro (safeStorage) indisponível neste sistema.',
    };
  }
  const enc = ss.encrypt(key);
  if (!enc) {
    return { ok: false, error: 'Não foi possível criptografar a chave.' };
  }
  if (typeof updateStateFn === 'function') {
    updateStateFn((s) => {
      const prev = normalizeAiWrite(s.settings.aiWrite);
      s.settings.aiWrite = { ...prev, apiKeyEnc: enc };
    });
  }
  broadcastConfig();
  return { ok: true };
}

function truncateText(text) {
  const s = String(text || '');
  if (s.length <= MAX_TEXT_CHARS) return s;
  return s.slice(0, MAX_TEXT_CHARS);
}

function resolveEndpoint(cfg) {
  const selftestBase = String(envGet('MULTIHEIZ_AI_SERVER') || '').trim();
  const inSelftest = String(envGet('MULTIHEIZ_SELFTEST') || '') === SELFTEST_MODE;
  if (selftestBase && inSelftest) {
    const v = validateBaseUrl(selftestBase, { allowLoopbackHttp: true });
    if (v.ok && v.url) {
      if (cfg.provider === 'gemini') {
        return { kind: 'gemini', base: v.url, model: cfg.model || 'gemini-fake' };
      }
      return { kind: 'openai', base: v.url.replace(/\/$/, ''), model: cfg.model || 'fake' };
    }
  }
  const meta = PROVIDERS[cfg.provider] || PROVIDERS.gemini;
  let base = '';
  if (cfg.provider === 'openai-compat') {
    base = cfg.baseUrl;
  } else {
    base = meta.defaultBase;
  }
  const allowLoopback =
    inSelftest ||
    cfg.provider === 'ollama' ||
    cfg.provider === 'lmstudio' ||
    /127\.0\.0\.1|localhost/i.test(base);
  const v = validateBaseUrl(base, {
    allowLoopbackHttp: allowLoopback,
    provider: cfg.provider,
  });
  if (!v.ok) {
    const err = new Error(v.error);
    err.code = 'bad-url';
    throw err;
  }
  return {
    kind: meta.kind,
    base: v.url || meta.defaultBase,
    model: cfg.model || meta.defaultModel || '',
  };
}

function cancelActive(reason) {
  if (activeAbort) {
    try {
      activeAbort.abort();
    } catch {
      /* ignore */
    }
  }
  activeAbort = null;
  activeRequestId += 1;
  if (reason) selftestStats.lastError = String(reason);
}

/**
 * @param {object} opts
 * @returns {Promise<{ ok: true, text: string, requestId: number } | { ok: false, error: string, requestId: number, skipped?: string }>}
 */
async function rewriteText(opts) {
  const cfg = currentConfig();
  const actionId = String((opts && opts.action) || '').trim();
  const action = ACTIONS[actionId];
  if (!cfg.enabled) {
    selftestStats.blocked += 1;
    return { ok: false, error: 'Módulo de IA desligado.', requestId: activeRequestId, skipped: 'disabled' };
  }
  if (!action) {
    return { ok: false, error: 'Ação inválida.', requestId: activeRequestId };
  }
  if (opts && opts.sensitive) {
    selftestStats.blocked += 1;
    return { ok: false, error: 'Campo sensível bloqueado.', requestId: activeRequestId, skipped: 'sensitive' };
  }
  if (opts && opts.field && isAiBlockedField(opts.field)) {
    selftestStats.blocked += 1;
    return { ok: false, error: 'Campo sensível bloqueado.', requestId: activeRequestId, skipped: 'sensitive' };
  }
  const text = truncateText(opts && opts.text);
  if (!text.trim()) {
    return { ok: false, error: 'Nenhum texto para processar.', requestId: activeRequestId, skipped: 'empty' };
  }
  const meta = PROVIDERS[cfg.provider] || PROVIDERS.gemini;
  const apiKey = decryptApiKey(cfg);
  if (meta.needsKey && !apiKey) {
    return { ok: false, error: 'Informe a chave da API nas configurações.', requestId: activeRequestId };
  }

  let endpoint;
  try {
    endpoint = resolveEndpoint(cfg);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), requestId: activeRequestId };
  }
  if (!endpoint.model) {
    return { ok: false, error: 'Informe o nome do modelo.', requestId: activeRequestId };
  }

  // Cancela pedido anterior; só então gera o id deste pedido
  cancelActive('superseded');
  const requestId = ++activeRequestId;
  const ac = new AbortController();
  activeAbort = ac;
  const timeoutMs = Number(opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  selftestStats.requests += 1;
  selftestStats.lastAction = actionId;
  selftestStats.lastError = '';

  try {
    if (!app.isReady()) await app.whenReady();
    let resultText = '';
    if (endpoint.kind === 'gemini') {
      resultText = await fetchGemini({
        base: endpoint.base,
        model: endpoint.model,
        apiKey,
        system: action.system,
        user: text,
        signal: ac.signal,
      });
    } else {
      resultText = await fetchOpenAiChat({
        base: endpoint.base,
        model: endpoint.model,
        apiKey,
        system: action.system,
        user: text,
        signal: ac.signal,
        provider: cfg.provider,
      });
    }
    if (requestId !== activeRequestId) {
      return { ok: false, error: 'cancelado', requestId, skipped: 'cancelled' };
    }
    const out = String(resultText || '').trim();
    if (!out) {
      return { ok: false, error: 'Resposta vazia do modelo.', requestId };
    }
    return { ok: true, text: out, requestId };
  } catch (err) {
    const name = err && err.name;
    const msg = String((err && err.message) || err || '');
    if (name === 'AbortError' || /aborted|abort/i.test(msg)) {
      selftestStats.lastError = 'timeout';
      return { ok: false, error: 'Tempo esgotado. Tente de novo.', requestId, skipped: 'timeout' };
    }
    selftestStats.lastError = msg.slice(0, 120);
    // Nunca ecoar a chave na mensagem
    const safe = msg.replace(apiKey ? new RegExp(escapeRegExp(apiKey), 'g') : /$^/, '[redacted]');
    return { ok: false, error: safe || 'Falha na requisição.', requestId };
  } finally {
    clearTimeout(timer);
    if (activeAbort === ac) activeAbort = null;
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {object} p
 */
async function fetchOpenAiChat(p) {
  const base = String(p.base || '').replace(/\/$/, '');
  let finalUrl = base;
  if (/\/chat\/completions$/i.test(base)) {
    finalUrl = base;
  } else if (/\/v1$/i.test(base)) {
    finalUrl = `${base}/chat/completions`;
  } else {
    finalUrl = `${base}/v1/chat/completions`;
  }

  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
  if (p.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/leoheiz/MultiHeiz';
    headers['X-Title'] = 'MultiHeiz';
  }

  const body = JSON.stringify({
    model: p.model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user },
    ],
  });

  const res = await net.fetch(finalUrl, {
    method: 'POST',
    headers,
    body,
    signal: p.signal,
  });
  selftestStats.lastStatus = res.status;
  if (!res.ok) {
    const err = new Error('ai-http-' + res.status);
    err.code = res.status;
    throw err;
  }
  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const content =
    (choice && choice.message && choice.message.content) ||
    (choice && choice.text) ||
    (data && data.content) ||
    '';
  return String(content || '').trim();
}

/**
 * @param {object} p
 */
async function fetchGemini(p) {
  const base = String(p.base || '').replace(/\/$/, '');
  const model = encodeURIComponent(p.model || 'gemini-2.0-flash');
  let url = `${base}/v1beta/models/${model}:generateContent`;
  // Selftest fake may serve at /v1beta/models/... or /gemini/generate
  if (/\/v1beta$/i.test(base)) {
    url = `${base}/models/${model}:generateContent`;
  }
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (p.apiKey) {
    headers['x-goog-api-key'] = p.apiKey;
  }
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: p.system }] },
    contents: [{ role: 'user', parts: [{ text: p.user }] }],
    generationConfig: { temperature: 0.3 },
  });
  const res = await net.fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: p.signal,
  });
  selftestStats.lastStatus = res.status;
  if (!res.ok) {
    const err = new Error('ai-http-' + res.status);
    err.code = res.status;
    throw err;
  }
  const data = await res.json();
  const parts =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((x) => String((x && x.text) || ''))
      .join('')
      .trim();
  }
  if (data && data.text) return String(data.text).trim();
  return '';
}

/**
 * Testa conexão com prompt mínimo.
 */
async function testConnection() {
  const cfg = currentConfig();
  const meta = PROVIDERS[cfg.provider] || PROVIDERS.gemini;
  const apiKey = decryptApiKey(cfg);
  if (meta.needsKey && !apiKey) {
    return { ok: false, error: 'Informe a chave da API.' };
  }
  try {
    const r = await rewriteText({
      action: 'mais-curto',
      text: 'ok',
      timeoutMs: 20000,
    });
    if (r.ok) return { ok: true, sample: String(r.text || '').slice(0, 80) };
    return { ok: false, error: r.error || 'Falha no teste.' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * Detecção opcional de Ollama / LM Studio.
 */
async function probeLocal() {
  if (!app.isReady()) await app.whenReady();
  const out = {
    ollama: { ok: false, models: /** @type {string[]} */ ([]) },
    lmstudio: { ok: false, models: /** @type {string[]} */ ([]) },
  };
  try {
    const res = await net.fetch('http://127.0.0.1:11434/api/tags', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      out.ollama.ok = true;
      out.ollama.models = Array.isArray(data && data.models)
        ? data.models.map((m) => String((m && (m.name || m.model)) || '')).filter(Boolean)
        : [];
    }
  } catch {
    /* offline */
  }
  try {
    const res = await net.fetch('http://127.0.0.1:1234/v1/models', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      out.lmstudio.ok = true;
      const list = Array.isArray(data && data.data) ? data.data : [];
      out.lmstudio.models = list.map((m) => String((m && m.id) || '')).filter(Boolean);
    }
  } catch {
    /* offline */
  }
  return out;
}

function publicConfig(settings) {
  const cfg = normalizeAiWrite(
    (settings && settings.aiWrite) ||
      (typeof getSettings === 'function' ? getSettings().aiWrite : null)
  );
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    actions: Object.keys(ACTIONS).map((id) => ({ id, label: ACTIONS[id].label })),
  };
}

function pushConfigToWc(wc, cfg) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
  try {
    wc.send('mh-ai-config', cfg);
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
 * Lê texto/campo ativo no painel.
 * @param {import('electron').WebContents} wc
 */
async function readActiveField(wc) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return null;
  const code = `(function(){
    try {
      if (window.__mhAi && typeof window.__mhAi.readActive === 'function') {
        return window.__mhAi.readActive();
      }
      return null;
    } catch (e) { return null; }
  })()`;
  try {
    return await wc.executeJavaScript(code, true);
  } catch {
    return null;
  }
}

/**
 * @param {import('electron').WebContents} wc
 * @param {string} text
 */
async function applyTextToActive(wc, text) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
  const code = `(function(){
    try {
      if (window.__mhAi && typeof window.__mhAi.applyText === 'function') {
        return window.__mhAi.applyText(${JSON.stringify(String(text || ''))});
      }
      return false;
    } catch (e) { return false; }
  })()`;
  try {
    return !!(await wc.executeJavaScript(code, true));
  } catch {
    return false;
  }
}

/** Estado da sessão do popover (main). */
let session = {
  accountId: null,
  sourceText: '',
  resultText: '',
  field: null,
  busy: false,
};

/**
 * Abre o popover leve de IA para o painel focado (ou wc informado).
 * @param {{ webContents?: import('electron').WebContents, accountId?: string, anchor?: object }} [opts]
 */
async function openFromFocused(opts = {}) {
  const cfg = currentConfig();
  if (!cfg.enabled) {
    selftestStats.blocked += 1;
    return { ok: false, error: 'disabled' };
  }
  let accountId = opts.accountId || null;
  if (!accountId && typeof getFocusedAccountId === 'function') {
    accountId = getFocusedAccountId();
  }
  let wc = opts.webContents || null;
  if (!wc && accountId && typeof getPanelWc === 'function') {
    wc = getPanelWc(accountId);
  }
  if (!wc) return { ok: false, error: 'no-panel' };

  const fieldInfo = await readActiveField(wc);
  if (fieldInfo && (fieldInfo.sensitive || fieldInfo.error === 'sensitive')) {
    selftestStats.blocked += 1;
    return { ok: false, error: 'sensitive', skipped: 'sensitive' };
  }
  if (!fieldInfo || !fieldInfo.ok) {
    return { ok: false, error: (fieldInfo && fieldInfo.error) || 'no-field' };
  }
  if (isAiBlockedField(fieldInfo.field || {})) {
    selftestStats.blocked += 1;
    return { ok: false, error: 'sensitive', skipped: 'sensitive' };
  }
  const sourceText = truncateText(fieldInfo.text || '');
  if (!sourceText.trim()) return { ok: false, error: 'empty' };

  session = {
    accountId: accountId || null,
    sourceText,
    resultText: '',
    field: fieldInfo.field || null,
    busy: false,
  };

  let viewBounds = opts.viewBounds || null;
  if (!viewBounds && accountId && typeof getPanelViewBounds === 'function') {
    try {
      viewBounds = getPanelViewBounds(accountId);
    } catch {
      viewBounds = null;
    }
  }
  const vx = Number(viewBounds && viewBounds.x) || 0;
  const vy = Number(viewBounds && viewBounds.y) || 0;
  const anchor = opts.anchor || {
    x: vx + (Number(fieldInfo.anchorX) || 40),
    y: vy + (Number(fieldInfo.anchorY) || 40),
    width: Number(fieldInfo.anchorW) || 40,
    height: Number(fieldInfo.anchorH) || 24,
  };

  const data = {
    sourceText,
    resultText: '',
    status: 'idle',
    error: '',
    actions: Object.keys(ACTIONS).map((id) => ({ id, label: ACTIONS[id].label })),
    accountId: session.accountId,
  };

  if (typeof showPopoverFn === 'function') {
    await showPopoverFn({
      id: 'ai-write-popover',
      kind: 'ai-write',
      prefer: 'below',
      anchor,
      data,
    });
  }
  return { ok: true, sourceText };
}

async function runSessionAction(actionId) {
  if (!session.sourceText) return { ok: false, error: 'Sem texto.' };
  session.busy = true;
  if (typeof updatePopoverFn === 'function') {
    updatePopoverFn({ status: 'loading', error: '', resultText: session.resultText });
  }
  const r = await rewriteText({
    action: actionId,
    text: session.sourceText,
    field: session.field,
  });
  session.busy = false;
  if (r.ok) {
    session.resultText = r.text;
    if (typeof updatePopoverFn === 'function') {
      updatePopoverFn({ status: 'done', resultText: r.text, error: '' });
    }
    return r;
  }
  if (typeof updatePopoverFn === 'function') {
    updatePopoverFn({
      status: 'error',
      error: r.error || 'Erro',
      resultText: session.resultText,
    });
  }
  return r;
}

async function applySessionResult() {
  if (!session.resultText) return { ok: false, error: 'Sem resultado.' };
  let wc = null;
  if (session.accountId && typeof getPanelWc === 'function') {
    wc = getPanelWc(session.accountId);
  }
  if (!wc && typeof getFocusedAccountId === 'function' && typeof getPanelWc === 'function') {
    const id = getFocusedAccountId();
    if (id) wc = getPanelWc(id);
  }
  if (!wc) return { ok: false, error: 'Painel indisponível.' };
  const ok = await applyTextToActive(wc, session.resultText);
  if (typeof hidePopoverFn === 'function') hidePopoverFn('ai-replace');
  return { ok: !!ok };
}

function copySessionResult() {
  if (!session.resultText) return { ok: false };
  try {
    clipboard.writeText(session.resultText);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function onSettingsChanged(settings) {
  cancelActive('settings');
  broadcastConfig();
  void settings;
}

/**
 * @param {{
 *   getSettings?: () => object,
 *   updateState?: (fn: (s: object) => void) => void,
 *   forEachPanelWebContents?: (cb: (wc: import('electron').WebContents) => void) => void,
 *   getPanelWebContents?: (accountId: string) => import('electron').WebContents|null,
 *   getFocusedAccountId?: () => string|null,
 *   getPanelViewBounds?: (accountId: string) => { x: number, y: number, width?: number, height?: number } | null,
 *   showPopover?: (opts: object) => Promise<object>|object,
 *   hidePopover?: (reason?: string) => void,
 *   updatePopover?: (data: object) => void,
 * }} opts
 */
function installAiWrite(opts = {}) {
  if (typeof opts.getSettings === 'function') getSettings = opts.getSettings;
  if (typeof opts.updateState === 'function') updateStateFn = opts.updateState;
  if (typeof opts.forEachPanelWebContents === 'function') forEachPanelWc = opts.forEachPanelWebContents;
  if (typeof opts.getPanelWebContents === 'function') getPanelWc = opts.getPanelWebContents;
  if (typeof opts.getFocusedAccountId === 'function') getFocusedAccountId = opts.getFocusedAccountId;
  if (typeof opts.getPanelViewBounds === 'function') getPanelViewBounds = opts.getPanelViewBounds;
  if (typeof opts.showPopover === 'function') showPopoverFn = opts.showPopover;
  if (typeof opts.hidePopover === 'function') hidePopoverFn = opts.hidePopover;
  if (typeof opts.updatePopover === 'function') updatePopoverFn = opts.updatePopover;

  if (ipcInstalled) return;
  ipcInstalled = true;

  ipcMain.on('panel:ai-sync', (event) => {
    try {
      event.returnValue = publicConfig();
    } catch {
      event.returnValue = publicConfig({ aiWrite: defaultAiWriteSettings() });
    }
  });

  ipcMain.handle('panel:ai-open', async (event) => {
    const wc = event && event.sender;
    return openFromFocused({ webContents: wc });
  });

  ipcMain.handle('ai:get-public', async () => publicMeta(currentConfig()));

  ipcMain.handle('ai:set-api-key', async (_e, raw) => {
    const key = raw && typeof raw === 'object' ? raw.key : raw;
    return setApiKey(key == null ? '' : String(key));
  });

  ipcMain.handle('ai:clear-api-key', async () => setApiKey(''));

  ipcMain.handle('ai:test-connection', async () => testConnection());

  ipcMain.handle('ai:probe-local', async () => probeLocal());

  ipcMain.handle('ai:rewrite', async (_e, raw) => {
    const payload = raw && typeof raw === 'object' ? raw : {};
    return rewriteText(payload);
  });

  ipcMain.handle('ai:cancel', async () => {
    cancelActive('user');
    return { ok: true };
  });

  ipcMain.handle('ai:open', async (_e, raw) => {
    const payload = raw && typeof raw === 'object' ? raw : {};
    return openFromFocused(payload);
  });

  ipcMain.handle('ai:session-action', async (_e, raw) => {
    const action = raw && typeof raw === 'object' ? raw.action : raw;
    return runSessionAction(String(action || ''));
  });

  ipcMain.handle('ai:session-replace', async () => applySessionResult());

  ipcMain.handle('ai:session-copy', async () => copySessionResult());

  ipcMain.handle('ai:selftest-stats', async () => {
    if (String(envGet('MULTIHEIZ_SELFTEST') || '') !== SELFTEST_MODE) return null;
    return getSelftestStats();
  });
}

function getSelftestStats() {
  return {
    ...selftestStats,
    activeRequestId,
    sessionBusy: session.busy,
    encryptionAvailable: safeStorageApi().available,
  };
}

function resetSelftestStats() {
  selftestStats.requests = 0;
  selftestStats.blocked = 0;
  selftestStats.lastStatus = 0;
  selftestStats.lastError = '';
  selftestStats.lastAction = '';
  selftestStats.logsWithKey = 0;
}

module.exports = {
  MAX_TEXT_CHARS,
  DEFAULT_TIMEOUT_MS,
  PROVIDERS,
  ACTIONS,
  LOCAL_MODEL_DOCS,
  TRAINING_WARNING,
  defaultAiWriteSettings,
  normalizeAiWrite,
  publicSettings,
  publicMeta,
  sanitizeSettingsObject,
  validateBaseUrl,
  isAiBlockedField,
  publicConfig,
  installAiWrite,
  onSettingsChanged,
  broadcastConfig,
  pushConfigToWc,
  setApiKey,
  decryptApiKey,
  rewriteText,
  testConnection,
  probeLocal,
  openFromFocused,
  applyTextToActive,
  readActiveField,
  cancelActive,
  getSelftestStats,
  resetSelftestStats,
  currentConfig,
};
