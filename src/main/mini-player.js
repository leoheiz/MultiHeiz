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

/**
 * Injected into content view: hide page chrome, fill viewport with the video.
 * Root cause of Twitch/YouTube letterboxing: ancestors with transform/filter/contain
 * create a containing block for position:fixed, and wrappers keep fixed pixel sizes.
 * Fix: reparent the <video> into a full-viewport host under documentElement (escapes
 * transformed ancestors), force 100vw/100vh + object-fit:contain with !important, and
 * fight inline width/height set by player JS via a style MutationObserver.
 */
const ISOLATE_VIDEO_JS = `(() => {
  const STYLE_ID = 'mh-mini-isolate-style';
  const HOST_ID = 'mh-mini-host';
  const ATTR = 'data-mh-mini-video';
  const CTX_ATTR = 'data-mh-ctx-video';
  if (window.__mhMiniIsolateInstalled) {
    try { window.__mhMiniIsolate.apply(); } catch (e) {}
    return !!window.__mhMiniIsolate.lastOk;
  }
  window.__mhMiniIsolateInstalled = true;

  function pickVideo() {
    try {
      var marked = document.querySelector('video[' + CTX_ATTR + ']');
      if (marked) return marked;
    } catch (e) {}
    var host = document.getElementById(HOST_ID);
    if (host) {
      var hv = host.querySelector('video');
      if (hv) return hv;
    }
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
      '#' + HOST_ID + ', #' + HOST_ID + ' * { visibility:visible !important; pointer-events:auto !important; }',
      'video[' + ATTR + '], video[' + ATTR + '] * { visibility:visible !important; pointer-events:auto !important; }',
      '#' + HOST_ID + ' {',
      '  position:fixed !important; inset:0 !important; left:0 !important; top:0 !important;',
      '  width:100vw !important; height:100vh !important; max-width:none !important; max-height:none !important;',
      '  min-width:0 !important; min-height:0 !important; margin:0 !important; padding:0 !important;',
      '  overflow:hidden !important; transform:none !important; contain:none !important;',
      '  z-index:2147483646 !important; background:#000 !important;',
      '}',
      'video[' + ATTR + '] {',
      '  position:fixed !important; inset:0 !important; left:0 !important; top:0 !important;',
      '  width:100vw !important; height:100vh !important;',
      '  max-width:none !important; max-height:none !important;',
      '  min-width:0 !important; min-height:0 !important;',
      '  object-fit:contain !important; object-position:center !important;',
      '  z-index:2147483647 !important; background:#000 !important; margin:0 !important; padding:0 !important;',
      '  transform:none !important; border:0 !important;',
      '}',
    ].join('\\n');
  }

  function ensureHost() {
    var host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      (document.documentElement || document.body).appendChild(host);
    } else if (host.parentNode !== document.documentElement && document.documentElement) {
      document.documentElement.appendChild(host);
    }
    return host;
  }

  function lockVideoInline(v) {
    if (!v) return;
    var applying = false;
    function force() {
      if (applying) return;
      applying = true;
      try {
        v.removeAttribute('width');
        v.removeAttribute('height');
        v.style.setProperty('position', 'fixed', 'important');
        v.style.setProperty('inset', '0', 'important');
        v.style.setProperty('left', '0', 'important');
        v.style.setProperty('top', '0', 'important');
        v.style.setProperty('width', '100vw', 'important');
        v.style.setProperty('height', '100vh', 'important');
        v.style.setProperty('max-width', 'none', 'important');
        v.style.setProperty('max-height', 'none', 'important');
        v.style.setProperty('min-width', '0', 'important');
        v.style.setProperty('min-height', '0', 'important');
        v.style.setProperty('object-fit', 'contain', 'important');
        v.style.setProperty('transform', 'none', 'important');
        v.style.setProperty('margin', '0', 'important');
        v.style.setProperty('z-index', '2147483647', 'important');
      } catch (e) {}
      applying = false;
    }
    force();
    if (!v.__mhStyleMo) {
      try {
        v.__mhStyleMo = new MutationObserver(function () { force(); });
        v.__mhStyleMo.observe(v, { attributes: true, attributeFilter: ['style', 'width', 'height'] });
      } catch (e2) {}
    }
  }

  function refreshLayout() {
    ensureStyle();
    var host = document.getElementById(HOST_ID);
    var v = window.__mhMiniIsolate.video || (host && host.querySelector('video')) || pickVideo();
    if (!v) return false;
    if (host) {
      try {
        host.style.setProperty('width', '100vw', 'important');
        host.style.setProperty('height', '100vh', 'important');
        host.style.setProperty('transform', 'none', 'important');
      } catch (e) {}
    }
    lockVideoInline(v);
    return true;
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
    var host = ensureHost();
    try {
      if (v.parentNode !== host) host.appendChild(v);
    } catch (e) {}
    v.setAttribute(ATTR, '1');
    try { v.setAttribute('playsinline', ''); } catch (e2) {}
    lockVideoInline(v);
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

  window.__mhMiniIsolate = { apply, refreshLayout, pickVideo, hitAt, mediaState, mediaCmd, lastOk: false };

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
  window.addEventListener('resize', function () {
    try { refreshLayout(); } catch (e) {}
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
/** @type {{ muted: boolean, wasPlaying: boolean, currentTime: number, isLive: boolean } | null} */
let sourceVideoSnapshot = null;
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
/** @type {boolean} */
let closing = false;
/** @type {object|null} last syncMiniPlayback result (selftest) */
let lastSyncResult = null;

/** Read source video state without mutating it. */
const SOURCE_READ_JS = `(() => {
  const list = Array.from(document.querySelectorAll('video'));
  if (!list.length) return { ok: false };
  const playing = list.find((v) => !v.paused && v.readyState >= 2);
  const v = playing || list[0];
  const dur = Number(v.duration);
  const isLive = !(Number.isFinite(dur)) || dur === Infinity;
  const state = {
    ok: true,
    currentTime: Number(v.currentTime) || 0,
    paused: !!v.paused,
    muted: !!v.muted,
    wasPlaying: !v.paused,
    duration: Number.isFinite(dur) ? dur : Infinity,
    isLive: !!isLive,
  };
  window.__mhMiniSourceVideo = v;
  window.__mhMiniSourceState = state;
  return state;
})()`;

const SOURCE_PAUSE_JS = `(() => {
  const v = window.__mhMiniSourceVideo || (function () {
    const list = Array.from(document.querySelectorAll('video'));
    if (!list.length) return null;
    const playing = list.find((x) => !x.paused && x.readyState >= 2);
    return playing || list[0];
  })();
  if (!v) return { ok: false };
  try { v.pause(); } catch (e) {}
  try { v.muted = true; } catch (e) {}
  window.__mhMiniSourceVideo = v;
  return { ok: true };
})()`;

/**
 * After isolation: wait for video metadata, seek (unless live), apply muted, play or stay paused.
 * @param {{ currentTime: number, wasPlaying: boolean, muted: boolean, isLive: boolean }} snap
 */
function buildSyncMiniPlaybackJs(snap) {
  const t = Number(snap && snap.currentTime);
  const timeLit = Number.isFinite(t) && t >= 0 ? String(t) : '0';
  const playLit = snap && snap.wasPlaying ? 'true' : 'false';
  const mutedLit = snap && snap.muted ? 'true' : 'false';
  const liveLit = snap && snap.isLive ? 'true' : 'false';
  return `(() => new Promise((resolve) => {
  const deadline = Date.now() + 6000;
  let settled = false;
  function pick() {
    try {
      if (window.__mhMiniIsolate && window.__mhMiniIsolate.pickVideo) {
        return window.__mhMiniIsolate.pickVideo();
      }
    } catch (e) {}
    return document.querySelector('video[data-mh-mini-video]') || document.querySelector('video');
  }
  function finish(v, sought) {
    if (settled) return;
    settled = true;
    const st = v ? {
      ok: true,
      paused: !!v.paused,
      currentTime: Number(v.currentTime) || 0,
      muted: !!v.muted,
      sought: !!sought,
      duration: Number(v.duration) || 0,
    } : { ok: false };
    resolve(st);
  }
  setTimeout(function () { finish(pick(), false); }, 6000);
  function apply(v) {
    if (!v) return finish(null, false);
    const isLive = ${liveLit} || !(Number.isFinite(Number(v.duration))) || Number(v.duration) === Infinity;
    let sought = false;
    try { v.muted = ${mutedLit}; } catch (e) {}
    function afterMeta() {
      if (settled) return;
      if (!isLive) {
        const t = ${timeLit};
        try {
          if (Number.isFinite(t) && t >= 0) {
            v.currentTime = t;
            sought = true;
          }
        } catch (e) {}
      }
      function afterSeekOrReady() {
        if (settled) return;
        if (${playLit}) {
          const p = v.play();
          if (p && typeof p.then === 'function') {
            p.then(function () { finish(v, sought); }).catch(function () { finish(v, sought); });
            return;
          }
        } else {
          try { v.pause(); } catch (e) {}
        }
        finish(v, sought);
      }
      if (!isLive && sought) {
        let done = false;
        const once = function () {
          if (done) return;
          done = true;
          v.removeEventListener('seeked', once);
          afterSeekOrReady();
        };
        v.addEventListener('seeked', once);
        setTimeout(once, 400);
      } else {
        afterSeekOrReady();
      }
    }
    if (v.readyState >= 1) afterMeta();
    else {
      const onMeta = function () {
        v.removeEventListener('loadedmetadata', onMeta);
        v.removeEventListener('canplay', onMeta);
        afterMeta();
      };
      v.addEventListener('loadedmetadata', onMeta);
      v.addEventListener('canplay', onMeta);
      setTimeout(function () { afterMeta(); }, 800);
    }
  }
  function tick() {
    if (settled) return;
    const v = pick();
    if (v) {
      apply(v);
      return;
    }
    if (Date.now() > deadline) return finish(null, false);
    setTimeout(tick, 50);
  }
  tick();
}))()`;
}

const STOP_MEDIA_JS = `(() => {
  document.querySelectorAll('video, audio').forEach((el) => {
    try { el.pause(); } catch (e) {}
    try {
      el.removeAttribute('src');
      el.src = '';
      el.srcObject = null;
    } catch (e) {}
    try { el.load(); } catch (e) {}
  });
  return true;
})()`;

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

/**
 * Read source <video> state (time/paused/muted/live) without pausing yet.
 * @param {string} accountId
 * @returns {Promise<{ muted: boolean, wasPlaying: boolean, currentTime: number, isLive: boolean }>}
 */
async function readSourceMedia(accountId) {
  const empty = { muted: false, wasPlaying: false, currentTime: 0, isLive: false };
  const wc = wcFor(accountId);
  if (!wc) return empty;
  try {
    const snap = await wc.executeJavaScript(SOURCE_READ_JS, true);
    if (snap && snap.ok) {
      return {
        muted: !!snap.muted,
        wasPlaying: !!snap.wasPlaying,
        currentTime: Number(snap.currentTime) || 0,
        isLive: !!snap.isLive,
      };
    }
  } catch {
    /* ignore */
  }
  return empty;
}

/**
 * Pause + mute the source panel's <video> so only the mini player plays.
 * @param {string} accountId
 * @returns {Promise<void>}
 */
async function pauseSourceMedia(accountId) {
  const wc = wcFor(accountId);
  if (!wc) return;
  try {
    await wc.executeJavaScript(SOURCE_PAUSE_JS, true);
  } catch {
    /* ignore */
  }
}

/**
 * Append &t=<seconds>s for YouTube-like watch URLs (fallback when in-page seek fails).
 * @param {string} url
 * @param {number} seconds
 * @returns {string}
 */
function withStartTimeParam(url, seconds) {
  const t = Math.floor(Number(seconds) || 0);
  if (!Number.isFinite(t) || t <= 0) return url;
  try {
    const u = new URL(String(url || ''));
    const host = (u.hostname || '').replace(/^www\./i, '').toLowerCase();
    const ytLike =
      host === 'youtube.com' ||
      host === 'youtu.be' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host.endsWith('.youtube.com');
    if (!ytLike) return url;
    if (u.searchParams.has('t') || u.searchParams.has('start')) return url;
    if (/[?&]t=/.test(u.hash || '')) return url;
    u.searchParams.set('t', `${t}s`);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Wait until the mini content has a <video> (and finite duration for VOD).
 * @param {{ needDuration?: boolean, ms?: number }} opts
 */
async function waitForMiniVideoReady(opts = {}) {
  const needDuration = !!opts.needDuration;
  const ms = typeof opts.ms === 'number' ? opts.ms : 8000;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!contentView || contentView.webContents.isDestroyed()) return null;
    try {
      const st = await contentView.webContents.executeJavaScript(
        `(() => {
  const v = (window.__mhMiniIsolate && window.__mhMiniIsolate.pickVideo && window.__mhMiniIsolate.pickVideo())
    || document.querySelector('video');
  if (!v) return null;
  const dur = Number(v.duration);
  return {
    readyState: v.readyState,
    duration: Number.isFinite(dur) ? dur : 0,
    paused: !!v.paused,
  };
})()`,
        true
      );
      if (st && st.readyState >= 1) {
        if (!needDuration || st.duration > 0.2) return st;
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 120));
    try {
      await applyVideoIsolation();
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Seek/play/mute the mini content video to match the source snapshot.
 * @param {{ muted: boolean, wasPlaying: boolean, currentTime: number, isLive: boolean }} snap
 */
async function syncMiniPlayback(snap) {
  lastSyncResult = null;
  if (!contentView || contentView.webContents.isDestroyed()) return null;
  try {
    lastSyncResult = await contentView.webContents.executeJavaScript(
      buildSyncMiniPlaybackJs(snap),
      true
    );
    return lastSyncResult;
  } catch {
    lastSyncResult = null;
    return null;
  }
}

/**
 * Resume source video at the mini player's last time (if any).
 * @param {number|null} resumeTime
 * @param {boolean} miniWasPlaying
 * @returns {Promise<void>}
 */
async function resumeSourceMedia(resumeTime, miniWasPlaying) {
  const id = sourceAccountId;
  const snap = sourceVideoSnapshot;
  sourceVideoSnapshot = null;
  if (!id) return;
  const wc = wcFor(id);
  const restoreMuted = snap ? !!snap.muted : false;
  const shouldPlay = miniWasPlaying || (snap && snap.wasPlaying);
  if (wc) {
    try {
      const t = Number(resumeTime);
      const timeLit = Number.isFinite(t) ? String(t) : 'NaN';
      await wc.executeJavaScript(
        `(() => {
  const v = window.__mhMiniSourceVideo || document.querySelector('video');
  if (!v) return { ok: false };
  const t = ${timeLit};
  if (Number.isFinite(t) && t >= 0) {
    try { v.currentTime = t; } catch (e) {}
  }
  try { v.muted = ${restoreMuted ? 'true' : 'false'}; } catch (e) {}
  if (${shouldPlay ? 'true' : 'false'}) {
    v.play().catch(function () {});
  }
  return { ok: true, currentTime: Number(v.currentTime) || 0, paused: !!v.paused };
})()`,
        true
      );
    } catch {
      /* ignore */
    }
    try {
      wc.setAudioMuted(!!sourceWasAudioMuted);
    } catch {
      /* ignore */
    }
  }
  sourceAccountId = null;
  sourceWasAudioMuted = false;
}

function restoreSourceAudioOnly() {
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
  sourceWasAudioMuted = false;
  sourceVideoSnapshot = null;
}

/**
 * Stop all media in the mini content view and tear down its webContents.
 * @returns {Promise<{ currentTime: number|null, wasPlaying: boolean }>}
 */
async function stopAndTearDownContent() {
  let currentTime = null;
  let wasPlaying = false;
  const cv = contentView;
  contentView = null;
  if (!cv || !cv.webContents || cv.webContents.isDestroyed()) {
    return { currentTime, wasPlaying };
  }
  const wc = cv.webContents;
  try {
    const st = await wc.executeJavaScript(
      `window.__mhMiniIsolate && window.__mhMiniIsolate.mediaState && window.__mhMiniIsolate.mediaState()`,
      true
    );
    if (st && typeof st === 'object') {
      currentTime = Number(st.currentTime);
      if (!Number.isFinite(currentTime)) currentTime = null;
      wasPlaying = !st.paused;
    }
  } catch {
    /* ignore */
  }
  try {
    await wc.executeJavaScript(STOP_MEDIA_JS, true);
  } catch {
    /* ignore */
  }
  try {
    wc.setAudioMuted(true);
  } catch {
    /* ignore */
  }
  try {
    await wc.loadURL('about:blank');
  } catch {
    /* ignore */
  }
  try {
    if (typeof wc.close === 'function') wc.close();
    else if (typeof wc.destroy === 'function') wc.destroy();
  } catch {
    /* ignore */
  }
  return { currentTime, wasPlaying };
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

/**
 * Fully tear down mini player (media stopped, shortcut gone, source resumed).
 * @returns {Promise<void>}
 */
async function destroyMini() {
  if (closing) return;
  closing = true;
  unregisterLockShortcut();
  persistGeometry();
  let resumeTime = null;
  let miniWasPlaying = false;
  try {
    const media = await stopAndTearDownContent();
    resumeTime = media.currentTime;
    miniWasPlaying = media.wasPlaying;
  } catch {
    /* ignore */
  }
  try {
    await resumeSourceMedia(resumeTime, miniWasPlaying);
  } catch {
    restoreSourceAudioOnly();
  }
  locked = false;
  isolationApplied = false;
  selftestFlags = { ignoreMouseEvents: false, focusable: true, locked: false };
  const win = miniWin;
  const chrome = chromeView;
  chromeView = null;
  contentView = null;
  miniWin = null;
  if (chrome && chrome.webContents) {
    try {
      ipcGuard.unregisterUiWebContents(chrome.webContents);
    } catch {
      /* ignore */
    }
    try {
      if (!chrome.webContents.isDestroyed()) {
        if (typeof chrome.webContents.close === 'function') chrome.webContents.close();
        else if (typeof chrome.webContents.destroy === 'function') chrome.webContents.destroy();
      }
    } catch {
      /* ignore */
    }
  }
  notifyLockState();
  if (win && !win.isDestroyed()) {
    try {
      win.removeAllListeners('closed');
    } catch {
      /* ignore */
    }
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
  closing = false;
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
    sourceSnap: sourceVideoSnapshot
      ? {
          currentTime: sourceVideoSnapshot.currentTime,
          wasPlaying: sourceVideoSnapshot.wasPlaying,
          muted: sourceVideoSnapshot.muted,
          isLive: sourceVideoSnapshot.isLive,
        }
      : null,
    lastSync: lastSyncResult,
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
    await close();
  }

  // Capture time/paused/muted BEFORE pausing the source (FIX-12).
  const mediaSnap = await readSourceMedia(id);
  sourceVideoSnapshot = mediaSnap;
  let loadUrl = url;
  if (!mediaSnap.isLive && mediaSnap.currentTime > 0) {
    loadUrl = withStartTimeParam(url, mediaSnap.currentTime);
  }

  const persisted = readPersisted();
  opacityPercent = persisted.opacityPercent;
  locked = false;
  isolationApplied = false;
  closing = false;
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
      // Allow resume play() without a fresh user gesture (mini opened from toolbar).
      autoplayPolicy: 'no-user-gesture-required',
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
    await destroyMini();
    return {
      ok: false,
      reason: 'view-failed',
      message: String(err && err.message ? err.message : err),
    };
  }

  layoutChildren();
  // Bounds + cheap style re-assert (no full re-inject). Players that set inline
  // width/height on resize lose to !important + MutationObserver inside isolation.
  miniWin.on('resize', () => {
    layoutChildren();
    contentExec(
      `(() => { try { return !!(window.__mhMiniIsolate && window.__mhMiniIsolate.refreshLayout && window.__mhMiniIsolate.refreshLayout()); } catch (e) { return false; } })()`
    ).catch(() => {});
  });
  miniWin.on('move', () => {
    /* persisted on close */
  });
  // Intercept X / Alt+F4 so we can stop media + resume source before the window dies.
  miniWin.on('close', (e) => {
    if (closing) return;
    e.preventDefault();
    void close();
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
  await loadWithTimeout(contentView.webContents, loadUrl, 12000);
  await applyVideoIsolation();

  // Pause + mute source media so only the mini player plays (root cause of dual playback).
  try {
    sourceWasAudioMuted = !!srcWc.isAudioMuted();
    srcWc.setAudioMuted(true);
    sourceAccountId = id;
  } catch {
    sourceAccountId = id;
    sourceWasAudioMuted = false;
  }
  await pauseSourceMedia(id);
  // Page scripts (e.g. VOD blob setup) may finish after did-finish-load — wait for <video>.
  await waitForMiniVideoReady({ needDuration: !mediaSnap.isLive, ms: 10000 });
  // Resume at source time (or live): seek after metadata, then play unless source was paused.
  await syncMiniPlayback(mediaSnap);

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

/**
 * Close mini player: stop media, destroy views/window, resume source, unregister shortcut.
 * @returns {Promise<{ ok: boolean }>}
 */
async function close() {
  if (!isOpen()) {
    unregisterLockShortcut();
    restoreSourceAudioOnly();
    notifyLockState();
    return { ok: true };
  }
  await destroyMini();
  return { ok: true };
}

/**
 * Close if the given account is the mini player's source (panel destroyed / removed).
 * @param {string} accountId
 */
function closeIfSource(accountId) {
  if (!accountId || sourceAccountId !== String(accountId)) return;
  void close();
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
  closeIfSource,
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
