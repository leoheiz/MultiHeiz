'use strict';

/**
 * Main-process cursor polling for sidebar auto-hide and (optional) F11 topbar reveal.
 * DOM mouseenter/leave are unreliable on Windows (app-region:drag caption + WebContentsView).
 * screen.getCursorScreenPoint vs getContentBounds is the source of truth.
 */

const { screen } = require('electron');

/** Reveal when cursor is within this many px of the content left edge (over panels too). */
const REVEAL_EDGE_PX = 12;
/** Also treat cursor just outside the left edge (maximized / flush to monitor). */
const OUTSIDE_LEFT_PX = 8;
/** Extra width beyond sidebarWidth while open (shadow / aim room). */
const OPEN_MARGIN_PX = 8;
/** Top-edge reveal zone while F11 topbar hover is enabled (~4–6 px). */
const REVEAL_TOP_PX = 6;
/** Also treat cursor just outside the top edge (fullscreen flush to monitor). */
const OUTSIDE_TOP_PX = 8;
/** Extra height beyond topbar while open (aim room). */
const OPEN_TOP_MARGIN_PX = 8;
/** Poll while looking for reveal. */
const POLL_CLOSED_MS = 70;
/** Poll while sidebar is revealed (keep-open). */
const POLL_OPEN_MS = 50;

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {(payload: object) => void} */
let emitToRenderer = () => {};
/** @type {() => boolean} */
let getChromeHidden = () => false;

let enabled = false;
let open = false;
let sidebarWidth = 240;
let chromeHiddenFlag = false;

/** F11 topbar edge-reveal (independent of sidebar). */
let topbarEnabled = false;
let topbarOpen = false;
let topbarHeight = 48;

/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;
/** @type {boolean | null} */
let lastInside = null;
/** @type {boolean | null} */
let lastTopInside = null;

/**
 * Selftest-only override of screen.getCursorScreenPoint (screen coords).
 * @type {{ x: number, y: number } | null}
 */
let cursorOverride = null;

/**
 * @param {import('electron').BrowserWindow} win
 * @param {(payload: object) => void} emit
 * @param {{ isChromeHidden?: () => boolean }} [opts]
 */
function init(win, emit, opts = {}) {
  mainWindow = win;
  emitToRenderer = typeof emit === 'function' ? emit : () => {};
  if (typeof opts.isChromeHidden === 'function') {
    getChromeHidden = opts.isChromeHidden;
  }
  // Resume polling when the window becomes usable again (no CPU cost while minimized).
  const resume = () => {
    if ((enabled || topbarEnabled) && !timer) tick();
  };
  try {
    win.on('focus', resume);
    win.on('restore', resume);
    win.on('show', resume);
    win.on('minimize', () => {
      stopTimer();
      emitInside(false);
      emitTopInside(false);
    });
    win.on('hide', () => {
      stopTimer();
      emitInside(false);
      emitTopInside(false);
    });
  } catch {
    /* ignore */
  }
}

function stopTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * @returns {{ x: number, y: number }}
 */
function getCursorScreenPoint() {
  if (cursorOverride && typeof cursorOverride.x === 'number' && typeof cursorOverride.y === 'number') {
    return { x: cursorOverride.x, y: cursorOverride.y };
  }
  return screen.getCursorScreenPoint();
}

/**
 * @param {{ x: number, y: number } | null} point
 */
function setCursorOverride(point) {
  if (!process.env.MULTIHEIZ_SELFTEST) {
    cursorOverride = null;
    return false;
  }
  if (
    point &&
    typeof point === 'object' &&
    typeof point.x === 'number' &&
    typeof point.y === 'number' &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  ) {
    cursorOverride = { x: point.x, y: point.y };
  } else {
    cursorOverride = null;
  }
  // Force a fresh classify on next tick / immediate tick
  lastInside = null;
  lastTopInside = null;
  if (enabled || topbarEnabled) tick();
  return true;
}

function getCursorOverride() {
  return cursorOverride ? { ...cursorOverride } : null;
}

/**
 * Screen bounds used for edge classify.
 * Fullscreen: window bounds (covers the display, not workArea).
 * Otherwise: content bounds (DIP, matches getCursorScreenPoint).
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function getPollBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    if (typeof mainWindow.isFullScreen === 'function' && mainWindow.isFullScreen()) {
      return mainWindow.getBounds();
    }
    return mainWindow.getContentBounds();
  } catch {
    return null;
  }
}

/**
 * Window is worth polling: visible, not minimized, and focused or cursor is
 * over / just outside the left edge. Chrome-hidden (F11) still polls so the
 * left-edge overlay can reveal the sidebar.
 */
function shouldPollWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return false;
  // F11 (chrome-hidden) still polls — left-edge / top-edge overlay reveal.
  if (mainWindow.isFocused()) return true;
  try {
    const pt = getCursorScreenPoint();
    const b = mainWindow.getBounds();
    return (
      pt.x >= b.x - OUTSIDE_LEFT_PX &&
      pt.x < b.x + b.width &&
      pt.y >= b.y - OUTSIDE_TOP_PX &&
      pt.y < b.y + b.height
    );
  } catch {
    return false;
  }
}

/**
 * @returns {{ insideHot: boolean, insideOpen: boolean }}
 */
function classifyCursor() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { insideHot: false, insideOpen: false };
  }
  const bounds = getPollBounds();
  if (!bounds) {
    return { insideHot: false, insideOpen: false };
  }
  const pt = getCursorScreenPoint();
  const inY = pt.y >= bounds.y && pt.y < bounds.y + bounds.height;
  if (!inY) {
    return { insideHot: false, insideOpen: false };
  }

  const left = bounds.x;
  const outsideLeft = pt.x >= left - OUTSIDE_LEFT_PX && pt.x < left;
  const nearLeft = pt.x >= left && pt.x <= left + REVEAL_EDGE_PX;
  const insideHot = outsideLeft || nearLeft;

  const openRight = left + Math.max(0, sidebarWidth) + OPEN_MARGIN_PX;
  const insideOpen = pt.x >= left - OUTSIDE_LEFT_PX && pt.x <= openRight;

  return { insideHot, insideOpen };
}

/**
 * @returns {{ insideHot: boolean, insideOpen: boolean }}
 */
function classifyTopCursor() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { insideHot: false, insideOpen: false };
  }
  const bounds = getPollBounds();
  if (!bounds) {
    return { insideHot: false, insideOpen: false };
  }
  const pt = getCursorScreenPoint();
  const inX = pt.x >= bounds.x && pt.x < bounds.x + bounds.width;
  if (!inX) {
    return { insideHot: false, insideOpen: false };
  }

  const top = bounds.y;
  const outsideTop = pt.y >= top - OUTSIDE_TOP_PX && pt.y < top;
  const nearTop = pt.y >= top && pt.y <= top + REVEAL_TOP_PX;
  const insideHot = outsideTop || nearTop;

  const openBottom = top + Math.max(0, topbarHeight) + OPEN_TOP_MARGIN_PX;
  const insideOpen = pt.y >= top - OUTSIDE_TOP_PX && pt.y <= openBottom;

  return { insideHot, insideOpen };
}

function emitInside(inside) {
  if (lastInside === inside) return;
  lastInside = inside;
  emitToRenderer({ type: 'sidebar:cursor', inside: !!inside });
}

function emitTopInside(inside) {
  if (lastTopInside === inside) return;
  lastTopInside = inside;
  emitToRenderer({ type: 'topbar:cursor', inside: !!inside });
}

function anyTrackingEnabled() {
  return enabled || topbarEnabled;
}

function tick() {
  if (!anyTrackingEnabled()) {
    stopTimer();
    return;
  }
  if (!shouldPollWindow()) {
    // Pause until focus/show/restore; treat as outside so pending reveal cancels.
    if (enabled) emitInside(false);
    if (topbarEnabled) emitTopInside(false);
    stopTimer();
    return;
  }
  if (enabled) {
    const { insideHot, insideOpen } = classifyCursor();
    const inside = open ? insideOpen || insideHot : insideHot;
    emitInside(inside);
  }
  if (topbarEnabled) {
    const top = classifyTopCursor();
    const insideTop = topbarOpen ? top.insideOpen || top.insideHot : top.insideHot;
    emitTopInside(insideTop);
  }
  scheduleNext();
}

function scheduleNext() {
  stopTimer();
  if (!anyTrackingEnabled()) return;
  const ms = open || topbarOpen ? POLL_OPEN_MS : POLL_CLOSED_MS;
  timer = setTimeout(() => {
    timer = null;
    tick();
  }, ms);
}

/**
 * @param {{
 *   enabled?: boolean,
 *   open?: boolean,
 *   sidebarWidth?: number,
 *   chromeHidden?: boolean,
 *   topbarEnabled?: boolean,
 *   topbarOpen?: boolean,
 *   topbarHeight?: number,
 * }} opts
 */
function setTracking(opts = {}) {
  if (typeof opts.enabled === 'boolean') enabled = opts.enabled;
  if (typeof opts.open === 'boolean') open = opts.open;
  if (typeof opts.sidebarWidth === 'number' && Number.isFinite(opts.sidebarWidth)) {
    sidebarWidth = Math.max(0, Math.round(opts.sidebarWidth));
  }
  if (typeof opts.chromeHidden === 'boolean') chromeHiddenFlag = opts.chromeHidden;
  if (typeof opts.topbarEnabled === 'boolean') topbarEnabled = opts.topbarEnabled;
  if (typeof opts.topbarOpen === 'boolean') topbarOpen = opts.topbarOpen;
  if (typeof opts.topbarHeight === 'number' && Number.isFinite(opts.topbarHeight)) {
    topbarHeight = Math.max(0, Math.round(opts.topbarHeight));
  }

  lastInside = null;
  lastTopInside = null;
  if (anyTrackingEnabled()) {
    tick();
  } else {
    stopTimer();
  }
  return {
    enabled,
    open,
    sidebarWidth,
    chromeHidden: chromeHiddenFlag,
    topbarEnabled,
    topbarOpen,
    topbarHeight,
  };
}

function getTracking() {
  return {
    enabled,
    open,
    sidebarWidth,
    chromeHidden: chromeHiddenFlag,
    topbarEnabled,
    topbarOpen,
    topbarHeight,
    polling: !!timer,
    lastInside,
    lastTopInside,
    revealEdgePx: REVEAL_EDGE_PX,
    revealTopPx: REVEAL_TOP_PX,
    outsideLeftPx: OUTSIDE_LEFT_PX,
    outsideTopPx: OUTSIDE_TOP_PX,
    openMarginPx: OPEN_MARGIN_PX,
    openTopMarginPx: OPEN_TOP_MARGIN_PX,
  };
}

/**
 * Content-relative point → screen coords (for selftests).
 * Uses the same bounds as classifyCursor (window bounds in fullscreen).
 * @param {number} contentX
 * @param {number} contentY
 * @returns {{ x: number, y: number } | null}
 */
function contentPointToScreen(contentX, contentY) {
  const b = getPollBounds();
  if (!b) return null;
  return { x: b.x + contentX, y: b.y + contentY };
}

function dispose() {
  stopTimer();
  enabled = false;
  topbarEnabled = false;
  cursorOverride = null;
  lastInside = null;
  lastTopInside = null;
  mainWindow = null;
}

module.exports = {
  init,
  setTracking,
  getTracking,
  setCursorOverride,
  getCursorOverride,
  getCursorScreenPoint,
  contentPointToScreen,
  classifyCursor,
  classifyTopCursor,
  getPollBounds,
  dispose,
  REVEAL_EDGE_PX,
  REVEAL_TOP_PX,
  OUTSIDE_LEFT_PX,
  OUTSIDE_TOP_PX,
  OPEN_MARGIN_PX,
  OPEN_TOP_MARGIN_PX,
  POLL_CLOSED_MS,
  POLL_OPEN_MS,
};
