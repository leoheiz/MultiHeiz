'use strict';

/**
 * Permissões de site (estilo Chrome/Edge) por origem + conta (partição).
 *
 * Default deny; allowlist segura (fullscreen, clipboard-sanitized-write, pointer-lock,
 * WebAuthn). Pedidos sensíveis: prompt in-app (não dialog nativo) + lembrar decisão.
 *
 * Microfone e câmera são chaves separadas (Electron envia permission "media" +
 * details.mediaTypes / mediaType).
 *
 * Indicador de captura: não há evento app/session "media-access" no Electron 44;
 * o panel-preload observa getUserMedia / tracks e reporta via ipc-message do painel
 * (mesmo padrão de panel:fps — amarrado ao WebContents do painel).
 *
 * Windows: o SO pode exigir "Permitir que aplicativos da área de trabalho acessem
 * o microfone" em Configurações → Privacidade; não usamos systemPreferences no Win.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, session } = require('electron');

/** Permitidos sem prompt (Chrome concede / seguros). */
const AUTO_ALLOW = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'pointer-lock',
  // Google / IdP: WebAuthn para poder cancelar passkey e cair em senha.
  'publickey-credentials-get',
  'publickey-credentials-create',
]);

/** Perguntar; lembrar por origem+permissão+conta. */
const ASK_PERMISSIONS = new Set([
  'media',
  'microphone',
  'camera',
  'mediaKeySystem',
  'notifications',
  'geolocation',
  'clipboard-read',
  'display-capture',
  'displayCapture',
]);

/** Sempre negar. */
const ALWAYS_DENY = new Set([
  'midi',
  'midiSysex',
  'hid',
  'serial',
  'usb',
  'openExternal',
  'open-external',
  'idle-detection',
  'idleDetection',
  'storage-access',
  'storageAccess',
  'window-management',
  'windowManagement',
  'clipboard',
  'fileSystem',
  'file-system',
  'local-fonts',
  'localFonts',
  'speaker-selection',
  'speakerSelection',
  // Sem UI FedCM no Electron.
  'identity-credentials-get',
]);

/** Permissões expostas no popover do site. */
const SITE_INFO_PERMISSIONS = [
  'microphone',
  'camera',
  'notifications',
  'geolocation',
  'clipboard-read',
  'display-capture',
];

/** @type {Map<string, 'allow'|'deny'>} */
const memoryDecisions = new Map();

/** @type {WeakMap<Electron.Session, string|null>} */
const sessionAccountIds = new WeakMap();

/** @type {Set<Electron.Session>} */
const attachedSessions = new WeakSet();

/** @type {(() => import('electron').BrowserWindow|null) | null} */
let getMainWindow = null;

/** @type {((payload: object) => void) | null} */
let emitToRenderer = null;

/** @type {((wc: Electron.WebContents) => string|null) | null} */
let resolveAccountIdFromWebContents = null;

/** Filas de prompt por painel (accountId). */
/** @type {Map<string, Array<{ id: string, resolve: (v: boolean) => void, payload: object }>>} */
const promptQueues = new Map();

/** Pedidos ativos por id. */
/** @type {Map<string, { accountId: string, origin: string, permission: string, rememberKeys: string[], resolve: (v: boolean) => void }>} */
const pendingById = new Map();

/** Uso de mídia ativo por painel: { microphone: boolean, camera: boolean } */
/** @type {Map<string, { microphone: boolean, camera: boolean }>} */
const mediaInUse = new Map();

let ipcRegistered = false;
let nextRequestId = 1;

function decisionsPath() {
  try {
    return path.join(app.getPath('userData'), 'permission-decisions.json');
  } catch {
    return null;
  }
}

/**
 * Migra chaves antigas `…|media` → microphone + camera (mantém deny/allow).
 * @param {Record<string, unknown>} raw
 */
function migrateRawDecisions(raw) {
  /** @type {Record<string, 'allow'|'deny'>} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v !== 'allow' && v !== 'deny') continue;
    const parts = String(k).split('|');
    if (parts.length >= 3 && parts[parts.length - 1] === 'media') {
      const base = parts.slice(0, -1).join('|');
      out[`${base}|microphone`] = v;
      out[`${base}|camera`] = v;
      // Mantém a chave antiga também (deny/allow de media legada).
      out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadPersisted() {
  const p = decisionsPath();
  if (!p || !fs.existsSync(p)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const migrated = migrateRawDecisions(raw);
    for (const [k, v] of Object.entries(migrated)) {
      memoryDecisions.set(k, v);
    }
    // Regrava se migrou chaves media → mic/cam
    const hadMedia =
      raw && typeof raw === 'object' && Object.keys(raw).some((k) => /\|media$/.test(k));
    if (hadMedia) persistDecisions();
  } catch {
    /* ignore */
  }
}

function persistDecisions() {
  const p = decisionsPath();
  if (!p) return;
  try {
    const obj = Object.fromEntries(memoryDecisions.entries());
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

/**
 * @param {string|null|undefined} accountId
 * @param {string} origin
 * @param {string} permission
 */
function decisionKey(accountId, origin, permission) {
  return `${accountId || 'default'}|${origin || ''}|${permission}`;
}

/**
 * @param {string} urlOrOrigin
 */
function originOf(urlOrOrigin) {
  try {
    const u = new URL(String(urlOrOrigin || ''));
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.origin;
    }
    return `${u.protocol}//${u.host || ''}`;
  } catch {
    return String(urlOrOrigin || '').slice(0, 200);
  }
}

/**
 * @param {string} permission
 */
function normalizePermission(permission) {
  const p = String(permission || '').trim();
  if (p === 'displayCapture') return 'display-capture';
  if (p === 'pointerLock') return 'pointer-lock';
  return p;
}

/**
 * Extrai tipos de mídia do details do Electron (request: mediaTypes[]; check: mediaType).
 * @param {object} [details]
 * @returns {{ audio: boolean, video: boolean }}
 */
function mediaTypesFromDetails(details) {
  const d = details || {};
  const types = Array.isArray(d.mediaTypes) ? d.mediaTypes.map(String) : [];
  const single = d.mediaType != null ? String(d.mediaType) : '';
  if (single) types.push(single);
  let audio = false;
  let video = false;
  for (const t of types) {
    const x = t.toLowerCase();
    if (x === 'audio' || x === 'microphone' || x === 'mic') audio = true;
    if (x === 'video' || x === 'camera') video = true;
  }
  // Pedido "media" sem tipos: trata como ambos (conservador — perguntar os dois).
  if (!audio && !video && (normalizePermission(d._permission || '') === 'media' || types.length === 0)) {
    /* leave both false — caller decides */
  }
  return { audio, video };
}

/**
 * Chaves de decisão a consultar/gravar para um pedido Electron.
 * @param {string} permission
 * @param {object} [details]
 * @returns {string[]}
 */
function expandPermissionKeys(permission, details) {
  const perm = normalizePermission(permission);
  if (perm === 'media' || perm === 'mediaKeySystem') {
    const { audio, video } = mediaTypesFromDetails({ ...details, _permission: perm });
    if (audio && video) return ['microphone', 'camera'];
    if (audio) return ['microphone'];
    if (video) return ['camera'];
    // Sem mediaTypes: pedido genérico de media — exige os dois (ou media legada).
    if (perm === 'mediaKeySystem') return ['mediaKeySystem'];
    return ['microphone', 'camera'];
  }
  if (perm === 'displayCapture') return ['display-capture'];
  return [perm];
}

/**
 * Texto do prompt (pt-BR).
 * @param {string} origin
 * @param {string[]} keys
 */
function promptMessage(origin, keys) {
  const site = origin || 'este site';
  const set = new Set(keys);
  if (set.has('microphone') && set.has('camera')) {
    return `${site} quer usar seu microfone e câmera`;
  }
  if (set.has('microphone')) return `${site} quer usar seu microfone`;
  if (set.has('camera')) return `${site} quer usar sua câmera`;
  if (set.has('notifications')) return `${site} quer mostrar notificações`;
  if (set.has('geolocation')) return `${site} quer saber sua localização`;
  if (set.has('clipboard-read')) return `${site} quer ler a área de transferência`;
  if (set.has('display-capture')) return `${site} quer compartilhar sua tela`;
  if (set.has('mediaKeySystem')) return `${site} quer usar proteção de mídia (EME)`;
  return `${site} pediu uma permissão`;
}

/**
 * Decisão pura (sem dialog).
 * @returns {'allow'|'deny'|'ask'}
 */
function classifyPermission(permission, requestingOrigin, details = {}) {
  const perm = normalizePermission(permission);
  const origin = originOf(requestingOrigin || (details && details.requestingUrl) || '');

  if (ALWAYS_DENY.has(perm)) return 'deny';

  // Expansão media → mic/cam: classifica como ask se http(s)
  if (perm === 'media') {
    if (!(origin.startsWith('http://') || origin.startsWith('https://'))) return 'deny';
    return 'ask';
  }

  if (AUTO_ALLOW.has(perm)) {
    if (perm === 'pointer-lock' || perm === 'pointerLock' || perm === 'fullscreen') {
      if (
        origin.startsWith('http://') ||
        origin.startsWith('https://') ||
        origin.startsWith('file://')
      ) {
        return 'allow';
      }
      return 'deny';
    }
    if (perm === 'publickey-credentials-get' || perm === 'publickey-credentials-create') {
      if (origin.startsWith('https://')) return 'allow';
      return 'deny';
    }
    return 'allow';
  }

  if (ASK_PERMISSIONS.has(perm)) {
    if (!(origin.startsWith('http://') || origin.startsWith('https://'))) {
      return 'deny';
    }
    return 'ask';
  }

  return 'deny';
}

/**
 * Estado lembrado para uma chave: 'allow' | 'deny' | 'ask'
 * @param {string|null} accountId
 * @param {string} origin
 * @param {string} key
 */
function getRememberedState(accountId, origin, key) {
  const k = decisionKey(accountId, origin, key);
  const v = memoryDecisions.get(k);
  if (v === 'allow' || v === 'deny') return v;
  // Legado: chave media aplica a mic/cam se não houver chave específica
  if (key === 'microphone' || key === 'camera') {
    const legacy = memoryDecisions.get(decisionKey(accountId, origin, 'media'));
    if (legacy === 'allow' || legacy === 'deny') return legacy;
  }
  return 'ask';
}

/**
 * @param {string|null} accountId
 * @param {string} permission
 * @param {string} requestingOrigin
 * @param {object} [details]
 * @returns {boolean|null} true/false decidido, null = perguntar
 */
function rememberedOrClassified(accountId, permission, requestingOrigin, details) {
  const perm = normalizePermission(permission);
  const origin = originOf(requestingOrigin || (details && details.requestingUrl) || '');
  const kind = classifyPermission(perm, origin, details);
  if (kind === 'allow') return true;
  if (kind === 'deny') return false;

  const keys = expandPermissionKeys(perm, details);
  // Todos allow → true; qualquer deny → false; senão ask (null)
  let anyAsk = false;
  for (const key of keys) {
    const st = getRememberedState(accountId, origin, key);
    if (st === 'deny') return false;
    if (st === 'ask') anyAsk = true;
  }
  if (anyAsk) return null;
  return true;
}

/**
 * Check síncrono (setPermissionCheckHandler).
 * permitido → true; perguntar/bloqueado → false (navigator.permissions.query).
 */
function checkPermission(accountId, permission, requestingOrigin, details) {
  const decided = rememberedOrClassified(accountId, permission, requestingOrigin, details);
  if (decided === null) return false;
  return decided;
}

/**
 * Empurra prompt para o renderer; resolve quando o usuário responde.
 * @param {string} accountId
 * @param {string} origin
 * @param {string[]} rememberKeys
 * @param {string} permission
 * @returns {Promise<boolean>}
 */
function enqueuePrompt(accountId, origin, rememberKeys, permission) {
  const panelKey = accountId || 'default';
  return new Promise((resolve) => {
    const id = `perm-${Date.now().toString(36)}-${nextRequestId++}`;
    const entry = {
      id,
      accountId: panelKey,
      origin,
      permission,
      rememberKeys,
      resolve,
    };
    pendingById.set(id, entry);
    let q = promptQueues.get(panelKey);
    if (!q) {
      q = [];
      promptQueues.set(panelKey, q);
    }
    q.push({
      id,
      resolve,
      payload: {
        type: 'permissions:prompt',
        requestId: id,
        accountId: panelKey,
        origin,
        permission,
        keys: rememberKeys,
        message: promptMessage(origin, rememberKeys),
      },
    });
    pumpQueue(panelKey);
  });
}

/**
 * @param {string} panelKey
 */
function pumpQueue(panelKey) {
  const q = promptQueues.get(panelKey);
  if (!q || !q.length) return;
  const head = q[0];
  if (!head || head._shown) return;
  head._shown = true;
  if (typeof emitToRenderer === 'function') {
    emitToRenderer(head.payload);
  }
}

/**
 * @param {string} requestId
 * @param {'allow'|'deny'|'dismiss'} action
 */
function respondPrompt(requestId, action) {
  const entry = pendingById.get(requestId);
  if (!entry) return { ok: false };
  pendingById.delete(requestId);
  const panelKey = entry.accountId;
  const q = promptQueues.get(panelKey);
  if (q) {
    const idx = q.findIndex((x) => x.id === requestId);
    if (idx >= 0) q.splice(idx, 1);
    if (!q.length) promptQueues.delete(panelKey);
  }

  const remember = action === 'allow' || action === 'deny';
  const allow = action === 'allow';
  if (remember) {
    for (const key of entry.rememberKeys) {
      memoryDecisions.set(decisionKey(entry.accountId, entry.origin, key), allow ? 'allow' : 'deny');
    }
    persistDecisions();
  }

  try {
    entry.resolve(allow);
  } catch {
    /* ignore */
  }

  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'permissions:prompt-closed', requestId, accountId: panelKey });
  }
  pumpQueue(panelKey);
  // Atualiza popover / indicadores
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({
      type: 'permissions:changed',
      accountId: panelKey,
      origin: entry.origin,
    });
  }
  return { ok: true, allow };
}

/**
 * Nega e remove prompts de um painel (fechou / navegou).
 * @param {string} accountId
 */
function cancelPromptsForAccount(accountId) {
  const panelKey = accountId || 'default';
  const q = promptQueues.get(panelKey);
  if (q) {
    for (const item of q.slice()) {
      respondPrompt(item.id, 'dismiss');
    }
  }
  // Qualquer pending órfão
  for (const [id, entry] of [...pendingById.entries()]) {
    if (entry.accountId === panelKey) respondPrompt(id, 'dismiss');
  }
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'permissions:prompt-cleared', accountId: panelKey });
  }
}

/**
 * @param {string|null} accountId
 * @param {string} permission
 * @param {string} requestingOrigin
 * @param {object} [details]
 * @returns {Promise<boolean>}
 */
async function requestPermission(accountId, permission, requestingOrigin, details) {
  const perm = normalizePermission(permission);
  const origin = originOf(requestingOrigin || (details && details.requestingUrl) || '');
  const decided = rememberedOrClassified(accountId, perm, origin, details);
  if (decided !== null) return decided;

  const keys = expandPermissionKeys(perm, details);
  const panelKey = accountId || 'default';
  return enqueuePrompt(panelKey, origin, keys, perm);
}

/**
 * @param {Electron.Session} ses
 * @param {string|null} [accountId]
 */
function attachToSession(ses, accountId = null) {
  if (!ses) return;
  if (accountId != null) sessionAccountIds.set(ses, accountId);
  else if (!sessionAccountIds.has(ses)) sessionAccountIds.set(ses, null);

  if (attachedSessions.has(ses)) {
    return;
  }
  attachedSessions.add(ses);

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    let acc =
      (sessionAccountIds.get(ses) != null ? sessionAccountIds.get(ses) : null) || null;
    if (!acc && typeof resolveAccountIdFromWebContents === 'function' && webContents) {
      try {
        acc = resolveAccountIdFromWebContents(webContents) || null;
      } catch {
        acc = null;
      }
    }
    const origin =
      (details && (details.requestingUrl || details.securityOrigin)) ||
      (webContents && !webContents.isDestroyed() ? webContents.getURL() : '') ||
      '';
    requestPermission(acc, permission, origin, details || {})
      .then((ok) => {
        try {
          callback(!!ok);
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        try {
          callback(false);
        } catch {
          /* ignore */
        }
      });
  });

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const acc =
      (sessionAccountIds.get(ses) != null ? sessionAccountIds.get(ses) : null) || null;
    return checkPermission(acc, permission, requestingOrigin, details || {});
  });

  // Dispositivos (USB etc. já negados); mídia: não bloquear se permissão do site ok.
  try {
    if (typeof ses.setDevicePermissionHandler === 'function') {
      ses.setDevicePermissionHandler((details) => {
        const acc =
          (sessionAccountIds.get(ses) != null ? sessionAccountIds.get(ses) : null) || null;
        const origin = originOf((details && details.origin) || '');
        const deviceType = String((details && details.deviceType) || '');
        // Só libera dispositivos de mídia quando mic/cam já concedidos; resto nega.
        if (deviceType === 'media' || deviceType === 'audio' || deviceType === 'video') {
          const mic = getRememberedState(acc, origin, 'microphone') === 'allow';
          const cam = getRememberedState(acc, origin, 'camera') === 'allow';
          return mic || cam;
        }
        return false;
      });
    }
  } catch {
    /* ignore */
  }
}

/**
 * Estados para o popover do site.
 * @param {string|null} accountId
 * @param {string} origin
 */
function getSitePermissionStates(accountId, origin) {
  const o = originOf(origin);
  /** @type {Record<string, 'ask'|'allow'|'deny'>} */
  const states = {};
  for (const key of SITE_INFO_PERMISSIONS) {
    states[key] = getRememberedState(accountId, o, key);
  }
  return { origin: o, states };
}

/**
 * @param {string|null} accountId
 * @param {string} origin
 * @param {string} permission
 * @param {'ask'|'allow'|'deny'} value
 */
function setSitePermission(accountId, origin, permission, value) {
  const o = originOf(origin);
  const key = normalizePermission(permission);
  if (!SITE_INFO_PERMISSIONS.includes(key) && key !== 'mediaKeySystem') {
    return { ok: false, error: 'unknown' };
  }
  const dk = decisionKey(accountId, o, key);
  if (value === 'ask') {
    memoryDecisions.delete(dk);
    // Limpa legado media se mic/cam
    if (key === 'microphone' || key === 'camera') {
      memoryDecisions.delete(decisionKey(accountId, o, 'media'));
    }
  } else if (value === 'allow' || value === 'deny') {
    memoryDecisions.set(dk, value);
  } else {
    return { ok: false, error: 'bad-value' };
  }
  persistDecisions();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'permissions:changed', accountId, origin: o });
  }
  const needsReload = key === 'notifications' || key === 'display-capture';
  return { ok: true, needsReload };
}

/**
 * @param {string|null} accountId
 * @param {string} origin
 */
function resetSitePermissions(accountId, origin) {
  const o = originOf(origin);
  const prefix = `${accountId || 'default'}|${o}|`;
  for (const k of [...memoryDecisions.keys()]) {
    if (k.startsWith(prefix)) memoryDecisions.delete(k);
  }
  persistDecisions();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'permissions:changed', accountId, origin: o });
  }
  return { ok: true };
}

/**
 * @param {string} accountId
 * @param {{ microphone?: boolean, camera?: boolean }} flags
 */
function setMediaInUse(accountId, flags) {
  if (!accountId) return;
  const cur = mediaInUse.get(accountId) || { microphone: false, camera: false };
  if (flags && typeof flags.microphone === 'boolean') cur.microphone = flags.microphone;
  if (flags && typeof flags.camera === 'boolean') cur.camera = flags.camera;
  if (!cur.microphone && !cur.camera) mediaInUse.delete(accountId);
  else mediaInUse.set(accountId, cur);
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({
      type: 'permissions:media-use',
      accountId,
      microphone: !!cur.microphone,
      camera: !!cur.camera,
    });
  }
}

/**
 * @param {string} accountId
 */
function clearMediaInUse(accountId) {
  if (!accountId) return;
  mediaInUse.delete(accountId);
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({
      type: 'permissions:media-use',
      accountId,
      microphone: false,
      camera: false,
    });
  }
}

function getMediaInUse(accountId) {
  return mediaInUse.get(accountId) || { microphone: false, camera: false };
}

function registerIpcHandlers() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  // Canal de painel (ipc-guard PANEL_CHANNELS): indicador de captura
  ipcMain.on('panel:media-use', (event, data) => {
    try {
      const wc = event && event.sender;
      let accountId = null;
      if (typeof resolveAccountIdFromWebContents === 'function' && wc) {
        accountId = resolveAccountIdFromWebContents(wc);
      }
      if (!accountId) return;
      setMediaInUse(accountId, {
        microphone: !!(data && data.microphone),
        camera: !!(data && data.camera),
      });
    } catch {
      /* ignore */
    }
  });

  ipcMain.handle('permissions:respond', (_e, payload) => {
    const requestId = payload && payload.requestId;
    const action = payload && payload.action;
    if (!requestId || !['allow', 'deny', 'dismiss'].includes(action)) {
      return { ok: false };
    }
    return respondPrompt(String(requestId), action);
  });

  ipcMain.handle('permissions:get', (_e, payload) => {
    const accountId = payload && payload.accountId;
    const origin = payload && payload.origin;
    return getSitePermissionStates(accountId || null, origin || '');
  });

  ipcMain.handle('permissions:set', (_e, payload) => {
    const accountId = payload && payload.accountId;
    const origin = payload && payload.origin;
    const permission = payload && payload.permission;
    const value = payload && payload.value;
    return setSitePermission(accountId || null, origin || '', permission, value);
  });

  ipcMain.handle('permissions:reset', (_e, payload) => {
    const accountId = payload && payload.accountId;
    const origin = payload && payload.origin;
    return resetSitePermissions(accountId || null, origin || '');
  });

  ipcMain.handle('permissions:media-use-get', (_e, accountId) => {
    return getMediaInUse(accountId);
  });
}

/**
 * @param {{
 *   getMainWindow?: () => import('electron').BrowserWindow|null,
 *   emit?: (payload: object) => void,
 *   resolveAccountIdFromWebContents?: (wc: Electron.WebContents) => string|null,
 * }} [opts]
 */
function initPermissions(opts = {}) {
  if (typeof opts.getMainWindow === 'function') {
    getMainWindow = opts.getMainWindow;
  }
  if (typeof opts.emit === 'function') {
    emitToRenderer = opts.emit;
  }
  if (typeof opts.resolveAccountIdFromWebContents === 'function') {
    resolveAccountIdFromWebContents = opts.resolveAccountIdFromWebContents;
  }
  loadPersisted();
  registerIpcHandlers();

  try {
    attachToSession(session.defaultSession, null);
  } catch {
    /* ignore */
  }

  try {
    app.on('session-created', (ses) => {
      attachToSession(ses, null);
    });
  } catch {
    /* ignore */
  }
}

/** Test helper: clear remembered decisions. */
function clearDecisionsForTest() {
  memoryDecisions.clear();
}

/** Test helper: set a remembered decision. */
function setDecisionForTest(accountId, origin, permission, value) {
  memoryDecisions.set(decisionKey(accountId, origin, permission), value);
}

/** Selftest: responde o prompt ativo do painel. */
function selftestRespond(accountId, action) {
  const q = promptQueues.get(accountId || 'default');
  if (!q || !q.length) return { ok: false, error: 'no-prompt' };
  return respondPrompt(q[0].id, action);
}

/** Selftest: há prompt visível / enfileirado. */
function selftestPeekPrompt(accountId) {
  const q = promptQueues.get(accountId || 'default');
  if (!q || !q.length) return null;
  return q[0].payload;
}

module.exports = {
  initPermissions,
  attachToSession,
  classifyPermission,
  checkPermission,
  requestPermission,
  rememberedOrClassified,
  clearDecisionsForTest,
  setDecisionForTest,
  decisionKey,
  originOf,
  expandPermissionKeys,
  mediaTypesFromDetails,
  promptMessage,
  getSitePermissionStates,
  setSitePermission,
  resetSitePermissions,
  cancelPromptsForAccount,
  setMediaInUse,
  clearMediaInUse,
  getMediaInUse,
  respondPrompt,
  selftestRespond,
  selftestPeekPrompt,
  migrateRawDecisions,
  AUTO_ALLOW,
  ASK_PERMISSIONS,
  ALWAYS_DENY,
  SITE_INFO_PERMISSIONS,
};
