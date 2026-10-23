'use strict';

/**
 * Central IPC sender-frame validation.
 * - UI channels: only main-window (or app UI) frames loading the local renderer.
 * - Panel channels: only known panel / account-session webContents.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ipcMain } = require('electron');

/** Channels used by panel-preload / cosmetic-preload / early-replay from http(s) pages. */
const PANEL_CHANNELS = new Set([
  '@ghostery/adblocker/early-scriptlets',
  '@ghostery/adblocker/early-timing',
  '@ghostery/adblocker/inject-cosmetic-filters',
  '@ghostery/adblocker/is-mutation-observer-enabled',
  'multiheiz/ext-early',
  'multiheiz/ext-early-done',
  // Indicador mic/câmera (panel-preload → main)
  'panel:media-use',
  // Zoom Ctrl+wheel (panel-preload → main)
  'panel:ctrl-wheel',
  // Volume fino: bootstrap sync (fonte + ganho) do panel-preload
  'panel:volume-sync',
  // Corretor LanguageTool (panel-preload → main)
  'panel:languagetool-sync',
  'panel:languagetool-check',
  'panel:languagetool-matches',
  // IA experimental (panel-preload → main)
  'panel:ai-sync',
  'panel:ai-open',
]);

/** Só frame principal (iframe cross-origin não chama). */
const MAIN_FRAME_ONLY_CHANNELS = new Set([
  'panel:ai-open',
  'panel:media-use',
  'panel:ctrl-wheel',
]);

/** LanguageTool: main frame ou subframe same-origin do top. */
const LT_PANEL_CHANNELS = new Set([
  'panel:languagetool-sync',
  'panel:languagetool-check',
  'panel:languagetool-matches',
]);

const INDEX_HTML = path.resolve(__dirname, '..', 'renderer', 'index.html');
const POPOVER_HTML = path.resolve(__dirname, '..', 'renderer', 'popover-overlay.html');
const MINI_PLAYER_HTML = path.resolve(__dirname, '..', 'renderer', 'mini-player.html');

/** @type {(() => import('electron').BrowserWindow|null) | null} */
let getMainWindow = null;
/** @type {((wc: Electron.WebContents) => boolean) | null} */
let isPanelWebContents = null;
/** @type {Set<import('electron').WebContents>} */
const extraUiWebContents = new Set();

let installed = false;
let rejectCount = 0;

/**
 * Local app UI HTML files (main chrome + popover overlay).
 * @param {string} resolvedPath
 * @returns {boolean}
 */
function isAllowedUiHtmlPath(resolvedPath) {
  const n = path.normalize(resolvedPath).toLowerCase();
  return (
    n === path.normalize(INDEX_HTML).toLowerCase() ||
    n === path.normalize(POPOVER_HTML).toLowerCase() ||
    n === path.normalize(MINI_PLAYER_HTML).toLowerCase()
  );
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAppRendererUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'file:') return false;
  let filePath = decodeURIComponent(u.pathname || '');
  // Windows file URL: /C:/...
  if (process.platform === 'win32' && /^\/[a-zA-Z]:\//.test(filePath)) {
    filePath = filePath.slice(1);
  }
  try {
    const resolved = path.resolve(filePath);
    return isAllowedUiHtmlPath(resolved);
  } catch {
    return false;
  }
}

/**
 * Expected file:// URL for the main UI (for navigation guards).
 * @returns {string}
 */
function getAppRendererFileUrl() {
  return pathToFileURL(INDEX_HTML).href;
}

/**
 * @param {Electron.WebContents | null | undefined} wc
 */
function isUiWebContents(wc) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed() && win.webContents === wc) return true;
  for (const extra of extraUiWebContents) {
    if (extra === wc && !(typeof extra.isDestroyed === 'function' && extra.isDestroyed())) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Electron.IpcMainInvokeEvent | Electron.IpcMainEvent | { sender?: Electron.WebContents, senderFrame?: Electron.WebFrameMain | null }} event
 * @returns {boolean}
 */
function isTrustedUiEvent(event) {
  if (!event || !event.senderFrame) return false;
  const frameUrl = event.senderFrame.url || '';
  if (!isAppRendererUrl(frameUrl)) return false;
  return isUiWebContents(event.sender);
}

/**
 * @param {Electron.IpcMainInvokeEvent | Electron.IpcMainEvent | { sender?: Electron.WebContents }} event
 * @returns {boolean}
 */
function isTrustedPanelEvent(event) {
  if (!event || !event.sender) return false;
  if (typeof isPanelWebContents === 'function') {
    try {
      return !!isPanelWebContents(event.sender);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Frame principal do WebContents (não iframe).
 * @param {object} event
 * @returns {boolean}
 */
function isMainFrameEvent(event) {
  if (!event || !event.senderFrame) return false;
  try {
    const frame = event.senderFrame;
    const sender = event.sender;
    if (sender && sender.mainFrame && frame === sender.mainFrame) return true;
    if (frame.parent == null) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Subframe com a mesma origem do frame principal.
 * @param {object} event
 * @returns {boolean}
 */
function isSameOriginAsMainFrame(event) {
  if (!event || !event.senderFrame) return false;
  try {
    const frame = event.senderFrame;
    let topUrl = '';
    if (event.sender && event.sender.mainFrame) {
      topUrl = event.sender.mainFrame.url || '';
    } else {
      let f = frame;
      while (f && f.parent) f = f.parent;
      topUrl = (f && f.url) || '';
    }
    if (!frame.url || !topUrl) return false;
    const fo = new URL(frame.url).origin;
    const to = new URL(topUrl).origin;
    if (!fo || fo === 'null' || !to || to === 'null') return false;
    return fo === to;
  } catch {
    return false;
  }
}

/**
 * @param {object} event
 * @param {string} channel
 * @returns {boolean}
 */
function isAllowedIpc(event, channel) {
  const ch = String(channel || '');
  if (PANEL_CHANNELS.has(ch)) {
    if (!isTrustedPanelEvent(event)) return false;
    if (MAIN_FRAME_ONLY_CHANNELS.has(ch)) {
      return isMainFrameEvent(event);
    }
    if (LT_PANEL_CHANNELS.has(ch)) {
      return isMainFrameEvent(event) || isSameOriginAsMainFrame(event);
    }
    return true;
  }
  return isTrustedUiEvent(event);
}

function logReject(channel, reason) {
  rejectCount += 1;
  if (rejectCount <= 20 || rejectCount % 50 === 0) {
    console.warn('[ipc-guard] rejected', channel, reason || '');
  }
}

/**
 * @param {{
 *   getMainWindow?: () => import('electron').BrowserWindow|null,
 *   isPanelWebContents?: (wc: Electron.WebContents) => boolean,
 * }} [opts]
 */
function configure(opts = {}) {
  if (typeof opts.getMainWindow === 'function') getMainWindow = opts.getMainWindow;
  if (typeof opts.isPanelWebContents === 'function') isPanelWebContents = opts.isPanelWebContents;
}

/**
 * @param {import('electron').WebContents} wc
 */
function registerUiWebContents(wc) {
  if (wc) extraUiWebContents.add(wc);
}

/**
 * @param {import('electron').WebContents} wc
 */
function unregisterUiWebContents(wc) {
  extraUiWebContents.delete(wc);
}

/**
 * Wrap an invoke-style listener (handle / handleOnce).
 * @param {string} channel
 * @param {Function} listener
 */
function wrapHandleListener(channel, listener) {
  return async (event, ...args) => {
    if (!isAllowedIpc(event, channel)) {
      logReject(channel, 'untrusted-ui-or-panel');
      return undefined;
    }
    return listener(event, ...args);
  };
}

/**
 * Wrap an on-style listener (on / once), including sendSync returnValue.
 * @param {string} channel
 * @param {Function} listener
 */
function wrapOnListener(channel, listener) {
  return (event, ...args) => {
    if (!isAllowedIpc(event, channel)) {
      logReject(channel, 'untrusted-ui-or-panel');
      try {
        // sendSync callers expect a returnValue
        if (event && Object.prototype.hasOwnProperty.call(event, 'returnValue')) {
          event.returnValue = undefined;
        }
      } catch {
        /* ignore */
      }
      return;
    }
    return listener(event, ...args);
  };
}

/**
 * Monkey-patch ipcMain.handle / on / handleOnce / once before handlers are registered.
 */
function install(opts = {}) {
  configure(opts);
  if (installed) return;
  installed = true;

  const origHandle = ipcMain.handle.bind(ipcMain);
  const origOn = ipcMain.on.bind(ipcMain);
  const origHandleOnce =
    typeof ipcMain.handleOnce === 'function' ? ipcMain.handleOnce.bind(ipcMain) : null;
  const origOnce = typeof ipcMain.once === 'function' ? ipcMain.once.bind(ipcMain) : null;

  ipcMain.handle = (channel, listener) => {
    return origHandle(channel, wrapHandleListener(channel, listener));
  };

  ipcMain.on = (channel, listener) => {
    return origOn(channel, wrapOnListener(channel, listener));
  };

  if (origHandleOnce) {
    ipcMain.handleOnce = (channel, listener) => {
      return origHandleOnce(channel, wrapHandleListener(channel, listener));
    };
  }

  if (origOnce) {
    ipcMain.once = (channel, listener) => {
      return origOnce(channel, wrapOnListener(channel, listener));
    };
  }
}

/**
 * Wrap a single handle listener (alternative to monkeypatch).
 */
function guardHandle(channel, listener) {
  return ipcMain.handle(channel, async (event, ...args) => {
    if (!isAllowedIpc(event, channel)) {
      logReject(channel, 'untrusted');
      return undefined;
    }
    return listener(event, ...args);
  });
}

/**
 * Wrap a single on listener.
 */
function guardOn(channel, listener) {
  return ipcMain.on(channel, (event, ...args) => {
    if (!isAllowedIpc(event, channel)) {
      logReject(channel, 'untrusted');
      try {
        if (event && Object.prototype.hasOwnProperty.call(event, 'returnValue')) {
          event.returnValue = undefined;
        }
      } catch {
        /* ignore */
      }
      return;
    }
    return listener(event, ...args);
  });
}

function getRejectCount() {
  return rejectCount;
}

function resetRejectCountForTest() {
  rejectCount = 0;
}

module.exports = {
  PANEL_CHANNELS,
  MAIN_FRAME_ONLY_CHANNELS,
  LT_PANEL_CHANNELS,
  INDEX_HTML,
  POPOVER_HTML,
  isAppRendererUrl,
  getAppRendererFileUrl,
  isTrustedUiEvent,
  isTrustedPanelEvent,
  isMainFrameEvent,
  isSameOriginAsMainFrame,
  isAllowedIpc,
  isUiWebContents,
  configure,
  install,
  guardHandle,
  guardOn,
  registerUiWebContents,
  unregisterUiWebContents,
  getRejectCount,
  resetRejectCountForTest,
};
