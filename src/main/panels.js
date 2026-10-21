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
  isAboutBlank,
  isSelftestOfflineMode,
  isSelftestAllowedUrl,
  sanitizeUserStartUrl,
} = require('./url-policy');
const history = require('./history');
const downloads = require('./downloads');
const adblock = require('./adblock');
const userAgent = require('./user-agent');
const sessionPersist = require('./session-persist');
const permissions = require('./permissions');
const chromeFullscreen = require('./chrome-fullscreen');
const extensions = require('./extensions');
const contextMenu = require('./context-menu');
const volumeControl = require('./volume-control');
const popoverOverlay = require('./popover-overlay');
const unread = require('./unread');
const partition = require('./partition');

/** @type {Map<string, { view: import('electron').WebContentsView, accountId: string, visible: boolean, parked: boolean }>} */
const panels = new Map();

/**
 * Selftest spies for park/capture/hide while small popovers are open
 * (MULTIHEIZ_SELFTEST only).
 * @type {Array<{ at: number, op: string, detail?: object }>}
 */
let overlaySelftestSpies = [];

function clearOverlaySelftestSpies() {
  overlaySelftestSpies = [];
}

function getOverlaySelftestSpies() {
  return overlaySelftestSpies.slice();
}

function noteOverlaySpy(op, detail) {
  if (!process.env.MULTIHEIZ_SELFTEST) return;
  overlaySelftestSpies.push({ at: Date.now(), op, detail: detail || undefined });
}

/** Apply WebRTC IP policy once per WebContents (not per navigation). */
/** @type {WeakSet<import('electron').WebContents>} */
const webRtcPolicyApplied = new WeakSet();

/**
 * WebRTC IP handling — avoids Chromium binding host-candidate UDP on every
 * LAN interface (Windows Firewall prompt when opening X/Meet/etc.).
 * Prefer default_public_interface_only (STUN/TURN still work) over
 * disable_non_proxied_udp (would break direct UDP calls).
 * Env MULTIHEIZ_WEBRTC_IP_POLICY overrides; MULTIHEIZ_SOCKETS_MEASURE skips
 * the production default so check:sockets can compare variants.
 * Called only when creating a panel/popup — never on did-navigate.
 * @param {import('electron').WebContents} wc
 */
function applyWebRtcIpHandlingPolicy(wc) {
  if (!wc || wc.isDestroyed()) return;
  if (webRtcPolicyApplied.has(wc)) return;
  try {
    const measure = process.env.MULTIHEIZ_SOCKETS_MEASURE === '1';
    const override = process.env.MULTIHEIZ_WEBRTC_IP_POLICY || '';
    let policy = override;
    if (!policy && !measure) {
      policy = 'default_public_interface_only';
    }
    if (!policy) return;
    if (typeof wc.setWebRTCIPHandlingPolicy === 'function') {
      wc.setWebRTCIPHandlingPolicy(
        /** @type {'default'|'default_public_interface_only'|'default_public_and_private_interfaces'|'disable_non_proxied_udp'} */ (
          policy
        )
      );
      webRtcPolicyApplied.add(wc);
    }
  } catch (err) {
    console.warn(
      '[panels] setWebRTCIPHandlingPolicy',
      err && err.message ? err.message : err
    );
  }
}

/** Contas com áudio tocando (indicador na UI). */
/** @type {Set<string>} */
const audibleAccounts = new Set();

/** Accounts being removed (clear session / state); layout:sync must not recreate them. */
/** @type {Set<string>} */
const removingAccounts = new Set();

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

/** @type {() => object} */
let getPublicState = () => getState();

/**
 * Overlay ids currently open in the renderer (modals, popovers, menus).
 * Toasts must NOT be registered here (v1.3 — they caused Liberar memória flicker).
 */
/** @type {Set<string>} */
const activeOverlays = new Set();

/** Last layout slots from the renderer (kept while overlays hide views). */
/** @type {Array<{ accountId: string, x: number, y: number, width: number, height: number }>} */
let lastSlots = [];

/**
 * Sidebar auto-hide overlay inset (CSS px). When > 0 the HTML sidebar is shown as an
 * overlay on the left; WebContentsViews sit above HTML so we must clear that strip.
 *
 * Strategy (shift-x, keep width — no page reflow):
 * - Logical slots / lastBounds stay as measured by the renderer (full panel area).
 * - For views that overlap [0, overlayW), setBounds moves x to overlayW and keeps the
 *   same width (the view may extend past the window's right edge and be clipped).
 * - Shrinking width would reflow the web viewport; shifting keeps viewport size stable.
 * - Visual: panel surface slides right while the sidebar occupies the freed strip
 *   (not a perfect "cover", but avoids reflow and flicker).
 * @type {number}
 */
let sidebarOverlayWidth = 0;

/** Last on-screen size for parking hidden panels offscreen. */
/** @type {Map<string, { width: number, height: number }>} */
const lastOnScreenSize = new Map();

/** Snapshot dataURLs shown behind modals while views are parked (v1.4). */
/** @type {Map<string, string>} */
const overlaySnapshots = new Map();
/** LRU order for overlaySnapshots (newest at end). */
/** @type {string[]} */
let overlaySnapshotLru = [];
const OVERLAY_SNAPSHOT_MAX = 6;
const OVERLAY_SNAPSHOT_MAX_WIDTH = 640;
const OVERLAY_SNAPSHOT_JPEG_QUALITY = 70;
/** Soft cap on dataURL length (~JPEG at 640px is well under this). */
const OVERLAY_SNAPSHOT_MAX_CHARS = 1_200_000;

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

/** Coalesce panel:nav emits (title/SPA in-page) — evita inundar o renderer da UI. */
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const navNotifyTimers = new Map();
const NAV_NOTIFY_THROTTLE_MS = 250;

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

/**
 * Login/OAuth popups keyed by accountId → frameName → BrowserWindow.
 * Used to reuse/focus instead of piling blank GIS windows on repeated clicks.
 * @type {Map<string, Map<string, import('electron').BrowserWindow>>}
 */
const loginPopupsByAccount = new Map();

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

/**
 * @param {import('electron').BrowserWindow} win
 * @param {(payload: object) => void} emit
 * @param {{ getPublicState?: () => object }} [opts]
 */
function initPanels(win, emit, opts) {
  mainWindow = win;
  emitToRenderer = emit;
  if (opts && typeof opts.getPublicState === 'function') {
    getPublicState = opts.getPublicState;
  }
  volumeControl.installVolumeIpc({
    resolveAccountIdFromWebContents: accountIdForWebContents,
    getAccount,
  });
}

/**
 * Abre http(s) em nova janela MultiHeiz (mesma ideia de window.open / target=_blank
 * com blankLinkMode new-panel / favoritos em janela nova).
 * @param {string} fromAccountId
 * @param {string} url
 * @returns {{ ok: boolean, reason?: string, windowId?: string }}
 */
function openUrlInNewPanel(fromAccountId, url) {
  const raw = String(url || '').trim();
  if (!isNavigableUrl(raw) || classifyScheme(raw) !== 'web') {
    return { ok: false, reason: 'blocked-scheme' };
  }
  const st = getState();
  const id =
    'acc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const colors = ['#2bb8a6', '#3d8bfd', '#e8a54b', '#e83e8c', '#6f42c1', '#20c997'];
  const from = getAccount(fromAccountId);
  const account = {
    id,
    name: 'Janela',
    color: colors[(st.accounts || []).length % colors.length],
    startUrl: sanitizeUserStartUrl(raw, 'https://www.google.com'),
    workspaceId: (from && from.workspaceId) || st.activeWorkspaceId,
    muted: false,
    volume: 100,
    pauseInBackground: false,
    keepAliveInBackground: false,
    privateHistory: false,
    adblockEnabled: true,
    showUnread: true,
    lastUrl: null,
    zoomFactor: 1,
  };
  updateState((s) => {
    s.accounts.push(account);
  });
  try {
    emitToRenderer({ type: 'state:changed', state: getPublicState() });
  } catch {
    /* ignore */
  }
  panelNavigate(id, raw);
  return { ok: true, windowId: id };
}

/**
 * Liga menu de contexto nativo a um webContents de painel/popup.
 * @param {import('electron').WebContents} wc
 * @param {string} accountId
 */
function wireContextMenu(wc, accountId) {
  if (!wc) return;
  contextMenu.attachContextMenu(wc, {
    getWindow: () => mainWindow,
    getViewBounds: () => {
      const entry = panels.get(accountId);
      if (!entry || !entry.view) return { x: 0, y: 0, width: 0, height: 0 };
      try {
        return entry.view.getBounds();
      } catch {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
    },
    getZoomFactor: () => {
      try {
        if (wc && !wc.isDestroyed() && typeof wc.getZoomFactor === 'function') {
          return wc.getZoomFactor();
        }
      } catch {
        /* ignore */
      }
      return 1;
    },
    openInNewWindow: (url) => {
      openUrlInNewPanel(accountId, url);
    },
  });
}

function getOverlayCount() {
  return activeOverlays.size;
}

/** Modal overlays that park panel views + snapshots (not light popovers). */
function getModalOverlayCount() {
  let n = 0;
  for (const id of activeOverlays) {
    if (!popoverOverlay.isLightOverlayId(id)) n += 1;
  }
  return n;
}

function areOverlaysActive() {
  // Light popovers use a dedicated transparent WebContentsView — never park panels.
  return getModalOverlayCount() > 0;
}

/**
 * @param {number} px Left overlay width in CSS px (0 = no sidebar overlay).
 */
function setSidebarOverlayWidth(px) {
  const next = Math.max(0, Math.round(Number(px) || 0));
  if (next === sidebarOverlayWidth) return;
  sidebarOverlayWidth = next;
  if (lastSlots.length) {
    applySlotBounds(lastSlots);
  }
}

function getSidebarOverlayWidth() {
  return sidebarOverlayWidth;
}

/**
 * Map a logical slot to on-screen view bounds under the sidebar overlay strategy.
 * @param {{ x: number, y: number, width: number, height: number }} slot
 * @param {number} overlayW
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 *   null => fully covered (caller should park/hide)
 */
function viewBoundsForSidebarOverlay(slot, overlayW) {
  const x = Math.round(Number(slot.x) || 0);
  const y = Math.round(Number(slot.y) || 0);
  const width = Math.round(Number(slot.width) || 0);
  const height = Math.round(Number(slot.height) || 0);
  if (!(overlayW > 0) || width < 1 || height < 1) {
    return { x, y, width, height };
  }
  const right = x + width;
  if (right <= overlayW) {
    return null;
  }
  if (x >= overlayW) {
    return { x, y, width, height };
  }
  // Overlaps left strip: shift origin, keep width (may clip on the right).
  return { x: overlayW, y, width, height };
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
 * Downscale + JPEG compress a capture for overlay backdrop memory.
 * @param {Electron.NativeImage} img
 * @returns {string|null} data URL or null
 */
function compressSnapshotImage(img) {
  if (!img || img.isEmpty()) return null;
  let work = img;
  try {
    const size = img.getSize();
    const w = size && size.width ? size.width : 0;
    if (w > OVERLAY_SNAPSHOT_MAX_WIDTH) {
      const scale = OVERLAY_SNAPSHOT_MAX_WIDTH / w;
      const h = Math.max(1, Math.round((size.height || 1) * scale));
      if (typeof img.resize === 'function') {
        work = img.resize({ width: OVERLAY_SNAPSHOT_MAX_WIDTH, height: h, quality: 'better' });
      }
    }
  } catch {
    work = img;
  }
  try {
    if (typeof work.toJPEG === 'function') {
      const buf = work.toJPEG(OVERLAY_SNAPSHOT_JPEG_QUALITY);
      if (buf && buf.length) {
        const dataUrl = 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64');
        if (dataUrl.length <= OVERLAY_SNAPSHOT_MAX_CHARS) return dataUrl;
      }
    }
  } catch {
    /* fall through to PNG dataURL */
  }
  try {
    const dataUrl = work.toDataURL();
    if (dataUrl && dataUrl.length <= OVERLAY_SNAPSHOT_MAX_CHARS) return dataUrl;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Capture visible on-screen panels for overlay backdrop (parallel, ~150 ms each).
 * @returns {Promise<Array<{ accountId: string, dataUrl: string|null, color: string }>>}
 */
async function captureVisibleSnapshots() {
  noteOverlaySpy('capturePage');
  // Sequential + yield between panels so the main event loop stays responsive
  // (Promise.all of N capturePage+JPEG used to spike lag when opening modals).
  const out = [];
  for (const slot of lastSlots) {
    const accountId = slot.accountId;
    const acc = getAccount(accountId);
    const color = (acc && acc.color) || '#2bb8a6';
    const entry = panels.get(accountId);
    if (!entry || entry.parked || !entry.visible) {
      out.push({ accountId, dataUrl: null, color });
      continue;
    }
    try {
      const img = await withTimeout(entry.view.webContents.capturePage(), CAPTURE_TIMEOUT_MS);
      await new Promise((r) => setImmediate(r));
      const dataUrl = compressSnapshotImage(img);
      out.push({ accountId, dataUrl, color });
    } catch {
      out.push({ accountId, dataUrl: null, color });
    }
    await new Promise((r) => setImmediate(r));
  }
  return out;
}

function touchSnapshotLru(accountId) {
  overlaySnapshotLru = overlaySnapshotLru.filter((id) => id !== accountId);
  overlaySnapshotLru.push(accountId);
  while (overlaySnapshotLru.length > OVERLAY_SNAPSHOT_MAX) {
    const evict = overlaySnapshotLru.shift();
    if (evict) overlaySnapshots.delete(evict);
  }
}

function emitOverlaySnapshots(list) {
  overlaySnapshots.clear();
  overlaySnapshotLru = [];
  const payload = [];
  for (const item of list || []) {
    if (item.dataUrl) {
      overlaySnapshots.set(item.accountId, item.dataUrl);
      touchSnapshotLru(item.accountId);
    }
    // After LRU eviction, drop dataUrl from payload if evicted
    const kept = item.dataUrl && overlaySnapshots.has(item.accountId) ? item.dataUrl : null;
    payload.push({
      accountId: item.accountId,
      dataUrl: kept,
      color: item.color,
    });
  }
  emitToRenderer({ type: 'overlay:snapshots', snapshots: payload });
}

function clearOverlaySnapshots() {
  overlaySnapshots.clear();
  overlaySnapshotLru = [];
  emitToRenderer({ type: 'overlay:snapshots', snapshots: [] });
}

/** @returns {{ count: number, max: number, maxChars: number, maxWidth: number }} */
function getOverlaySnapshotDebug() {
  let maxChars = 0;
  for (const url of overlaySnapshots.values()) {
    if (url && url.length > maxChars) maxChars = url.length;
  }
  return {
    count: overlaySnapshots.size,
    max: OVERLAY_SNAPSHOT_MAX,
    maxChars,
    maxWidth: OVERLAY_SNAPSHOT_MAX_WIDTH,
    lru: overlaySnapshotLru.slice(),
  };
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
  // Toasts / light popovers must never hide panel views
  if (key === 'toast' || key.startsWith('toast:')) {
    return getOverlayCount();
  }
  if (popoverOverlay.isLightOverlayId(key)) {
    // Track for diagnostics only — never park/snapshot
    if (active) activeOverlays.add(key);
    else activeOverlays.delete(key);
    return getOverlayCount();
  }
  const beforeModal = getModalOverlayCount();
  if (active) activeOverlays.add(key);
  else activeOverlays.delete(key);
  const afterModal = getModalOverlayCount();
  if (beforeModal === 0 && afterModal > 0) {
    const epoch = ++overlayParkEpoch;
    await prepareAndParkForOverlay(epoch);
  } else if (beforeModal > 0 && afterModal === 0) {
    overlayParkEpoch += 1;
    restoreViewsAfterOverlay();
  }
  return activeOverlays.size;
}

async function setOverlayCount(ids) {
  const beforeModal = getModalOverlayCount();
  activeOverlays.clear();
  if (Array.isArray(ids)) {
    for (const id of ids) {
      const key = String(id || '').trim();
      if (!key || key === 'toast' || key.startsWith('toast:')) continue;
      activeOverlays.add(key);
    }
  }
  const afterModal = getModalOverlayCount();
  if (beforeModal === 0 && afterModal > 0) {
    const epoch = ++overlayParkEpoch;
    await prepareAndParkForOverlay(epoch);
  } else if (afterModal === 0 && beforeModal > 0) {
    overlayParkEpoch += 1;
    restoreViewsAfterOverlay();
  }
  return activeOverlays.size;
}

async function prepareAndParkForOverlay(epoch) {
  noteOverlaySpy('prepareAndParkForOverlay');
  const snaps = await captureVisibleSnapshots();
  // Overlay may have closed while capture was in flight — do not park/stuck-snap
  if (getModalOverlayCount() === 0) return;
  if (epoch != null && epoch !== overlayParkEpoch) return;
  emitOverlaySnapshots(snaps);
  parkViewsForOverlay();
}

/**
 * Park every attached view offscreen so modals are not covered, while media keeps running.
 */
function parkViewsForOverlay() {
  noteOverlaySpy('parkViewsForOverlay');
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
  if (!next) noteOverlaySpy('setVisible(false)', { accountId: entry.accountId });
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

/**
 * Partição Chromium da janela (`persist:acc-<partitionId>`).
 * Se a conta compartilha sessão, partitionId pode apontar para outra janela.
 * @param {string} accountId
 * @returns {string}
 */
function partitionFor(accountId) {
  const acc = getAccount(accountId);
  if (acc) return partition.partitionForAccount(acc);
  return partition.partitionString(accountId);
}

/**
 * partitionId efetivo da janela (padrão = accountId).
 * @param {string} accountId
 * @returns {string}
 */
function resolvePartitionId(accountId) {
  const acc = getAccount(accountId);
  if (acc) return partition.resolvePartitionId(acc);
  return String(accountId || '');
}

function chromeUserAgent() {
  return userAgent.buildChromeUserAgent();
}

function isOauthOrLoginUrl(url) {
  if (isKnownIdentityProviderUrl(url)) return true;
  // Selftest: mock GIS/OAuth em http://127.0.0.1/…/mock-accounts/… (nunca em produção).
  if (
    process.env.MULTIHEIZ_SELFTEST &&
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/mock-accounts\//i.test(String(url || ''))
  ) {
    return true;
  }
  return false;
}

/**
 * GIS/OAuth often opens about:blank (or '') with size features, then navigates.
 * @param {string} url
 * @param {string} [disposition]
 * @param {string} [features]
 */
function isLoginStylePopup(url, disposition, features) {
  if (isOauthOrLoginUrl(url)) return true;
  if (!isAboutBlank(url)) return false;
  if (disposition === 'new-window') return true;
  const f = String(features || '');
  return /\b(width|height)\s*=/i.test(f);
}

/**
 * @param {string} accountId
 * @returns {Map<string, import('electron').BrowserWindow>}
 */
function loginPopupMapFor(accountId) {
  let m = loginPopupsByAccount.get(accountId);
  if (!m) {
    m = new Map();
    loginPopupsByAccount.set(accountId, m);
  }
  return m;
}

/**
 * Reuse an open login popup for the same account (+ frameName when set).
 * @param {string} accountId
 * @param {string} [frameName]
 */
function findReusableLoginPopup(accountId, frameName) {
  const m = loginPopupsByAccount.get(accountId);
  if (!m) return null;
  const name = String(frameName || '');
  const named = m.get(name);
  if (named && !named.isDestroyed()) return named;
  // _blank / empty: avoid piling windows on repeated GIS clicks
  if (!name || name === '_blank') {
    for (const w of m.values()) {
      if (w && !w.isDestroyed()) return w;
    }
  }
  return null;
}

/**
 * @param {string} accountId
 * @param {string} frameName
 * @param {import('electron').BrowserWindow} win
 */
function trackLoginPopup(accountId, frameName, win) {
  const m = loginPopupMapFor(accountId);
  const key = String(frameName || '');
  m.set(key, win);
  childPopups.add(win);
  win.on('closed', () => {
    childPopups.delete(win);
    const map = loginPopupsByAccount.get(accountId);
    if (map) {
      for (const [k, v] of [...map.entries()]) {
        if (v === win) map.delete(k);
      }
      if (map.size === 0) loginPopupsByAccount.delete(accountId);
    }
    emitToRenderer({ type: 'toast', message: 'Login fechado — voltando ao painel' });
  });
}

/**
 * BrowserWindow options for GIS/OAuth popups (same partition as the panel).
 * @param {Electron.Session} ses
 */
function loginPopupBrowserOptions(ses) {
  return {
    width: 520,
    height: 720,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
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
  };
}

/**
 * Bind adblock/permissions/UA + nested window.open for a login popup.
 * Keeps header UA, webContents UA and navigator patch consistent (Electron UA
 * on accounts.google.com so Botguard does not show "may not be secure").
 * @param {string} accountId
 * @param {import('electron').BrowserWindow} child
 * @param {Electron.Session} ses
 * @param {string} [initialUrl]
 */
function wireLoginPopupWindow(accountId, child, ses, initialUrl) {
  if (!child || child.isDestroyed()) return;
  permissions.attachToSession(ses, accountId);
  userAgent.applySessionUserAgent(ses);
  try {
    adblock.attachSession(ses, accountId);
  } catch {
    /* ignore */
  }
  try {
    adblock.bindWebContents(accountId, child.webContents);
  } catch {
    /* ignore */
  }
  applyWebRtcIpHandlingPolicy(child.webContents);

  const applyUaForUrl = (navUrl) => {
    try {
      if (userAgent.isGoogleAuthUrl(navUrl)) {
        child.webContents.setUserAgent(userAgent.buildGoogleAuthUserAgent());
      } else {
        child.webContents.setUserAgent(chromeUserAgent());
      }
    } catch {
      /* ignore */
    }
  };
  applyUaForUrl(initialUrl || '');

  child.webContents.on('did-navigate', (_e, navUrl) => applyUaForUrl(navUrl));
  child.webContents.on('did-navigate-in-page', (_e, navUrl) => applyUaForUrl(navUrl));

  child.webContents.on('will-navigate', (e, navUrl) => {
    if (!isNavigableUrl(navUrl, { allowData: allowInternalDataUrls() })) {
      e.preventDefault();
    }
  });
  child.webContents.on('will-redirect', (e, navUrl) => {
    if (!isNavigableUrl(navUrl, { allowData: allowInternalDataUrls() })) {
      e.preventDefault();
    }
  });

  // Nested popups from the login window (account chooser → consent, etc.)
  child.webContents.setWindowOpenHandler((details) =>
    handlePanelWindowOpen(accountId, details, ses, child.webContents)
  );
  child.webContents.on('did-create-window', (nested, details) => {
    onDidCreateLoginWindow(accountId, nested, ses, details);
  });
  wireContextMenu(child.webContents, accountId);
}

/**
 * @param {string} accountId
 * @param {import('electron').BrowserWindow} childWin
 * @param {Electron.Session} ses
 * @param {{ url?: string, frameName?: string }} [details]
 */
function onDidCreateLoginWindow(accountId, childWin, ses, details) {
  if (!childWin || childWin.isDestroyed()) return;
  trackLoginPopup(accountId, (details && details.frameName) || '', childWin);
  wireLoginPopupWindow(accountId, childWin, ses, (details && details.url) || '');
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
 * GIS/OAuth: action 'allow' so Chromium keeps window.opener (postMessage back).
 * @param {string} accountId
 * @param {string|{ url?: string, frameName?: string, features?: string, disposition?: string }} detailsOrUrl
 * @param {Electron.Session} ses
 * @param {import('electron').WebContents} wc
 */
function handlePanelWindowOpen(accountId, detailsOrUrl, ses, wc) {
  const details =
    typeof detailsOrUrl === 'string'
      ? { url: detailsOrUrl, frameName: '', features: '', disposition: 'new-window' }
      : detailsOrUrl || {};
  const url = String(details.url || '');
  const frameName = String(details.frameName || '');
  const features = String(details.features || '');
  const disposition = String(details.disposition || '');

  const kind = classifyScheme(isAboutBlank(url) ? 'about:blank' : url);
  if (kind === 'blocked') {
    return { action: 'deny' };
  }
  if (kind === 'external') {
    confirmOpenExternal(url).catch(() => {});
    return { action: 'deny' };
  }

  // GIS/OAuth: keep opener via Chromium-owned popup (not a detached BrowserWindow).
  if (isLoginStylePopup(url, disposition, features)) {
    const existing = findReusableLoginPopup(accountId, frameName);
    if (existing && !existing.isDestroyed()) {
      try {
        existing.focus();
      } catch {
        /* ignore */
      }
      // Named target: Chromium would reuse on allow; for _blank pile-up we deny
      // and optionally navigate the existing window to the new IdP URL.
      if (url && !isAboutBlank(url) && isNavigableUrl(url)) {
        try {
          const cur = existing.webContents.getURL();
          if (cur !== url) existing.loadURL(url).catch(() => {});
        } catch {
          existing.loadURL(url).catch(() => {});
        }
      }
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: loginPopupBrowserOptions(ses),
    };
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
 * Open login/OAuth popup programmatically (selftests / internal).
 * Prefer window.open → setWindowOpenHandler(action allow) for real GIS so opener is set.
 * @param {string} accountId
 * @param {string} url
 * @param {Electron.Session} ses
 */
function openLoginPopup(accountId, url, ses) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const existing = findReusableLoginPopup(accountId, '');
  if (existing && !existing.isDestroyed()) {
    try {
      existing.focus();
    } catch {
      /* ignore */
    }
    if (url && isNavigableUrl(url)) {
      existing.loadURL(url).catch(() => {});
    }
    return existing;
  }
  const child = new BrowserWindow(loginPopupBrowserOptions(ses));
  trackLoginPopup(accountId, '', child);
  wireLoginPopupWindow(accountId, child, ses, url);
  if (isNavigableUrl(url)) {
    child.loadURL(url).catch(() => {});
  }
  return child;
}

function getAccount(accountId) {
  return getState().accounts.find((a) => a.id === accountId) || null;
}

/**
 * Whether a hidden panel stays parked/alive (anti-throttle loop + no Chromium throttle).
 * v1.2.0: opt-in per window (`keepAliveInBackground`, default OFF). Global
 * `keepBackgroundRunning` still forces all panels alive when explicitly ON.
 */
function keepRunningInBackground(accountId) {
  const settings = getState().settings || {};
  const preset = settings.backgroundPreset || 'balanced';
  const acc = getAccount(accountId);
  if (acc && acc.pauseInBackground) return false;
  if (preset === 'max-save') return false;
  if (preset === 'always') return true;
  if (acc && acc.keepAliveInBackground) return true;
  if (settings.keepBackgroundRunning === true) return true;
  return false;
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

function isAccountRemoving(accountId) {
  return removingAccounts.has(accountId);
}

function markAccountRemoving(accountId) {
  if (accountId) removingAccounts.add(accountId);
}

function unmarkAccountRemoving(accountId) {
  if (accountId) removingAccounts.delete(accountId);
}

function createPanel(accountId) {
  if (!mainWindow || panels.has(accountId)) return panels.get(accountId) || null;
  if (isAccountRemoving(accountId)) return null;
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
    const proxyMod = require('./proxy');
    // Aplica antes do loadURL (promise; load espera abaixo)
    ses._mhProxyReady = proxyMod.applyProxyToSession(accountId, ses).catch(() => ({ ok: false }));
  } catch {
    ses._mhProxyReady = Promise.resolve({ ok: true });
  }
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
      // Runtime control via setBackgroundThrottling / applyThrottlingTo
      backgroundThrottling: true,
    },
  });

  adblock.bindWebContents(accountId, view.webContents);
  applyWebRtcIpHandlingPolicy(view.webContents);

  try {
    const popoverOverlay = require('./popover-overlay');
    popoverOverlay.attachOutsideCloseTarget(view.webContents, 'panel');
  } catch {
    /* ignore */
  }

  try {
    view.webContents.setUserAgent(chromeUserAgent());
  } catch {
    /* older electron */
  }

  view.webContents.setAudioMuted(!!account.muted);
  try {
    const initialVol = volumeControl.volumeOfAccount(account);
    volumeControl.pushVolumeToWebContents(view.webContents, initialVol);
  } catch {
    /* ignore */
  }

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
    try {
      permissions.cancelPromptsForAccount(accountId);
      permissions.clearMediaInUse(accountId);
    } catch {
      /* ignore */
    }
    rememberUrl(accountId, url);
    recordHistory(accountId, url);
    touchAccount(accountId);
    notifyNav(accountId, { immediate: true });
    try {
      let title = '';
      try {
        title = view.webContents.getTitle() || '';
      } catch {
        title = '';
      }
      unread.handleDidNavigate(accountId, title);
    } catch {
      /* ignore */
    }
    signalLoadCommitted(accountId);
    // Google auth: align webContents UA with per-request Google-auth headers
    try {
      if (userAgent.isGoogleAuthUrl(url)) {
        view.webContents.setUserAgent(userAgent.buildGoogleAuthUserAgent());
      } else {
        view.webContents.setUserAgent(chromeUserAgent());
      }
    } catch {
      /* ignore */
    }
    try {
      extensions.onPanelNavigated(accountId, url, view.webContents);
    } catch {
      /* ignore */
    }
  });
  view.webContents.on('did-navigate-in-page', (_e, url) => {
    rememberUrl(accountId, url);
    recordHistory(accountId, url);
    touchAccount(accountId);
    notifyNav(accountId);
    try {
      extensions.onPanelNavigated(accountId, url, view.webContents);
    } catch {
      /* ignore */
    }
  });
  view.webContents.on('did-finish-load', () => {
    notifyNav(accountId, { immediate: true });
    signalLoadCommitted(accountId);
    try {
      const u = view.webContents.getURL();
      extensions.onPanelNavigated(accountId, u, view.webContents);
    } catch {
      /* ignore */
    }
    try {
      const pct = volumeControl.volumeOfAccount(getAccount(accountId));
      volumeControl.pushVolumeToWebContents(view.webContents, pct);
    } catch {
      /* ignore */
    }
    try {
      const languagetool = require('./languagetool');
      languagetool.pushConfigToWc(view.webContents, languagetool.publicConfig());
    } catch {
      /* ignore */
    }
    try {
      const aiWrite = require('./ai-write');
      aiWrite.pushConfigToWc(view.webContents, aiWrite.publicConfig());
    } catch {
      /* ignore */
    }
  });
  view.webContents.on('dom-ready', () => {
    signalLoadCommitted(accountId);
    try {
      view.webContents.send('mh-rehook-media');
    } catch {
      /* ignore */
    }
    try {
      const pct = volumeControl.volumeOfAccount(getAccount(accountId));
      volumeControl.pushVolumeToWebContents(view.webContents, pct);
    } catch {
      /* ignore */
    }
    try {
      const languagetool = require('./languagetool');
      languagetool.pushConfigToWc(view.webContents, languagetool.publicConfig());
    } catch {
      /* ignore */
    }
    try {
      const aiWrite = require('./ai-write');
      aiWrite.pushConfigToWc(view.webContents, aiWrite.publicConfig());
    } catch {
      /* ignore */
    }
  });
  const emitAudible = () => {
    let audible = false;
    try {
      audible = !!(
        view.webContents &&
        typeof view.webContents.isCurrentlyAudible === 'function' &&
        view.webContents.isCurrentlyAudible()
      );
    } catch {
      audible = false;
    }
    if (audible) audibleAccounts.add(accountId);
    else audibleAccounts.delete(accountId);
    emitToRenderer({ type: 'panel:audible', accountId, audible: !!audible });
  };
  try {
    view.webContents.on('media-started-playing', emitAudible);
    view.webContents.on('media-paused', emitAudible);
  } catch {
    /* ignore */
  }
  try {
    if (typeof view.webContents.on === 'function') {
      view.webContents.on('audio-state-changed', emitAudible);
    }
  } catch {
    /* ignore */
  }
  view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || event.defaultPrevented) return;
    const codeStr = String(errorDescription || '');
    const retryable =
      RETRYABLE_ERRORS.has(errorCode) ||
      [...RETRYABLE_CODES].some((c) => codeStr.includes(c));
    if (!retryable) {
      signalLoadCommitted(accountId, { force: true });
      return;
    }
    const n = loadRetries.get(accountId) || 0;
    if (n >= 1) {
      loadRetries.delete(accountId);
      emitToRenderer({
        type: 'panel:load-status',
        accountId,
        status: 'error',
        message: `Falha de rede (${codeStr || errorCode})`,
      });
      signalLoadCommitted(accountId, { force: true });
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
  view.webContents.on('page-title-updated', (_e, title) => {
    notifyNav(accountId);
    try {
      unread.handleTitleUpdated(accountId, title != null ? String(title) : view.webContents.getTitle());
    } catch {
      /* ignore */
    }
  });
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    const favicon = Array.isArray(favicons) && favicons.length ? favicons[0] : '';
    emitToRenderer({ type: 'panel:favicon', accountId, favicon });
    try {
      unread.handleFaviconUpdated(accountId, favicons);
    } catch {
      /* ignore */
    }
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
      return;
    }
    // Indicador mic/câmera: panel-preload observa getUserMedia (sem evento media-access no Electron 44).
    if (channel === 'panel:media-use' && data && typeof data === 'object') {
      try {
        permissions.setMediaInUse(accountId, {
          microphone: !!data.microphone,
          camera: !!data.camera,
        });
      } catch {
        /* ignore */
      }
    }
  });
  view.webContents.on('focus', () => {
    setFocusedAccount(accountId);
  });
  // Click / key inside page also focuses this panel (sidebar + URL follow).
  // F11 / Esc for chrome-fullscreen focus mode (preventDefault only when handled).
  view.webContents.on('before-input-event', (e, input) => {
    if (input && (input.type === 'keyDown' || input.type === 'mouseDown')) {
      setFocusedAccount(accountId);
    }
    chromeFullscreen.handleBeforeInput(e, input, accountId);
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
  // Track HTML5 element fullscreen so Esc/F11 are left to the page when active.
  view.webContents.on('enter-html-full-screen', () => {
    chromeFullscreen.noteHtmlFullscreen(accountId, true);
  });
  view.webContents.on('leave-html-full-screen', () => {
    chromeFullscreen.noteHtmlFullscreen(accountId, false);
  });
  // Block in-page navigations to non-http(s) schemes (defense in depth).
  // data: only while MULTIHEIZ_SELFTEST (internal probes), never for normal browsing.
  // catalog/badges selftests: também bloqueia hosts não-locais (sem internet real).
  view.webContents.on('will-navigate', (e, url) => {
    if (!isNavigableUrl(url, { allowData: allowInternalDataUrls() })) {
      e.preventDefault();
      return;
    }
    if (isSelftestOfflineMode() && !isSelftestAllowedUrl(url)) {
      e.preventDefault();
    }
  });
  view.webContents.on('will-redirect', (e, url) => {
    if (!isNavigableUrl(url, { allowData: allowInternalDataUrls() })) {
      e.preventDefault();
      return;
    }
    if (isSelftestOfflineMode() && !isSelftestAllowedUrl(url)) {
      e.preventDefault();
    }
  });
  view.webContents.setWindowOpenHandler((details) =>
    handlePanelWindowOpen(accountId, details, ses, view.webContents)
  );
  view.webContents.on('did-create-window', (childWin, details) => {
    onDidCreateLoginWindow(accountId, childWin, ses, details);
  });
  wireContextMenu(view.webContents, accountId);

  mainWindow.contentView.addChildView(view);
  const entry = {
    view,
    accountId,
    visible: true,
    parked: false,
  };
  panels.set(accountId, entry);
  logMutation(accountId, 'create', {});
  try {
    applyThrottlingTo(accountId);
  } catch {
    /* ignore */
  }

  if (areOverlaysActive()) {
    parkPanelOffscreen(entry);
  }

  // Actual navigation may be deferred by staggered load queue
  const finishCreate = () => {
    if (!deferNextCreateLoad) {
      let url = startUrlFor(account);
      // data: only for selftest probe startUrl; user-typed startUrl is http/https only
      const dataOpts = { allowData: allowInternalDataUrls() };
      if (!isNavigableUrl(url, dataOpts)) {
        url = normalizeUrl(url) || 'https://www.google.com';
      }
      // Selftest catalog/badges: guarda a URL alvo no estado, mas não carrega sites reais.
      if (isSelftestOfflineMode() && !isSelftestAllowedUrl(url)) {
        console.log('[selftest-offline] skip loadURL', accountId, url);
      } else if (isNavigableUrl(url, dataOpts)) {
        view.webContents.loadURL(url).catch((err) => {
          console.error('loadURL failed', accountId, err);
        });
      }
    }
    applyThrottlingTo(accountId);
    emitSuspendedState();
  };
  const proxyReady = ses._mhProxyReady || Promise.resolve();
  Promise.resolve(proxyReady).then(finishCreate).catch(finishCreate);
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

/**
 * @param {string} accountId
 * @param {{ immediate?: boolean }} [opts] immediate=true em did-navigate / finish-load
 */
function notifyNav(accountId, opts = {}) {
  const immediate = !!(opts && opts.immediate);
  if (!immediate) {
    if (navNotifyTimers.has(accountId)) return;
    navNotifyTimers.set(
      accountId,
      setTimeout(() => {
        navNotifyTimers.delete(accountId);
        notifyNavNow(accountId);
      }, NAV_NOTIFY_THROTTLE_MS)
    );
    return;
  }
  const pending = navNotifyTimers.get(accountId);
  if (pending) {
    clearTimeout(pending);
    navNotifyTimers.delete(accountId);
  }
  notifyNavNow(accountId);
}

function notifyNavNow(accountId) {
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
  pruneLoadQueueAccount(accountId);
  try {
    permissions.cancelPromptsForAccount(accountId);
    permissions.clearMediaInUse(accountId);
  } catch {
    /* ignore */
  }
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
  overlaySnapshotLru = overlaySnapshotLru.filter((id) => id !== accountId);
  chromeFullscreen.clearHtmlFullscreen(accountId);
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
  // Opt-in keep-alive (per window or global) skips auto-suspend
  if (keepRunningInBackground(accountId) && !settings.suspendHidden) {
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
  }, 250);
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
    if (isAccountRemoving(slot.accountId)) continue;
    clearSuspendTimer(slot.accountId);
    touchAccount(slot.accountId);

    if (forceSuspended.has(slot.accountId)) {
      if (panels.has(slot.accountId)) destroyPanel(slot.accountId);
      continue;
    }

    let entry = panels.get(slot.accountId);
    if (entry) {
      try {
        if (entry.view.webContents.isDestroyed()) {
          panels.delete(slot.accountId);
          entry = null;
        }
      } catch {
        panels.delete(slot.accountId);
        entry = null;
      }
    }
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

    const visual = viewBoundsForSidebarOverlay(
      { x, y, width, height },
      sidebarOverlayWidth
    );
    if (!visual || visual.width < 1 || visual.height < 1) {
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
    entry.view.setBounds(visual);
    entry.parked = false;
    if (
      mutationLogEnabled &&
      prevBounds &&
      (prevBounds.x !== visual.x ||
        prevBounds.y !== visual.y ||
        prevBounds.width !== visual.width ||
        prevBounds.height !== visual.height)
    ) {
      logMutation(slot.accountId, 'bounds', {
        from: prevBounds,
        to: visual,
        logical: { x, y, width, height },
        sidebarOverlayWidth,
      });
    }
    setViewVisible(entry, true);
    repaintPanel(slot.accountId);
  }
}

/**
 * @param {Array<{ accountId: string, x: number, y: number, width: number, height: number }>} slots
 */
/**
 * Advance load queue only for real navigations (not about:blank from deferred create).
 * @param {string} accountId
 * @param {{ force?: boolean }} [opts]
 */
function signalLoadCommitted(accountId, opts = {}) {
  if (!loadQueuePending.has(accountId)) return;
  if (!opts.force) {
    const entry = panels.get(accountId);
    if (entry) {
      try {
        const u = entry.view.webContents.getURL();
        if (!u || isAboutBlank(u)) return;
      } catch {
        /* destroyed — treat as committed */
      }
    }
  }
  loadQueuePending.delete(accountId);
  loadQueueRunning = false;
  setImmediate(() => pumpLoadQueue());
}

/**
 * Remove destroyed/removed accounts from the stagger queue and unblock if needed.
 * @param {string} accountId
 */
function pruneLoadQueueAccount(accountId) {
  const before = loadQueue.length;
  loadQueue = loadQueue.filter((id) => id !== accountId);
  const wasPending = loadQueuePending.delete(accountId);
  if (wasPending || before !== loadQueue.length) {
    if (wasPending) loadQueueRunning = false;
    setImmediate(() => pumpLoadQueue());
  }
}

function pruneStaleLoadQueue() {
  loadQueue = loadQueue.filter((id) => {
    if (!id || isAccountRemoving(id)) return false;
    if (!getAccount(id)) return false;
    return true;
  });
  for (const id of [...loadQueuePending]) {
    if (isAccountRemoving(id) || !getAccount(id)) {
      loadQueuePending.delete(id);
      loadQueueRunning = false;
    }
  }
}

function pumpLoadQueue() {
  if (loadQueueRunning) return;
  pruneStaleLoadQueue();
  // Find next that still needs create+load
  let id = null;
  while (loadQueue.length) {
    const candidate = loadQueue.shift();
    if (!candidate || isAccountRemoving(candidate)) continue;
    const existing = panels.get(candidate);
    if (existing && !loadQueuePending.has(candidate)) {
      let cur = '';
      try {
        cur = existing.view.webContents.getURL();
      } catch {
        cur = '';
      }
      // Only skip if the panel already navigated (deferred creates stay about:blank)
      if (cur && !isAboutBlank(cur)) continue;
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
  let waitingForLoad = false;
  try {
    let entry = panels.get(id);
    if (!entry) {
      entry = createPanelDeferred(id);
    }
    if (!entry) {
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
    if (!current || isAboutBlank(current)) {
      if (isNavigableUrl(url, dataOpts)) {
        waitingForLoad = true;
        wc.loadURL(url).catch(() => {
          signalLoadCommitted(id, { force: true });
        });
      }
    }
    if (waitingForLoad) {
      const watchdog = setTimeout(() => {
        if (loadQueuePending.has(id)) {
          signalLoadCommitted(id, { force: true });
        }
      }, STAGGER_MAX_MS);
      if (typeof watchdog.unref === 'function') watchdog.unref();
    }
  } catch (err) {
    console.error('[panels] pumpLoadQueue', id, err && err.message ? err.message : err);
  } finally {
    if (!waitingForLoad) {
      loadQueuePending.delete(id);
      loadQueueRunning = false;
      setImmediate(() => pumpLoadQueue());
    }
  }
}

/**
 * Create panel without immediate navigation (for staggered queue).
 */
function createPanelDeferred(accountId) {
  if (panels.has(accountId)) return panels.get(accountId);
  deferNextCreateLoad = true;
  try {
    return createPanel(accountId);
  } finally {
    deferNextCreateLoad = false;
  }
}

function enqueueVisibleLoads(accountIds) {
  const ordered = Array.isArray(accountIds) ? accountIds.slice() : [];
  const next = [];
  for (const id of ordered) {
    if (!id || isAccountRemoving(id)) continue;
    if (!next.includes(id)) next.push(id);
  }
  // Substitute queue (drop stale workspace ids); keep in-flight pending if still needed
  loadQueue = next;
  for (const id of [...loadQueuePending]) {
    if (!next.includes(id)) {
      loadQueuePending.delete(id);
      loadQueueRunning = false;
    }
  }
  pumpLoadQueue();
}

function getLoadQueueDebug() {
  return {
    queue: loadQueue.slice(),
    pending: [...loadQueuePending],
    running: loadQueueRunning,
  };
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
  pruneStaleLoadQueue();
  try {
    popoverOverlay.onPanelsLayoutChanged();
  } catch {
    /* ignore */
  }

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
    .filter((id) => !panels.has(id) && !isAccountRemoving(id));
  if (needCreate.length > 1) {
    // Create first with bounds via applySlotBounds path that uses queue
    for (const id of needCreate) {
      deferNextCreateLoad = true;
      try {
        createPanel(id);
      } finally {
        deferNextCreateLoad = false;
      }
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
    sidebarOverlayWidth,
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
  if (isSelftestOfflineMode() && !isSelftestAllowedUrl(normalized)) {
    console.log('[selftest-offline] skip panelNavigate', accountId, normalized);
    return;
  }
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
 * Volume fino 0–200% (persistido em account.volume). Default 100.
 * @param {string} accountId
 * @param {unknown} percent
 * @returns {number}
 */
function panelSetVolume(accountId, percent) {
  const p = volumeControl.normalizeVolumePercent(percent);
  updateState((s) => {
    const acc = s.accounts.find((a) => a.id === accountId);
    if (acc) acc.volume = p;
  });
  const entry = panels.get(accountId);
  if (entry) volumeControl.pushVolumeToWebContents(entry.view.webContents, p);
  emitToRenderer({ type: 'panel:volume', accountId, volume: p });
  return p;
}

/**
 * @param {string} accountId
 * @returns {number}
 */
function panelGetVolume(accountId) {
  return volumeControl.volumeOfAccount(getAccount(accountId));
}

/**
 * @param {string} accountId
 * @returns {boolean}
 */
function panelIsAudible(accountId) {
  if (audibleAccounts.has(accountId)) return true;
  const entry = panels.get(accountId);
  if (!entry) return false;
  try {
    return !!(
      typeof entry.view.webContents.isCurrentlyAudible === 'function' &&
      entry.view.webContents.isCurrentlyAudible()
    );
  } catch {
    return false;
  }
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
  const keepBg = keepRunningInBackground(accountId);
  const userThrottle = !!settings.backgroundThrottling || preset === 'max-save';
  const fps = Math.max(1, Number(settings.backgroundFps) || 5);
  const capHidden = Math.max(1, Number(settings.frameCapHidden) || 30);
  const capAll = Number(settings.frameCapAll) || 0;

  let shouldThrottle = false;
  if (preset === 'always' && !pauseBg) {
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

/**
 * Destrói o painel e, se for o último usuário da partição, limpa cookies/storage/cache.
 * Partições compartilhadas só são limpas quando nenhuma outra janela as usa.
 * @param {string} accountId
 * @param {{ forceClear?: boolean }} [opts]
 */
async function clearAccountSession(accountId, opts = {}) {
  const alreadyMarked = isAccountRemoving(accountId);
  if (!alreadyMarked) markAccountRemoving(accountId);
  try {
    const partId = resolvePartitionId(accountId);
    const st = getState();
    const others = partition.countPartitionUsers(partId, st.accounts, {
      excludeAccountId: accountId,
    });
    const shouldClear = !!opts.forceClear || others === 0;
    destroyPanel(accountId, { keepLastUrl: false });
    forceSuspended.delete(accountId);
    lastUsedAt.delete(accountId);
    if (shouldClear && partId) {
      const ses = session.fromPartition(partition.partitionString(partId));
      await ses.clearStorageData();
      try {
        await ses.clearCache();
      } catch {
        /* ignore */
      }
    }
    emitSuspendedState();
  } finally {
    // If caller pre-marked (account:remove), keep tombstone until state is updated.
    if (!alreadyMarked) unmarkAccountRemoving(accountId);
  }
}

/**
 * Recria o WebContentsView se a partição da conta mudou (ex.: área virou
 * "Navegador convencional"). Mantém lastUrl.
 * @param {string} accountId
 */
function rebindPanelSession(accountId) {
  if (!panels.has(accountId)) return false;
  destroyPanel(accountId, { keepLastUrl: true });
  return true;
}

/**
 * Limpa storage/cache de uma partição pelo id (sem destruir painéis).
 * @param {string} partitionId
 */
async function clearPartitionData(partitionId) {
  const partId = String(partitionId || '').trim();
  if (!partId) return;
  const ses = session.fromPartition(partition.partitionString(partId));
  await ses.clearStorageData();
  try {
    await ses.clearCache();
  } catch {
    /* ignore */
  }
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
/**
 * @param {import('electron').WebContents | null | undefined} wc
 * @returns {string|null}
 */
function accountIdForWebContents(wc) {
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return null;
  for (const [id, entry] of panels.entries()) {
    try {
      if (entry.view && entry.view.webContents === wc) return id;
    } catch {
      /* ignore */
    }
  }
  return null;
}

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
  panelSetVolume,
  panelGetVolume,
  panelIsAudible,
  clearAccountSession,
  rebindPanelSession,
  clearPartitionData,
  markAccountRemoving,
  unmarkAccountRemoving,
  isAccountRemoving,
  resolvePartitionId,
  getLoadQueueDebug,
  enqueueVisibleLoads,
  getPanelCapture,
  destroyAllPanels,
  listActivePanelIds,
  isPanelWebContents,
  accountIdForWebContents,
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
  getModalOverlayCount,
  clearOverlaySelftestSpies,
  getOverlaySelftestSpies,
  getOverlayCount,
  areOverlaysActive,
  setSidebarOverlayWidth,
  getSidebarOverlayWidth,
  viewBoundsForSidebarOverlay,
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
  compressSnapshotImage,
  prepareAndParkForOverlay,
  clearOverlaySnapshots,
  getOverlaySnapshotDebug,
  OVERLAY_SNAPSHOT_MAX,
  OVERLAY_SNAPSHOT_MAX_WIDTH,
  OVERLAY_SNAPSHOT_MAX_CHARS,
  childPopups,
  handlePanelWindowOpen,
  findReusableLoginPopup,
  isLoginStylePopup,
  openUrlInNewPanel,
  wireContextMenu,
};
