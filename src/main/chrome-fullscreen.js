'use strict';

/**
 * F11 "tela cheia" focus mode: OS fullscreen + hide app chrome (topbar/sidebar/statusbar)
 * so WebContentsView panels fill the content area. Esc exits (unless a panel is in
 * HTML5 element fullscreen — then Esc/F11 are left to the page).
 *
 * Policy when a panel is in HTML5 fullscreen: do not intercept F11 or Esc (page keeps
 * the keys; we do not toggle our mode on that keypress).
 *
 * Windows note: an owned child BrowserWindow with alwaysOnTop can scramble the owner's
 * z-order/activation after setFullScreen. The exit hint is a non-topmost owned child
 * (HTML overlay in the main renderer would sit under WebContentsViews). After entering
 * fullscreen we show/focus/moveTop the main window and briefly pin alwaysOnTop, then
 * clear it and restore focus to the previously focused panel.
 */

const { BrowserWindow } = require('electron');

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {(payload: object) => void} */
let emitToRenderer = () => {};
/** @type {() => void} */
let onLayoutChange = () => {};
/** @type {() => string | null} */
let getFocusedPanelId = () => null;
/** @type {(accountId: string | null) => void} */
let focusPanelById = () => {};

let chromeHidden = false;
/** Account ids whose webContents reported HTML5 fullscreen. */
/** @type {Set<string>} */
const htmlFullscreenAccounts = new Set();

/**
 * Our F11 chrome-hidden flag at the moment the first HTML5 element fullscreen
 * started. Used to restore F11 after leave-html-full-screen (Electron often
 * exits OS fullscreen when leaving element fullscreen).
 * @type {boolean | null}
 */
let htmlFsSavedChromeHidden = null;

/** Suppress clearing chrome-hidden while we re-enter OS FS after HTML5 exit. */
let restoreOsFsAfterHtml = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let restoreOsFsTimer = null;
/**
 * Until this timestamp, leave-full-screen while chromeHidden re-asserts OS FS
 * (HTML5 exit churn) instead of clearing F11 mode.
 */
let reassertOsFsUntil = 0;

let toggleLockUntil = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let hintTimer = null;
/** @type {import('electron').BrowserWindow | null} */
let hintWin = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let alwaysOnTopTimer = null;
/** @type {(() => void) | null} */
let pendingEnterFsHandler = null;

/**
 * @param {import('electron').BrowserWindow} win
 * @param {(payload: object) => void} emit
 * @param {() => void} layoutChange
 * @param {{ getFocusedPanelId?: () => string | null, focusPanelById?: (id: string | null) => void }} [opts]
 */
function init(win, emit, layoutChange, opts = {}) {
  mainWindow = win;
  emitToRenderer = typeof emit === 'function' ? emit : () => {};
  onLayoutChange = typeof layoutChange === 'function' ? layoutChange : () => {};
  if (typeof opts.getFocusedPanelId === 'function') {
    getFocusedPanelId = opts.getFocusedPanelId;
  }
  if (typeof opts.focusPanelById === 'function') {
    focusPanelById = opts.focusPanelById;
  }
}

function isChromeHidden() {
  return chromeHidden;
}

function isAnyHtmlFullscreen() {
  return htmlFullscreenAccounts.size > 0;
}

function clearRestoreOsFsTimer() {
  if (restoreOsFsTimer) {
    clearTimeout(restoreOsFsTimer);
    restoreOsFsTimer = null;
  }
  restoreOsFsAfterHtml = false;
}

/**
 * Re-enter OS fullscreen while keeping chrome-hidden (F11) after HTML5 exit.
 */
function reassertOsFullscreenForChrome() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    onLayoutChange();
    return;
  }
  if (!chromeHidden) {
    chromeHidden = true;
    emitToRenderer({
      type: 'chrome:hidden',
      hidden: true,
      showHint: false,
    });
  }
  if (mainWindow.isFullScreen()) {
    onLayoutChange();
    return;
  }
  clearRestoreOsFsTimer();
  restoreOsFsAfterHtml = true;
  clearPendingEnterFs();
  const onEnter = () => {
    pendingEnterFsHandler = null;
    restoreOsFsAfterHtml = false;
    afterEnteredFullScreen(getFocusedPanelId(), false);
    onLayoutChange();
  };
  pendingEnterFsHandler = onEnter;
  mainWindow.once('enter-full-screen', onEnter);
  try {
    mainWindow.setFullScreen(true);
  } catch {
    restoreOsFsAfterHtml = false;
    pendingEnterFsHandler = null;
  }
  restoreOsFsTimer = setTimeout(() => {
    restoreOsFsTimer = null;
    if (
      pendingEnterFsHandler === onEnter &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isFullScreen()
    ) {
      try {
        mainWindow.removeListener('enter-full-screen', onEnter);
      } catch {
        /* ignore */
      }
      pendingEnterFsHandler = null;
      restoreOsFsAfterHtml = false;
      afterEnteredFullScreen(getFocusedPanelId(), false);
      onLayoutChange();
    } else {
      restoreOsFsAfterHtml = false;
      onLayoutChange();
    }
  }, 500);
}

/**
 * After the last HTML5 element fullscreen exits: restore F11 OS fullscreen if
 * we were in chrome-hidden mode, without flashing chrome back on.
 */
function restoreAfterLastHtmlFullscreen() {
  const wantChrome = !!htmlFsSavedChromeHidden;
  htmlFsSavedChromeHidden = null;
  if (!wantChrome) {
    onLayoutChange();
    return;
  }
  // Electron often fires leave-full-screen right after leave-html-full-screen;
  // briefly re-assert OS FS instead of clearing F11.
  reassertOsFsUntil = Date.now() + 1500;
  reassertOsFullscreenForChrome();
}

/**
 * @param {string} accountId
 * @param {boolean} entered
 */
function noteHtmlFullscreen(accountId, entered) {
  if (!accountId) return;
  if (entered) {
    if (htmlFullscreenAccounts.size === 0) {
      htmlFsSavedChromeHidden = chromeHidden;
    }
    htmlFullscreenAccounts.add(accountId);
  } else {
    htmlFullscreenAccounts.delete(accountId);
    if (htmlFullscreenAccounts.size === 0) {
      restoreAfterLastHtmlFullscreen();
    }
  }
}

/**
 * @param {string} accountId
 */
function clearHtmlFullscreen(accountId) {
  if (!accountId) return;
  const had = htmlFullscreenAccounts.has(accountId);
  htmlFullscreenAccounts.delete(accountId);
  if (had && htmlFullscreenAccounts.size === 0) {
    restoreAfterLastHtmlFullscreen();
  }
}

function clearAlwaysOnTopTimer() {
  if (alwaysOnTopTimer) {
    clearTimeout(alwaysOnTopTimer);
    alwaysOnTopTimer = null;
  }
}

function ensureNotAlwaysOnTop() {
  clearAlwaysOnTopTimer();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isAlwaysOnTop()) mainWindow.setAlwaysOnTop(false);
  } catch {
    /* ignore */
  }
}

function clearPendingEnterFs() {
  if (pendingEnterFsHandler && mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.removeListener('enter-full-screen', pendingEnterFsHandler);
    } catch {
      /* ignore */
    }
  }
  pendingEnterFsHandler = null;
}

/**
 * Bring the main window to the foreground after OS fullscreen activation.
 * Temporary alwaysOnTop (~250ms) helps Windows when titleBarStyle is hidden;
 * it is always cleared afterwards.
 * @param {string | null} restoreAccountId
 */
function bringMainWindowForward(restoreAccountId) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (!mainWindow.isVisible()) mainWindow.show();
    try {
      mainWindow.setAlwaysOnTop(true);
    } catch {
      /* ignore */
    }
    try {
      mainWindow.moveTop();
    } catch {
      /* ignore */
    }
    try {
      mainWindow.focus();
    } catch {
      /* ignore */
    }
    try {
      mainWindow.show();
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }

  clearAlwaysOnTopTimer();
  alwaysOnTopTimer = setTimeout(() => {
    alwaysOnTopTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setAlwaysOnTop(false);
    } catch {
      /* ignore */
    }
    if (restoreAccountId) {
      try {
        focusPanelById(restoreAccountId);
      } catch {
        /* ignore */
      }
    }
  }, 250);
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

/**
 * Exit hint as an owned child window (no alwaysOnTop — that broke parent z-order
 * on Windows after setFullScreen). Child ownership keeps it above the parent's
 * WebContentsViews without pinching the main window behind other apps.
 */
function showExitHint() {
  destroyHint();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const parentBounds = mainWindow.getBounds();
    const w = 360;
    const h = 36;
    // Bottom-center: must not cover the left-edge hot zone (≤12px) used for sidebar reveal.
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
      alwaysOnTop: false,
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
 * After fullscreen is active: activate window, then show the exit hint.
 * @param {string | null} restoreAccountId
 * @param {boolean} wantHint
 */
function afterEnteredFullScreen(restoreAccountId, wantHint) {
  bringMainWindowForward(restoreAccountId);
  if (wantHint) showExitHint();
}

/**
 * @param {boolean} hidden
 * @param {{ fromWindowEvent?: boolean, showHint?: boolean }} [opts]
 */
function setChromeHidden(hidden, opts = {}) {
  const next = !!hidden;
  const fromWindowEvent = !!opts.fromWindowEvent;
  // Do not drop F11 chrome while a panel owns HTML5 element fullscreen
  // (except the dedicated leave-full-screen / restore paths).
  if (!next && isAnyHtmlFullscreen() && !opts.force) {
    return;
  }
  const changed = chromeHidden !== next;
  const restoreAccountId = getFocusedPanelId();
  const wantHint = !!(next && opts.showHint);
  chromeHidden = next;

  if (!fromWindowEvent && mainWindow && !mainWindow.isDestroyed()) {
    const fs = mainWindow.isFullScreen();
    if (chromeHidden && !fs) {
      clearPendingEnterFs();
      const onEnter = () => {
        pendingEnterFsHandler = null;
        afterEnteredFullScreen(restoreAccountId, wantHint);
      };
      pendingEnterFsHandler = onEnter;
      mainWindow.once('enter-full-screen', onEnter);
      mainWindow.setFullScreen(true);
      // Fallback if the event already fired or is delayed oddly
      setTimeout(() => {
        if (
          pendingEnterFsHandler === onEnter &&
          mainWindow &&
          !mainWindow.isDestroyed() &&
          mainWindow.isFullScreen()
        ) {
          try {
            mainWindow.removeListener('enter-full-screen', onEnter);
          } catch {
            /* ignore */
          }
          pendingEnterFsHandler = null;
          afterEnteredFullScreen(restoreAccountId, wantHint);
        }
      }, 400);
    } else if (chromeHidden && fs) {
      // Already fullscreen (e.g. re-enter) — still activate + optional hint
      afterEnteredFullScreen(restoreAccountId, wantHint);
    }
    if (!chromeHidden && fs) {
      clearPendingEnterFs();
      ensureNotAlwaysOnTop();
      destroyHint();
      mainWindow.setFullScreen(false);
    }
  }

  if (changed || opts.showHint) {
    emitToRenderer({
      type: 'chrome:hidden',
      hidden: chromeHidden,
      showHint: wantHint,
    });
    onLayoutChange();
  }

  if (!chromeHidden) {
    clearPendingEnterFs();
    ensureNotAlwaysOnTop();
    destroyHint();
  }
}

function enter() {
  setChromeHidden(true, { showHint: true });
}

function exit(opts = {}) {
  setChromeHidden(false, opts);
}

function toggle() {
  // Never flip F11 chrome while a panel is in HTML5 element fullscreen.
  if (isAnyHtmlFullscreen()) return;
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
 * Skip while HTML5 element fullscreen is active (or we are restoring F11 after
 * it): Electron often exits OS fullscreen when leaving element fullscreen.
 */
function onLeaveFullScreen() {
  clearPendingEnterFs();
  ensureNotAlwaysOnTop();
  destroyHint();
  if (isAnyHtmlFullscreen()) {
    return;
  }
  if (restoreOsFsAfterHtml) {
    return;
  }
  if (!chromeHidden) return;
  if (htmlFsSavedChromeHidden || Date.now() < reassertOsFsUntil) {
    reassertOsFullscreenForChrome();
    return;
  }
  setChromeHidden(false, { fromWindowEvent: true });
}

function getDebugState() {
  return {
    chromeHidden,
    htmlFullscreenAccounts: [...htmlFullscreenAccounts],
    htmlFsSavedChromeHidden,
    restoreOsFsAfterHtml,
    reassertOsFsUntil,
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
  bringMainWindowForward,
  ensureNotAlwaysOnTop,
};
