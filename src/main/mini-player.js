'use strict';

/**
 * Experimental always-on-top mini player.
 * Frameless BrowserWindow + chrome WebContentsView + content WebContentsView
 * (same session/partition as the source panel). Source panel audio muted while open.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  BrowserWindow,
  WebContentsView,
  globalShortcut,
  ipcMain,
} = require('electron');
const keymap = require('./keymap');
const { getState, updateState } = require('./state');
const ipcGuard = require('./ipc-guard');

const CHROME_HTML = path.resolve(__dirname, '..', 'renderer', 'mini-player.html');
const CHROME_PRELOAD = path.resolve(__dirname, '..', 'preload', 'mini-player-preload.js');
const CHROME_H = 36;
const DEFAULT_LOCK_COMBO = 'Ctrl+Alt+L';

/** @type {object | null} */
let panelsApi = null;
/** @type {(() => import('electron').BrowserWindow | null) | null} */
let getMainWindow = null;

/** @type {import('electron').BrowserWindow | null} */
let miniWin = null;
/** @type {import('electron').WebContentsView | null} */
let chromeView = null;
/** @type {import('electron').WebContentsView | null} */
let contentView = null;
/** @type {string | null} */
let sourceAccountId = null;
/** @type {boolean} */
let sourceWasAudioMuted = false;
/** @type {boolean} */
let locked = false;
/** @type {number} */
let opacityPercent = 100;
/** @type {string | null} */
let registeredAccel = null;
/** @type {boolean} */
let ipcWired = false;

/** Selftest flags */
/** @type {{ ignoreMouseEvents: boolean, focusable: boolean, locked: boolean }} */
let selftestFlags = {
  ignoreMouseEvents: false,
  focusable: true,
  locked: false,
};

function selftestOn() {
  return !!process.env.MULTIHEIZ_SELFTEST;
}

/**
 * @param {{
 *   panels: object,
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 * }} deps
 */
function configure(deps) {
  panelsApi = deps.panels || null;
  getMainWindow = deps.getMainWindow || null;
  ensureIpc();
}

/**
 * @param {string} accountId
 * @returns {import('electron').WebContents | null}
 */
function wcFor(accountId) {
  if (!panelsApi || typeof panelsApi.getPanelCapture !== 'function') return null;
  try {
    const wc = panelsApi.getPanelCapture(accountId);
    if (wc && !wc.isDestroyed()) return wc;
  } catch {
    /* ignore */
  }
  return null;
}

function clampOpacity(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 100;
  return Math.max(20, Math.min(100, Math.round(v)));
}

function readPersisted() {
  try {
    const s = getState();
    const mp = s && s.miniPlayer && typeof s.miniPlayer === 'object' ? s.miniPlayer : {};
    const settingsOp =
      s && s.settings && typeof s.settings.miniPlayerOpacity === 'number'
        ? s.settings.miniPlayerOpacity
        : undefined;
    return {
      x: typeof mp.x === 'number' ? mp.x : undefined,
      y: typeof mp.y === 'number' ? mp.y : undefined,
      width: typeof mp.width === 'number' ? mp.width : 420,
      height: typeof mp.height === 'number' ? mp.height : 280,
      opacityPercent: clampOpacity(
        typeof mp.opacityPercent === 'number'
          ? mp.opacityPercent
          : settingsOp != null
            ? settingsOp
            : 100
      ),
    };
  } catch {
    return { width: 420, height: 280, opacityPercent: 100 };
  }
}

function persistGeometry() {
  if (!miniWin || miniWin.isDestroyed()) return;
  let b;
  try {
    b = miniWin.getBounds();
  } catch {
    return;
  }
  updateState((s) => {
    if (!s.miniPlayer || typeof s.miniPlayer !== 'object') s.miniPlayer = {};
    s.miniPlayer.x = b.x;
    s.miniPlayer.y = b.y;
    s.miniPlayer.width = b.width;
    s.miniPlayer.height = b.height;
    s.miniPlayer.opacityPercent = opacityPercent;
    if (!s.settings || typeof s.settings !== 'object') s.settings = {};
    s.settings.miniPlayerOpacity = opacityPercent;
  });
}

/**
 * Electron accelerator for globalShortcut from keymap combo.
 * @param {string} combo
 * @returns {string}
 */
function comboToGlobalAccel(combo) {
  const acc = keymap.comboToAccelerator(combo);
  if (acc) return acc;
  // Fallback: Ctrl → CommandOrControl
  return String(combo || '')
    .replace(/^Ctrl\+/i, 'CommandOrControl+')
    .replace(/\+/g, '+');
}

function resolveLockCombo() {
  try {
    const s = getState();
    const ks = s && s.settings && s.settings.keyboardShortcuts;
    const r = keymap.resolveShortcut(ks, 'miniPlayerLock');
    if (r && !r.disabled && r.combo) return r.combo;
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCK_COMBO;
}

function unregisterLockShortcut() {
  if (!registeredAccel) return;
  try {
    globalShortcut.unregister(registeredAccel);
  } catch {
    /* ignore */
  }
  registeredAccel = null;
}

function registerLockShortcut() {
  unregisterLockShortcut();
  const combo = resolveLockCombo();
  const accel = comboToGlobalAccel(combo);
  if (!accel) return false;
  try {
    const ok = globalShortcut.register(accel, () => {
      toggleLock();
    });
    if (ok) {
      registeredAccel = accel;
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function layoutChildren() {
  if (!miniWin || miniWin.isDestroyed()) return;
  let b;
  try {
    b = miniWin.getContentBounds();
  } catch {
    return;
  }
  const w = Math.max(1, b.width);
  const h = Math.max(1, b.height);
  const chromeH = locked ? 0 : CHROME_H;
  if (chromeView && !chromeView.webContents.isDestroyed()) {
    try {
      chromeView.setBounds({ x: 0, y: 0, width: w, height: chromeH });
      chromeView.setVisible(!locked);
    } catch {
      /* ignore */
    }
  }
  if (contentView && !contentView.webContents.isDestroyed()) {
    try {
      contentView.setBounds({
        x: 0,
        y: chromeH,
        width: w,
        height: Math.max(1, h - chromeH),
      });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {boolean} next
 */
function applyLock(next) {
  locked = !!next;
  selftestFlags.locked = locked;
  if (!miniWin || miniWin.isDestroyed()) return;
  try {
    if (locked) {
      miniWin.setIgnoreMouseEvents(true);
      miniWin.setFocusable(false);
      selftestFlags.ignoreMouseEvents = true;
      selftestFlags.focusable = false;
    } else {
      miniWin.setIgnoreMouseEvents(false);
      miniWin.setFocusable(true);
      selftestFlags.ignoreMouseEvents = false;
      selftestFlags.focusable = true;
    }
  } catch {
    /* ignore */
  }
  layoutChildren();
  sendChrome('mini-player:lock-hint', { locked });
  sendChrome('mini-player:state', { locked, opacityPercent });
}

function toggleLock() {
  applyLock(!locked);
}

/**
 * @param {string} channel
 * @param {object} payload
 */
function sendChrome(channel, payload) {
  if (!chromeView || chromeView.webContents.isDestroyed()) return;
  try {
    chromeView.webContents.send(channel, payload);
  } catch {
    /* ignore */
  }
}

/**
 * @param {number} pct
 */
function setOpacityPercent(pct) {
  opacityPercent = clampOpacity(pct);
  if (miniWin && !miniWin.isDestroyed()) {
    try {
      miniWin.setOpacity(opacityPercent / 100);
    } catch {
      /* ignore */
    }
  }
  sendChrome('mini-player:state', { opacityPercent, locked });
  try {
    updateState((s) => {
      if (!s.miniPlayer || typeof s.miniPlayer !== 'object') s.miniPlayer = {};
      s.miniPlayer.opacityPercent = opacityPercent;
      if (!s.settings || typeof s.settings !== 'object') s.settings = {};
      s.settings.miniPlayerOpacity = opacityPercent;
    });
  } catch {
    /* ignore */
  }
}

function restoreSourceAudio() {
  if (!sourceAccountId) return;
  const wc = wcFor(sourceAccountId);
  if (wc) {
    try {
      wc.setAudioMuted(!!sourceWasAudioMuted);
    } catch {
      /* ignore */
    }
  }
  sourceAccountId = null;
}

function destroyMini() {
  unregisterLockShortcut();
  persistGeometry();
  restoreSourceAudio();
  locked = false;
  selftestFlags = { ignoreMouseEvents: false, focusable: true, locked: false };
  const win = miniWin;
  if (chromeView && chromeView.webContents) {
    try {
      ipcGuard.unregisterUiWebContents(chromeView.webContents);
    } catch {
      /* ignore */
    }
  }
  chromeView = null;
  contentView = null;
  miniWin = null;
  if (win && !win.isDestroyed()) {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
}

function isOpen() {
  return !!(miniWin && !miniWin.isDestroyed());
}

function getSelftestSnapshot() {
  const alwaysOnTop = !!(miniWin && !miniWin.isDestroyed() && miniWin.isAlwaysOnTop());
  let opacity = opacityPercent / 100;
  if (miniWin && !miniWin.isDestroyed()) {
    try {
      opacity = miniWin.getOpacity();
    } catch {
      /* ignore */
    }
  }
  return {
    open: isOpen(),
    alwaysOnTop,
    opacity,
    opacityPercent,
    locked: selftestFlags.locked,
    ignoreMouseEvents: selftestFlags.ignoreMouseEvents,
    focusable: selftestFlags.focusable,
    shortcutRegistered: !!(registeredAccel && globalShortcut.isRegistered(registeredAccel)),
    registeredAccel,
    sourceAccountId,
  };
}

/**
 * @param {string} accountId
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function open(accountId) {
  const id = String(accountId || '');
  if (!id) return { ok: false, reason: 'no-account' };
  const srcWc = wcFor(id);
  if (!srcWc) return { ok: false, reason: 'no-panel' };

  let url = '';
  try {
    url = srcWc.getURL() || '';
  } catch {
    url = '';
  }
  if (!url || url === 'about:blank') return { ok: false, reason: 'no-url' };

  let ses = null;
  try {
    ses = srcWc.session;
  } catch {
    ses = null;
  }

  if (isOpen()) {
    close();
  }

  const persisted = readPersisted();
  opacityPercent = persisted.opacityPercent;
  locked = false;
  selftestFlags = { ignoreMouseEvents: false, focusable: true, locked: false };

  const hide = selftestOn();
  /** @type {import('electron').BrowserWindowConstructorOptions} */
  const opts = {
    width: Math.max(240, persisted.width || 420),
    height: Math.max(160, persisted.height || 280),
    x: typeof persisted.x === 'number' ? persisted.x : undefined,
    y: typeof persisted.y === 'number' ? persisted.y : undefined,
    show: false,
    frame: false,
    transparent: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: '#12151a',
    title: 'Mini player',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  };
  if (hide) {
    opts.x = -20000;
    opts.y = 0;
  }

  try {
    miniWin = new BrowserWindow(opts);
  } catch (err) {
    miniWin = null;
    return {
      ok: false,
      reason: 'create-failed',
      message: String(err && err.message ? err.message : err),
    };
  }

  try {
    miniWin.setAlwaysOnTop(true, 'screen-saver');
  } catch {
    try {
      miniWin.setAlwaysOnTop(true);
    } catch {
      /* ignore */
    }
  }
  try {
    miniWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    try {
      miniWin.setVisibleOnAllWorkspaces(true);
    } catch {
      /* ignore */
    }
  }
  try {
    miniWin.setOpacity(opacityPercent / 100);
  } catch {
    /* ignore */
  }

  chromeView = new WebContentsView({
    webPreferences: {
      preload: CHROME_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  contentView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      ...(ses ? { session: ses } : {}),
    },
  });

  try {
    ipcGuard.registerUiWebContents(chromeView.webContents);
  } catch {
    /* ignore */
  }

  try {
    miniWin.contentView.addChildView(contentView);
    miniWin.contentView.addChildView(chromeView);
  } catch (err) {
    destroyMini();
    return {
      ok: false,
      reason: 'view-failed',
      message: String(err && err.message ? err.message : err),
    };
  }

  layoutChildren();
  miniWin.on('resize', () => layoutChildren());
  miniWin.on('move', () => {
    /* persisted on close */
  });
  miniWin.on('closed', () => {
    if (chromeView && chromeView.webContents) {
      try {
        ipcGuard.unregisterUiWebContents(chromeView.webContents);
      } catch {
        /* ignore */
      }
    }
    chromeView = null;
    contentView = null;
    miniWin = null;
    unregisterLockShortcut();
    restoreSourceAudio();
    locked = false;
    selftestFlags = { ignoreMouseEvents: false, focusable: true, locked: false };
  });

  try {
    chromeView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contentView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  } catch {
    /* ignore */
  }

  async function loadWithTimeout(wc, target, ms) {
    if (!wc || wc.isDestroyed()) return;
    let settled = false;
    await Promise.race([
      wc.loadURL(target).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      ),
      new Promise((resolve) => {
        setTimeout(() => {
          if (!settled) {
            try {
              wc.stop();
            } catch {
              /* ignore */
            }
          }
          resolve();
        }, ms);
      }),
    ]);
  }

  await loadWithTimeout(chromeView.webContents, pathToFileURL(CHROME_HTML).href, 8000);
  await loadWithTimeout(contentView.webContents, url, 12000);

  // Mute source so audio comes from the mini player only.
  try {
    sourceWasAudioMuted = !!srcWc.isAudioMuted();
    srcWc.setAudioMuted(true);
    sourceAccountId = id;
  } catch {
    sourceAccountId = id;
    sourceWasAudioMuted = false;
  }

  registerLockShortcut();

  try {
    if (typeof miniWin.showInactive === 'function') miniWin.showInactive();
    else miniWin.show();
  } catch {
    try {
      miniWin.show();
    } catch {
      /* ignore */
    }
  }

  sendChrome('mini-player:state', { opacityPercent, locked: false });
  return { ok: true };
}

function close() {
  if (!isOpen()) {
    unregisterLockShortcut();
    restoreSourceAudio();
    return { ok: true };
  }
  destroyMini();
  return { ok: true };
}

function ensureIpc() {
  if (ipcWired) return;
  ipcWired = true;

  ipcMain.handle('mini-player:set-opacity', (event, pct) => {
    if (!chromeView || event.sender !== chromeView.webContents) return { ok: false };
    setOpacityPercent(pct);
    return { ok: true, opacityPercent };
  });
  ipcMain.handle('mini-player:close', (event) => {
    if (!chromeView || event.sender !== chromeView.webContents) return { ok: false };
    return close();
  });
  ipcMain.handle('mini-player:info', (event) => {
    if (!chromeView || event.sender !== chromeView.webContents) return null;
    return { opacityPercent, locked, open: isOpen() };
  });
}

module.exports = {
  configure,
  open,
  close,
  isOpen,
  toggleLock,
  applyLock,
  setOpacityPercent,
  getSelftestSnapshot,
  resolveLockCombo,
  DEFAULT_LOCK_COMBO,
  ensureIpc,
};
