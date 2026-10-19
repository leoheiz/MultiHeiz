'use strict';

/**
 * F11 "tela cheia" focus mode: OS fullscreen + hide app chrome (topbar/sidebar/statusbar)
 * so WebContentsView panels fill the content area. Esc exits (unless a panel is in
 * HTML5 element fullscreen — then Esc/F11 are left to the page).
 *
 * Policy when a panel is in HTML5 fullscreen: do not intercept F11 or Esc (page keeps
 * the keys; we do not toggle our mode on that keypress).
 */

const { BrowserWindow } = require('electron');

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {(payload: object) => void} */
let emitToRenderer = () => {};
/** @type {() => void} */
let onLayoutChange = () => {};

let chromeHidden = false;
/** Account ids whose webContents reported HTML5 fullscreen. */
/** @type {Set<string>} */
const htmlFullscreenAccounts = new Set();

let toggleLockUntil = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let hintTimer = null;
/** @type {import('electron').BrowserWindow | null} */
let hintWin = null;

/**
 * @param {import('electron').BrowserWindow} win
 * @param {(payload: object) => void} emit
 * @param {() => void} layoutChange
 */
function init(win, emit, layoutChange) {
  mainWindow = win;
  emitToRenderer = typeof emit === 'function' ? emit : () => {};
  onLayoutChange = typeof layoutChange === 'function' ? layoutChange : () => {};
}

function isChromeHidden() {
  return chromeHidden;
}

function isAnyHtmlFullscreen() {
  return htmlFullscreenAccounts.size > 0;
}

/**
 * @param {string} accountId
 * @param {boolean} entered
 */
function noteHtmlFullscreen(accountId, entered) {
  if (!accountId) return;
  if (entered) htmlFullscreenAccounts.add(accountId);
  else htmlFullscreenAccounts.delete(accountId);
}

/**
 * @param {string} accountId
 */
function clearHtmlFullscreen(accountId) {
  if (accountId) htmlFullscreenAccounts.delete(accountId);
}

function destroyHint() {
  if (hintTimer) {
    clearTimeout(hintTimer);
    hintTimer = null;
  }
  if (hintWin && !hintWin.isDestroyed()) {
    try {
      hintWin.close();
    } catch {
      /* ignore */
    }
  }
  hintWin = null;
}

function showExitHint() {
  destroyHint();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const parentBounds = mainWindow.getBounds();
    const w = 360;
    const h = 36;
    const x = Math.round(parentBounds.x + (parentBounds.width - w) / 2);
    const y = Math.round(parentBounds.y + parentBounds.height - h - 48);
    hintWin = new BrowserWindow({
      parent: mainWindow,
      modal: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      width: w,
      height: h,
      x,
      y,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'html,body{margin:0;height:100%;overflow:hidden;background:transparent;}' +
      '.hint{display:flex;align-items:center;justify-content:center;height:100%;' +
      'padding:0 14px;border-radius:8px;background:rgba(20,24,31,.88);' +
      'color:#e6ebea;font:13px "Segoe UI",sans-serif;letter-spacing:.01em;}' +
      '</style></head><body><div class="hint">Pressione F11 ou Esc para sair</div></body></html>';
    hintWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    hintWin.once('ready-to-show', () => {
      if (hintWin && !hintWin.isDestroyed()) hintWin.showInactive();
    });
    hintTimer = setTimeout(() => destroyHint(), 3000);
  } catch {
    destroyHint();
  }
}

/**
 * @param {boolean} hidden
 * @param {{ fromWindowEvent?: boolean, showHint?: boolean }} [opts]
 */
function setChromeHidden(hidden, opts = {}) {
  const next = !!hidden;
  const fromWindowEvent = !!opts.fromWindowEvent;
  const changed = chromeHidden !== next;
  chromeHidden = next;

  if (!fromWindowEvent && mainWindow && !mainWindow.isDestroyed()) {
    const fs = mainWindow.isFullScreen();
    if (chromeHidden && !fs) mainWindow.setFullScreen(true);
    if (!chromeHidden && fs) mainWindow.setFullScreen(false);
  }

  if (changed || opts.showHint) {
    emitToRenderer({
      type: 'chrome:hidden',
      hidden: chromeHidden,
      showHint: !!(chromeHidden && opts.showHint),
    });
    onLayoutChange();
  }

  if (chromeHidden && opts.showHint) showExitHint();
  if (!chromeHidden) destroyHint();
}

function enter() {
  setChromeHidden(true, { showHint: true });
}

function exit(opts = {}) {
  setChromeHidden(false, opts);
}

function toggle() {
  const now = Date.now();
  if (now < toggleLockUntil) return;
  toggleLockUntil = now + 80;
  if (chromeHidden) exit();
  else enter();
}

/**
 * Handle F11 / Esc for focus mode. Call from before-input-event.
 * Returns true if the event was consumed (preventDefault already called).
 *
 * @param {Electron.Event} event
 * @param {Electron.Input} input
 * @param {string | null} [accountId] panel account id, or null for main UI
 * @returns {boolean}
 */
function handleBeforeInput(event, input, accountId) {
  if (!input || input.type !== 'keyDown') return false;
  if (input.control || input.alt || input.meta || input.shift) return false;

  const key = String(input.key || '');
  const inHtmlFs =
    (accountId && htmlFullscreenAccounts.has(accountId)) || isAnyHtmlFullscreen();

  if (key === 'F11') {
    // HTML5 page fullscreen: leave F11 to the page (do not toggle our mode).
    if (inHtmlFs) return false;
    event.preventDefault();
    toggle();
    return true;
  }

  if (key === 'Escape' && chromeHidden) {
    // Esc must exit HTML5 fullscreen first — do not intercept.
    if (inHtmlFs) return false;
    event.preventDefault();
    exit();
    return true;
  }

  return false;
}

/**
 * OS left fullscreen by other means — clear chrome-hidden cleanly.
 */
function onLeaveFullScreen() {
  if (!chromeHidden) return;
  setChromeHidden(false, { fromWindowEvent: true });
}

function getDebugState() {
  return {
    chromeHidden,
    htmlFullscreenAccounts: [...htmlFullscreenAccounts],
  };
}

module.exports = {
  init,
  isChromeHidden,
  isAnyHtmlFullscreen,
  noteHtmlFullscreen,
  clearHtmlFullscreen,
  setChromeHidden,
  enter,
  exit,
  toggle,
  handleBeforeInput,
  onLeaveFullScreen,
  getDebugState,
  showExitHint,
  destroyHint,
};
