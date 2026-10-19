'use strict';

/**
 * Session permission policy for all Electron sessions.
 * Default deny; small allowlist; ask+remember for media/geo/display-capture.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, session } = require('electron');

/** Allowed without prompt (same-origin / sanitized). */
const AUTO_ALLOW = new Set([
  'clipboard-sanitized-write',
  'clipboard-read',
  'fullscreen',
  'pointerLock',
  'pointer-lock',
]);

/** Ask the user; remember per origin+permission+account. */
const ASK_PERMISSIONS = new Set([
  'media',
  'mediaKeySystem',
  'geolocation',
  'display-capture',
  'displayCapture',
]);

/** Always deny. */
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
]);

/** @type {Map<string, 'allow'|'deny'>} */
const memoryDecisions = new Map();

/** @type {WeakMap<Electron.Session, string|null>} */
const sessionAccountIds = new WeakMap();

/** @type {Set<Electron.Session>} */
const attachedSessions = new WeakSet();

/** @type {(() => import('electron').BrowserWindow|null) | null} */
let getMainWindow = null;

/** @type {Promise<boolean> | null} */
let pendingAsk = null;

function decisionsPath() {
  try {
    return path.join(app.getPath('userData'), 'permission-decisions.json');
  } catch {
    return null;
  }
}

function loadPersisted() {
  const p = decisionsPath();
  if (!p || !fs.existsSync(p)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    for (const [k, v] of Object.entries(raw)) {
      if (v === 'allow' || v === 'deny') memoryDecisions.set(k, v);
    }
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
  return String(permission || '').trim();
}

/**
 * @param {string} permission
 * @param {string} origin
 * @param {object} [details]
 */
function permissionLabel(permission, origin, details) {
  const site = origin || 'este site';
  const mediaTypes = (details && details.mediaTypes) || [];
  if (permission === 'media' || permission === 'mediaKeySystem') {
    const hasVideo = mediaTypes.includes('video') || mediaTypes.includes('camera');
    const hasAudio = mediaTypes.includes('audio') || mediaTypes.includes('microphone');
    if (hasVideo && hasAudio) {
      return `O site ${site} quer usar sua câmera e microfone. Permitir?`;
    }
    if (hasVideo) return `O site ${site} quer usar sua câmera. Permitir?`;
    if (hasAudio) return `O site ${site} quer usar seu microfone. Permitir?`;
    return `O site ${site} quer usar câmera/microfone. Permitir?`;
  }
  if (permission === 'geolocation') {
    return `O site ${site} quer usar sua localização. Permitir?`;
  }
  if (permission === 'display-capture' || permission === 'displayCapture') {
    return `O site ${site} quer capturar a tela. Permitir?`;
  }
  return `O site ${site} pediu permissão "${permission}". Permitir?`;
}

/**
 * Pure decision for checks / tests (no dialog).
 * @returns {'allow'|'deny'|'ask'}
 */
function classifyPermission(permission, requestingOrigin, details = {}) {
  const perm = normalizePermission(permission);
  const origin = originOf(requestingOrigin || (details && details.requestingUrl) || '');

  if (ALWAYS_DENY.has(perm)) return 'deny';

  if (perm === 'notifications') {
    if (origin.startsWith('http://') || origin.startsWith('https://')) return 'allow';
    // Internal file:// UI: allow app notifications if ever requested
    if (origin.startsWith('file://')) return 'allow';
    return 'deny';
  }

  if (AUTO_ALLOW.has(perm)) {
    // pointerLock / fullscreen: only from http(s) or file (own UI)
    if (perm === 'pointerLock' || perm === 'pointer-lock' || perm === 'fullscreen') {
      if (
        origin.startsWith('http://') ||
        origin.startsWith('https://') ||
        origin.startsWith('file://')
      ) {
        return 'allow';
      }
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

  // Unknown permissions: deny
  return 'deny';
}

/**
 * @param {string|null} accountId
 * @param {string} permission
 * @param {string} requestingOrigin
 * @param {object} [details]
 * @returns {boolean|null} true/false if decided, null if should ask
 */
function rememberedOrClassified(accountId, permission, requestingOrigin, details) {
  const perm = normalizePermission(permission);
  const origin = originOf(requestingOrigin || (details && details.requestingUrl) || '');
  const kind = classifyPermission(perm, origin, details);
  if (kind === 'allow') return true;
  if (kind === 'deny') return false;

  const key = decisionKey(accountId, origin, perm);
  const remembered = memoryDecisions.get(key);
  if (remembered === 'allow') return true;
  if (remembered === 'deny') return false;
  return null;
}

/**
 * Synchronous check used by setPermissionCheckHandler.
 * @returns {boolean}
 */
function checkPermission(accountId, permission, requestingOrigin, details) {
  const decided = rememberedOrClassified(accountId, permission, requestingOrigin, details);
  if (decided === null) return false; // not yet granted
  return decided;
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

  // Serialize dialogs
  while (pendingAsk) {
    try {
      await pendingAsk;
    } catch {
      /* ignore */
    }
  }

  const askPromise = (async () => {
    const win = getMainWindow && getMainWindow();
    let response = 1;
    try {
      const result = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
        type: 'question',
        buttons: ['Permitir', 'Bloquear'],
        defaultId: 1,
        cancelId: 1,
        title: 'Permissão do site',
        message: permissionLabel(perm, origin, details),
        noLink: true,
      });
      response = result.response;
    } catch {
      response = 1;
    }
    const allow = response === 0;
    memoryDecisions.set(decisionKey(accountId, origin, perm), allow ? 'allow' : 'deny');
    persistDecisions();
    return allow;
  })();

  pendingAsk = askPromise;
  try {
    return await askPromise;
  } finally {
    if (pendingAsk === askPromise) pendingAsk = null;
  }
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
    // Still refresh account id binding
    return;
  }
  attachedSessions.add(ses);

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const acc =
      (sessionAccountIds.get(ses) != null ? sessionAccountIds.get(ses) : null) ||
      null;
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
      (sessionAccountIds.get(ses) != null ? sessionAccountIds.get(ses) : null) ||
      null;
    return checkPermission(acc, permission, requestingOrigin, details || {});
  });
}

/**
 * @param {{ getMainWindow?: () => import('electron').BrowserWindow|null }} [opts]
 */
function initPermissions(opts = {}) {
  if (typeof opts.getMainWindow === 'function') {
    getMainWindow = opts.getMainWindow;
  }
  loadPersisted();

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
  AUTO_ALLOW,
  ASK_PERMISSIONS,
  ALWAYS_DENY,
};
