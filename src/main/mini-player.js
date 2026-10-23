'use strict';

/**
 * Experimental always-on-top mini player.
 * Frameless BrowserWindow + chrome WebContentsView + content WebContentsView
 * (same session/partition as the source panel). Source panel audio muted while open.
 * Content view isolates the chosen <video> (PiP-like) via injected CSS/JS.
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

/** Injected into content view: hide page chrome, fill viewport with the video. */
const ISOLATE_VIDEO_JS = `(() => {
  const STYLE_ID = 'mh-mini-isolate-style';
  const ATTR = 'data-mh-mini-video';
  if (window.__mhMiniIsolateInstalled) {
    try { window.__mhMiniIsolate.apply(); } catch (e) {}
    return !!window.__mhMiniIsolate.lastOk;
  }
  window.__mhMiniIsolateInstalled = true;

  function pickVideo() {
    const list = Array.from(document.querySelectorAll('video'));
    if (!list.length) return null;
    const playing = list.find((v) => !v.paused && v.readyState >= 2);
    if (playing) return playing;
    let best = list[0];
    let bestArea = 0;
    for (const v of list) {
      const r = v.getBoundingClientRect();
      const a = Math.max(0, r.width) * Math.max(0, r.height);
      if (a > bestArea) { best = v; bestArea = a; }
    }
    return best;
  }

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = [
      'html, body { background:#000 !important; margin:0 !important; overflow:hidden !important; height:100% !important; width:100% !important; }',
      'body * { visibility:hidden !important; pointer-events:none !important; }',
      'video[' + ATTR + '], video[' + ATTR + '] * { visibility:visible !important; pointer-events:auto !important; }',
      'video[' + ATTR + '] {',
      '  position:fixed !important; inset:0 !important; width:100% !important; height:100% !important;',
      '  max-width:none !important; max-height:none !important; object-fit:contain !important;',
      '  z-index:2147483647 !important; background:#000 !important; margin:0 !important;',
      '  transform:none !important; left:0 !important; top:0 !important;',
      '}',
    ].join('\\n');
  }

  function apply() {
    ensureStyle();
    const v = pickVideo();
    document.querySelectorAll('video[' + ATTR + ']').forEach((el) => {
      if (el !== v) el.removeAttribute(ATTR);
    });
    if (!v) {
      window.__mhMiniIsolate.lastOk = false;
      return false;
    }
    v.setAttribute(ATTR, '1');
    try { v.setAttribute('playsinline', ''); } catch (e) {}
    window.__mhMiniIsolate.lastOk = true;
    window.__mhMiniIsolate.video = v;
    return true;
  }

  function hitAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { tag: null, isVideo: false };
    const v = el.closest ? el.closest('video') : (el.tagName === 'VIDEO' ? el : null);
    return {
      tag: el.tagName || null,
      isVideo: !!(v && v.getAttribute && v.getAttribute(ATTR) === '1') ||
        (el.tagName === 'VIDEO' && el.getAttribute(ATTR) === '1'),
    };
  }

  function mediaState() {
    const v = window.__mhMiniIsolate.video || pickVideo();
    if (!v) return null;
    return {
      paused: !!v.paused,
      currentTime: Number(v.currentTime) || 0,
      duration: Number(v.duration) || 0,
      volume: Number(v.volume) || 0,
      muted: !!v.muted,
    };
  }

  function mediaCmd(cmd, value) {
    const v = window.__mhMiniIsolate.video || pickVideo();
    if (!v) return { ok: false };
    if (cmd === 'toggle') {
      if (v.paused) v.play().catch(function () {});
      else v.pause();
    } else if (cmd === 'play') v.play().catch(function () {});
    else if (cmd === 'pause') v.pause();
    else if (cmd === 'seek') {
      const t = Number(value);
      if (Number.isFinite(t)) v.currentTime = Math.max(0, t);
    } else if (cmd === 'volume') {
      const vol = Number(value);
      if (Number.isFinite(vol)) {
        v.volume = Math.max(0, Math.min(1, vol));
        v.muted = v.volume === 0;
      }
    }
    return { ok: true, state: mediaState() };
  }

  window.__mhMiniIsolate = { apply, pickVideo, hitAt, mediaState, mediaCmd, lastOk: false };

  const _push = history.pushState;
  history.pushState = function () {
    const r = _push.apply(this, arguments);
    setTimeout(apply, 50);
    setTimeout(apply, 300);
    return r;
  };
  const _replace = history.replaceState;
  history.replaceState = function () {
    const r = _replace.apply(this, arguments);
    setTimeout(apply, 50);
    setTimeout(apply, 300);
    return r;
  };
  window.addEventListener('popstate', function () {
    setTimeout(apply, 50);
    setTimeout(apply, 300);
  });
  window.addEventListener('yt-navigate-finish', function () {
    setTimeout(apply, 50);
    setTimeout(apply, 300);
  });
  try {
    const mo = new MutationObserver(function () {
      if (!document.querySelector('video[' + ATTR + ']')) apply();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  apply();
  setTimeout(apply, 200);
  setTimeout(apply, 800);
  return !!window.__mhMiniIsolate.lastOk;
})()`;

/** @type {object | null} */
let panelsApi = null;
/** @type {(() => import('electron').BrowserWindow | null) | null} */
let getMainWindow = null;
/** @type {((payload: object) => void) | null} */
let emitToRenderer = null;

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
/** @type {boolean} */
let isolationApplied = false;

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
 *   emitToRenderer?: (payload: object) => void,
 * }} deps
 */
function configure(deps) {
  panelsApi = deps.panels || null;
  getMainWindow = deps.getMainWindow || null;
  emitToRenderer = typeof deps.emitToRenderer === 'function' ? deps.emitToRenderer : null;
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

function notifyLockState() {
  const payload = {
    type: 'mini-player:lock-changed',
    locked: !!locked,
    open: isOpen(),
  };
  if (emitToRenderer) {
    try {
      emitToRenderer(payload);
    } catch {
      /* ignore */
    }
  }
  if (getMainWindow) {
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('event', payload);
      }
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
  if (!miniWin || miniWin.isDestroyed()) {
    notifyLockState();
    return;
  }
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
  notifyLockState();
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

async function applyVideoIsolation() {
  isolationApplied = false;
  if (!contentView || contentView.webContents.isDestroyed()) return false;
  try {
    const ok = await contentView.webContents.executeJavaScript(ISOLATE_VIDEO_JS, true);
    isolationApplied = !!ok;
    return isolationApplied;
  } catch {
    isolationApplied = false;
    return false;
  }
}

/**
 * @param {string} js
 * @returns {Promise<any>}
 */
async function contentExec(js) {
  if (!contentView || contentView.webContents.isDestroyed()) return null;
  try {
    return await contentView.webContents.executeJavaScript(js, true);
  } catch {
    return null;
  }
}

function wireContentIsolation(wc) {
  if (!wc || wc.isDestroyed()) return;
  const run = () => {
    applyVideoIsolation().catch(() => {});
  };
  try {
    wc.on('did-finish-load', run);
    wc.on('did-navigate-in-page', run);
    wc.on('dom-ready', run);
  } catch {
    /* ignore */
  }
}

function destroyMini() {
  unregisterLockShortcut();
  persistGeometry();
  restoreSourceAudio();
  locked = false;
  isolationApplied = false;
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
  notifyLockState();
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
    isolationApplied,
  };
}

/**
 * Hit-test isolation at several points (for selftest).
 * @returns {Promise<{ ok: boolean, points?: object[] }>}
 */
async function selftestHitIsolation() {
  if (!contentView || contentView.webContents.isDestroyed()) {
    return { ok: false, reason: 'no-content' };
  }
  const result = await contentExec(`(() => {
    const iso = window.__mhMiniIsolate;
    if (!iso) return { ok: false, reason: 'no-iso' };
    iso.apply();
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    const pts = [
      [w / 2, h / 2],
      [10, 10],
      [w - 10, 10],
      [10, h - 10],
      [w - 10, h - 10],
    ];
    const points = pts.map(([x, y]) => {
      const hit = iso.hitAt(x, y);
      return { x, y, tag: hit.tag, isVideo: hit.isVideo };
    });
    const ok = points.every((p) => p.isVideo);
    return { ok, points, isolationOk: !!iso.lastOk };
  })()`);
  return result || { ok: false, reason: 'exec-failed' };
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
  isolationApplied = false;
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
    isolationApplied = false;
    selftestFlags = { ignoreMouseEvents: false, focusable: true, locked: false };
    notifyLockState();
  });

  try {
    chromeView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contentView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  } catch {
    /* ignore */
  }

  wireContentIsolation(contentView.webContents);

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
  await applyVideoIsolation();

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
  notifyLockState();
  return { ok: true };
}

function close() {
  if (!isOpen()) {
    unregisterLockShortcut();
    restoreSourceAudio();
    notifyLockState();
    return { ok: true };
  }
  destroyMini();
  return { ok: true };
}

async function mediaCommand(cmd, value) {
  const r = await contentExec(
    `window.__mhMiniIsolate && window.__mhMiniIsolate.mediaCmd(${JSON.stringify(cmd)}, ${JSON.stringify(value)})`
  );
  return r || { ok: false };
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
  ipcMain.handle('mini-player:toggle-lock', (event) => {
    if (!chromeView || event.sender !== chromeView.webContents) return { ok: false };
    toggleLock();
    return { ok: true, locked };
  });
  ipcMain.handle('mini-player:media', async (event, payload) => {
    if (!chromeView || event.sender !== chromeView.webContents) return { ok: false };
    const cmd = payload && payload.cmd;
    const value = payload && payload.value;
    return mediaCommand(String(cmd || ''), value);
  });
  ipcMain.handle('mini-player:media-state', async (event) => {
    if (!chromeView || event.sender !== chromeView.webContents) return null;
    return contentExec(
      `window.__mhMiniIsolate && window.__mhMiniIsolate.mediaState && window.__mhMiniIsolate.mediaState()`
    );
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
  applyVideoIsolation,
  selftestHitIsolation,
  contentExec,
  mediaCommand,
};
