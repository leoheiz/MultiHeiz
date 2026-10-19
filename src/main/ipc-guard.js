'use strict';

/**
 * Central IPC sender-frame validation.
 * - UI channels: only main-window (or app UI) frames loading the local renderer.
 * - Panel channels: only known panel / account-session webContents.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ipcMain } = require('electron');

/** Channels used by panel-preload / cosmetic-preload from http(s) pages. */
const PANEL_CHANNELS = new Set([
  '@ghostery/adblocker/early-scriptlets',
  '@ghostery/adblocker/early-timing',
  '@ghostery/adblocker/inject-cosmetic-filters',
  '@ghostery/adblocker/is-mutation-observer-enabled',
]);

const INDEX_HTML = path.resolve(__dirname, '..', 'renderer', 'index.html');

/** @type {(() => import('electron').BrowserWindow|null) | null} */
let getMainWindow = null;
/** @type {((wc: Electron.WebContents) => boolean) | null} */
let isPanelWebContents = null;
/** @type {Set<import('electron').WebContents>} */
const extraUiWebContents = new Set();

let installed = false;
let rejectCount = 0;

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
    if (resolved.toLowerCase() === INDEX_HTML.toLowerCase()) return true;
    // Allow same file with different slash normalization
    return path.normalize(resolved).toLowerCase() === path.normalize(INDEX_HTML).toLowerCase();
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
 * @param {object} event
 * @param {string} channel
 * @returns {boolean}
 */
function isAllowedIpc(event, channel) {
  const ch = String(channel || '');
  if (PANEL_CHANNELS.has(ch)) {
    return isTrustedPanelEvent(event);
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
 * Monkey-patch ipcMain.handle / ipcMain.on before handlers are registered.
 */
function install(opts = {}) {
  configure(opts);
  if (installed) return;
  installed = true;

  const origHandle = ipcMain.handle.bind(ipcMain);
  const origOn = ipcMain.on.bind(ipcMain);

  ipcMain.handle = (channel, listener) => {
    return origHandle(channel, async (event, ...args) => {
      if (!isAllowedIpc(event, channel)) {
        logReject(channel, 'untrusted-ui-or-panel');
        return undefined;
      }
      return listener(event, ...args);
    });
  };

  ipcMain.on = (channel, listener) => {
    return origOn(channel, (event, ...args) => {
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
    });
  };
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
  INDEX_HTML,
  isAppRendererUrl,
  getAppRendererFileUrl,
  isTrustedUiEvent,
  isTrustedPanelEvent,
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
