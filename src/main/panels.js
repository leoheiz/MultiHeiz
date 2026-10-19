'use strict';

const path = require('node:path');
const { WebContentsView, BrowserWindow, session, shell, dialog } = require('electron');
const { getState, updateState } = require('./state');
const { resolveNavigateUrl } = require('./search-url');
const {
  classifyScheme,
  isNavigableUrl,
  allowInternalDataUrls,
  isKnownIdentityProviderUrl,
} = require('./url-policy');
const history = require('./history');
const downloads = require('./downloads');
const adblock = require('./adblock');
const userAgent = require('./user-agent');
const sessionPersist = require('./session-persist');
const permissions = require('./permissions');

/** @type {Map<string, { view: import('electron').WebContentsView, accountId: string, visible: boolean, parked: boolean }>} */
const panels = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const suspendTimers = new Map();

/** last interaction / focus / visibility */
/** @type {Map<string, number>} */
const lastUsedAt = new Map();

/** Panels that stay destroyed until explicit reactivate (hard limit / manual). */
/** @type {Set<string>} */
const forceSuspended = new Set();

/** @type {Set<string>} */
let visibleAccountIds = new Set();

/** @type {string | null} */
let focusedAccountId = null;

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;

/** @type {(payload: object) => void} */
let emitToRenderer = () => {};

/**
 * Overlay ids currently open in the renderer (modals, popovers, menus).
 * Toasts must NOT be registered here (v1.3 — they caused Liberar memória flicker).
 */
/** @type {Set<string>} */
const activeOverlays = new Set();

/** Last layout slots from the renderer (kept while overlays hide views). */
/** @type {Array<{ accountId: string, x: number, y: number, width: number, height: number }>} */
let lastSlots = [];

/** Last on-screen size for parking hidden panels offscreen. */
/** @type {Map<string, { width: number, height: number }>} */
const lastOnScreenSize = new Map();

/** Snapshot dataURLs shown behind modals while views are parked (v1.4). */
/** @type {Map<string, string>} */
const overlaySnapshots = new Map();

/**
 * Bumped whenever overlays close (or a new park cycle starts) so an in-flight
 * capture cannot leave views parked after the overlay already closed (v1.4.1).
 */
let overlayParkEpoch = 0;

/** Instrumentation for selftests (visible detach/bounds changes). */
/** @type {Array<object>} */
let viewMutationLog = [];
let mutationLogEnabled = false;

/** FPS samples from panel preload (isolated world). */
/** @type {Map<string, number>} */
const panelFps = new Map();

/** Staggered create/load queue (workspace switch / startup). */
/** @type {string[]} */
let loadQueue = [];
let loadQueueRunning = false;
/** @type {Set<string>} */
const loadQueuePending = new Set();
/** @type {Map<string, number>} */
const loadRetries = new Map();
/** Child login/OAuth popups */
/** @type {Set<import('electron').BrowserWindow>} */
const childPopups = new Set();

/** When true, createPanel skips initial loadURL (staggered queue). */
let deferNextCreateLoad = false;

const { resolvePreloadPath } = require('./preload-path');
const PANEL_PRELOAD = resolvePreloadPath(
  path.join(__dirname, '..', 'preload', 'panel-preload.js')
).path;
const OFFSCREEN_X = -20000;
const OFFSCREEN_Y = 0;
const CAPTURE_TIMEOUT_MS = 150;
const STAGGER_MAX_MS = 20_000;
const RETRYABLE_ERRORS = new Set([
  -7, // ERR_TIMED_OUT
  -101, // ERR_CONNECTION_RESET
  -21, // ERR_NETWORK_CHANGED
  -106, // ERR_INTERNET_DISCONNECTED
]);
const RETRYABLE_CODES = new Set([
  'ERR_TIMED_OUT',
  'ERR_CONNECTION_RESET',
  'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED',
]);

function initPanels(win, emit) {
  mainWindow = win;
  emitToRenderer = emit;
}

function getOverlayCount() {
  return activeOverlays.size;
}

function areOverlaysActive() {
  return activeOverlays.size > 0;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Capture visible on-screen panels for overlay backdrop (parallel, ~150 ms each).
 * @returns {Promise<Array<{ accountId: string, dataUrl: string|null, color: string }>>}
 */
async function captureVisibleSnapshots() {
  const tasks = lastSlots.map(async (slot) => {
    const accountId = slot.accountId;
    const acc = getAccount(accountId);
    const color = (acc && acc.color) || '#2bb8a6';
    const entry = panels.get(accountId);
    if (!entry || entry.parked || !entry.visible) {
      return { accountId, dataUrl: null, color };
    }
    try {
      const img = await withTimeout(entry.view.webContents.capturePage(), CAPTURE_TIMEOUT_MS);
      const dataUrl = img.toDataURL();
      // Bound memory: skip absurdly large captures
      if (dataUrl && dataUrl.length > 8_000_000) {
        return { accountId, dataUrl: null, color };
      }
      return { accountId, dataUrl, color };
    } catch {
      return { accountId, dataUrl: null, color };
    }
  });
  return Promise.all(tasks);
}

function emitOverlaySnapshots(list) {
  overlaySnapshots.clear();
  const payload = [];
  for (const item of list || []) {
    if (item.dataUrl) overlaySnapshots.set(item.accountId, item.dataUrl);
    payload.push({
      accountId: item.accountId,
      dataUrl: item.dataUrl,
      color: item.color,
    });
  }
  emitToRenderer({ type: 'overlay:snapshots', snapshots: payload });
}

function clearOverlaySnapshots() {
  overlaySnapshots.clear();
  emitToRenderer({ type: 'overlay:snapshots', snapshots: [] });
}

/**
 * Central overlay counter: renderer opens/closes named overlays.
 * While count > 0, visible panel views are snapshotted then parked offscreen
 * (keep media running — not setVisible(false) / not destroyed).
 * @param {string} id
 * @param {boolean} active
 */
async function setOverlay(id, active) {
  const key = String(id || '').trim();
  if (!key) return getOverlayCount();
  // Toasts must never hide panel views
  if (key === 'toast' || key.startsWith('toast:')) {
    return getOverlayCount();
  }
  const before = activeOverlays.size;
  if (active) activeOverlays.add(key);
  else activeOverlays.delete(key);
  const after = activeOverlays.size;
  if (before === 0 && after > 0) {
    const epoch = ++overlayParkEpoch;
    await prepareAndParkForOverlay(epoch);
  } else if (before > 0 && after === 0) {
    overlayParkEpoch += 1;
    restoreViewsAfterOverlay();
  }
  return activeOverlays.size;
}

async function setOverlayCount(ids) {
  const before = activeOverlays.size;
  activeOverlays.clear();
  if (Array.isArray(ids)) {
    for (const id of ids) {
      const key = String(id || '').trim();
      if (!key || key === 'toast' || key.startsWith('toast:')) continue;
      activeOverlays.add(key);
    }
  }
  const after = activeOverlays.size;
  if (before === 0 && after > 0) {
    const epoch = ++overlayParkEpoch;
    await prepareAndParkForOverlay(epoch);
  } else if (after === 0) {
    overlayParkEpoch += 1;
    restoreViewsAfterOverlay();
  }
  return activeOverlays.size;
}

async function prepareAndParkForOverlay(epoch) {
  const snaps = await captureVisibleSnapshots();
  // Overlay may have closed while capture was in flight — do not park/stuck-snap
  if (activeOverlays.size === 0) return;
  if (epoch != null && epoch !== overlayParkEpoch) return;
  emitOverlaySnapshots(snaps);
  parkViewsForOverlay();
}

/**
 * Park every attached view offscreen so modals are not covered, while media keeps running.
 */
function parkViewsForOverlay() {
  for (const entry of panels.values()) {
    parkPanelOffscreen(entry);
  }
}

function logMutation(accountId, action, extra = {}) {
  if (!mutationLogEnabled) return;
  viewMutationLog.push({
    at: Date.now(),
    accountId,
    action,
    ...extra,
  });
}

function enableViewMutationLog(on = true) {
  mutationLogEnabled = !!on;
  if (on) viewMutationLog = [];
}

function clearViewMutationLog() {
  viewMutationLog = [];
}

function getViewMutationLog() {
  return viewMutationLog.slice();
}

function setViewVisible(entry, visible) {
  const next = !!visible;
  const prev = !!entry.visible;
  entry.visible = next;
  try {
    entry.view.setVisible(next);
  } catch {
    /* ignore */
  }
  if (mutationLogEnabled && prev !== next) {
    let bounds = null;
    try {
      bounds = entry.view.getBounds();
    } catch {
      /* ignore */
    }
    logMutation(entry.accountId, next ? 'show' : 'hide', { bounds });
  }
}

function hideViewsForOverlay() {
  // v1.4: park offscreen (keep running) instead of setVisible(false)
  parkViewsForOverlay();
}

function restoreViewsAfterOverlay() {
  if (lastSlots.length) {
    applySlotBounds(lastSlots, { forceShow: true });
    for (const slot of lastSlots) {
      repaintPanel(slot.accountId);
    }
  }
  // Re-park hidden panels that should keep running in the background
  for (const [id, entry] of panels) {
    if (visibleAccountIds.has(id)) continue;
    if (keepRunningInBackground(id)) {
      parkPanelOffscreen(entry);
    }
  }
  // Clear snapshots after a frame so the live view paints first (avoid flash)
  setTimeout(() => clearOverlaySnapshots(), 32);
}

function partitionFor(accountId) {
  return `persist:acc-${accountId}`;
}

function chromeUserAgent() {
  return userAgent.buildChromeUserAgent();
}

function isOauthOrLoginUrl(url) {
  return isKnownIdentityProviderUrl(url);
}

/**
 * Ask the user before opening a known external scheme via the OS handler.
 * @param {string} url
 */
async function confirmOpenExternal(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = String(url || '').slice(0, 500);
  let result;
  try {
    result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Abrir', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Abrir link externo',
      message: 'Abrir este link com o aplicativo do sistema?',
      detail: display,
      noLink: true,
    });
  } catch {
    return;
  }
  if (result.response !== 0) return;
  try {
    await shell.openExternal(url);
  } catch {
    /* ignore */
  }
}

/**
 * Handle window.open / target=_blank according to URL policy.
 * @param {string} accountId
 * @param {string} url
 * @param {Electron.Session} ses
 * @param {import('electron').WebContents} wc
 */
function handlePanelWindowOpen(accountId, url, ses, wc) {
  const kind = classifyScheme(url);
  if (kind === 'blocked') {
    return { action: 'deny' };
  }
  if (kind === 'external') {
    confirmOpenExternal(url).catch(() => {});
    return { action: 'deny' };
  }
  // web (http/https/about:blank)
  if (isOauthOrLoginUrl(url)) {
    openLoginPopup(accountId, url, ses);
    return { action: 'deny' };
  }
  if (!isNavigableUrl(url)) {
    return { action: 'deny' };
  }
  const settings = getState().settings || {};
  if (settings.blankLinkMode === 'new-panel') {
    emitToRenderer({ type: 'ui:open-url-new-panel', url, fromAccountId: accountId });
    return { action: 'deny' };
  }
  wc.loadURL(url).catch(() => {});
  return { action: 'deny' };
}

/**
 * Open login/OAuth popup in a child BrowserWindow with the SAME partition.
 * @param {string} accountId
 * @param {string} url
 * @param {Electron.Session} ses
 */
function openLoginPopup(accountId, url, ses) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const child = new BrowserWindow({
    width: 520,
    height: 720,
    parent: mainWindow,
    modal: false,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInSubFrames: true,
      preload: PANEL_PRELOAD,
      backgroundThrottling: false,
    },
  });
  childPopups.add(child);
  try {
    child.webContents.setUserAgent(chromeUserAgent());
  } catch {
    /* ignore */
  }
  userAgent.applySessionUserAgent(ses);
  child.on('closed', () => {
    childPopups.delete(child);
    emitToRenderer({ type: 'toast', message: 'Login fechado — voltando ao painel' });
  });
  if (isNavigableUrl(url)) {
    child.loadURL(url).catch(() => {});
  }
  return child;
}

function getAccount(accountId) {
  return getState().accounts.find((a) => a.id === accountId) || null;
}

function keepRunningInBackground(accountId) {
  const settings = getState().settings || {};
  const preset = settings.backgroundPreset || 'balanced';
  if (preset === 'always') {
    const accAlways = getAccount(accountId);
    if (accAlways && accAlways.pauseInBackground) return false;
    return true;
  }
  if (preset === 'max-save') return false;
  if (settings.keepBackgroundRunning === false) return false;
  const acc = getAccount(accountId);
  if (acc && acc.pauseInBackground) return false;
  return true;
}

function homeUrlFor(account) {
  const settings = getState().settings || {};
  return account.startUrl || settings.homepage || 'https://www.google.com';
}

function startUrlFor(account) {
  const settings = getState().settings || {};
  if (settings.openLastPage !== false && account.lastUrl) return account.lastUrl;
  return homeUrlFor(account);
}

function normalizeUrl(input) {
  const settings = getState().settings || {};
  return resolveNavigateUrl(input, settings);
}

function touchAccount(accountId) {
  if (!accountId) return;
  lastUsedAt.set(accountId, Date.now());
}

function setFocusedAccount(accountId) {
  const next = accountId || null;
  const changed = focusedAccountId !== next;
  focusedAccountId = next;
  if (accountId) touchAccount(accountId);
  applyThrottling();
  emitSuspendedState();
  if (changed) {
    emitToRenderer({
      type: 'panel:focus-changed',
      accountId: focusedAccountId,
      zoom: focusedAccountId ? panelGetZoom(focusedAccountId) : 1,
    });
  }
}

function getFocusedAccountId() {
  return focusedAccountId;
}

function getLastUsedAt(accountId) {
  return lastUsedAt.get(accountId) || 0;
}

function getForceSuspendedIds() {
  return forceSuspended;
}

function getVisibleAccountIds() {
  return visibleAccountIds;
}

function isPanelActive(accountId) {
  return panels.has(accountId);
}

function isForceSuspended(accountId) {
  return forceSuspended.has(accountId);
}

function emitSuspendedState() {
  emitToRenderer({
    type: 'memory:suspended',
    suspendedIds: [...forceSuspended],
    focusedAccountId,
  });
}

function getMainUiProcessId() {
  if (!mainWindow || mainWindow.isDestroyed()) return 0;
  try {
    return mainWindow.webContents.getOSProcessId();
  } catch {
    return 0;
  }
}

function createPanel(accountId) {
  if (!mainWindow || panels.has(accountId)) return panels.get(accountId) || null;
  const account = getAccount(accountId);
  if (!account) return null;

  clearSuspendTimer(accountId);
  forceSuspended.delete(accountId);
  touchAccount(accountId);

  const ses = session.fromPartition(partitionFor(accountId));
  permissions.attachToSession(ses, accountId);
  hookDownloadsForAccount(accountId, ses);
  userAgent.applySessionUserAgent(ses);
  sessionPersist.hookSessionCookies(ses);
  adblock.attachSession(ses, accountId);
  try {
    const extensions = require('./extensions');
    extensions.loadForAccount(accountId).catch((err) => {
      console.warn('[extensions] loadForAccount', accountId, err && err.message);
    });
  } catch {
    /* ignore */
  }
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Required so session cosmetic preload (type:'frame') runs in iframes
      nodeIntegrationInSubFrames: true,
      preload: PANEL_PRELOAD,
      // Always false in prefs; runtime control via setBackgroundThrottling
      backgroundThrottling: false,
    },
  });

  adblock.bindWebContents(accountId, view.webContents);

  try {
    view.webContents.setUserAgent(chromeUserAgent());
  } catch {
    /* older electron */
  }

  try {
    if (typeof view.webContents.setBackgroundThrottling === 'function') {
      view.webContents.setBackgroundThrottling(false);
    }
  } catch {
    /* ignore */
  }

  view.webContents.setAudioMuted(!!account.muted);

  // Per-panel zoom (view bounds unaffected); disable Chromium pinch/visual zoom
  try {
    if (typeof view.webContents.setVisualZoomLevelLimits === 'function') {
      view.webContents.setVisualZoomLevelLimits(1, 1);
    }
  } catch {
    /* ignore */
  }
  const zf = Number(account.zoomFactor);
  if (Number.isFinite(zf) && zf >= 0.25 && zf <= 3) {
    try {
      view.webContents.setZoomFactor(zf);
    } catch {
      /* ignore */
    }
  }

  // Apply stored bounds immediately (avoids stuck "carregando" until F5)
  const storedBounds = account.lastBounds;
  if (
    storedBounds &&
    Number(storedBounds.width) > 1 &&
    Number(storedBounds.height) > 1
  ) {
    try {
      view.setBounds({
        x: Math.round(Number(storedBounds.x) || 0),
        y: Math.round(Number(storedBounds.y) || 0),
        width: Math.round(Number(storedBounds.width)),
        height: Math.round(Number(storedBounds.height)),
      });
    } catch {
      /* ignore */
    }
  }

  view.webContents.on('did-navigate', (_e, url) => {
    rememberUrl(accountId, url);
    recordHistory(accountId, url);
    touchAccount(accountId);
    notifyNav(accountId);
    signalLoadCommitted(accountId);
  });
  view.webContents.on('did-navigate-in-page', (_e, url) => {
    rememberUrl(accountId, url);
    recordHistory(accountId, url);
    touchAccount(accountId);
    notifyNav(accountId);
  });
  view.webContents.on('did-finish-load', () => {
    notifyNav(accountId);
    signalLoadCommitted(accountId);
  });
  view.webContents.on('dom-ready', () => signalLoadCommitted(accountId));
  view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || event.defaultPrevented) return;
    const codeStr = String(errorDescription || '');
    const retryable =
      RETRYABLE_ERRORS.has(errorCode) ||
      [...RETRYABLE_CODES].some((c) => codeStr.includes(c));
    if (!retryable) return;
    const n = loadRetries.get(accountId) || 0;
    if (n >= 1) {
      loadRetries.delete(accountId);
      emitToRenderer({
        type: 'panel:load-status',
        accountId,
        status: 'error',
        message: `Falha de rede (${codeStr || errorCode})`,
      });
      return;
    }
    loadRetries.set(accountId, n + 1);
    emitToRenderer({
      type: 'panel:load-status',
      accountId,
      status: 'retry',
      message: 'Reconectando…',
    });
    const delay = 3000 + Math.floor(Math.random() * 2000);
    setTimeout(() => {
      const entry2 = panels.get(accountId);
      if (!entry2 || entry2.view.webContents.isDestroyed()) return;
      const target = validatedURL || entry2.view.webContents.getURL();
      if (target && isNavigableUrl(target, { allowData: allowInternalDataUrls() })) {
        entry2.view.webContents.loadURL(target).catch(() => {});
      }
    }, delay);
  });
  view.webContents.on('page-title-updated', () => notifyNav(accountId));
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    const favicon = Array.isArray(favicons) && favicons.length ? favicons[0] : '';
    emitToRenderer({ type: 'panel:favicon', accountId, favicon });
  });
  view.webContents.on('ipc-message', (_e, channel, data) => {
    if (channel === 'panel:ctrl-wheel') {
      const deltaY = data && typeof data.deltaY === 'number' ? data.deltaY : 0;
      // wheel up (negative deltaY) = zoom in
      const step = deltaY < 0 ? 0.1 : deltaY > 0 ? -0.1 : 0;
      if (step !== 0) {
        setFocusedAccount(accountId);
        panelZoom(accountId, step);
      }
      return;
    }
    if (channel === 'panel:fps' && data && typeof data.fps === 'number') {
      panelFps.set(accountId, data.fps);
      emitToRenderer({
        type: 'panel:fps',
        accountId,
        fps: data.fps,
      });
    }
  });
  view.webContents.on('focus', () => {
    setFocusedAccount(accountId);
  });
  // Click / key inside page also focuses this panel (sidebar + URL follow)
  view.webContents.on('before-input-event', (_e, input) => {
    if (input && (input.type === 'keyDown' || input.type === 'mouseDown')) {
      setFocusedAccount(accountId);
    }
  });
  try {
    view.webContents.on('input-event', (_e, input) => {
      if (input && (input.type === 'mouseDown' || input.type === 'rawKeyDown')) {
        setFocusedAccount(accountId);
      }
    });
  } catch {
    /* older Electron without input-event */
  }
  // Block in-page navigations to non-http(s) schemes (defense in depth).
  // data: only while MULTIHEIZ_SELFTEST (internal probes), never for normal browsing.
  view.webContents.on('will-navigate', (e, url) => {
    if (!isNavigableUrl(url, { allowData: allowInternalDataUrls() })) {
      e.preventDefault();
    }
  });
  view.webContents.on('will-redirect', (e, url) => {
    if (!isNavigableUrl(url, { allowData: allowInternalDataUrls() })) {
      e.preventDefault();
    }
  });
  view.webContents.setWindowOpenHandler(({ url }) =>
    handlePanelWindowOpen(accountId, url, ses, view.webContents)
  );

  mainWindow.contentView.addChildView(view);
  const entry = {
    view,
    accountId,
    visible: true,
    parked: false,
  };
  panels.set(accountId, entry);
  logMutation(accountId, 'create', {});

  if (areOverlaysActive()) {
    parkPanelOffscreen(entry);
  }

  // Actual navigation may be deferred by staggered load queue
  if (!deferNextCreateLoad) {
    let url = startUrlFor(account);
    // data: only for selftest probe startUrl; user-typed startUrl is http/https only
    const dataOpts = { allowData: allowInternalDataUrls() };
    if (!isNavigableUrl(url, dataOpts)) {
      url = normalizeUrl(url) || 'https://www.google.com';
    }
    if (isNavigableUrl(url, dataOpts)) {
      view.webContents.loadURL(url).catch((err) => {
        console.error('loadURL failed', accountId, err);
      });
    }
  }

  applyThrottlingTo(accountId);
  emitSuspendedState();
  return panels.get(accountId);
}

function rememberUrl(accountId, url) {
  if (!url || url.startsWith('about:') || url.startsWith('chrome:')) return;
  // Never persist data:/file:/javascript: as lastUrl (user reopen must stay http/https)
  if (!isNavigableUrl(url)) return;
  updateState((s) => {
    const acc = s.accounts.find((a) => a.id === accountId);
    if (acc) acc.lastUrl = url;
  });
}

function recordHistory(accountId, url) {
  if (history.shouldIgnoreUrl(url)) return;
  const acc = getAccount(accountId);
  if (!acc || acc.privateHistory) return;
  let title = '';
  let favicon = '';
  try {
    const entry = panels.get(accountId);
    if (entry) title = entry.view.webContents.getTitle() || '';
  } catch {
    /* ignore */
  }
  history.record({
    url,
    title: title || acc.name || '',
    favicon,
    windowId: accountId,
    windowName: acc.name || '',
  });
}

function hookDownloadsForAccount(accountId, ses) {
  downloads.hookSession(ses, () => {
    const acc = getAccount(accountId);
    return {
      windowId: accountId,
      windowName: (acc && acc.name) || '',
    };
  });
}

function canGoBack(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
      return wc.navigationHistory.canGoBack();
    }
  } catch {
    /* fall through */
  }
  return typeof wc.canGoBack === 'function' ? wc.canGoBack() : false;
}

function canGoForward(wc) {
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoForward === 'function') {
      return wc.navigationHistory.canGoForward();
    }
  } catch {
    /* fall through */
  }
  return typeof wc.canGoForward === 'function' ? wc.canGoForward() : false;
}

function goBack(wc) {
  if (wc.navigationHistory && typeof wc.navigationHistory.goBack === 'function') {
    wc.navigationHistory.goBack();
  } else if (typeof wc.goBack === 'function') {
    wc.goBack();
  }
}

function goForward(wc) {
  if (wc.navigationHistory && typeof wc.navigationHistory.goForward === 'function') {
    wc.navigationHistory.goForward();
  } else if (typeof wc.goForward === 'function') {
    wc.goForward();
  }
}

function notifyNav(accountId) {
  const entry = panels.get(accountId);
  if (!entry) return;
  const wc = entry.view.webContents;
  let domain = '';
  try {
    domain = new URL(wc.getURL()).hostname || '';
  } catch {
    domain = '';
  }
  emitToRenderer({
    type: 'panel:nav',
    accountId,
    url: wc.getURL(),
    title: wc.getTitle(),
    domain,
    canGoBack: canGoBack(wc),
    canGoForward: canGoForward(wc),
    muted: wc.isAudioMuted(),
  });
}

function getPanelFps(accountId) {
  if (accountId) return panelFps.get(accountId) || 0;
  return focusedAccountId ? panelFps.get(focusedAccountId) || 0 : 0;
}

function getOverlaySnapshotMap() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [id, url] of overlaySnapshots) out[id] = url;
  return out;
}

function destroyPanel(accountId, { keepLastUrl = true } = {}) {
  clearSuspendTimer(accountId);
  const entry = panels.get(accountId);
  if (!entry) return;
  const { view } = entry;
  logMutation(accountId, 'destroy', {
    wasVisible: !!entry.visible,
    inVisibleSet: visibleAccountIds.has(accountId),
  });
  try {
    const url = view.webContents.getURL();
    if (keepLastUrl) rememberUrl(accountId, url);
  } catch {
    /* destroyed */
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(view);
    }
  } catch {
    /* ignore */
  }
  try {
    view.webContents.close();
  } catch {
    try {
      if (typeof view.webContents.destroy === 'function') view.webContents.destroy();
    } catch {
      /* ignore */
    }
  }
  panels.delete(accountId);
  lastOnScreenSize.delete(accountId);
  panelFps.delete(accountId);
  overlaySnapshots.delete(accountId);
  if (focusedAccountId === accountId) focusedAccountId = null;
}

function clearSuspendTimer(accountId) {
  const t = suspendTimers.get(accountId);
  if (t) {
    clearTimeout(t);
    suspendTimers.delete(accountId);
  }
}

function scheduleSuspend(accountId) {
  const settings = getState().settings;
  // keepBackgroundRunning (default ON) wins over auto-suspend unless user wants suspendHidden
  if (settings.keepBackgroundRunning !== false && !settings.suspendHidden) {
    return;
  }
  if (!settings.suspendHidden) return;
  if (forceSuspended.has(accountId)) {
    destroyPanel(accountId);
    return;
  }
  clearSuspendTimer(accountId);
  const delay = Math.max(0, Number(settings.suspendDelayMs) || 0);
  if (delay === 0) {
    destroyPanel(accountId);
    return;
  }
  suspendTimers.set(
    accountId,
    setTimeout(() => {
      suspendTimers.delete(accountId);
      destroyPanel(accountId);
    }, delay)
  );
}

/**
 * Suspend for memory pressure. force=true keeps placeholder until reactivate.
 */
function suspendForMemory(accountId, { force = false } = {}) {
  if (force) forceSuspended.add(accountId);
  destroyPanel(accountId, { keepLastUrl: true });
  emitSuspendedState();
}

function reactivatePanel(accountId) {
  forceSuspended.delete(accountId);
  touchAccount(accountId);
  setFocusedAccount(accountId);
  if (visibleAccountIds.has(accountId)) {
    createPanel(accountId);
  }
  emitSuspendedState();
  return { active: panels.has(accountId), forced: forceSuspended.has(accountId) };
}

/**
 * Park a hidden panel offscreen so Chromium keeps media/timers running
 * (setVisible(false) flips document.visibilityState to "hidden" and freezes many players).
 */
function parkPanelOffscreen(entry) {
  const size = lastOnScreenSize.get(entry.accountId) || { width: 800, height: 600 };
  const width = Math.max(320, Math.round(size.width) || 800);
  const height = Math.max(240, Math.round(size.height) || 600);
  const bounds = { x: OFFSCREEN_X, y: OFFSCREEN_Y, width, height };
  try {
    entry.view.setBounds(bounds);
  } catch {
    /* ignore */
  }
  entry.parked = true;
  setViewVisible(entry, true);
  applyThrottlingTo(entry.accountId);
  forceNoThrottle(entry.accountId);
  setTimeout(() => forceNoThrottle(entry.accountId), 0);
  setTimeout(() => forceNoThrottle(entry.accountId), 50);
  setTimeout(() => forceNoThrottle(entry.accountId), 200);
  ensureAntiThrottleLoop();
  logMutation(entry.accountId, 'park', { bounds });
}

function forceNoThrottle(accountId) {
  if (!keepRunningInBackground(accountId)) return;
  const entry = panels.get(accountId);
  if (!entry) return;
  try {
    const wc = entry.view.webContents;
    if (typeof wc.setBackgroundThrottling === 'function') {
      wc.setBackgroundThrottling(false);
    }
  } catch {
    /* ignore */
  }
}

/** @type {ReturnType<typeof setInterval> | null} */
let antiThrottleTimer = null;

function ensureAntiThrottleLoop() {
  if (antiThrottleTimer) return;
  antiThrottleTimer = setInterval(() => {
    let any = false;
    for (const [id, entry] of panels) {
      if (entry.parked && keepRunningInBackground(id)) {
        forceNoThrottle(id);
        any = true;
      }
    }
    if (!any && antiThrottleTimer) {
      clearInterval(antiThrottleTimer);
      antiThrottleTimer = null;
    }
  }, 200);
}

function repaintPanel(accountId) {
  const entry = panels.get(accountId);
  if (!entry) return;
  try {
    if (typeof entry.view.webContents.invalidate === 'function') {
      entry.view.webContents.invalidate();
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {Array<{ accountId: string, x: number, y: number, width: number, height: number }>} slots
 * @param {{ forceShow?: boolean }} [opts]
 */
function applySlotBounds(slots, opts = {}) {
  const forceShow = !!opts.forceShow;
  const hideForOverlay = !forceShow && areOverlaysActive();

  for (const slot of slots) {
    clearSuspendTimer(slot.accountId);
    touchAccount(slot.accountId);

    if (forceSuspended.has(slot.accountId)) {
      if (panels.has(slot.accountId)) destroyPanel(slot.accountId);
      continue;
    }

    let entry = panels.get(slot.accountId);
    if (!entry) entry = createPanel(slot.accountId);
    if (!entry) continue;

    const x = Math.round(Number(slot.x) || 0);
    const y = Math.round(Number(slot.y) || 0);
    const width = Math.round(Number(slot.width) || 0);
    const height = Math.round(Number(slot.height) || 0);

    if (width < 1 || height < 1) {
      if (keepRunningInBackground(slot.accountId)) {
        parkPanelOffscreen(entry);
      } else {
        setViewVisible(entry, false);
      }
      continue;
    }

    lastOnScreenSize.set(slot.accountId, { width, height });
    updateState((s) => {
      const acc = s.accounts.find((a) => a.id === slot.accountId);
      if (acc) acc.lastBounds = { x, y, width, height };
    });

    // While overlays are open, keep views parked offscreen (media running) — don't cover modals
    if (hideForOverlay) {
      parkPanelOffscreen(entry);
      continue;
    }

    const prevBounds = (() => {
      try {
        return entry.view.getBounds();
      } catch {
        return null;
      }
    })();
    entry.view.setBounds({ x, y, width, height });
    entry.parked = false;
    if (
      mutationLogEnabled &&
      prevBounds &&
      (prevBounds.x !== x ||
        prevBounds.y !== y ||
        prevBounds.width !== width ||
        prevBounds.height !== height)
    ) {
      logMutation(slot.accountId, 'bounds', {
        from: prevBounds,
        to: { x, y, width, height },
      });
    }
    setViewVisible(entry, true);
    repaintPanel(slot.accountId);
  }
}

/**
 * @param {Array<{ accountId: string, x: number, y: number, width: number, height: number }>} slots
 */
function signalLoadCommitted(accountId) {
  if (!loadQueuePending.has(accountId)) return;
  loadQueuePending.delete(accountId);
  // Continue staggered queue
  setImmediate(() => pumpLoadQueue());
}

function pumpLoadQueue() {
  if (loadQueueRunning) return;
  const nextId = loadQueue.find((id) => !panels.has(id) || loadQueuePending.has(id));
  // Find next that still needs create+load
  let id = null;
  while (loadQueue.length) {
    const candidate = loadQueue.shift();
    if (!candidate) continue;
    const existing = panels.get(candidate);
    if (existing && !loadQueuePending.has(candidate)) {
      let cur = '';
      try {
        cur = existing.view.webContents.getURL();
      } catch {
        cur = '';
      }
      // Only skip if the panel already navigated (deferred creates stay about:blank)
      if (cur && cur !== 'about:blank') continue;
    }
    id = candidate;
    break;
  }
  if (!id) {
    loadQueueRunning = false;
    return;
  }
  loadQueueRunning = true;
  loadQueuePending.add(id);
  let entry = panels.get(id);
  if (!entry) {
    entry = createPanelDeferred(id);
  }
  if (!entry) {
    loadQueuePending.delete(id);
    loadQueueRunning = false;
    setImmediate(() => pumpLoadQueue());
    return;
  }
  const account = getAccount(id);
  let url = account ? startUrlFor(account) : 'https://www.google.com';
  const dataOpts = { allowData: allowInternalDataUrls() };
  if (!isNavigableUrl(url, dataOpts)) {
    url = normalizeUrl(url) || 'https://www.google.com';
  }
  const wc = entry.view.webContents;
  const current = (() => {
    try {
      return wc.getURL();
    } catch {
      return '';
    }
  })();
  if (!current || current === 'about:blank') {
    if (isNavigableUrl(url, dataOpts)) {
      wc.loadURL(url).catch(() => {});
    } else {
      loadQueuePending.delete(id);
      loadQueueRunning = false;
      setImmediate(() => pumpLoadQueue());
      return;
    }
  } else {
    loadQueuePending.delete(id);
    loadQueueRunning = false;
    setImmediate(() => pumpLoadQueue());
    return;
  }
  const watchdog = setTimeout(() => {
    if (loadQueuePending.has(id)) {
      loadQueuePending.delete(id);
      loadQueueRunning = false;
      pumpLoadQueue();
    }
  }, STAGGER_MAX_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  const finish = () => {
    if (!loadQueuePending.has(id)) {
      clearTimeout(watchdog);
      loadQueueRunning = false;
      pumpLoadQueue();
    }
  };
  // finish when committed (signalLoadCommitted clears pending)
  const check = setInterval(() => {
    if (!loadQueuePending.has(id)) {
      clearInterval(check);
      finish();
    }
  }, 50);
  if (typeof check.unref === 'function') check.unref();
}

/**
 * Create panel without immediate navigation (for staggered queue).
 */
function createPanelDeferred(accountId) {
  if (panels.has(accountId)) return panels.get(accountId);
  deferNextCreateLoad = true;
  const entry = createPanel(accountId);
  deferNextCreateLoad = false;
  return entry;
}

function enqueueVisibleLoads(accountIds) {
  const ordered = Array.isArray(accountIds) ? accountIds.slice() : [];
  for (const id of ordered) {
    if (!loadQueue.includes(id)) loadQueue.push(id);
  }
  pumpLoadQueue();
}

function syncVisiblePanels(slots) {
  const list = Array.isArray(slots) ? slots : [];
  lastSlots = list.map((s) => ({
    accountId: s.accountId,
    x: Number(s.x) || 0,
    y: Number(s.y) || 0,
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
  }));

  visibleAccountIds = new Set(lastSlots.map((s) => s.accountId));

  for (const id of [...panels.keys()]) {
    if (!visibleAccountIds.has(id)) {
      const entry = panels.get(id);
      if (!entry) continue;
      // Overlay hide is not suspension — only park/schedule when truly off-page
      if (areOverlaysActive()) continue;
      if (keepRunningInBackground(id)) {
        clearSuspendTimer(id);
        parkPanelOffscreen(entry);
      } else {
        setViewVisible(entry, false);
        scheduleSuspend(id);
      }
    }
  }

  // Stagger create+load for newly visible panels
  const needCreate = lastSlots
    .filter((s) => Number(s.width) > 1 && Number(s.height) > 1)
    .map((s) => s.accountId)
    .filter((id) => !panels.has(id));
  if (needCreate.length > 1) {
    // Create first with bounds via applySlotBounds path that uses queue
    for (const id of needCreate) {
      deferNextCreateLoad = true;
      createPanel(id);
      deferNextCreateLoad = false;
    }
    applySlotBounds(lastSlots);
    enqueueVisibleLoads(needCreate);
  } else {
    applySlotBounds(lastSlots);
  }
  applyThrottling();
  // Re-assert no-throttle for parked keep-running panels after Chromium reacts to bounds
  for (const id of panels.keys()) {
    const entry = panels.get(id);
    if (entry && entry.parked) forceNoThrottle(id);
  }
  setTimeout(() => {
    for (const id of panels.keys()) {
      const entry = panels.get(id);
      if (entry && entry.parked) forceNoThrottle(id);
    }
  }, 100);
  emitSuspendedState();
}

function getPanelDebugInfo() {
  const out = [];
  for (const [accountId, entry] of panels) {
    let bounds = { x: 0, y: 0, width: 0, height: 0 };
    let url = '';
    try {
      bounds = entry.view.getBounds();
    } catch {
      /* ignore */
    }
    try {
      url = entry.view.webContents.getURL();
    } catch {
      /* ignore */
    }
    let visible = !!entry.visible;
    try {
      if (typeof entry.view.getVisible === 'function') {
        visible = entry.view.getVisible();
      }
    } catch {
      /* keep tracked flag */
    }
    out.push({
      accountId,
      bounds,
      visible,
      parked: !!entry.parked,
      url,
      attached: true,
    });
  }
  return {
    overlayCount: getOverlayCount(),
    overlayIds: [...activeOverlays],
    lastSlots: lastSlots.map((s) => ({ ...s })),
    panels: out,
  };
}

function snapshotVisiblePanelBounds() {
  /** @type {Record<string, { x: number, y: number, width: number, height: number, visible: boolean, attached: boolean }>} */
  const map = {};
  for (const id of visibleAccountIds) {
    const entry = panels.get(id);
    if (!entry) {
      map[id] = { x: 0, y: 0, width: 0, height: 0, visible: false, attached: false };
      continue;
    }
    let bounds = { x: 0, y: 0, width: 0, height: 0 };
    try {
      bounds = entry.view.getBounds();
    } catch {
      /* ignore */
    }
    let visible = !!entry.visible;
    try {
      if (typeof entry.view.getVisible === 'function') visible = entry.view.getVisible();
    } catch {
      /* ignore */
    }
    map[id] = { ...bounds, visible, attached: true };
  }
  return map;
}

function compareBoundsMaps(before, after) {
  const ids = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const id of ids) {
    const a = before[id];
    const b = after[id];
    if (!a || !b) return false;
    if (!a.attached || !b.attached) return false;
    if (!!a.visible !== !!b.visible) return false;
    if (
      a.x !== b.x ||
      a.y !== b.y ||
      a.width !== b.width ||
      a.height !== b.height
    ) {
      return false;
    }
  }
  return true;
}

function hideAllPanels() {
  for (const id of [...panels.keys()]) {
    scheduleSuspend(id);
  }
}

function panelGoHome(accountId) {
  const account = getAccount(accountId);
  if (!account) return;
  const url = homeUrlFor(account);
  panelNavigate(accountId, url);
}

function openLoginInSystemBrowser(accountId) {
  const entry = panels.get(accountId);
  let url = '';
  try {
    if (entry) url = entry.view.webContents.getURL();
  } catch {
    /* ignore */
  }
  if (!url) {
    const acc = getAccount(accountId);
    url = (acc && (acc.lastUrl || acc.startUrl)) || '';
  }
  if (url && /^https?:/i.test(url)) {
    shell.openExternal(url).catch(() => {});
    return { ok: true, url };
  }
  return { ok: false, url };
}

function getAccountSessions() {
  const out = [];
  const seen = new Set();
  for (const acc of getState().accounts || []) {
    const part = partitionFor(acc.id);
    if (seen.has(part)) continue;
    seen.add(part);
    try {
      out.push(session.fromPartition(part));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function panelNavigate(accountId, url) {
  const normalized = normalizeUrl(url);
  if (!normalized || !isNavigableUrl(normalized)) return;
  forceSuspended.delete(accountId);
  touchAccount(accountId);
  setFocusedAccount(accountId);
  let entry = panels.get(accountId);
  if (!entry) entry = createPanel(accountId);
  if (!entry) return;
  entry.view.webContents.loadURL(normalized).catch(() => {});
}

function panelBack(accountId) {
  touchAccount(accountId);
  setFocusedAccount(accountId);
  const entry = panels.get(accountId);
  if (entry && canGoBack(entry.view.webContents)) goBack(entry.view.webContents);
}

function panelForward(accountId) {
  touchAccount(accountId);
  setFocusedAccount(accountId);
  const entry = panels.get(accountId);
  if (entry && canGoForward(entry.view.webContents)) goForward(entry.view.webContents);
}

function panelReload(accountId) {
  touchAccount(accountId);
  setFocusedAccount(accountId);
  const entry = panels.get(accountId);
  if (entry) entry.view.webContents.reload();
}

function panelHardReload(accountId) {
  touchAccount(accountId);
  setFocusedAccount(accountId);
  const entry = panels.get(accountId);
  if (entry) entry.view.webContents.reloadIgnoringCache();
}

function panelOpenDevTools(accountId) {
  const entry = panels.get(accountId);
  if (entry && !entry.view.webContents.isDestroyed()) {
    entry.view.webContents.openDevTools({ mode: 'detach' });
  }
}

function panelZoom(accountId, delta) {
  const entry = panels.get(accountId);
  if (!entry) return 1;
  const wc = entry.view.webContents;
  const cur = wc.getZoomFactor();
  const next =
    delta === 0 ? 1 : Math.min(3, Math.max(0.25, Math.round((cur + delta) * 100) / 100));
  try {
    wc.setZoomFactor(next);
  } catch {
    /* ignore */
  }
  updateState((s) => {
    const acc = s.accounts.find((a) => a.id === accountId);
    if (acc) acc.zoomFactor = next;
  });
  emitToRenderer({ type: 'panel:zoom-changed', accountId, zoom: next });
  return next;
}

function panelGetZoom(accountId) {
  const entry = panels.get(accountId);
  if (entry && !entry.view.webContents.isDestroyed()) {
    try {
      return entry.view.webContents.getZoomFactor();
    } catch {
      /* ignore */
    }
  }
  const acc = getAccount(accountId);
  const z = acc && Number(acc.zoomFactor);
  return Number.isFinite(z) ? z : 1;
}

function panelReloadAll(workspaceId) {
  const s = getState();
  const ws = workspaceId || s.activeWorkspaceId;
  for (const acc of s.accounts || []) {
    if (acc.workspaceId === ws && panels.has(acc.id)) {
      panelReload(acc.id);
    }
  }
}

function panelMuteAll(muted, workspaceId) {
  const s = getState();
  const ws = workspaceId || s.activeWorkspaceId;
  for (const acc of s.accounts || []) {
    if (acc.workspaceId === ws) {
      panelSetMuted(acc.id, !!muted);
    }
  }
}

function panelCanGoBack(accountId) {
  const entry = panels.get(accountId);
  return entry ? canGoBack(entry.view.webContents) : false;
}

function panelCanGoForward(accountId) {
  const entry = panels.get(accountId);
  return entry ? canGoForward(entry.view.webContents) : false;
}

function panelSetMuted(accountId, muted) {
  updateState((s) => {
    const acc = s.accounts.find((a) => a.id === accountId);
    if (acc) acc.muted = !!muted;
  });
  const entry = panels.get(accountId);
  if (entry) entry.view.webContents.setAudioMuted(!!muted);
  notifyNav(accountId);
}

/**
 * Throttling rules (v1.3 + v1.8 presets):
 * - Never throttle the focused panel (unless frameCapAll).
 * - Presets: balanced (default) / always (all active) / max-save (throttle+suspend hidden).
 * - User FPS throttle when settings.backgroundThrottling is ON.
 */
function applyThrottlingTo(accountId) {
  const entry = panels.get(accountId);
  if (!entry) return;
  const settings = getState().settings;
  const wc = entry.view.webContents;
  const isFocused = focusedAccountId === accountId;
  const isOnScreen = visibleAccountIds.has(accountId) && !entry.parked;
  const acc = getAccount(accountId);
  const pauseBg = !!(acc && acc.pauseInBackground);
  const preset = settings.backgroundPreset || 'balanced';
  const keepBg =
    preset === 'always'
      ? true
      : preset === 'max-save'
        ? false
        : settings.keepBackgroundRunning !== false;
  const userThrottle = !!settings.backgroundThrottling || preset === 'max-save';
  const fps = Math.max(1, Number(settings.backgroundFps) || 5);
  const capHidden = Math.max(1, Number(settings.frameCapHidden) || 30);
  const capAll = Number(settings.frameCapAll) || 0;

  let shouldThrottle = false;
  if (preset === 'always') {
    shouldThrottle = false;
  } else if (!isFocused) {
    if (!isOnScreen) {
      if (pauseBg || !keepBg || preset === 'max-save') shouldThrottle = true;
      else if (userThrottle) shouldThrottle = false;
    } else if (userThrottle) {
      shouldThrottle = true;
    }
  }

  try {
    if (typeof wc.setBackgroundThrottling === 'function') {
      wc.setBackgroundThrottling(shouldThrottle);
    }
  } catch {
    /* ignore */
  }

  try {
    if (typeof wc.setFrameRate === 'function') {
      if (capAll > 0) {
        wc.setFrameRate(capAll);
      } else if (shouldThrottle && userThrottle) {
        wc.setFrameRate(fps);
      } else if (shouldThrottle && (pauseBg || !keepBg || preset === 'max-save')) {
        wc.setFrameRate(Math.min(fps, capHidden, 5));
      } else if (!isOnScreen && keepBg) {
        wc.setFrameRate(capHidden);
      } else {
        wc.setFrameRate(60);
      }
    }
  } catch {
    /* setFrameRate may be unavailable for on-screen views */
  }
}

function applyThrottling() {
  for (const id of panels.keys()) applyThrottlingTo(id);
}

async function clearAccountSession(accountId) {
  destroyPanel(accountId, { keepLastUrl: false });
  forceSuspended.delete(accountId);
  lastUsedAt.delete(accountId);
  const ses = session.fromPartition(partitionFor(accountId));
  await ses.clearStorageData();
  try {
    await ses.clearCache();
  } catch {
    /* ignore */
  }
  emitSuspendedState();
}

async function clearAllPartitionCaches() {
  const st = getState();
  const seen = new Set();
  for (const acc of st.accounts) {
    const part = partitionFor(acc.id);
    if (seen.has(part)) continue;
    seen.add(part);
    const ses = session.fromPartition(part);
    try {
      await ses.clearCache();
    } catch {
      /* ignore */
    }
  }
  try {
    await session.defaultSession.clearCache();
  } catch {
    /* ignore */
  }
}

/**
 * @param {{ hiddenOnly?: boolean }} [opts]
 */
function hintGarbageCollection(opts = {}) {
  const hiddenOnly = !!opts.hiddenOnly;
  for (const [id, entry] of panels) {
    if (hiddenOnly && visibleAccountIds.has(id) && !entry.parked) continue;
    try {
      const wc = entry.view.webContents;
      if (typeof wc.invalidate === 'function') wc.invalidate();
    } catch {
      /* ignore */
    }
  }
  try {
    if (typeof global.gc === 'function') global.gc();
  } catch {
    /* ignore */
  }
}

function getPanelCapture(accountId) {
  const entry = panels.get(accountId);
  if (!entry) return null;
  return entry.view.webContents;
}

function destroyAllPanels() {
  for (const id of [...panels.keys()]) {
    destroyPanel(id, { keepLastUrl: true });
  }
}

function listActivePanelIds() {
  return [...panels.keys()];
}

/**
 * True if webContents belongs to a panel, login popup, or same account session
 * (extension action/options windows share persist:acc-* partitions).
 * @param {import('electron').WebContents | null | undefined} wc
 */
function isPanelWebContents(wc) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
  for (const entry of panels.values()) {
    try {
      if (entry.view && entry.view.webContents === wc) return true;
    } catch {
      /* ignore */
    }
  }
  for (const win of childPopups) {
    try {
      if (win && !win.isDestroyed() && win.webContents === wc) return true;
    } catch {
      /* ignore */
    }
  }
  try {
    const ses = wc.session;
    if (!ses) return false;
    const ids = new Set(panels.keys());
    for (const acc of getState().accounts || []) {
      if (acc && acc.id) ids.add(acc.id);
    }
    for (const id of ids) {
      try {
        if (session.fromPartition(partitionFor(id)) === ses) return true;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

module.exports = {
  initPanels,
  createPanel,
  destroyPanel,
  syncVisiblePanels,
  hideAllPanels,
  panelNavigate,
  panelGoHome,
  panelBack,
  panelForward,
  panelReload,
  panelHardReload,
  panelOpenDevTools,
  panelZoom,
  panelGetZoom,
  panelReloadAll,
  panelMuteAll,
  panelCanGoBack,
  panelCanGoForward,
  panelSetMuted,
  clearAccountSession,
  getPanelCapture,
  destroyAllPanels,
  listActivePanelIds,
  isPanelWebContents,
  partitionFor,
  normalizeUrl,
  chromeUserAgent,
  homeUrlFor,
  openLoginInSystemBrowser,
  openLoginPopup,
  getAccountSessions,
  touchAccount,
  setFocusedAccount,
  getFocusedAccountId,
  getLastUsedAt,
  getForceSuspendedIds,
  getVisibleAccountIds,
  isPanelActive,
  isForceSuspended,
  suspendForMemory,
  reactivatePanel,
  applyThrottling,
  clearAllPartitionCaches,
  hintGarbageCollection,
  setOverlay,
  setOverlayCount,
  getOverlayCount,
  areOverlaysActive,
  getPanelDebugInfo,
  getMainUiProcessId,
  enableViewMutationLog,
  clearViewMutationLog,
  getViewMutationLog,
  snapshotVisiblePanelBounds,
  compareBoundsMaps,
  repaintPanel,
  keepRunningInBackground,
  forceNoThrottle,
  getPanelFps,
  getOverlaySnapshotMap,
  captureVisibleSnapshots,
  prepareAndParkForOverlay,
  clearOverlaySnapshots,
  childPopups,
};
