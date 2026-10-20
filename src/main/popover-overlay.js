'use strict';

/**
 * Dedicated transparent WebContentsView for small popovers/menus.
 * Sized to the popover rect only so clicks outside reach panels/chrome.
 * Does NOT park, hide, blur, or capturePage panel views.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WebContentsView } = require('electron');

const POPOVER_HTML = path.resolve(__dirname, '..', 'renderer', 'popover-overlay.html');
const POPOVER_PRELOAD = path.resolve(__dirname, '..', 'preload', 'popover-preload.js');

/** Overlay ids that must never trigger panel park/snapshot. */
const LIGHT_OVERLAY_IDS = new Set([
  'volume-popover',
  'site-perm-popover',
  'context-menu',
  'panel-ext-menu',
  'layout-select',
  'mem-popover',
  'store-bar-menu',
]);

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {(payload: object) => void} */
let emitToRenderer = () => {};
/** @type {(() => void) | null} */
let onCloseRequest = null;

/** @type {import('electron').WebContentsView | null} */
let overlayView = null;
/** @type {Promise<void> | null} */
let readyPromise = null;
/** @type {((v?: void) => void) | null} */
let readyResolve = null;

/** @type {null | { id: string, kind: string, bounds: { x: number, y: number, width: number, height: number }, payload: object }} */
let current = null;

/** Selftest-only call log (MULTIHEIZ_SELFTEST). */
/** @type {Array<{ at: number, op: string, detail?: object }>} */
let selftestLog = [];

function selftestEnabled() {
  return !!process.env.MULTIHEIZ_SELFTEST;
}

function logSelftest(op, detail) {
  if (!selftestEnabled()) return;
  selftestLog.push({ at: Date.now(), op, detail: detail || undefined });
}

function clearSelftestLog() {
  selftestLog = [];
}

function getSelftestLog() {
  return selftestLog.slice();
}

function isLightOverlayId(id) {
  const key = String(id || '').trim();
  if (!key) return false;
  if (LIGHT_OVERLAY_IDS.has(key)) return true;
  if (key === 'toast' || key.startsWith('toast:')) return true;
  return false;
}

/** @type {() => import('electron').BrowserWindow | null} */
let getMainWindow = () => mainWindow;

/**
 * @param {{
 *   getMainWindow?: () => import('electron').BrowserWindow | null,
 *   emitToRenderer?: (payload: object) => void,
 * }} opts
 */
function configure(opts) {
  if (typeof opts.getMainWindow === 'function') getMainWindow = opts.getMainWindow;
  if (typeof opts.emitToRenderer === 'function') emitToRenderer = opts.emitToRenderer;
}

function setMainWindow(win) {
  mainWindow = win;
  getMainWindow = () => mainWindow;
}

function htmlUrl() {
  return pathToFileURL(POPOVER_HTML).href;
}

function ensureView() {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  if (overlayView) {
    try {
      if (!overlayView.webContents.isDestroyed()) return overlayView;
    } catch {
      overlayView = null;
    }
  }

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: POPOVER_PRELOAD,
      backgroundThrottling: false,
    },
  });

  try {
    view.setBackgroundColor('#00000000');
  } catch {
    /* ignore */
  }

  try {
    view.setVisible(false);
  } catch {
    /* ignore */
  }

  try {
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  } catch {
    /* ignore */
  }

  readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });

  view.webContents.once('did-finish-load', () => {
    if (readyResolve) {
      readyResolve();
      readyResolve = null;
    }
  });

  view.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      requestClose('escape');
    }
  });

  view.webContents.on('blur', () => {
    // Click into a panel steals focus — close shortly if still open
    setTimeout(() => {
      if (!current) return;
      try {
        if (overlayView && !overlayView.webContents.isDestroyed() && overlayView.webContents.isFocused()) {
          return;
        }
      } catch {
        /* ignore */
      }
      requestClose('blur');
    }, 0);
  });

  try {
    win.contentView.addChildView(view);
  } catch {
    /* ignore */
  }

  try {
    const ipcGuard = require('./ipc-guard');
    ipcGuard.registerUiWebContents(view.webContents);
  } catch {
    /* ignore */
  }

  overlayView = view;
  view.webContents.loadURL(htmlUrl()).catch(() => {});
  logSelftest('create-view');
  return view;
}

async function waitReady() {
  const view = ensureView();
  if (!view) return false;
  if (readyPromise) {
    await Promise.race([
      readyPromise,
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  }
  try {
    if (view.webContents.isDestroyed()) return false;
    const u = view.webContents.getURL() || '';
    if (!u.includes('popover-overlay.html')) {
      await view.webContents.loadURL(htmlUrl());
      if (readyPromise) await readyPromise;
    }
  } catch {
    return false;
  }
  return true;
}

function raiseAbovePanels() {
  const win = getMainWindow();
  const view = overlayView;
  if (!win || win.isDestroyed() || !view) return;
  try {
    // Re-add last so z-order is above panel WebContentsViews
    win.contentView.removeChildView(view);
  } catch {
    /* ignore */
  }
  try {
    win.contentView.addChildView(view);
  } catch {
    /* ignore */
  }
  logSelftest('raise');
}

/**
 * Clamp and place popover rect in contentView DIP coordinates.
 * @param {{ x: number, y: number, width: number, height: number }} anchor
 * @param {number} width
 * @param {number} height
 * @param {'below'|'above'|'auto'} [prefer]
 */
function placeBounds(anchor, width, height, prefer) {
  const win = getMainWindow();
  let cw = 1280;
  let ch = 800;
  try {
    if (win && !win.isDestroyed()) {
      const size = win.getContentSize();
      cw = size[0] || cw;
      ch = size[1] || ch;
    }
  } catch {
    /* ignore */
  }
  const w = Math.max(40, Math.round(width));
  const h = Math.max(24, Math.round(height));
  const ax = Number(anchor && anchor.x) || 0;
  const ay = Number(anchor && anchor.y) || 0;
  const aw = Number(anchor && anchor.width) || 0;
  const ah = Number(anchor && anchor.height) || 0;

  let x = Math.round(ax);
  let y;
  const pref = prefer || 'below';
  if (pref === 'above') {
    y = Math.round(ay - h - 4);
  } else {
    y = Math.round(ay + ah + 4);
  }
  // Prefer opening under the right edge of the anchor when it would overflow
  if (x + w > cw - 8) x = Math.round(cw - w - 8);
  if (x < 8) x = 8;
  if (y + h > ch - 8) {
    // Flip above anchor
    const above = Math.round(ay - h - 4);
    y = above >= 8 ? above : Math.max(8, ch - h - 8);
  }
  if (y < 8) y = 8;
  // Center horizontally on anchor when possible
  if (aw > 0) {
    const centered = Math.round(ax + aw / 2 - w / 2);
    if (centered >= 8 && centered + w <= cw - 8) x = centered;
  }
  return { x, y, width: w, height: h };
}

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.kind
 * @param {object} opts.data
 * @param {{ x: number, y: number, width?: number, height?: number }} opts.anchor
 * @param {object} [opts.theme]
 * @param {'below'|'above'|'auto'} [opts.prefer]
 */
async function show(opts) {
  const id = String((opts && opts.id) || '').trim();
  const kind = String((opts && opts.kind) || '').trim();
  if (!id || !kind) return { ok: false, reason: 'missing-id-or-kind' };

  const okReady = await waitReady();
  if (!okReady || !overlayView) return { ok: false, reason: 'no-view' };

  const theme = (opts && opts.theme) || {};
  const data = (opts && opts.data) || {};
  const anchor = (opts && opts.anchor) || { x: 8, y: 8, width: 0, height: 0 };
  const prefer = (opts && opts.prefer) || 'below';

  // Estimate size; overlay will measure and may resize once
  const estimate = estimateSize(kind, data);
  let bounds = placeBounds(anchor, estimate.width, estimate.height, prefer);

  const t0 = Date.now();
  try {
    overlayView.setBounds(bounds);
  } catch {
    /* ignore */
  }
  raiseAbovePanels();
  try {
    overlayView.setVisible(true);
  } catch {
    /* ignore */
  }

  current = { id, kind, bounds, payload: { id, kind, data, theme, prefer, anchor } };

  try {
    overlayView.webContents.send('popover:render', {
      id,
      kind,
      data,
      theme,
    });
  } catch {
    /* ignore */
  }

  // Focus overlay so Esc works; pointer events stay on the small rect
  try {
    overlayView.webContents.focus();
  } catch {
    /* ignore */
  }

  const lag = Date.now() - t0;
  logSelftest('show', { id, kind, bounds, lagMs: lag });
  emitToRenderer({ type: 'popover:opened', id, kind, bounds });
  return { ok: true, id, kind, bounds, lagMs: lag };
}

/**
 * Apply measured size from the overlay document.
 * @param {{ width: number, height: number }} size
 */
function applyMeasuredSize(size) {
  if (!current || !overlayView) return current && current.bounds;
  const w = Math.max(40, Math.ceil(Number(size.width) || 0));
  const h = Math.max(24, Math.ceil(Number(size.height) || 0));
  const anchor = (current.payload && current.payload.anchor) || { x: current.bounds.x, y: current.bounds.y };
  const prefer = (current.payload && current.payload.prefer) || 'below';
  const bounds = placeBounds(anchor, w, h, prefer);
  try {
    overlayView.setBounds(bounds);
  } catch {
    /* ignore */
  }
  current.bounds = bounds;
  logSelftest('measure', { bounds });
  emitToRenderer({ type: 'popover:bounds', id: current.id, bounds });
  return bounds;
}

function estimateSize(kind, data) {
  if (kind === 'volume') return { width: 236, height: 112 };
  if (kind === 'site-perm') {
    const n = (data && data.keys && data.keys.length) || 8;
    return { width: 300, height: 48 + n * 32 + 40 };
  }
  if (kind === 'layout') {
    const n = (data && data.options && data.options.length) || 6;
    return { width: 160, height: 8 + n * 32 };
  }
  if (kind === 'menu') {
    const n = (data && data.items && data.items.length) || 2;
    return { width: 200, height: 8 + n * 32 };
  }
  if (kind === 'ext-menu') return { width: 280, height: 220 };
  if (kind === 'mem') return { width: 280, height: 200 };
  return { width: 220, height: 120 };
}

function hide(reason) {
  const t0 = Date.now();
  const was = current;
  current = null;
  if (overlayView) {
    try {
      overlayView.webContents.send('popover:clear');
    } catch {
      /* ignore */
    }
    try {
      overlayView.setVisible(false);
    } catch {
      /* ignore */
    }
    try {
      overlayView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    } catch {
      /* ignore */
    }
  }
  const lag = Date.now() - t0;
  logSelftest('hide', { reason: reason || '', lagMs: lag, id: was && was.id });
  if (was) {
    emitToRenderer({ type: 'popover:closed', id: was.id, kind: was.kind, reason: reason || '' });
  }
  return { ok: true, lagMs: lag };
}

function requestClose(reason) {
  if (!current) return;
  const id = current.id;
  hide(reason);
  emitToRenderer({ type: 'popover:close-request', id, reason: reason || '' });
  if (typeof onCloseRequest === 'function') {
    try {
      onCloseRequest({ id, reason });
    } catch {
      /* ignore */
    }
  }
}

function isOpen() {
  return !!current;
}

function getCurrent() {
  if (!current) return null;
  return {
    id: current.id,
    kind: current.kind,
    bounds: { ...current.bounds },
  };
}

function getView() {
  return overlayView;
}

/**
 * Child order index among contentView children (−1 if missing).
 */
function getZOrderIndex() {
  const win = getMainWindow();
  if (!win || win.isDestroyed() || !overlayView) return -1;
  try {
    const children = win.contentView.children || [];
    return children.indexOf(overlayView);
  } catch {
    return -1;
  }
}

/**
 * @param {object} action
 */
function forwardAction(action) {
  emitToRenderer({ type: 'popover:action', ...(action || {}) });
}

/**
 * Pointer enter/leave from overlay (volume hover bridge).
 * @param {'enter'|'leave'} phase
 */
function forwardPointer(phase) {
  emitToRenderer({
    type: 'popover:pointer',
    phase,
    id: current && current.id,
    kind: current && current.kind,
  });
}

/**
 * Update live data (e.g. volume percent) without reopening.
 * @param {object} data
 */
function updateData(data) {
  if (!current || !overlayView) return { ok: false };
  current.payload.data = { ...(current.payload.data || {}), ...(data || {}) };
  try {
    overlayView.webContents.send('popover:update', data || {});
  } catch {
    /* ignore */
  }
  return { ok: true };
}

function destroy() {
  const win = getMainWindow();
  const view = overlayView;
  overlayView = null;
  current = null;
  readyPromise = null;
  readyResolve = null;
  if (!view) return;
  try {
    const ipcGuard = require('./ipc-guard');
    ipcGuard.unregisterUiWebContents(view.webContents);
  } catch {
    /* ignore */
  }
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  } catch {
    /* ignore */
  }
  try {
    view.webContents.close();
  } catch {
    /* ignore */
  }
}

/**
 * Re-raise after panel layout sync so overlay stays on top while open.
 */
function onPanelsLayoutChanged() {
  if (!current || !overlayView) return;
  raiseAbovePanels();
}

/**
 * Close when window is resized/moved.
 */
function attachWindowListeners(win) {
  if (!win) return;
  const close = () => {
    if (current) requestClose('window-geometry');
  };
  win.on('resize', close);
  win.on('move', close);
  win.on('maximize', close);
  win.on('unmaximize', close);
  win.on('enter-full-screen', close);
  win.on('leave-full-screen', close);
}

function setCloseRequestHandler(fn) {
  onCloseRequest = typeof fn === 'function' ? fn : null;
}

module.exports = {
  LIGHT_OVERLAY_IDS,
  isLightOverlayId,
  configure,
  setMainWindow,
  ensureView,
  show,
  hide,
  requestClose,
  isOpen,
  getCurrent,
  getView,
  getZOrderIndex,
  applyMeasuredSize,
  forwardAction,
  forwardPointer,
  updateData,
  destroy,
  onPanelsLayoutChanged,
  attachWindowListeners,
  setCloseRequestHandler,
  clearSelftestLog,
  getSelftestLog,
  htmlUrl,
  POPOVER_HTML,
};
