'use strict';

/** @typedef {{ id: string, name: string, color: string, startUrl: string, workspaceId: string, muted: boolean, pauseInBackground?: boolean, keepAliveInBackground?: boolean, lastUrl?: string|null }} Account */
/** @typedef {{ id: string, name: string }} Workspace */
/** @typedef {{ c: number, r: number, w: number, h: number }} Tile */
/** @typedef {{ workspaces: Workspace[], activeWorkspaceId: string, accounts: Account[], layout: string, page: number, maximizedAccountId: string|null, settings: object, ui: object, appearance: object, freeTiles: object }} AppState */

const FREE_COLS = 12;
const FREE_ROWS = 8;
const FREE_MIN_W = 2;
const FREE_MIN_H = 2;
/** px inset on content edges so resize handles stay above WebContentsView (v1.4.1) */
const HANDLE_INSET = 7;
/** Focus frame drawn in HTML around the native view (inset view bounds) */
const FOCUS_FRAME = 2;
/** Auto-collapse sidebar below this window width (CSS px) */
const SIDEBAR_AUTO_BREAKPOINT = 900;
/** Expanded sidebar width bounds (user-resizable) */
const SIDEBAR_W_MIN = 160;
const SIDEBAR_W_MAX = 360;
const SIDEBAR_W_DEFAULT = 240;
/** px movement before a header/handle gesture commits as drag */
const DRAG_THRESHOLD = 4;

const THEME_PRESETS = {
  escuro: {
    preset: 'escuro',
    accent: '#2bb8a6',
    background: '#14181f',
    surface: '#1e2430',
    text: '#e6ebea',
    panelHeader: '#243040',
    sidebar: '#181c24',
  },
  claro: {
    preset: 'claro',
    accent: '#0d8a7a',
    background: '#f0f3f5',
    surface: '#ffffff',
    text: '#1a2228',
    panelHeader: '#d9e4ea',
    sidebar: '#e8eef1',
  },
  grafite: {
    preset: 'grafite',
    accent: '#e8a54b',
    background: '#1a1c1e',
    surface: '#262a2e',
    text: '#eceef0',
    panelHeader: '#2e333a',
    sidebar: '#15171a',
  },
};

/** @type {AppState} */
let state = {
  workspaces: [],
  activeWorkspaceId: '',
  accounts: [],
  layout: 'auto',
  page: 0,
  maximizedAccountId: null,
  settings: {},
  ui: {
    sidebarCollapsed: false,
    sidebarAutoHide: false,
    layoutLocked: true,
    sidebarWidth: SIDEBAR_W_DEFAULT,
  },
  appearance: { ...THEME_PRESETS.escuro },
  freeTiles: {},
};

/** Hot-zone DOM strip width (must match --sidebar-hotzone-w); main also polls ≤12px */
const SIDEBAR_HOTZONE_PX = 6;
/** Delay before revealing sidebar from hot-zone (avoid accidental triggers) */
const SIDEBAR_SHOW_DELAY_MS = 150;
/** Delay before hiding after cursor left hot-zone/sidebar (main polling is source of truth) */
const SIDEBAR_HIDE_DELAY_MS = 700;

/** When true, user forced the sidebar open while under the auto-collapse breakpoint */
let sidebarForceExpanded = false;
/** Auto-hide overlay currently slid in (session; not persisted) */
let sidebarAutoHideOpen = false;
/**
 * Temporary pin while F11 chrome-hidden: keep overlay open until unpin or leave FS.
 * Does not change saved sidebarAutoHide / legacy prefs.
 */
let sidebarFsPinned = false;
/** Native Menu.popup from sidebar account context menu is open */
let sidebarNativeMenuOpen = false;
/** Last inside/outside from main-process cursor polling (null = unknown) */
let sidebarCursorInside = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let sidebarShowTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let sidebarHideTimer = null;
/** Current zoom factor for the focused panel */
let focusedZoom = 1;
/** @type {Map<string, number>} accountId -> zoom factor (for header chips) */
const panelZoomMap = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let zoomToastTimer = null;

/** @type {Map<string, { url: string, title?: string, domain?: string, canGoBack: boolean, canGoForward: boolean, muted: boolean }>} */
const navState = new Map();
/** @type {Map<string, { store: string, id: string, installed?: boolean, extensionId?: string|null, name?: string|null, status?: string, message?: string }>} */
const storeOffers = new Map();
/** @type {Map<string, string>} */
const favicons = new Map();
/** @type {Map<string, string|null>} */
const overlaySnapMap = new Map();
/** @type {Set<string>} */
let forceSuspended = new Set();
/** @type {object | null} */
let latestMetrics = null;
/** @type {string | null} */
let focusedAccountId = null;
let focusedFps = 0;
let appStartedAt = Date.now();
let appVersion = '—';

let editingAccountId = null;
let editingWorkspaceId = null;
let pendingConfirm = null;
let syncTimer = null;
let toastTimer = null;
let statusTimer = null;
let editingUrlFor = null;

/** @type {Set<string>} */
const openOverlays = new Set();

/** Free-layout drag/resize session */
let tileDrag = null;

const el = {
  app: document.getElementById('app'),
  sidebar: document.getElementById('sidebar'),
  sidebarHotzone: document.getElementById('sidebar-hotzone'),
  sidebarList: document.getElementById('sidebar-list'),
  btnSidebarToggle: document.getElementById('btn-sidebar-toggle'),
  tabs: document.getElementById('workspace-tabs'),
  btnTabsMore: document.getElementById('btn-tabs-more'),
  grid: document.getElementById('grid'),
  layoutSelect: document.getElementById('layout-select'),
  btnLayoutLock: document.getElementById('btn-layout-lock'),
  layoutEditBanner: document.getElementById('layout-edit-banner'),
  btnBannerLock: document.getElementById('btn-banner-lock'),
  clockSkewBanner: document.getElementById('clock-skew-banner'),
  btnClockSkewDismiss: document.getElementById('btn-clock-skew-dismiss'),
  mainCol: document.getElementById('main-col'),
  dlgNovidades: document.getElementById('dlg-novidades'),
  pager: document.getElementById('pager'),
  pageLabel: document.getElementById('page-label'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  btnAddAccount: document.getElementById('btn-add-account'),
  btnOverflow: document.getElementById('btn-overflow'),
  btnWsAdd: document.getElementById('btn-ws-add'),
  btnSettings: document.getElementById('btn-settings'),
  topbar: document.getElementById('topbar'),
  winControls: document.getElementById('win-controls'),
  btnWinMin: document.getElementById('btn-win-min'),
  btnWinMax: document.getElementById('btn-win-max'),
  btnWinClose: document.getElementById('btn-win-close'),
  btnMemTotal: document.getElementById('btn-mem-total'),
  btnFreeMem: document.getElementById('btn-free-mem'),
  memPopover: document.getElementById('mem-popover'),
  memPopoverList: document.getElementById('mem-popover-list'),
  memPopoverTotal: document.getElementById('mem-popover-total'),
  btnMemClose: document.getElementById('btn-mem-close'),
  toast: document.getElementById('toast'),
  dlgAccount: document.getElementById('dlg-account'),
  formAccount: document.getElementById('form-account'),
  dlgAccountTitle: document.getElementById('dlg-account-title'),
  accountWsSelect: document.getElementById('account-ws-select'),
  dlgWorkspace: document.getElementById('dlg-workspace'),
  formWorkspace: document.getElementById('form-workspace'),
  dlgSettings: document.getElementById('dlg-settings'),
  formSettings: document.getElementById('form-settings'),
  dlgConfirm: document.getElementById('dlg-confirm'),
  formConfirm: document.getElementById('form-confirm'),
  confirmMessage: document.getElementById('confirm-message'),
  dlgProxy: document.getElementById('dlg-proxy'),
  formProxy: document.getElementById('form-proxy'),
  dlgProxyTitle: document.getElementById('dlg-proxy-title'),
  dlgProxyHint: document.getElementById('dlg-proxy-hint'),
  proxyType: document.getElementById('proxy-type'),
  proxyFields: document.getElementById('proxy-fields'),
  proxyHost: document.getElementById('proxy-host'),
  proxyPort: document.getElementById('proxy-port'),
  proxyUser: document.getElementById('proxy-user'),
  proxyPass: document.getElementById('proxy-pass'),
  proxyPassHint: document.getElementById('proxy-pass-hint'),
  proxyBypass: document.getElementById('proxy-bypass'),
  proxyStatus: document.getElementById('proxy-status'),
  btnProxySave: document.getElementById('btn-proxy-save'),
  btnProxyTest: document.getElementById('btn-proxy-test'),
  btnProxyRemove: document.getElementById('btn-proxy-remove'),
  btnProxyCancel: document.getElementById('btn-proxy-cancel'),
  statCpu: document.getElementById('stat-cpu'),
  statRam: document.getElementById('stat-ram'),
  statFps: document.getElementById('stat-fps'),
  statUptime: document.getElementById('stat-uptime'),
  statVersion: document.getElementById('stat-version'),
  themePreset: document.getElementById('theme-preset'),
  btnThemeReset: document.getElementById('btn-theme-reset'),
};

function svg(pathD, extra = '') {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${pathD}"/>${extra}</svg>`;
}

/** Lucide-style multi-node icon (ISC) — path + optional circle/extra markup */
function svgNodes(inner) {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

const ICO = {
  back: 'M15 6l-6 6 6 6',
  forward: 'M9 6l6 6-6 6',
  reload: 'M21 12a9 9 0 11-3-6.7M21 3v6h-6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z',
  mute: 'M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6',
  unmute: 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 010 7M18 6a9 9 0 010 12',
  max: 'M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3',
  restore: 'M8 8h10v10H8zM6 6h10v2H8v8H6V6z',
  more: 'M12 12h.01M12 6h.01M12 18h.01',
  star: 'M12 3l2.5 6.5L21 10l-5 4.2L17.5 21 12 17.3 6.5 21 8 14.2 3 10l6.5-.5L12 3z',
  starFilled: 'M12 3l2.5 6.5L21 10l-5 4.2L17.5 21 12 17.3 6.5 21 8 14.2 3 10l6.5-.5L12 3z',
  lock: 'M5 11h14v10H5zM8 11V8a4 4 0 018 0v3',
  unlock: 'M5 11h14v10H5zM8 11V8a4 4 0 017.5-2',
  // Shield (adblock) — own SVG path
  shield:
    'M12 2l8 3v6c0 5.25-3.4 9.74-8 11-4.6-1.26-8-5.75-8-11V5l8-3zM12 6.2l-5.2 1.95v4.1c0 3.7 2.35 6.9 5.2 8.05 2.85-1.15 5.2-4.35 5.2-8.05v-4.1L12 6.2z',
  // Info do site (cadeado / i)
  siteInfo:
    'M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a1.25 1.25 0 110 2.5A1.25 1.25 0 0112 6zm-1.25 4h2.5v8h-2.5v-8z',
  mic: 'M12 1a3 3 0 00-3 3v6a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v1a7 7 0 01-14 0v-1M12 19v4M8 23h8',
  camera: 'M23 7l-5 4V8a2 2 0 00-2-2H3a2 2 0 00-2 2v8a2 2 0 002 2h13a2 2 0 002-2v-3l5 4V7z',
  home: 'M3 11l9-8 9 8v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1v-9z',
  // Lucide puzzle (extension actions)
  puzzle:
    'M19.439 7.5H17.5a2.5 2.5 0 0 0-5 0H10a2 2 0 0 0-2 2v1.561a2.5 2.5 0 1 0 0 5V18a2 2 0 0 0 2 2h1.439a2.5 2.5 0 1 0 5 0H19a2 2 0 0 0 2-2v-1.439a2.5 2.5 0 1 0 0-5V9.5a2 2 0 0 0-1.561-2z',
  // Lucide settings (gear) — path + circle via svgNodes
  settingsPath:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  // Lucide table / bell / sticky-note for modules
  table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9',
  stickyNote: 'M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z',
};

function settingsIconHtml() {
  return svgNodes(
    `<path d="${ICO.settingsPath}"/><circle cx="12" cy="12" r="3"/>`
  );
}

/** @type {Map<string, number>} */
const adblockPageCounts = new Map();
let adblockSessionTotal = 0;

/** Prompt de permissão ativo por painel (barra sob o header). */
/** @type {Map<string, object>} */
const permissionPrompts = new Map();

/** Uso de mídia por painel. */
/** @type {Map<string, { microphone: boolean, camera: boolean }>} */
const mediaUseByPanel = new Map();

const SITE_PERM_LABELS = {
  microphone: 'Microfone',
  camera: 'Câmera',
  notifications: 'Notificações',
  geolocation: 'Localização',
  'clipboard-read': 'Área de transferência',
  'display-capture': 'Compartilhar tela',
};

function slotsForLayout(layout, count) {
  const map = { '1': 1, '2': 2, '4': 4, '6': 6 };
  if (layout === 'livre') return Math.max(1, count || 1);
  if (layout === 'auto') {
    if (count <= 1) return 1;
    if (count === 2) return 2;
    if (count <= 4) return 4;
    return 6;
  }
  return map[layout] || 1;
}

function displaySlotCount(visibleCount, layoutCapacity) {
  const k = Math.max(0, visibleCount | 0);
  if (k <= 0) return Math.max(1, layoutCapacity | 0);
  if (k >= layoutCapacity) return layoutCapacity;
  return k;
}

function gridTemplate(slotCount) {
  switch (slotCount) {
    case 1:
      return { cols: '1fr', rows: '1fr' };
    case 2:
      return { cols: '1fr 1fr', rows: '1fr' };
    case 3:
      return { cols: '1fr 1fr 1fr', rows: '1fr' };
    case 4:
      return { cols: '1fr 1fr', rows: '1fr 1fr' };
    case 5:
      return { cols: '1fr 1fr 1fr', rows: '1fr 1fr' };
    case 6:
      return { cols: '1fr 1fr 1fr', rows: '1fr 1fr' };
    default:
      return { cols: '1fr', rows: '1fr' };
  }
}

function accountsInWorkspace() {
  return state.accounts.filter((a) => a.workspaceId === state.activeWorkspaceId);
}

function visiblePageAccounts() {
  const all = accountsInWorkspace();
  if (state.maximizedAccountId) {
    const one = all.find((a) => a.id === state.maximizedAccountId);
    return one ? [one] : all.slice(0, 1);
  }
  if (state.layout === 'livre') return all;
  const slots = slotsForLayout(state.layout, all.length || 1);
  const page = Math.max(0, state.page || 0);
  const start = page * slots;
  return all.slice(start, start + slots);
}

function pageCount() {
  const all = accountsInWorkspace();
  if (state.maximizedAccountId || state.layout === 'livre') return 1;
  const slots = slotsForLayout(state.layout, all.length || 1);
  return Math.max(1, Math.ceil(all.length / slots) || 1);
}

function workspaceTiles() {
  const map = (state.freeTiles && state.freeTiles[state.activeWorkspaceId]) || {};
  return { ...map };
}

function tilesOverlap(a, b) {
  return !(a.c + a.w <= b.c || b.c + b.w <= a.c || a.r + a.h <= b.r || b.r + b.h <= a.r);
}

function findFreeSpot(tiles, w = 6, h = 4) {
  for (let r = 0; r <= FREE_ROWS - h; r++) {
    for (let c = 0; c <= FREE_COLS - w; c++) {
      const cand = { c, r, w, h };
      let ok = true;
      for (const t of Object.values(tiles)) {
        if (tilesOverlap(cand, t)) {
          ok = false;
          break;
        }
      }
      if (ok) return cand;
    }
  }
  return { c: 0, r: 0, w: Math.min(w, FREE_COLS), h: Math.min(h, FREE_ROWS) };
}

function ensureTilesForVisible(visible) {
  const tiles = workspaceTiles();
  let changed = false;
  for (const acc of visible) {
    if (!tiles[acc.id]) {
      tiles[acc.id] = findFreeSpot(tiles, 6, 4);
      changed = true;
    }
  }
  const ids = new Set(visible.map((a) => a.id));
  for (const id of Object.keys(tiles)) {
    if (!ids.has(id)) {
      delete tiles[id];
      changed = true;
    }
  }
  if (changed) {
    const next = { ...(state.freeTiles || {}), [state.activeWorkspaceId]: tiles };
    state.freeTiles = next;
    window.multiheiz.setFreeTiles(state.activeWorkspaceId, tiles).then((s) => {
      if (s) state = s;
    });
  }
  return tiles;
}

function applyAppearance(appearance) {
  const a = appearance || THEME_PRESETS.escuro;
  const preset = a.preset && THEME_PRESETS[a.preset] ? a.preset : a.preset === 'custom' ? 'custom' : 'escuro';
  const base = preset !== 'custom' && THEME_PRESETS[preset] ? THEME_PRESETS[preset] : a;
  const merged = { ...base, ...a, preset: a.preset || preset };
  const root = document.documentElement;
  if (merged.preset === 'claro' || merged.preset === 'grafite' || merged.preset === 'escuro') {
    root.setAttribute('data-theme', merged.preset);
  } else {
    root.setAttribute('data-theme', 'escuro');
  }
  root.style.setProperty('--accent', merged.accent || base.accent);
  root.style.setProperty('--bg', merged.background || base.background);
  root.style.setProperty('--bg-elev', merged.surface || base.surface);
  root.style.setProperty('--surface', merged.surface || base.surface);
  root.style.setProperty('--text', merged.text || base.text);
  root.style.setProperty('--panel-header-bg', merged.panelHeader || base.panelHeader);
  root.style.setProperty('--sidebar-bg', merged.sidebar || base.sidebar);
}

/**
 * @param {object} next
 * @param {{ soft?: boolean }} [opts] soft=true: update state without full re-render (settings apply)
 */
function applyState(next, opts = {}) {
  state = next;
  if (!state.ui) {
    state.ui = {
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      layoutLocked: true,
      sidebarWidth: SIDEBAR_W_DEFAULT,
    };
  }
  if (typeof state.ui.sidebarAutoHide !== 'boolean') {
    state.ui.sidebarAutoHide = false;
  }
  if (typeof state.ui.sidebarWidth !== 'number' || !Number.isFinite(state.ui.sidebarWidth)) {
    state.ui.sidebarWidth = SIDEBAR_W_DEFAULT;
  }
  if (!state.appearance) state.appearance = { ...THEME_PRESETS.escuro };
  if (!state.freeTiles) state.freeTiles = {};
  if (opts.soft) {
    // Settings-only path: keep panels/layout as-is; modules may refresh lightly.
    if (window.MultiHeizV16 && window.MultiHeizV16.renderSidebarModules) {
      window.MultiHeizV16.renderSidebarModules();
    }
    return;
  }
  applyAppearance(state.appearance);
  applySidebarWidthCss();
  render();
  scheduleSync();
  if (window.MultiHeizV16 && window.MultiHeizV16.renderSidebarModules) {
    window.MultiHeizV16.renderSidebarModules();
  }
}

/** Legacy setting: arrow collapses like before (no auto-hide / hot-zone / overlay). */
function isSidebarLegacyAlwaysActive() {
  return !!(state.settings && state.settings.sidebarAlwaysActive);
}

function isSidebarAutoHide() {
  if (isSidebarLegacyAlwaysActive()) return false;
  return !!(state.ui && state.ui.sidebarAutoHide);
}

function isChromeHiddenMode() {
  return document.body.classList.contains('is-chrome-hidden');
}

/**
 * Overlay + hot-zone behavior: normal auto-hide, or always while F11 chrome-hidden
 * (independent of fixed / auto-hide / legacy preference).
 */
function usesSidebarOverlay() {
  return isChromeHiddenMode() || isSidebarAutoHide();
}

function clearSidebarHoverTimers() {
  if (sidebarShowTimer) {
    clearTimeout(sidebarShowTimer);
    sidebarShowTimer = null;
  }
  if (sidebarHideTimer) {
    clearTimeout(sidebarHideTimer);
    sidebarHideTimer = null;
  }
}

/**
 * Keep auto-hide sidebar open while a menu / rename / modal / drag is active.
 */
function shouldHoldSidebarOpen() {
  if (isChromeHiddenMode() && sidebarFsPinned) return true;
  if (sidebarNativeMenuOpen) return true;
  if (document.querySelector('.context-menu')) return true;
  if (document.querySelector('.panel-ext-menu')) return true;
  if (tileDrag) return true;
  if (
    openOverlays.has('dlg-account') ||
    openOverlays.has('dlg-workspace') ||
    openOverlays.has('dlg-settings') ||
    openOverlays.has('dlg-confirm') ||
    openOverlays.has('dlg-novidades') ||
    openOverlays.has('dlg-proxy')
  ) {
    return true;
  }
  const ae = document.activeElement;
  if (ae && el.sidebar && el.sidebar.contains(ae)) {
    const tag = (ae.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || ae.isContentEditable) return true;
  }
  return false;
}

/**
 * Tell main to start/stop cursor polling for auto-hide / F11 edge reveal + keep-open.
 */
function syncSidebarAutoHideTracking() {
  if (!window.multiheiz || typeof window.multiheiz.setSidebarAutoHideTracking !== 'function') {
    return;
  }
  const edge = usesSidebarOverlay();
  try {
    window.multiheiz.setSidebarAutoHideTracking({
      enabled: edge,
      open: !!(edge && sidebarAutoHideOpen),
      sidebarWidth: clampSidebarWidth(state.ui && state.ui.sidebarWidth),
      // Still report chrome-hidden for debug; main keeps polling when enabled.
      chromeHidden: isChromeHiddenMode(),
    });
  } catch {
    /* ignore */
  }
}

/**
 * Sync main-process WebContentsView inset for the sidebar overlay strip.
 * @param {boolean} open
 */
async function syncSidebarOverlayBounds(open) {
  if (!window.multiheiz.setSidebarOverlay) return;
  const w =
    open && usesSidebarOverlay() ? clampSidebarWidth(state.ui && state.ui.sidebarWidth) : 0;
  try {
    await window.multiheiz.setSidebarOverlay(w);
  } catch {
    /* ignore */
  }
}

/**
 * @param {boolean} open
 * @param {{ force?: boolean }} [opts]
 */
function setSidebarAutoHideOpen(open, opts = {}) {
  if (!usesSidebarOverlay()) {
    open = false;
  }
  // Temporary F11 pin: ignore hide unless force (unpin / leave FS).
  if (
    !open &&
    isChromeHiddenMode() &&
    sidebarFsPinned &&
    !opts.force
  ) {
    return;
  }
  const next = !!open;
  if (next === sidebarAutoHideOpen && !opts.force) {
    if (next) clearSidebarHoverTimers();
    return;
  }
  sidebarAutoHideOpen = next;
  if (el.app) el.app.classList.toggle('sidebar-auto-hide-open', next);
  if (el.sidebar) {
    el.sidebar.classList.toggle('auto-hide-open', next);
  }
  syncSidebarOverlayBounds(next);
  syncSidebarAutoHideTracking();
  // Overlay does not change flex layout; still nudge sync so main reapplies transform.
  scheduleSync();
}

function requestSidebarShow() {
  if (!usesSidebarOverlay()) return;
  clearSidebarHoverTimers();
  if (sidebarAutoHideOpen) return;
  sidebarShowTimer = setTimeout(() => {
    sidebarShowTimer = null;
    setSidebarAutoHideOpen(true);
  }, SIDEBAR_SHOW_DELAY_MS);
}

function requestSidebarHide() {
  if (!usesSidebarOverlay()) return;
  if (!sidebarAutoHideOpen) return;
  if (isChromeHiddenMode() && sidebarFsPinned) return;
  // Do not reset an in-flight hide countdown (continuous "outside" must stay ~700ms).
  if (sidebarHideTimer) return;
  if (sidebarShowTimer) {
    clearTimeout(sidebarShowTimer);
    sidebarShowTimer = null;
  }
  sidebarHideTimer = setTimeout(() => {
    sidebarHideTimer = null;
    if (shouldHoldSidebarOpen()) {
      requestSidebarHide();
      return;
    }
    // Main polling may have moved back inside during the delay.
    if (sidebarCursorInside === true) return;
    setSidebarAutoHideOpen(false);
  }, SIDEBAR_HIDE_DELAY_MS);
}

/**
 * Main-process cursor poll result (robust vs drag regions + WebContentsView).
 * @param {boolean} inside
 */
function onSidebarCursorFromMain(inside) {
  if (!usesSidebarOverlay()) return;
  sidebarCursorInside = !!inside;
  if (inside) {
    if (sidebarAutoHideOpen) {
      clearSidebarHoverTimers();
    } else {
      requestSidebarShow();
    }
  } else if (sidebarAutoHideOpen) {
    requestSidebarHide();
  } else {
    // Cancel pending reveal when cursor left the hot edge.
    if (sidebarShowTimer) {
      clearTimeout(sidebarShowTimer);
      sidebarShowTimer = null;
    }
  }
}

function clampSidebarWidth(w) {
  const n = Math.round(Number(w) || SIDEBAR_W_DEFAULT);
  return Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, n));
}

function applySidebarWidthCss() {
  const w = clampSidebarWidth(state.ui && state.ui.sidebarWidth);
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
}

function isSidebarEffectivelyCollapsed() {
  // Auto-hide uses overlay + hot-zone, not the icon-rail collapsed width.
  if (isSidebarAutoHide()) return false;
  const userCollapsed = !!(state.ui && state.ui.sidebarCollapsed);
  const auto = window.innerWidth < SIDEBAR_AUTO_BREAKPOINT && !sidebarForceExpanded;
  return userCollapsed || auto;
}

function updateSidebarToggleUi() {
  if (!el.btnSidebarToggle) return;
  const hideIco = el.btnSidebarToggle.querySelector('.ico-sidebar-hide');
  const pinIco = el.btnSidebarToggle.querySelector('.ico-sidebar-pin');
  // F11: temporary pin/unpin (session only), same icons as auto-hide toggle.
  if (isChromeHiddenMode()) {
    const label = sidebarFsPinned ? 'Esconder automaticamente' : 'Fixar barra lateral';
    el.btnSidebarToggle.title = label;
    el.btnSidebarToggle.setAttribute('aria-label', label);
    if (hideIco) hideIco.classList.toggle('hidden', !sidebarFsPinned);
    if (pinIco) pinIco.classList.toggle('hidden', !!sidebarFsPinned);
    return;
  }
  if (isSidebarLegacyAlwaysActive()) {
    const collapsed = isSidebarEffectivelyCollapsed();
    const label = collapsed ? 'Expandir barra lateral' : 'Recolher barra lateral';
    el.btnSidebarToggle.title = label;
    el.btnSidebarToggle.setAttribute('aria-label', label);
    if (hideIco) hideIco.classList.toggle('hidden', false);
    if (pinIco) pinIco.classList.toggle('hidden', true);
    return;
  }
  const autoHide = isSidebarAutoHide();
  const label = autoHide ? 'Fixar barra lateral' : 'Esconder automaticamente';
  el.btnSidebarToggle.title = label;
  el.btnSidebarToggle.setAttribute('aria-label', label);
  if (hideIco) hideIco.classList.toggle('hidden', autoHide);
  if (pinIco) pinIco.classList.toggle('hidden', !autoHide);
}

function updateSidebarCollapseClasses() {
  const chromeHidden = isChromeHiddenMode();
  const autoHide = isSidebarAutoHide();
  // F11 always uses overlay edge-reveal (ignore fixed / legacy layout for chrome).
  const overlayMode = chromeHidden || autoHide;
  const userCollapsed = !!(state.ui && state.ui.sidebarCollapsed);
  const auto =
    !overlayMode &&
    window.innerWidth < SIDEBAR_AUTO_BREAKPOINT &&
    !sidebarForceExpanded &&
    !userCollapsed;
  const collapsed = overlayMode ? false : isSidebarEffectivelyCollapsed();

  if (el.app) {
    el.app.classList.toggle('sidebar-auto-hide', overlayMode);
    el.app.classList.toggle('sidebar-auto-hide-open', overlayMode && sidebarAutoHideOpen);
  }
  if (el.sidebarHotzone) {
    // Hot-zone while edge-reveal active and not temporarily pinned in F11.
    const showZone = overlayMode && !(chromeHidden && sidebarFsPinned);
    el.sidebarHotzone.classList.toggle('hidden', !showZone);
    el.sidebarHotzone.setAttribute('aria-hidden', showZone ? 'false' : 'true');
  }
  el.sidebar.classList.toggle('collapsed', collapsed);
  el.sidebar.classList.toggle('auto-collapsed', auto);
  el.sidebar.classList.toggle('auto-hide-open', overlayMode && sidebarAutoHideOpen);

  if (!overlayMode && sidebarAutoHideOpen) {
    sidebarAutoHideOpen = false;
    if (el.app) el.app.classList.remove('sidebar-auto-hide-open');
    syncSidebarOverlayBounds(false);
  }

  syncSidebarAutoHideTracking();
  updateSidebarToggleUi();
}

async function refresh() {
  const next = await window.multiheiz.getState();
  applyState(next);
}

function isLayoutLocked() {
  return state.ui?.layoutLocked !== false;
}

function render() {
  updateSidebarCollapseClasses();
  el.layoutSelect.value = state.layout || 'auto';
  updateLockButton();
  renderTabs();
  renderPager();
  renderSidebar();
  renderGrid();
  updateMemBadges();
  updateStatusBar();
}

function zoomPctFor(accountId) {
  const z = panelZoomMap.has(accountId)
    ? panelZoomMap.get(accountId)
    : accountId === focusedAccountId
      ? focusedZoom
      : 1;
  const acc = state.accounts.find((a) => a.id === accountId);
  const fromState = acc && Number(acc.zoomFactor);
  const factor = panelZoomMap.has(accountId)
    ? z
    : Number.isFinite(fromState)
      ? fromState
      : z || 1;
  return Math.round((factor || 1) * 100);
}

function showPanelZoomToast(accountId, zoom) {
  const pct = Math.round((zoom || 1) * 100);
  panelZoomMap.set(accountId, zoom);
  const slot = el.grid.querySelector(`.panel-slot[data-account-id="${accountId}"]`);
  if (!slot) return;
  let chip = slot.querySelector('.panel-zoom-chip');
  if (pct === 100) {
    if (chip) chip.remove();
    return;
  }
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'panel-zoom-chip';
    chip.title = 'Redefinir zoom (100%)';
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await window.multiheiz.panelZoom(accountId, 0);
      if (res && res.ok && typeof res.zoom === 'number') {
        focusedZoom = res.zoom;
        panelZoomMap.set(accountId, res.zoom);
        showPanelZoomToast(accountId, res.zoom);
      }
    });
    const header = slot.querySelector('.panel-header');
    if (header) header.appendChild(chip);
  }
  chip.textContent = `${pct}%`;
  chip.classList.add('flash');
  if (zoomToastTimer) clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => {
    chip.classList.remove('flash');
  }, 1200);
}

function updateLockButton() {
  const locked = isLayoutLocked();
  const livreEdit = state.layout === 'livre' && !locked && !state.maximizedAccountId;
  const lockLabel = locked ? 'Destravar layout' : 'Travar layout';
  el.btnLayoutLock.title = lockLabel;
  el.btnLayoutLock.setAttribute('aria-label', lockLabel);
  el.btnLayoutLock.innerHTML = svg(locked ? ICO.lock : ICO.unlock);
  el.btnLayoutLock.classList.toggle('active', livreEdit);
  el.btnLayoutLock.style.display = state.layout === 'livre' ? '' : 'none';
  if (el.layoutEditBanner) {
    el.layoutEditBanner.classList.toggle('hidden', !livreEdit);
  }
  if (el.mainCol) {
    el.mainCol.classList.toggle('editing-layout', livreEdit);
  }
}

function isLivreEditMode() {
  return state.layout === 'livre' && !isLayoutLocked() && !state.maximizedAccountId;
}

/**
 * Bounds sent to main for WebContentsView placement.
 * In Livre edit mode, inset edges so HTML resize handles receive mouse events.
 * Focused panel insets by FOCUS_FRAME so the HTML accent border/glow is visible
 * around the native view (which otherwise covers its own rect).
 */
function contentRectToViewSlot(accountId, rect) {
  let x = rect.left;
  let y = rect.top;
  let width = rect.width;
  let height = rect.height;
  if (isLivreEditMode()) {
    x += HANDLE_INSET;
    width -= HANDLE_INSET * 2;
    height -= HANDLE_INSET;
  }
  if (accountId && accountId === focusedAccountId) {
    x += FOCUS_FRAME;
    y += FOCUS_FRAME;
    width -= FOCUS_FRAME * 2;
    height -= FOCUS_FRAME * 2;
  }
  if (width < 1) width = 1;
  if (height < 1) height = 1;
  return { accountId, x, y, width, height };
}

function renderTabs() {
  el.tabs.innerHTML = '';
  for (const ws of state.workspaces) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab' + (ws.id === state.activeWorkspaceId ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', ws.id === state.activeWorkspaceId ? 'true' : 'false');
    btn.setAttribute('aria-label', ws.name || 'Área de trabalho');
    btn.textContent = ws.name;
    btn.addEventListener('click', async () => {
      applyState(await window.multiheiz.setWorkspace(ws.id));
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showWsMenu(e.clientX, e.clientY, ws);
    });
    const edit = document.createElement('span');
    edit.className = 'tab-edit';
    edit.textContent = '✎';
    edit.title = 'Renomear';
    edit.setAttribute('aria-hidden', 'true');
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      openWorkspaceDialog(ws);
    });
    btn.appendChild(edit);
    el.tabs.appendChild(btn);
  }
  requestAnimationFrame(updateTabsOverflow);
}

function updateTabsOverflow() {
  if (!el.tabs || !el.btnTabsMore) return;
  const overflow = el.tabs.scrollWidth > el.tabs.clientWidth + 2;
  el.btnTabsMore.classList.toggle('hidden', !overflow);
}

function showTabsOverflowMenu() {
  if (!el.btnTabsMore || !state.workspaces?.length) return;
  closeMenus();
  const r = el.btnTabsMore.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.style.left = `${Math.max(8, r.left)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  for (const ws of state.workspaces) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.textContent = ws.name + (ws.id === state.activeWorkspaceId ? ' ✓' : '');
    item.addEventListener('click', async () => {
      closeMenus();
      applyState(await window.multiheiz.setWorkspace(ws.id));
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  pushOverlay('context-menu');
}

function showWsMenu(x, y, ws) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.textContent = 'Renomear';
  rename.addEventListener('click', () => {
    closeMenus();
    openWorkspaceDialog(ws);
  });
  menu.appendChild(rename);

  if (state.workspaces.length > 1) {
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Excluir categoria';
    del.addEventListener('click', () => {
      closeMenus();
      const n = state.accounts.filter((a) => a.workspaceId === ws.id).length;
      confirmAction(workspaceDeleteConfirmMessage(ws.name, n), async () => {
        applyState(await window.multiheiz.deleteWorkspace(ws.id));
      });
    });
    menu.appendChild(del);
  }

  document.body.appendChild(menu);
  pushOverlay('context-menu');
}

function closeMenus() {
  const hadCtx = document.querySelectorAll('.context-menu').length > 0;
  const hadExt = document.querySelectorAll('.panel-ext-menu').length > 0;
  document.querySelectorAll('.context-menu').forEach((n) => n.remove());
  document.querySelectorAll('.panel-ext-menu').forEach((n) => n.remove());
  document.querySelectorAll('.panel-site-perm-popover').forEach((n) => n.remove());
  if (hadCtx) popOverlay('context-menu');
  if (hadExt) popOverlay('panel-ext-menu');
}

async function openPanelExtensionsMenu(accountId, x, y) {
  closeMenus();
  if (!window.multiheiz.extensionsForPanel) return;
  const list = await window.multiheiz.extensionsForPanel(accountId);
  const menu = document.createElement('div');
  menu.className = 'panel-ext-menu';
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
  const badge = document.createElement('div');
  badge.className = 'badge-experimental panel-ext-badge';
  badge.textContent = 'Experimental (em testes)';
  menu.appendChild(badge);

  if (!list || !list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nenhuma extensão instalada';
    menu.appendChild(empty);
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'panel-ext-manage';
    addBtn.textContent = 'Adicionar extensão';
    addBtn.addEventListener('click', () => {
      closeMenus();
      openSettingsSection('extensoes');
    });
    menu.appendChild(addBtn);
  } else {
    for (const ext of list) {
      const row = document.createElement('div');
      row.className = 'panel-ext-row' + (ext.activeOnPanel ? '' : ' inactive');
      if (ext.iconDataUrl) {
        const img = document.createElement('img');
        img.src = ext.iconDataUrl;
        img.alt = '';
        row.appendChild(img);
      }
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'panel-ext-name';
      nameBtn.textContent = ext.name || ext.id;
      nameBtn.disabled = !ext.activeOnPanel || !ext.hasAction;
      nameBtn.title = ext.hasAction
        ? 'Abrir popup da extensão'
        : 'Esta extensão não tem popup';
      nameBtn.addEventListener('click', async () => {
        closeMenus();
        const r = await window.multiheiz.extensionsOpenAction(ext.id, accountId, x, y);
        if (r && !r.ok) showToast(r.error || 'Não foi possível abrir o popup');
      });
      row.appendChild(nameBtn);

      const swLabel = document.createElement('label');
      swLabel.className = 'panel-ext-switch';
      swLabel.title = 'Ativa nesta janela';
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.checked = !!ext.activeOnPanel;
      sw.addEventListener('change', async () => {
        const r = await window.multiheiz.extensionsSetActiveOnPanel(
          ext.id,
          accountId,
          sw.checked
        );
        if (r && r.note) showToast(r.note);
        closeMenus();
        openPanelExtensionsMenu(accountId, x, y);
      });
      swLabel.append(sw, document.createTextNode(' Nesta janela'));
      row.appendChild(swLabel);
      menu.appendChild(row);
    }
  }

  const footer = document.createElement('button');
  footer.type = 'button';
  footer.className = 'panel-ext-manage';
  footer.textContent = 'Gerenciar extensões';
  footer.addEventListener('click', () => {
    closeMenus();
    openSettingsSection('extensoes');
  });
  menu.appendChild(footer);

  document.body.appendChild(menu);
  pushOverlay('panel-ext-menu');
  const onDoc = (ev) => {
    if (!menu.contains(ev.target)) {
      closeMenus();
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    }
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      closeMenus();
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function openSettingsSection(section) {
  openSettings();
  if (window.MultiHeizV16 && window.MultiHeizV16.openSettingsSection) {
    window.MultiHeizV16.openSettingsSection(section);
  } else {
    const btn = document.querySelector(`.settings-nav-btn[data-section="${section}"]`);
    if (btn) btn.click();
  }
}

function renderPager() {
  const pages = pageCount();
  const page = Math.min(state.page || 0, pages - 1);
  if (page !== state.page) {
    window.multiheiz.setPage(page).then(applyState);
    return;
  }
  const show = pages > 1 && !state.maximizedAccountId && state.layout !== 'livre';
  el.pager.classList.toggle('hidden', !show);
  el.pageLabel.textContent = `${page + 1}/${pages}`;
  el.btnPrev.disabled = page <= 0;
  el.btnNext.disabled = page >= pages - 1;
}

function windowStatus(acc) {
  if (forceSuspended.has(acc.id)) return 'suspensa';
  if (acc.muted) return 'mudo';
  const onPage = visiblePageAccounts().some((a) => a.id === acc.id);
  if (onPage && state.activeWorkspaceId === acc.workspaceId) return 'ativa';
  return 'segundo';
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function renderSidebar() {
  el.sidebarList.innerHTML = '';
  const list = accountsInWorkspace();
  for (const acc of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className =
      'sidebar-item' + (focusedAccountId === acc.id || visiblePageAccounts().some((a) => a.id === acc.id && a.id === focusedAccountId) ? ' active' : '');
    if (visiblePageAccounts().some((a) => a.id === acc.id) && !focusedAccountId) {
      /* leave */
    }
    if (focusedAccountId === acc.id) item.classList.add('active');

    const stripe = document.createElement('div');
    stripe.className = 'sidebar-color';
    stripe.style.background = acc.color || 'var(--accent)';

    const fav = document.createElement('img');
    fav.className = 'sidebar-fav';
    fav.alt = '';
    const favUrl = favicons.get(acc.id);
    if (favUrl) fav.src = favUrl;
    else fav.style.opacity = '0.35';

    const body = document.createElement('div');
    body.className = 'sidebar-body';
    const name = document.createElement('div');
    name.className = 'sidebar-name';
    name.textContent = acc.name;
    const meta = document.createElement('div');
    meta.className = 'sidebar-meta';
    const m = panelMetrics(acc.id);
    const st = windowStatus(acc);
    const stLabel =
      st === 'ativa' ? 'ativa' : st === 'segundo' ? 'em segundo plano' : st === 'suspensa' ? 'suspensa' : 'mudo';
    const blocked = adblockPageCounts.get(acc.id) || 0;
    const blockBit = blocked > 0 ? ` · blk ${blocked}` : '';
    meta.textContent = m
      ? `${stLabel} · ${m.ramMb ?? 0} MB · ${m.cpu ?? 0}%${blockBit}`
      : `${stLabel}${blockBit}`;
    body.append(name, meta);

    const proxyActive = !!(acc.proxy && acc.proxy.active);
    let proxyBadge = null;
    if (proxyActive) {
      proxyBadge = document.createElement('span');
      proxyBadge.className = 'sidebar-proxy-badge';
      proxyBadge.textContent = 'P';
      proxyBadge.title =
        acc.proxy.host && acc.proxy.port
          ? `Usando proxy ${acc.proxy.host}:${acc.proxy.port}`
          : 'Usando proxy';
      proxyBadge.setAttribute('aria-label', proxyBadge.title);
    }

    const dot = document.createElement('span');
    dot.className = `status-dot ${st}`;
    dot.title = stLabel;
    dot.setAttribute('aria-hidden', 'true');

    const proxyBit = proxyActive
      ? ` — proxy ${acc.proxy.host || ''}:${acc.proxy.port || ''}`
      : '';
    const a11yLabel = `${acc.name} — ${stLabel}${proxyBit}`;
    item.title = a11yLabel;
    item.setAttribute('aria-label', a11yLabel);
    if (proxyBadge) item.append(stripe, fav, body, proxyBadge, dot);
    else item.append(stripe, fav, body, dot);
    item.addEventListener('click', async () => {
      focusedAccountId = acc.id;
      await window.multiheiz.panelFocus(acc.id);
      if (state.layout !== 'livre' && !visiblePageAccounts().some((a) => a.id === acc.id)) {
        const all = accountsInWorkspace();
        const slots = slotsForLayout(state.layout, all.length || 1);
        const idx = all.findIndex((a) => a.id === acc.id);
        if (idx >= 0) applyState(await window.multiheiz.setPage(Math.floor(idx / slots)));
      }
      renderSidebar();
    });
    item.addEventListener('dblclick', () => toggleMaximize(acc.id));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showAccountMenu(e.clientX, e.clientY, acc);
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        item.click();
      }
    });
    el.sidebarList.appendChild(item);
  }
}

/**
 * Native Menu.popup from main — always on top of WebContentsViews, no overlay.
 * (HTML dropdown used to park panels then lose the menu to document click / z-order.)
 */
function showAccountMenu(x, y, acc) {
  closeMenus();
  window.multiheiz.popupAccountMenu(acc.id, Math.round(x), Math.round(y));
}

function renderGrid() {
  const all = accountsInWorkspace();
  const visible = visiblePageAccounts();
  const isLivre = state.layout === 'livre' && !state.maximizedAccountId;

  el.grid.classList.toggle('livre-mode', isLivre);
  el.grid.classList.toggle('show-grid', isLivre && !isLayoutLocked());
  el.grid.innerHTML = '';

  if (!isLivre) {
    const layoutCapacity = state.maximizedAccountId
      ? 1
      : slotsForLayout(state.layout, all.length || 1);
    const slotCount = state.maximizedAccountId
      ? 1
      : displaySlotCount(visible.length, layoutCapacity);
    const tpl = gridTemplate(slotCount);
    el.grid.style.gridTemplateColumns = tpl.cols;
    el.grid.style.gridTemplateRows = tpl.rows;
  } else {
    el.grid.style.gridTemplateColumns = '';
    el.grid.style.gridTemplateRows = '';
  }

  if (!all.length) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = 'Nenhuma janela nesta categoria. Clique em “+ Nova janela”.';
    el.grid.appendChild(hint);
    scheduleSync();
    return;
  }

  const tiles = isLivre ? ensureTilesForVisible(visible) : null;

  for (const acc of visible) {
    const slot = buildPanelSlot(acc, isLivre ? tiles[acc.id] : null);
    el.grid.appendChild(slot);
  }

  applyOverlaySnapshotsToDom();
}

function panelMetrics(accountId) {
  if (!latestMetrics || !Array.isArray(latestMetrics.panels)) return null;
  return latestMetrics.panels.find((p) => p.accountId === accountId) || null;
}

function formatBadge(m) {
  if (!m || !m.active) return '—';
  const ram = typeof m.ramMb === 'number' ? m.ramMb : 0;
  const cpu = typeof m.cpu === 'number' ? m.cpu : 0;
  const shared = m.shared ? ' (compartilhado)' : '';
  return `${ram} MB · ${cpu}%${shared}`;
}

function metricName(metrics) {
  const m = (metrics && metrics.metric) || (latestMetrics && latestMetrics.metric) || 'workingSetSize';
  return m === 'privateBytes' ? 'privateBytes' : 'workingSetSize';
}

function breakdownText(metrics) {
  const b = (metrics && metrics.breakdown) || {};
  return `Painéis: ${b.panelsMb ?? 0} MB · Interface: ${b.interfaceMb ?? 0} MB · GPU: ${b.gpuMb ?? 0} MB · Outros: ${b.outrosMb ?? 0} MB`;
}

function memTooltip(m) {
  if (!m) return 'Sem métricas';
  const metric = m.metric || metricName();
  const shared = m.shared
    ? `\nProcesso compartilhado com: ${(m.sharedWith || []).join(', ') || '—'}`
    : '';
  return `RAM: ${m.ramMb} MB (${metric})\nCPU: ${m.cpu}%\nPID: ${m.pid || '—'}\nEstado: ${m.state}${shared}`;
}

function applyTileStyle(slot, tile) {
  if (!tile) return;
  const left = (tile.c / FREE_COLS) * 100;
  const top = (tile.r / FREE_ROWS) * 100;
  const width = (tile.w / FREE_COLS) * 100;
  const height = (tile.h / FREE_ROWS) * 100;
  slot.style.left = `calc(${left}% + 3px)`;
  slot.style.top = `calc(${top}% + 3px)`;
  slot.style.width = `calc(${width}% - 6px)`;
  slot.style.height = `calc(${height}% - 6px)`;
}

function buildPanelSlot(acc, tile) {
  const slot = document.createElement('div');
  slot.className =
    'panel-slot' +
    (state.maximizedAccountId === acc.id ? ' maximized' : '') +
    (focusedAccountId === acc.id ? ' focused' : '');
  slot.dataset.accountId = acc.id;
  if (tile) {
    slot.dataset.tile = JSON.stringify(tile);
    applyTileStyle(slot, tile);
  }
  slot.addEventListener('mousedown', () => {
    focusedAccountId = acc.id;
    window.multiheiz.panelFocus(acc.id);
  });

  const header = document.createElement('div');
  header.className = 'panel-header';
  const appearance = state.appearance || THEME_PRESETS.escuro;
  header.style.background = appearance.panelHeader || 'var(--panel-header-bg)';

  const stripe = document.createElement('div');
  stripe.className = 'panel-stripe';
  stripe.style.background = acc.color || 'var(--accent)';

  const fav = document.createElement('img');
  fav.className = 'panel-fav';
  fav.alt = '';
  const favUrl = favicons.get(acc.id);
  if (favUrl) fav.src = favUrl;

  const nav = navState.get(acc.id) || {
    url: acc.lastUrl || acc.startUrl || '',
    title: acc.name,
    domain: '',
    canGoBack: false,
    canGoForward: false,
    muted: !!acc.muted,
  };

  let domain = nav.domain || '';
  if (!domain && nav.url) {
    try {
      domain = new URL(nav.url).hostname;
    } catch {
      domain = '';
    }
  }

  const siteInfoBtn = iconBtn(ICO.siteInfo, 'Informações do site', (e) => {
    e.stopPropagation();
    const r = siteInfoBtn.getBoundingClientRect();
    openSitePermissionsPopover(acc.id, Math.round(r.left), Math.round(r.bottom + 4));
  });
  siteInfoBtn.dataset.role = 'panel-site-info';
  siteInfoBtn.classList.add('panel-site-info');

  const mediaUse = mediaUseByPanel.get(acc.id) || { microphone: false, camera: false };
  const mediaInd = document.createElement('span');
  mediaInd.className = 'panel-media-use';
  mediaInd.dataset.role = 'panel-media-use';
  if (mediaUse.microphone) {
    const micEl = document.createElement('span');
    micEl.className = 'panel-media-use-icon is-mic';
    micEl.title = 'Microfone em uso';
    micEl.innerHTML = svg(ICO.mic);
    mediaInd.appendChild(micEl);
  }
  if (mediaUse.camera) {
    const camEl = document.createElement('span');
    camEl.className = 'panel-media-use-icon is-cam';
    camEl.title = 'Câmera em uso';
    camEl.innerHTML = svg(ICO.camera);
    mediaInd.appendChild(camEl);
  }
  if (!mediaUse.microphone && !mediaUse.camera) {
    mediaInd.hidden = true;
  }

  const titleBlock = document.createElement('div');
  titleBlock.className = 'panel-title-block';
  titleBlock.title = 'Clique para editar URL · duplo clique maximiza';
  const titleEl = document.createElement('div');
  titleEl.className = 'panel-title';
  titleEl.textContent = nav.title || acc.name;
  const domainEl = document.createElement('div');
  domainEl.className = 'panel-domain';
  domainEl.textContent = domain || acc.name;
  titleBlock.append(titleEl, domainEl);
  titleBlock.addEventListener('dblclick', () => toggleMaximize(acc.id));
  titleBlock.addEventListener('click', () => showUrlEditor(slot, acc));

  const actions = document.createElement('div');
  actions.className = 'panel-header-actions';

  const btnBack = iconBtn(ICO.back, 'Voltar', () => window.multiheiz.panelBack(acc.id));
  btnBack.disabled = !nav.canGoBack;
  const btnFwd = iconBtn(ICO.forward, 'Avançar', () => window.multiheiz.panelForward(acc.id));
  btnFwd.disabled = !nav.canGoForward;
  const btnHome = iconBtn(ICO.home, 'Início', () => {
    if (window.multiheiz.panelHome) window.multiheiz.panelHome(acc.id);
  });
  btnHome.dataset.role = 'panel-home';
  const btnReload = iconBtn(ICO.reload, 'Recarregar', () => window.multiheiz.panelReload(acc.id));
  const btnMute = iconBtn(nav.muted ? ICO.mute : ICO.unmute, 'Mudo', async () => {
    applyState(await window.multiheiz.panelSetMuted(acc.id, !nav.muted));
  });
  const btnStar = iconBtn(ICO.star, 'Favoritar (Ctrl+D)', async (e) => {
    e.stopPropagation();
    focusedAccountId = acc.id;
    if (window.MultiHeizV16) await window.MultiHeizV16.favoriteCurrentUrl();
  });
  btnStar.dataset.role = 'panel-star';
  btnStar.classList.add('star-btn');
  const urlForStar = nav.url || acc.lastUrl || '';
  if (urlForStar && window.multiheiz.bookmarksFindUrl) {
    window.multiheiz.bookmarksFindUrl(urlForStar).then((bm) => {
      if (bm) {
        btnStar.classList.add('starred');
        btnStar.innerHTML = svg(ICO.starFilled);
      }
    }).catch(() => {});
  }
  const blockedN = adblockPageCounts.get(acc.id) || 0;
  const winOn = acc.adblockEnabled !== false;
  const globOn = !state.settings?.adblock || state.settings.adblock.enabled !== false;
  const btnShield = iconBtn(
    ICO.shield,
    winOn && globOn
      ? `Bloqueador: ${blockedN} nesta página (clique para opções)`
      : 'Bloqueador desligado nesta janela (clique para opções)',
    (e) => {
      e.stopPropagation();
      const r = btnShield.getBoundingClientRect();
      const url = (navState.get(acc.id) && navState.get(acc.id).url) || acc.lastUrl || '';
      window.multiheiz.adblockPopupMenu(acc.id, Math.round(r.left), Math.round(r.bottom + 4), url);
    }
  );
  btnShield.dataset.role = 'panel-adblock';
  btnShield.classList.add('adblock-shield');
  if (!winOn || !globOn) btnShield.classList.add('off');
  const countEl = document.createElement('span');
  countEl.className = 'adblock-count';
  countEl.textContent = String(blockedN);
  if (blockedN > 0) btnShield.appendChild(countEl);
  const btnExt = iconBtn(ICO.puzzle, 'Extensões nesta janela (em testes)', (e) => {
    e.stopPropagation();
    const r = btnExt.getBoundingClientRect();
    openPanelExtensionsMenu(acc.id, Math.round(r.left), Math.round(r.bottom + 4));
  });
  btnExt.dataset.role = 'panel-extensions';
  const btnMax = iconBtn(
    state.maximizedAccountId === acc.id ? ICO.restore : ICO.max,
    'Maximizar',
    () => toggleMaximize(acc.id)
  );
  const btnReloadMarked = btnReload;
  btnReloadMarked.dataset.role = 'panel-reload';
  const btnMore = iconBtn(ICO.more, 'Menu', (e) => {
    e.stopPropagation();
    const r = btnMore.getBoundingClientRect();
    showAccountMenu(r.left, r.bottom + 4, acc);
  });
  btnMore.dataset.role = 'panel-menu';

  // Star + shield + puzzle on the left so header-actions stay compact (livre drag hit-tests ~35% into header)
  actions.append(btnBack, btnFwd, btnHome, btnReloadMarked, btnMute, btnMax, btnMore);
  header.append(stripe, fav, siteInfoBtn, mediaInd, btnStar, btnShield, btnExt, titleBlock, actions);
  header.dataset.role = 'panel-header';

  const zPct = zoomPctFor(acc.id);
  if (zPct !== 100) {
    const zChip = document.createElement('button');
    zChip.type = 'button';
    zChip.className = 'panel-zoom-chip';
    zChip.textContent = `${zPct}%`;
    zChip.title = 'Redefinir zoom (100%)';
    zChip.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await window.multiheiz.panelZoom(acc.id, 0);
      if (res && res.ok && typeof res.zoom === 'number') {
        focusedZoom = res.zoom;
        panelZoomMap.set(acc.id, res.zoom);
        showPanelZoomToast(acc.id, res.zoom);
      }
    });
    header.appendChild(zChip);
  }

  if (isLivreEditMode()) {
    header.style.cursor = 'grab';
    const onHeaderDown = (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      if (tileDrag) return;
      startTileDrag(acc.id, e, 'move');
    };
    header.addEventListener('pointerdown', onHeaderDown);
    header.addEventListener('mousedown', onHeaderDown);
  }

  const content = document.createElement('div');
  content.className = 'panel-content';
  content.dataset.accountId = acc.id;

  const snap = document.createElement('img');
  snap.className = 'panel-snapshot';
  snap.alt = '';
  snap.dataset.accountId = acc.id;
  content.appendChild(snap);

  if (forceSuspended.has(acc.id)) {
    const ph = document.createElement('div');
    ph.className = 'panel-placeholder';
    ph.innerHTML =
      '<span>Suspenso para economizar memória — clique para recarregar</span>';
    ph.addEventListener('click', async () => {
      await window.multiheiz.panelReactivate(acc.id);
      scheduleSync();
    });
    content.appendChild(ph);
  }

  slot.append(header, content);
  const cachedOffer = storeOffers.get(acc.id);
  if (cachedOffer) {
    ensureStoreOfferBar(slot, acc.id, cachedOffer);
  }
  ensurePermissionPromptBar(slot, acc.id, permissionPrompts.get(acc.id) || null);

  if (isLivreEditMode()) {
    for (const dir of ['e', 's', 'se']) {
      const h = document.createElement('div');
      h.className = `resize-handle ${dir}`;
      h.dataset.role = `resize-${dir}`;
      const onHandleDown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (tileDrag) return;
        startTileDrag(acc.id, e, dir);
      };
      h.addEventListener('pointerdown', onHandleDown);
      h.addEventListener('mousedown', onHandleDown);
      slot.appendChild(h);
    }
  }

  return slot;
}

/**
 * Atualiza indicador mic/câmera na barra do painel.
 * @param {string} accountId
 * @param {{ microphone?: boolean, camera?: boolean }} flags
 */
function applyMediaUseToPanel(accountId, flags) {
  mediaUseByPanel.set(accountId, {
    microphone: !!flags.microphone,
    camera: !!flags.camera,
  });
  const slot = el.grid && el.grid.querySelector(`.panel-slot[data-account-id="${accountId}"]`);
  if (!slot) return;
  let ind = slot.querySelector('.panel-media-use');
  if (!ind) {
    ind = document.createElement('span');
    ind.className = 'panel-media-use';
    ind.dataset.role = 'panel-media-use';
    const siteBtn = slot.querySelector('[data-role="panel-site-info"]');
    if (siteBtn && siteBtn.nextSibling) {
      siteBtn.parentNode.insertBefore(ind, siteBtn.nextSibling);
    } else if (siteBtn) {
      siteBtn.after(ind);
    } else {
      const header = slot.querySelector('.panel-header');
      if (header) header.appendChild(ind);
    }
  }
  ind.replaceChildren();
  if (flags.microphone) {
    const micEl = document.createElement('span');
    micEl.className = 'panel-media-use-icon is-mic';
    micEl.title = 'Microfone em uso';
    micEl.innerHTML = svg(ICO.mic);
    ind.appendChild(micEl);
  }
  if (flags.camera) {
    const camEl = document.createElement('span');
    camEl.className = 'panel-media-use-icon is-cam';
    camEl.title = 'Câmera em uso';
    camEl.innerHTML = svg(ICO.camera);
    ind.appendChild(camEl);
  }
  ind.hidden = !flags.microphone && !flags.camera;
}

/**
 * Faixa de permissão do site (sob o header do painel), estilo store-bar.
 * @param {HTMLElement} slot
 * @param {string} accountId
 * @param {object|null} prompt
 */
function ensurePermissionPromptBar(slot, accountId, prompt) {
  let bar = slot.querySelector('.panel-perm-bar');
  if (!prompt) {
    if (bar) {
      bar.remove();
      scheduleSync();
    }
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'panel-perm-bar';
    bar.dataset.role = 'panel-perm-bar';
    const content = slot.querySelector('.panel-content');
    const storeBar = slot.querySelector('.panel-store-bar');
    if (storeBar) slot.insertBefore(bar, storeBar);
    else if (content) slot.insertBefore(bar, content);
    else slot.appendChild(bar);
  }
  bar.dataset.accountId = accountId;
  bar.dataset.requestId = prompt.requestId || '';
  bar.replaceChildren();

  const label = document.createElement('span');
  label.className = 'panel-perm-bar-label';
  label.textContent = prompt.message || 'Este site pediu uma permissão';

  const btnAllow = document.createElement('button');
  btnAllow.type = 'button';
  btnAllow.className = 'btn primary panel-perm-bar-btn';
  btnAllow.dataset.role = 'perm-allow';
  btnAllow.textContent = 'Permitir';
  btnAllow.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.multiheiz.permissionsRespond({
      requestId: prompt.requestId,
      action: 'allow',
    });
  });

  const btnBlock = document.createElement('button');
  btnBlock.type = 'button';
  btnBlock.className = 'btn ghost panel-perm-bar-btn';
  btnBlock.dataset.role = 'perm-deny';
  btnBlock.textContent = 'Bloquear';
  btnBlock.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.multiheiz.permissionsRespond({
      requestId: prompt.requestId,
      action: 'deny',
    });
  });

  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'btn icon ghost panel-perm-bar-close';
  btnClose.dataset.role = 'perm-dismiss';
  btnClose.title = 'Negar só desta vez';
  btnClose.setAttribute('aria-label', 'Fechar');
  btnClose.textContent = '×';
  btnClose.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.multiheiz.permissionsRespond({
      requestId: prompt.requestId,
      action: 'dismiss',
    });
  });

  bar.append(label, btnAllow, btnBlock, btnClose);
  scheduleSync();
}

/**
 * Popover de permissões do site (origem + Perguntar/Permitir/Bloquear).
 * @param {string} accountId
 * @param {number} x
 * @param {number} y
 */
async function openSitePermissionsPopover(accountId, x, y) {
  closeMenus();
  const nav = navState.get(accountId) || {};
  const acc = (state.accounts || []).find((a) => a.id === accountId);
  let origin = '';
  const candidates = [nav.url, acc && acc.lastUrl, acc && acc.startUrl];
  for (const raw of candidates) {
    try {
      const o = new URL(String(raw || '')).origin;
      if (o.startsWith('http://') || o.startsWith('https://')) {
        origin = o;
        break;
      }
    } catch {
      /* next */
    }
  }
  if (!origin) {
    showToast('Abra um site http(s) para gerenciar permissões.');
    return;
  }

  const data = await window.multiheiz.permissionsGet(accountId, origin);
  const states = (data && data.states) || {};

  const pop = document.createElement('div');
  pop.className = 'panel-site-perm-popover';
  pop.dataset.role = 'site-perm-popover';
  pop.style.left = `${Math.max(8, x)}px`;
  pop.style.top = `${Math.max(8, y)}px`;

  const title = document.createElement('div');
  title.className = 'panel-site-perm-origin';
  title.textContent = origin;

  const list = document.createElement('div');
  list.className = 'panel-site-perm-list';

  const keys = Object.keys(SITE_PERM_LABELS);
  for (const key of keys) {
    const row = document.createElement('div');
    row.className = 'panel-site-perm-row';
    const lab = document.createElement('span');
    lab.className = 'panel-site-perm-name';
    lab.textContent = SITE_PERM_LABELS[key];
    const sel = document.createElement('select');
    sel.className = 'panel-site-perm-select';
    sel.dataset.permission = key;
    for (const [val, text] of [
      ['ask', 'Perguntar'],
      ['allow', 'Permitir'],
      ['deny', 'Bloquear'],
    ]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      if ((states[key] || 'ask') === val) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', async () => {
      const res = await window.multiheiz.permissionsSet(
        accountId,
        origin,
        key,
        sel.value
      );
      if (res && res.needsReload) {
        showToast('Recarregue a página para aplicar.');
      }
    });
    row.append(lab, sel);
    list.appendChild(row);
  }

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn ghost panel-site-perm-reset';
  resetBtn.dataset.role = 'perm-reset';
  resetBtn.textContent = 'Redefinir permissões';
  resetBtn.addEventListener('click', async () => {
    await window.multiheiz.permissionsReset(accountId, origin);
    pop.remove();
    showToast('Permissões redefinidas. O site perguntará de novo.');
  });

  pop.append(title, list, resetBtn);
  document.body.appendChild(pop);

  const onDoc = (ev) => {
    if (pop.contains(ev.target)) return;
    pop.remove();
    document.removeEventListener('mousedown', onDoc, true);
  };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
}

/**
 * Slim MultiHeiz bar under the panel header on store detail pages.
 * @param {HTMLElement} slot
 * @param {string} accountId
 * @param {object|null} offer
 */
function ensureStoreOfferBar(slot, accountId, offer) {
  let bar = slot.querySelector('.panel-store-bar');
  if (!offer) {
    if (bar) {
      bar.remove();
      scheduleSync();
    }
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'panel-store-bar';
    const content = slot.querySelector('.panel-content');
    if (content) slot.insertBefore(bar, content);
    else slot.appendChild(bar);
  }
  bar.dataset.accountId = accountId;
  bar.dataset.store = offer.store || '';
  bar.dataset.extId = offer.id || '';
  const storeLabel = offer.store === 'edge' ? 'Edge' : 'Chrome Web Store';
  const status = offer.status || '';
  const busy = status === 'downloading' || status === 'installing';
  const msg =
    offer.message ||
    (offer.installed
      ? 'Já instalada' + (offer.name ? ': ' + offer.name : '')
      : 'Extensão da ' + storeLabel);

  bar.replaceChildren();
  const label = document.createElement('span');
  label.className = 'panel-store-bar-label';
  label.textContent = msg;
  bar.appendChild(label);

  if (busy) {
    const spin = document.createElement('span');
    spin.className = 'panel-store-bar-busy';
    spin.textContent = status === 'downloading' ? 'Baixando…' : 'Instalando…';
    bar.appendChild(spin);
  } else if (offer.installed) {
    const badge = document.createElement('span');
    badge.className = 'panel-store-bar-badge';
    badge.textContent = 'Já instalada';
    const btnRm = document.createElement('button');
    btnRm.type = 'button';
    btnRm.className = 'btn ghost panel-store-bar-btn';
    btnRm.textContent = 'Remover';
    btnRm.addEventListener('click', async (e) => {
      e.stopPropagation();
      btnRm.disabled = true;
      const r = await window.multiheiz.extensionsStoreBarRemove(accountId, offer.id);
      if (!r || !r.ok) {
        label.textContent = (r && r.error) || 'Falha ao remover';
        btnRm.disabled = false;
        return;
      }
      if (window.MultiHeizV16 && window.MultiHeizV16.refreshExtensionsUi) {
        window.MultiHeizV16.refreshExtensionsUi().catch(() => {});
      }
    });
    bar.append(badge, btnRm);
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary panel-store-bar-btn';
    btn.textContent = 'Instalar no MultiHeiz';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      updateStoreOfferProgress(accountId, 'downloading', 'Baixando…');
      const r = await window.multiheiz.extensionsStoreBarInstall(
        accountId,
        offer.store,
        offer.id
      );
      if (!r || !r.ok) {
        updateStoreOfferProgress(
          accountId,
          'error',
          (r && r.error) || 'Falha ao instalar'
        );
        return;
      }
      if (window.MultiHeizV16 && window.MultiHeizV16.refreshExtensionsUi) {
        window.MultiHeizV16.refreshExtensionsUi().catch(() => {});
      }
    });
    bar.appendChild(btn);
  }
  scheduleSync();
}

function updateStoreOfferBar(accountId, offer) {
  if (!offer) {
    storeOffers.delete(accountId);
  } else {
    const prev = storeOffers.get(accountId) || {};
    const sameExt =
      prev.store === offer.store &&
      String(prev.id || '').toLowerCase() === String(offer.id || '').toLowerCase();
    const installedUnchanged = !!prev.installed === !!offer.installed;
    const inherit = sameExt && installedUnchanged;
    storeOffers.set(accountId, {
      ...prev,
      ...offer,
      status: inherit
        ? offer.status != null
          ? offer.status
          : prev.status
        : offer.status != null
          ? offer.status
          : '',
      message: inherit
        ? offer.message != null
          ? offer.message
          : prev.message
        : offer.message != null
          ? offer.message
          : '',
    });
  }
  const slot = el.grid.querySelector(`.panel-slot[data-account-id="${accountId}"]`);
  if (slot) ensureStoreOfferBar(slot, accountId, storeOffers.get(accountId) || null);
}

function updateStoreOfferProgress(accountId, status, message) {
  const cur = storeOffers.get(accountId);
  if (!cur) return;
  cur.status = status || '';
  cur.message = message || '';
  if (status === 'done') {
    cur.installed = true;
    cur.status = '';
  }
  if (status === 'error') {
    cur.status = '';
  }
  storeOffers.set(accountId, cur);
  const slot = el.grid.querySelector(`.panel-slot[data-account-id="${accountId}"]`);
  if (slot) ensureStoreOfferBar(slot, accountId, cur);
}

function showUrlEditor(slot, acc) {
  editingUrlFor = acc.id;
  const header = slot.querySelector('.panel-header');
  if (!header || header.querySelector('.panel-url')) return;
  const titleBlock = header.querySelector('.panel-title-block');
  const nav = navState.get(acc.id) || {};
  const urlInput = document.createElement('input');
  urlInput.className = 'panel-url';
  urlInput.value = nav.url || acc.startUrl || '';
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      window.multiheiz.panelNavigate(acc.id, urlInput.value);
      editingUrlFor = null;
      renderGrid();
      scheduleSync();
    } else if (e.key === 'Escape') {
      editingUrlFor = null;
      renderGrid();
      scheduleSync();
    }
  });
  urlInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (editingUrlFor === acc.id) {
        editingUrlFor = null;
        renderGrid();
        scheduleSync();
      }
    }, 120);
  });
  if (titleBlock) titleBlock.replaceWith(urlInput);
  urlInput.focus();
  urlInput.select();
}

function iconBtn(pathD, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn icon ghost';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg(pathD);
  b.addEventListener('click', onClick);
  return b;
}

async function toggleMaximize(accountId) {
  const next = state.maximizedAccountId === accountId ? null : accountId;
  applyState(await window.multiheiz.setMaximized(next));
}

function pushOverlay(id) {
  const key = String(id || '').trim();
  if (!key) return;
  openOverlays.add(key);
  window.multiheiz.setOverlay(key, true);
}

function popOverlay(id) {
  const key = String(id || '').trim();
  if (!key) return;
  if (!openOverlays.has(key)) return;
  openOverlays.delete(key);
  window.multiheiz.setOverlay(key, false);
}

function applyOverlaySnapshotsToDom() {
  for (const node of el.grid.querySelectorAll('.panel-snapshot')) {
    const id = node.dataset.accountId;
    const dataUrl = overlaySnapMap.get(id);
    node.classList.remove('visible', 'fallback');
    if (dataUrl) {
      node.src = dataUrl;
      node.classList.add('visible');
    } else if (overlaySnapMap.has(id) || openOverlays.size > 0) {
      const acc = state.accounts.find((a) => a.id === id);
      node.removeAttribute('src');
      node.style.setProperty('--snap-color', (acc && acc.color) || '#243040');
      node.classList.add('visible', 'fallback');
    } else {
      node.removeAttribute('src');
    }
  }
}

function scheduleSync() {
  if (syncTimer) cancelAnimationFrame(syncTimer);
  syncTimer = requestAnimationFrame(() => {
    syncTimer = requestAnimationFrame(syncViews);
  });
}

function syncViews() {
  const contents = [...el.grid.querySelectorAll('.panel-content')];
  const slots = [];
  for (const node of contents) {
    const accountId = node.dataset.accountId;
    const rect = node.getBoundingClientRect();
    slots.push(contentRectToViewSlot(accountId, rect));
  }
  window.multiheiz.syncLayout(slots);
}

function updateMemBadges() {
  if (!latestMetrics) return;
  const total = latestMetrics.totalRamMb;
  el.btnMemTotal.textContent = typeof total === 'number' ? `${total} MB` : '— MB';
  const metric = metricName(latestMetrics);
  el.btnMemTotal.title = `Total do app: ${total} MB (${metric})\n${breakdownText(latestMetrics)}\nCPU ${latestMetrics.totalCpu}% (clique para monitor)`;
  updateStatusBar();
}

function updateStatusBar() {
  if (latestMetrics) {
    el.statCpu.textContent = `CPU ${latestMetrics.totalCpu ?? 0}%`;
    el.statRam.textContent = `RAM ${latestMetrics.totalRamMb ?? 0} MB`;
    el.statRam.title = breakdownText(latestMetrics);
  }
  el.statFps.textContent = focusedFps ? `FPS ${focusedFps}` : 'FPS —';
  el.statUptime.textContent = `Uptime ${formatUptime(Date.now() - appStartedAt)}`;
  el.statVersion.textContent = `v${appVersion}`;
}

function renderMemPopover() {
  if (!latestMetrics) {
    el.memPopoverTotal.textContent = 'Coletando métricas…';
    el.memPopoverList.innerHTML = '';
    return;
  }
  const metric = metricName(latestMetrics);
  el.memPopoverTotal.textContent = `Total: ${latestMetrics.totalRamMb} MB (${metric}) · CPU ${latestMetrics.totalCpu}% · ${latestMetrics.processCount} processos\n${breakdownText(latestMetrics)}\n${latestMetrics.panels.length} janela(s)`;
  el.memPopoverList.innerHTML = '';

  for (const p of latestMetrics.panels) {
    const row = document.createElement('div');
    row.className = 'mem-row';

    const title = document.createElement('div');
    title.className = 'mem-row-title';
    title.textContent = p.name;

    const meta = document.createElement('div');
    meta.className = 'mem-row-meta';
    const sharedNote = p.shared ? ' · compartilhado' : '';
    meta.textContent = `${p.workspaceName || '—'} · ${p.state} · ${p.ramMb} MB · ${p.cpu}%${sharedNote}`;
    const actions = document.createElement('div');
    actions.className = 'mem-row-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost';
    if (p.active) {
      btn.textContent = 'Suspender';
      btn.addEventListener('click', async () => {
        await window.multiheiz.panelSuspend(p.accountId);
        scheduleSync();
        render();
      });
    } else {
      btn.textContent = 'Reativar';
      btn.addEventListener('click', async () => {
        await window.multiheiz.panelReactivate(p.accountId);
        scheduleSync();
        render();
      });
    }
    actions.appendChild(btn);

    row.append(title, actions, meta);
    el.memPopoverList.appendChild(row);
  }
}

function showToast(message, action) {
  el.toast.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  el.toast.appendChild(text);
  if (action && action.label && action.path) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost tiny';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      if (window.multiheiz.openPath) window.multiheiz.openPath(action.path);
    });
    el.toast.appendChild(btn);
  }
  el.toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.add('hidden');
  }, 8000);
}

function openAccountDialog(account) {
  editingAccountId = account ? account.id : null;
  el.dlgAccountTitle.textContent = account ? 'Editar janela' : 'Nova janela';
  const form = el.formAccount;
  form.name.value = account ? account.name : '';
  form.color.value = account ? account.color : '#2bb8a6';
  form.startUrl.value = account ? account.startUrl : 'https://www.google.com';
  const keepAlive = !!(account && account.keepAliveInBackground);
  const pauseBg = !!(account && account.pauseInBackground);
  // Mutually exclusive — pause wins if both were somehow set
  form.keepAliveInBackground.checked = keepAlive && !pauseBg;
  form.pauseInBackground.checked = pauseBg;
  el.accountWsSelect.innerHTML = '';
  for (const ws of state.workspaces) {
    const opt = document.createElement('option');
    opt.value = ws.id;
    opt.textContent = ws.name;
    if (
      (account && account.workspaceId === ws.id) ||
      (!account && ws.id === state.activeWorkspaceId)
    ) {
      opt.selected = true;
    }
    el.accountWsSelect.appendChild(opt);
  }
  pushOverlay('dlg-account');
  el.dlgAccount.showModal();
}

function openWorkspaceDialog(ws) {
  editingWorkspaceId = ws ? ws.id : null;
  el.formWorkspace.name.value = ws ? ws.name : '';
  pushOverlay('dlg-workspace');
  el.dlgWorkspace.showModal();
}

/** @type {string|null} */
let proxyDialogAccountId = null;
/** @type {boolean} */
let proxyPasswordSaved = false;

function setProxyStatus(msg, kind) {
  if (!el.proxyStatus) return;
  el.proxyStatus.textContent = msg || '';
  el.proxyStatus.classList.toggle('is-error', kind === 'error');
  el.proxyStatus.classList.toggle('is-ok', kind === 'ok');
}

function syncProxyFieldsVisibility() {
  const none = el.proxyType.value === 'none';
  if (el.proxyFields) el.proxyFields.hidden = none;
  if (el.btnProxyTest) el.btnProxyTest.disabled = none;
  if (el.btnProxyRemove) el.btnProxyRemove.disabled = none;
}

async function openProxyDialog(accountId) {
  const acc = (state.accounts || []).find((a) => a.id === accountId);
  if (!acc || !el.dlgProxy) return;
  proxyDialogAccountId = accountId;
  el.dlgProxyTitle.textContent = `Proxy — ${acc.name || 'Janela'}`;
  el.dlgProxyHint.textContent = 'Aplica só a esta janela (sessão persistente).';
  setProxyStatus('', '');
  let data = null;
  try {
    data = await window.multiheiz.proxyGet(accountId);
  } catch (err) {
    setProxyStatus((err && err.message) || 'Falha ao carregar proxy', 'error');
  }
  const p = (data && data.proxy) || acc.proxy || { type: 'none' };
  el.proxyType.value = p.type || 'none';
  el.proxyHost.value = p.host || '';
  el.proxyPort.value = p.port ? String(p.port) : '';
  el.proxyUser.value = p.username || '';
  el.proxyPass.value = '';
  el.proxyBypass.value = p.bypass || '<local>';
  proxyPasswordSaved = !!(p.passwordSaved);
  if (el.proxyPassHint) {
    if (proxyPasswordSaved) {
      el.proxyPassHint.hidden = false;
      el.proxyPassHint.textContent = '••••• (salva) — deixe em branco para manter.';
    } else {
      el.proxyPassHint.hidden = true;
      el.proxyPassHint.textContent = '';
    }
  }
  if (data && data.encryptionAvailable === false) {
    setProxyStatus(
      'Criptografia do sistema indisponível: a senha não será salva.',
      'error'
    );
  }
  syncProxyFieldsVisibility();
  pushOverlay('dlg-proxy');
  el.dlgProxy.showModal();
}

function closeProxyDialog() {
  if (el.dlgProxy && el.dlgProxy.open) el.dlgProxy.close();
}

function fillAppearanceForm() {
  const a = state.appearance || THEME_PRESETS.escuro;
  el.themePreset.value = a.preset || 'escuro';
  const f = el.formSettings;
  f.accent.value = a.accent || '#2bb8a6';
  f.background.value = a.background || '#14181f';
  f.surface.value = a.surface || '#1e2430';
  f.text.value = a.text || '#e6ebea';
  f.panelHeader.value = a.panelHeader || '#243040';
  f.sidebar.value = a.sidebar || '#181c24';
}

function readAppearanceFromForm() {
  const f = el.formSettings;
  const preset = el.themePreset.value;
  if (preset !== 'custom' && THEME_PRESETS[preset]) {
    return { ...THEME_PRESETS[preset] };
  }
  return {
    preset: 'custom',
    accent: f.accent.value,
    background: f.background.value,
    surface: f.surface.value,
    text: f.text.value,
    panelHeader: f.panelHeader.value,
    sidebar: f.sidebar.value,
  };
}

function openSettings() {
  if (window.MultiHeizV16 && window.MultiHeizV16.fillSettingsForm) {
    window.MultiHeizV16.fillSettingsForm();
  } else {
    fillAppearanceForm();
  }
  pushOverlay('dlg-settings');
  el.dlgSettings.showModal();
}

function setClockSkewBanner(show, message) {
  if (!el.clockSkewBanner) return;
  if (message) {
    const span = el.clockSkewBanner.querySelector('span');
    if (span) span.textContent = message;
  }
  el.clockSkewBanner.classList.toggle('hidden', !show);
  if (el.mainCol) el.mainCol.classList.toggle('has-clock-skew', !!show);
  scheduleSync();
}

if (el.btnClockSkewDismiss) {
  el.btnClockSkewDismiss.addEventListener('click', () => setClockSkewBanner(false));
}

if (el.dlgNovidades) {
  el.dlgNovidades.addEventListener('close', () => popOverlay('dlg-novidades'));
}

/**
 * pt-BR confirm copy for deleting a workspace/area.
 * @param {string} name
 * @param {number} windowCount
 */
function workspaceDeleteConfirmMessage(name, windowCount) {
  const label = String(name || '');
  const n = Math.max(0, Number(windowCount) || 0);
  if (n <= 0) return `Excluir a área "${label}"?`;
  if (n === 1) {
    return `Excluir a área "${label}" e sua 1 janela? Isso não pode ser desfeito.`;
  }
  return `Excluir a área "${label}" e suas ${n} janelas? Isso não pode ser desfeito.`;
}

function confirmAction(message, onOk) {
  pendingConfirm = onOk;
  el.confirmMessage.textContent = message;
  pushOverlay('dlg-confirm');
  el.dlgConfirm.showModal();
}

function openMemPopover() {
  el.memPopover.classList.remove('hidden');
  pushOverlay('mem-popover');
  renderMemPopover();
}

function closeMemPopover() {
  if (el.memPopover.classList.contains('hidden')) return;
  el.memPopover.classList.add('hidden');
  popOverlay('mem-popover');
}

/* ---- Livre layout drag/resize ---- */

function startTileDrag(accountId, e, mode) {
  if (!isLivreEditMode()) return;
  e.preventDefault();
  const tiles = workspaceTiles();
  const tile = tiles[accountId] ? { ...tiles[accountId] } : null;
  if (!tile) return;
  const gridRect = el.grid.getBoundingClientRect();
  const target = e.currentTarget;
  tileDrag = {
    accountId,
    mode,
    startX: e.clientX,
    startY: e.clientY,
    origin: { ...tile },
    gridRect,
    colW: gridRect.width / FREE_COLS,
    rowH: gridRect.height / FREE_ROWS,
    pointerId: e.pointerId,
    moved: false,
    captureEl: target,
  };
  // Park views under snapshots so the whole tile receives pointer events during drag
  pushOverlay('layout-edit');
  try {
    if (target && typeof target.setPointerCapture === 'function' && e.pointerId != null) {
      target.setPointerCapture(e.pointerId);
    }
  } catch {
    /* ignore */
  }
  const slot = el.grid.querySelector(`.panel-slot[data-account-id="${accountId}"]`);
  if (slot) slot.classList.add(mode === 'move' ? 'dragging' : 'resizing');
  if (mode === 'move' && slot) {
    const hdr = slot.querySelector('.panel-header');
    if (hdr) hdr.style.cursor = 'grabbing';
  }
  window.addEventListener('pointermove', onTilePointerMove);
  window.addEventListener('pointerup', onTilePointerUp);
  window.addEventListener('pointercancel', onTilePointerUp);
  // sendInputEvent synthesizes mouse events — keep a parallel path for selftests
  window.addEventListener('mousemove', onTilePointerMove);
  window.addEventListener('mouseup', onTilePointerUp);
}

function onTilePointerMove(e) {
  if (!tileDrag) return;
  const { accountId, mode, startX, startY, origin, colW, rowH } = tileDrag;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (!tileDrag.moved) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    tileDrag.moved = true;
  }
  let next = { ...origin };
  if (mode === 'move') {
    next.c = Math.round(origin.c + dx / colW);
    next.r = Math.round(origin.r + dy / rowH);
  } else {
    if (mode.includes('e')) next.w = Math.round(origin.w + dx / colW);
    if (mode.includes('s')) next.h = Math.round(origin.h + dy / rowH);
  }
  next.w = Math.max(FREE_MIN_W, Math.min(FREE_COLS, next.w));
  next.h = Math.max(FREE_MIN_H, Math.min(FREE_ROWS, next.h));
  next.c = Math.max(0, Math.min(FREE_COLS - next.w, next.c));
  next.r = Math.max(0, Math.min(FREE_ROWS - next.h, next.r));

  const tiles = workspaceTiles();
  let conflict = false;
  for (const [id, t] of Object.entries(tiles)) {
    if (id === accountId) continue;
    if (tilesOverlap(next, t)) {
      conflict = true;
      break;
    }
  }
  if (conflict) return;

  tiles[accountId] = next;
  state.freeTiles = { ...(state.freeTiles || {}), [state.activeWorkspaceId]: tiles };
  const slot = el.grid.querySelector(`.panel-slot[data-account-id="${accountId}"]`);
  if (slot) {
    slot.dataset.tile = JSON.stringify(next);
    applyTileStyle(slot, next);
  }
}

async function onTilePointerUp(e) {
  if (!tileDrag) return;
  const { accountId, moved, captureEl, pointerId } = tileDrag;
  tileDrag = null;
  window.removeEventListener('pointermove', onTilePointerMove);
  window.removeEventListener('pointerup', onTilePointerUp);
  window.removeEventListener('pointercancel', onTilePointerUp);
  window.removeEventListener('mousemove', onTilePointerMove);
  window.removeEventListener('mouseup', onTilePointerUp);
  try {
    if (captureEl && pointerId != null && typeof captureEl.releasePointerCapture === 'function') {
      captureEl.releasePointerCapture(pointerId);
    }
  } catch {
    /* ignore */
  }
  const slot = el.grid.querySelector(`.panel-slot[data-account-id="${accountId}"]`);
  if (slot) {
    slot.classList.remove('dragging', 'resizing');
    const hdr = slot.querySelector('.panel-header');
    if (hdr && isLivreEditMode()) hdr.style.cursor = 'grab';
  }
  if (!moved) {
    popOverlay('layout-edit');
    scheduleSync();
    return;
  }
  const tiles = workspaceTiles();
  applyState(await window.multiheiz.setFreeTiles(state.activeWorkspaceId, tiles));
  popOverlay('layout-edit');
  scheduleSync();
}

/** Reject overlapping tile placement (for selftests / API). */
function proposeTiles(tiles) {
  const ids = Object.keys(tiles);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (tilesOverlap(tiles[ids[i]], tiles[ids[j]])) {
        return { ok: false, reason: 'overlap' };
      }
    }
  }
  return { ok: true, tiles };
}

/* Events */

el.btnAddAccount.addEventListener('click', () => openAccountDialog(null));
el.btnWsAdd.addEventListener('click', () => openWorkspaceDialog(null));
el.btnSettings.addEventListener('click', openSettings);
if (el.btnOverflow) {
  el.btnOverflow.addEventListener('click', (e) => {
    const r = el.btnOverflow.getBoundingClientRect();
    window.multiheiz.popupTopMenu(Math.round(r.left), Math.round(r.bottom + 2));
    e.stopPropagation();
  });
}
if (el.btnTabsMore) {
  el.btnTabsMore.addEventListener('click', (e) => {
    e.stopPropagation();
    showTabsOverflowMenu();
  });
}
if (el.tabs) {
  el.tabs.addEventListener(
    'wheel',
    (e) => {
      if (el.tabs.scrollWidth <= el.tabs.clientWidth + 1) return;
      const dy = e.deltaY;
      const dx = e.deltaX;
      if (Math.abs(dy) >= Math.abs(dx) && dy !== 0) {
        e.preventDefault();
        el.tabs.scrollLeft += dy;
        updateTabsOverflow();
      }
    },
    { passive: false }
  );
  el.tabs.addEventListener('scroll', () => updateTabsOverflow(), { passive: true });
}
window.addEventListener('resize', () => updateTabsOverflow());

el.btnSidebarToggle.addEventListener('click', async () => {
  clearSidebarHoverTimers();
  // F11: temporary pin/unpin — never writes sidebarAutoHide / legacy prefs.
  if (isChromeHiddenMode()) {
    if (sidebarFsPinned) {
      sidebarFsPinned = false;
      setSidebarAutoHideOpen(false, { force: true });
      updateSidebarCollapseClasses();
    } else {
      sidebarFsPinned = true;
      setSidebarAutoHideOpen(true, { force: true });
      updateSidebarCollapseClasses();
    }
    return;
  }
  if (isSidebarLegacyAlwaysActive()) {
    // Pre-1.3.0 behavior: collapse/expand icon rail (incl. narrow auto-collapse).
    const narrow = window.innerWidth < SIDEBAR_AUTO_BREAKPOINT;
    const currentlyCollapsed = isSidebarEffectivelyCollapsed();
    if (narrow) {
      if (currentlyCollapsed) {
        sidebarForceExpanded = true;
        applyState(await window.multiheiz.updateUi({ sidebarCollapsed: false }));
      } else {
        sidebarForceExpanded = false;
        applyState(await window.multiheiz.updateUi({ sidebarCollapsed: true }));
      }
    } else {
      sidebarForceExpanded = false;
      const collapsed = !state.ui?.sidebarCollapsed;
      applyState(await window.multiheiz.updateUi({ sidebarCollapsed: collapsed }));
    }
    return;
  }
  sidebarForceExpanded = false;
  const nextAutoHide = !isSidebarAutoHide();
  if (!nextAutoHide) {
    // Pin while revealed: switch to fixed layout first (sidebar stays visible), then
    // clear overlay — avoid a closed/open flash.
    const wasOpen = sidebarAutoHideOpen;
    applyState(
      await window.multiheiz.updateUi({
        sidebarAutoHide: false,
        sidebarCollapsed: false,
      })
    );
    sidebarAutoHideOpen = false;
    sidebarCursorInside = null;
    if (el.app) el.app.classList.remove('sidebar-auto-hide-open');
    if (el.sidebar) el.sidebar.classList.remove('auto-hide-open');
    await syncSidebarOverlayBounds(false);
    syncSidebarAutoHideTracking();
    if (wasOpen) scheduleSync();
    return;
  }
  applyState(
    await window.multiheiz.updateUi({
      sidebarAutoHide: true,
      // Clear collapsed flag when using the new fixed/auto-hide toggle.
      sidebarCollapsed: false,
    })
  );
  // Entering auto-hide: start hidden (panels full width + hot-zone).
  setSidebarAutoHideOpen(false);
});

/* Auto-hide: DOM hot-zone + leave hints; main cursor polling is the durable source of truth */
(function setupSidebarAutoHideHover() {
  if (el.sidebarHotzone) {
    el.sidebarHotzone.addEventListener('mouseenter', () => requestSidebarShow());
    el.sidebarHotzone.addEventListener('mouseleave', () => {
      // If moving into the open sidebar, do not schedule hide.
      if (sidebarAutoHideOpen) return;
      // Polling may still report inside (≤12px over a panel) — do not cancel reveal then.
      if (sidebarCursorInside === true) return;
      if (sidebarShowTimer) {
        clearTimeout(sidebarShowTimer);
        sidebarShowTimer = null;
      }
    });
  }
  if (el.sidebar) {
    el.sidebar.addEventListener('mouseenter', () => {
      if (!usesSidebarOverlay()) return;
      clearSidebarHoverTimers();
    });
    el.sidebar.addEventListener('mouseleave', () => {
      if (!usesSidebarOverlay() || !sidebarAutoHideOpen) return;
      // Drag regions / panels fire leave even when the cursor is still in the keep-open strip.
      if (sidebarCursorInside === true) return;
      requestSidebarHide();
    });
  }
})();

el.btnLayoutLock.addEventListener('click', async () => {
  applyState(await window.multiheiz.updateUi({ layoutLocked: !isLayoutLocked() }));
});

if (el.btnBannerLock) {
  el.btnBannerLock.addEventListener('click', async () => {
    applyState(await window.multiheiz.updateUi({ layoutLocked: true }));
  });
}

el.btnMemTotal.addEventListener('click', (e) => {
  e.stopPropagation();
  if (el.memPopover.classList.contains('hidden')) openMemPopover();
  else closeMemPopover();
});
el.btnMemClose.addEventListener('click', () => closeMemPopover());

el.dlgAccount.addEventListener('close', () => popOverlay('dlg-account'));
el.dlgWorkspace.addEventListener('close', () => popOverlay('dlg-workspace'));
el.dlgSettings.addEventListener('close', () => popOverlay('dlg-settings'));
el.dlgConfirm.addEventListener('close', () => popOverlay('dlg-confirm'));
if (el.dlgProxy) {
  el.dlgProxy.addEventListener('close', () => {
    popOverlay('dlg-proxy');
    proxyDialogAccountId = null;
  });
  if (el.proxyType) {
    el.proxyType.addEventListener('change', syncProxyFieldsVisibility);
  }
  if (el.btnProxyCancel) {
    el.btnProxyCancel.addEventListener('click', () => closeProxyDialog());
  }
  if (el.formProxy) {
    el.formProxy.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!proxyDialogAccountId) return;
      setProxyStatus('Salvando…', '');
      const payload = {
        accountId: proxyDialogAccountId,
        type: el.proxyType.value,
        host: el.proxyHost.value,
        port: el.proxyPort.value,
        username: el.proxyUser.value,
        bypass: el.proxyBypass.value,
      };
      const passVal = el.proxyPass.value;
      if (passVal) payload.password = passVal;
      try {
        const res = await window.multiheiz.proxySet(payload);
        if (!res || !res.ok) {
          setProxyStatus((res && res.error) || 'Falha ao salvar proxy', 'error');
          return;
        }
        if (res.state) applyState(res.state);
        if (res.passwordWarning) {
          setProxyStatus(res.passwordWarning, 'error');
        } else {
          setProxyStatus('Proxy salvo.', 'ok');
        }
        el.proxyPass.value = '';
        proxyPasswordSaved = !!(res.proxy && res.proxy.passwordSaved);
        if (el.proxyPassHint) {
          el.proxyPassHint.hidden = !proxyPasswordSaved;
          el.proxyPassHint.textContent = proxyPasswordSaved
            ? '••••• (salva) — deixe em branco para manter.'
            : '';
        }
        renderSidebar();
      } catch (err) {
        setProxyStatus((err && err.message) || 'Falha ao salvar proxy', 'error');
      }
    });
  }
  if (el.btnProxyTest) {
    el.btnProxyTest.addEventListener('click', async () => {
      if (!proxyDialogAccountId) return;
      setProxyStatus('Testando proxy…', '');
      try {
        const res = await window.multiheiz.proxyTest(proxyDialogAccountId);
        if (!res || !res.ok) {
          setProxyStatus((res && res.error) || 'Teste falhou', 'error');
          return;
        }
        const ip = res.ip || '';
        setProxyStatus(
          ip ? `Proxy OK — IP/resposta: ${ip}` : 'Proxy OK',
          'ok'
        );
      } catch (err) {
        setProxyStatus((err && err.message) || 'Teste falhou', 'error');
      }
    });
  }
  if (el.btnProxyRemove) {
    el.btnProxyRemove.addEventListener('click', async () => {
      if (!proxyDialogAccountId) return;
      setProxyStatus('Removendo…', '');
      try {
        const res = await window.multiheiz.proxyRemove(proxyDialogAccountId);
        if (!res || !res.ok) {
          setProxyStatus((res && res.error) || 'Falha ao remover', 'error');
          return;
        }
        if (res.state) applyState(res.state);
        el.proxyType.value = 'none';
        el.proxyPass.value = '';
        proxyPasswordSaved = false;
        if (el.proxyPassHint) el.proxyPassHint.hidden = true;
        syncProxyFieldsVisibility();
        setProxyStatus('Proxy removido (conexão direta).', 'ok');
        renderSidebar();
      } catch (err) {
        setProxyStatus((err && err.message) || 'Falha ao remover', 'error');
      }
    });
  }
}

el.layoutSelect.addEventListener('mousedown', () => pushOverlay('layout-select'));
el.layoutSelect.addEventListener('focus', () => pushOverlay('layout-select'));
el.layoutSelect.addEventListener('blur', () => popOverlay('layout-select'));

el.btnFreeMem.addEventListener('click', async () => {
  el.btnFreeMem.disabled = true;
  try {
    const res = await window.multiheiz.freeMemory();
    if (!res.freedMb) {
      showToast('Memória: nenhum MB liberado (0 MB)');
    } else {
      showToast(
        `Memória: ${res.beforeMb} MB → ${res.afterMb} MB (liberados ${res.freedMb} MB)`
      );
    }
    scheduleSync();
    render();
  } catch {
    showToast('Falha ao liberar memória');
  } finally {
    el.btnFreeMem.disabled = false;
  }
});

el.layoutSelect.addEventListener('change', async () => {
  popOverlay('layout-select');
  applyState(await window.multiheiz.setLayout(el.layoutSelect.value));
});

el.btnPrev.addEventListener('click', async () => {
  applyState(await window.multiheiz.setPage(Math.max(0, (state.page || 0) - 1)));
});
el.btnNext.addEventListener('click', async () => {
  applyState(await window.multiheiz.setPage((state.page || 0) + 1));
});

// Manter ativa / Pausar em segundo plano: mutually exclusive checkboxes
if (el.formAccount && el.formAccount.keepAliveInBackground && el.formAccount.pauseInBackground) {
  el.formAccount.keepAliveInBackground.addEventListener('change', () => {
    if (el.formAccount.keepAliveInBackground.checked) {
      el.formAccount.pauseInBackground.checked = false;
    }
  });
  el.formAccount.pauseInBackground.addEventListener('change', () => {
    if (el.formAccount.pauseInBackground.checked) {
      el.formAccount.keepAliveInBackground.checked = false;
    }
  });
}

el.formAccount.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(el.formAccount);
  let keepAliveInBackground = el.formAccount.keepAliveInBackground.checked;
  let pauseInBackground = el.formAccount.pauseInBackground.checked;
  if (keepAliveInBackground && pauseInBackground) {
    keepAliveInBackground = false;
  }
  const data = {
    name: String(fd.get('name') || '').trim(),
    color: String(fd.get('color') || '#2bb8a6'),
    startUrl: String(fd.get('startUrl') || '').trim(),
    workspaceId: String(fd.get('workspaceId') || state.activeWorkspaceId),
    keepAliveInBackground,
    pauseInBackground,
  };
  if (editingAccountId) {
    applyState(await window.multiheiz.updateAccount({ id: editingAccountId, ...data }));
  } else {
    const res = await window.multiheiz.createAccount(data);
    applyState(res.state);
  }
  el.dlgAccount.close();
});

document.getElementById('btn-account-cancel').addEventListener('click', () => el.dlgAccount.close());

el.formWorkspace.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = String(new FormData(el.formWorkspace).get('name') || '').trim();
  if (!name) return;
  if (editingWorkspaceId) {
    applyState(await window.multiheiz.renameWorkspace(editingWorkspaceId, name));
  } else {
    applyState(await window.multiheiz.createWorkspace(name));
  }
  el.dlgWorkspace.close();
});

document.getElementById('btn-ws-cancel').addEventListener('click', () => el.dlgWorkspace.close());

el.themePreset.addEventListener('change', () => {
  const preset = el.themePreset.value;
  if (THEME_PRESETS[preset]) {
    const p = THEME_PRESETS[preset];
    const f = el.formSettings;
    f.accent.value = p.accent;
    f.background.value = p.background;
    f.surface.value = p.surface;
    f.text.value = p.text;
    f.panelHeader.value = p.panelHeader;
    f.sidebar.value = p.sidebar;
    applyAppearance(p);
  } else {
    applyAppearance(readAppearanceFromForm());
  }
  if (window.MultiHeizV16 && window.MultiHeizV16.autosaveSettings) {
    window.MultiHeizV16.autosaveSettings();
  }
});

for (const id of ['theme-accent', 'theme-bg', 'theme-surface', 'theme-text', 'theme-header', 'theme-sidebar']) {
  const node = document.getElementById(id);
  if (node) {
    node.addEventListener('input', () => {
      el.themePreset.value = 'custom';
      applyAppearance(readAppearanceFromForm());
    });
    node.addEventListener('change', () => {
      if (window.MultiHeizV16 && window.MultiHeizV16.autosaveSettings) {
        window.MultiHeizV16.autosaveSettings();
      }
    });
  }
}

el.btnThemeReset.addEventListener('click', async () => {
  applyState(await window.multiheiz.resetAppearance());
  fillAppearanceForm();
  applyAppearance(state.appearance);
  if (window.MultiHeizV16 && window.MultiHeizV16.autosaveSettings) {
    window.MultiHeizV16.autosaveSettings();
  }
});

el.formSettings.addEventListener('submit', (e) => {
  e.preventDefault();
});

document.getElementById('btn-settings-cancel').addEventListener('click', () => el.dlgSettings.close());

el.formConfirm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fn = pendingConfirm;
  pendingConfirm = null;
  el.dlgConfirm.close();
  if (fn) await fn();
});

document.getElementById('confirm-cancel').addEventListener('click', () => {
  pendingConfirm = null;
  el.dlgConfirm.close();
});

window.addEventListener('resize', () => {
  if (window.innerWidth >= SIDEBAR_AUTO_BREAKPOINT) {
    sidebarForceExpanded = false;
  }
  updateSidebarCollapseClasses();
  scheduleSync();
});

if (typeof ResizeObserver === 'function') {
  const ro = new ResizeObserver(() => scheduleSync());
  ro.observe(el.grid);
  ro.observe(el.sidebar);
}

/* Sidebar width drag (optional, saved in ui.sidebarWidth) */
(function setupSidebarResize() {
  if (!el.sidebar) return;
  let handle = el.sidebar.querySelector('.sidebar-resize-handle');
  if (!handle) {
    handle = document.createElement('div');
    handle.className = 'sidebar-resize-handle';
    handle.title = 'Redimensionar barra lateral';
    el.sidebar.appendChild(handle);
  }
  let dragging = false;
  let startX = 0;
  let startW = SIDEBAR_W_DEFAULT;
  handle.addEventListener('mousedown', (e) => {
    if (isSidebarEffectivelyCollapsed() || isSidebarAutoHide()) return;
    dragging = true;
    startX = e.clientX;
    startW = el.sidebar.getBoundingClientRect().width;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const next = clampSidebarWidth(startW + (e.clientX - startX));
    document.documentElement.style.setProperty('--sidebar-w', `${next}px`);
    scheduleSync();
  });
  window.addEventListener('mouseup', async () => {
    if (!dragging) return;
    dragging = false;
    const w = clampSidebarWidth(el.sidebar.getBoundingClientRect().width);
    applyState(await window.multiheiz.updateUi({ sidebarWidth: w }));
  });
})();

document.addEventListener('click', (e) => {
  if (!e.target.closest('.context-menu')) {
    // Defer so a same-tick opener can attach the menu before we tear it down
    setTimeout(() => closeMenus(), 0);
  }
  if (
    !el.memPopover.classList.contains('hidden') &&
    !e.target.closest('#mem-popover') &&
    !e.target.closest('#btn-mem-total')
  ) {
    closeMemPopover();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
});

window.multiheiz.onEvent((payload) => {
  if (!payload) return;
  if (payload.type === 'state:changed' && payload.state) {
    applyState(payload.state);
    scheduleSync();
    return;
  }
  if (payload.type === 'ui:open-proxy' && payload.accountId) {
    openProxyDialog(payload.accountId);
    return;
  }
  if (payload.type === 'ui:open-url-new-panel' && payload.url) {
    (async () => {
      try {
        const res = await window.multiheiz.createAccount({
          name: 'Janela',
          startUrl: payload.url,
        });
        if (res && res.state) applyState(res.state);
        if (res && res.account) {
          await window.multiheiz.panelNavigate(res.account.id, payload.url);
        }
        scheduleSync();
      } catch (err) {
        console.warn('ui:open-url-new-panel', err);
      }
    })();
    return;
  }
  if (payload.type === 'ui:edit-account' && payload.accountId) {
    const acc = state.accounts.find((a) => a.id === payload.accountId);
    if (acc) openAccountDialog(acc);
    return;
  }
  if (payload.type === 'ui:confirm-remove-account' && payload.accountId) {
    const acc = state.accounts.find((a) => a.id === payload.accountId);
    if (!acc) return;
    const doRemove = async () => {
      applyState(await window.multiheiz.removeAccount(acc.id));
    };
    if (state.settings && state.settings.confirmOnRemove === false) {
      doRemove();
    } else {
      confirmAction(`Remover a janela “${acc.name}”?`, doRemove);
    }
    return;
  }
  if (payload.type === 'layout:recompute') {
    scheduleSync();
    return;
  }
  if (payload.type === 'window:maximized') {
    setWindowMaximizedUi(!!payload.maximized);
    scheduleSync();
    return;
  }
  if (payload.type === 'window:fullscreen') {
    document.body.classList.toggle('is-fullscreen', !!payload.fullscreen);
    scheduleSync();
    return;
  }
  if (payload.type === 'chrome:hidden') {
    document.body.classList.toggle('is-chrome-hidden', !!payload.hidden);
    clearSidebarHoverTimers();
    sidebarFsPinned = false;
    sidebarCursorInside = null;
    if (payload.hidden) {
      // Enter F11: sidebar hidden by default; left edge reveals as overlay.
      sidebarAutoHideOpen = false;
      if (el.app) el.app.classList.remove('sidebar-auto-hide-open');
      if (el.sidebar) el.sidebar.classList.remove('auto-hide-open');
      syncSidebarOverlayBounds(false);
    } else {
      // Leave F11: restore saved mode visually (prefs unchanged).
      sidebarAutoHideOpen = false;
      if (el.app) el.app.classList.remove('sidebar-auto-hide-open');
      if (el.sidebar) el.sidebar.classList.remove('auto-hide-open');
      syncSidebarOverlayBounds(false);
    }
    updateSidebarCollapseClasses();
    scheduleSync();
    return;
  }
  if (payload.type === 'sidebar:native-menu') {
    sidebarNativeMenuOpen = !!payload.open;
    if (!sidebarNativeMenuOpen && usesSidebarOverlay() && sidebarAutoHideOpen) {
      requestSidebarHide();
    }
    return;
  }
  if (payload.type === 'sidebar:cursor') {
    onSidebarCursorFromMain(!!payload.inside);
    return;
  }
  if (payload.type === 'overlay:snapshots') {
    overlaySnapMap.clear();
    for (const s of payload.snapshots || []) {
      overlaySnapMap.set(s.accountId, s.dataUrl || null);
    }
    applyOverlaySnapshotsToDom();
    return;
  }
  if (payload.type === 'panel:focus-changed') {
    focusedAccountId = payload.accountId || null;
    if (typeof payload.zoom === 'number') {
      focusedZoom = payload.zoom;
      if (focusedAccountId) panelZoomMap.set(focusedAccountId, payload.zoom);
    }
    renderSidebar();
    // Highlight focused panel chrome; URL bar (Ctrl+L) follows focusedAccountId
    for (const slot of el.grid.querySelectorAll('.panel-slot')) {
      slot.classList.toggle('focused', slot.dataset.accountId === focusedAccountId);
    }
    // Re-sync so focused panel view inset (FOCUS_FRAME) updates
    scheduleSync();
    return;
  }
  if (payload.type === 'panel:zoom-changed') {
    if (typeof payload.zoom === 'number' && payload.accountId) {
      panelZoomMap.set(payload.accountId, payload.zoom);
      if (payload.accountId === focusedAccountId) focusedZoom = payload.zoom;
      showPanelZoomToast(payload.accountId, payload.zoom);
    }
    return;
  }
  if (payload.type === 'ui:new-account') {
    openAccountDialog(null);
    return;
  }
  if (payload.type === 'ui:help-shortcuts') {
    showToast(
      'Atalhos: F5 recarregar · Ctrl+L URL · Ctrl+/-/0 zoom · F11 tela cheia · Ctrl+J downloads · Alt+Home início'
    );
    return;
  }
  if (payload.type === 'ui:novidades') {
    if (window.MultiHeizV16 && window.MultiHeizV16.openNovidades) {
      // Show-once after update marks seen on close; manual/menu does not force-mark.
      const markSeen = payload.reason === 'update' || payload.auto === true;
      window.MultiHeizV16.openNovidades({
        auto: !!payload.auto,
        markSeen,
      });
    }
    return;
  }
  if (payload.type === 'clock:skew') {
    setClockSkewBanner(!!payload.skewed, payload.message);
    return;
  }
  if (payload.type === 'focus:url') {
    const focused =
      el.grid.querySelector(`.panel-slot[data-account-id="${focusedAccountId}"]`) ||
      el.grid.querySelector('.panel-slot');
    if (focused) {
      const acc = state.accounts.find((a) => a.id === focused.dataset.accountId);
      if (acc) showUrlEditor(focused, acc);
    }
    return;
  }
  if (payload.type === 'memory:metrics' && payload.metrics) {
    latestMetrics = payload.metrics;
    updateMemBadges();
    renderSidebar();
    return;
  }
  if (payload.type === 'memory:suspended' && Array.isArray(payload.suspendedIds)) {
    const next = new Set(payload.suspendedIds);
    let changed = next.size !== forceSuspended.size;
    if (!changed) {
      for (const id of next) {
        if (!forceSuspended.has(id)) {
          changed = true;
          break;
        }
      }
    }
    forceSuspended = next;
    if (changed) {
      render();
      scheduleSync();
    }
    return;
  }
  if (payload.type === 'memory:freed') {
    if (!el.btnFreeMem.disabled) {
      if (!payload.freedMb) {
        showToast('Memória: nenhum MB liberado (0 MB)');
      } else {
        showToast(
          `Memória: ${payload.beforeMb} MB → ${payload.afterMb} MB (liberados ${payload.freedMb} MB)`
        );
      }
    }
    return;
  }
  if (payload.type === 'adblock:stats') {
    if (payload.accountId) {
      const n = Number(payload.pageBlocked) || 0;
      adblockPageCounts.set(payload.accountId, n);
      const panel =
        el.grid &&
        el.grid.querySelector(`.panel-slot[data-account-id="${payload.accountId}"]`);
      const shield = panel && panel.querySelector('[data-role="panel-adblock"]');
      if (shield) {
        let c = shield.querySelector('.adblock-count');
        if (n > 0) {
          if (!c) {
            c = document.createElement('span');
            c.className = 'adblock-count';
            shield.appendChild(c);
          }
          c.textContent = String(n);
          const tipBase = `Bloqueador: ${n} nesta página (clique para opções)`;
          shield.title = tipBase;
          if (window.multiheiz.adblockFocusedDiagnostics) {
            const url = (state.accounts.find((a) => a.id === payload.accountId) || {}).lastUrl || '';
            window.multiheiz
              .adblockFocusedDiagnostics(payload.accountId, url)
              .then((d) => {
                if (!d || !shield.isConnected) return;
                const early = d.scriptletsInjected
                  ? `scriptlets ${d.scriptletCount}${d.earlyCss ? ' + CSS' : ''}`
                  : 'early pendente';
                shield.title = `${tipBase}\n${early} · motor ${d.engineSource || '?'}`;
              })
              .catch(() => {});
          }
        } else if (c) {
          c.remove();
        }
      }
    }
    if (typeof payload.sessionTotal === 'number') {
      adblockSessionTotal = payload.sessionTotal;
    }
  }
  if (payload.type === 'extensions:changed') {
    /* list refreshed when settings pane opens; puzzle menu fetches live */
    if (window.MultiHeizV16 && window.MultiHeizV16.refreshExtensionsUi) {
      window.MultiHeizV16.refreshExtensionsUi().catch(() => {});
    }
    return;
  }
  if (payload.type === 'permissions:prompt' && payload.accountId) {
    permissionPrompts.set(payload.accountId, payload);
    const slot = el.grid.querySelector(`.panel-slot[data-account-id="${payload.accountId}"]`);
    if (slot) ensurePermissionPromptBar(slot, payload.accountId, payload);
  }
  if (
    (payload.type === 'permissions:prompt-closed' || payload.type === 'permissions:prompt-cleared') &&
    payload.accountId
  ) {
    if (payload.type === 'permissions:prompt-cleared') {
      permissionPrompts.delete(payload.accountId);
    } else if (payload.requestId) {
      const cur = permissionPrompts.get(payload.accountId);
      if (cur && cur.requestId === payload.requestId) {
        permissionPrompts.delete(payload.accountId);
      }
    }
    const slot = el.grid.querySelector(`.panel-slot[data-account-id="${payload.accountId}"]`);
    if (slot) {
      ensurePermissionPromptBar(
        slot,
        payload.accountId,
        permissionPrompts.get(payload.accountId) || null
      );
    }
  }
  if (payload.type === 'permissions:media-use' && payload.accountId) {
    applyMediaUseToPanel(payload.accountId, {
      microphone: !!payload.microphone,
      camera: !!payload.camera,
    });
  }
  if (payload.type === 'extensions:store-offer') {
    updateStoreOfferBar(payload.accountId, payload.offer || null);
    return;
  }
  if (payload.type === 'extensions:store-progress') {
    updateStoreOfferProgress(payload.accountId, payload.status, payload.message);
    return;
  }
  if (payload.type === 'extensions:prompt-apply') {
    // Reuse Configurações → Extensões applyTo radios (same as after file install)
    const openBtn = document.getElementById('btn-settings');
    if (openBtn) openBtn.click();
    if (window.MultiHeizV16 && window.MultiHeizV16.openSettingsSection) {
      setTimeout(() => window.MultiHeizV16.openSettingsSection('extensoes'), 40);
    }
    if (window.MultiHeizV16 && window.MultiHeizV16.refreshExtensionsUi) {
      window.MultiHeizV16.refreshExtensionsUi().catch(() => {});
    }
    return;
  }
  if (payload.type === 'adblock:progress' || payload.type === 'adblock:status') {
    const prog = document.getElementById('adblock-progress');
    if (prog) {
      if (payload.rebuilding) {
        prog.textContent = payload.progress || 'Recompilando…';
      } else if (payload.type === 'adblock:progress') {
        prog.textContent = '';
      }
    }
    const total = document.getElementById('adblock-total-rules');
    const st = payload.status;
    if (total && st && st.ready) {
      total.textContent = `${st.totalFilterCount || 0} (${st.networkFilterCount || 0} rede + ${st.cosmeticFilterCount || 0} cosmético)`;
    }
    const msg = document.getElementById('adblock-status-msg');
    if (msg && st && st.statusMessage) msg.textContent = st.statusMessage;
  }

  if (payload.type === 'panel:favicon') {
    if (payload.favicon) favicons.set(payload.accountId, payload.favicon);
    const imgs = document.querySelectorAll(
      `.panel-fav, .sidebar-fav`
    );
    /* refresh sidebar/panel favicons lightly */
    renderSidebar();
    const slotFav = el.grid.querySelector(
      `.panel-slot[data-account-id="${payload.accountId}"] .panel-fav`
    );
    if (slotFav && payload.favicon) slotFav.src = payload.favicon;
    return;
  }
  if (payload.type === 'panel:fps') {
    if (payload.accountId === focusedAccountId) {
      focusedFps = payload.fps | 0;
      updateStatusBar();
    }
    return;
  }
  if (payload.type === 'toast' && payload.message) {
    showToast(payload.message, payload.action);
    return;
  }
  if (payload.type === 'panel:load-status') {
    const slot = el.grid.querySelector(`.panel-slot[data-account-id="${payload.accountId}"]`);
    if (slot) {
      let st = slot.querySelector('.panel-load-status');
      if (!st) {
        st = document.createElement('div');
        st.className = 'panel-load-status';
        slot.appendChild(st);
      }
      st.textContent = payload.message || '';
      st.dataset.status = payload.status || '';
      if (payload.status === 'error' || payload.status === 'retry') {
        st.classList.remove('hidden');
      } else {
        st.classList.add('hidden');
      }
    }
    return;
  }
  if (payload.type === 'panel:nav') {
    navState.set(payload.accountId, {
      url: payload.url || '',
      title: payload.title || '',
      domain: payload.domain || '',
      canGoBack: !!payload.canGoBack,
      canGoForward: !!payload.canGoForward,
      muted: !!payload.muted,
    });
    const slot = el.grid.querySelector(`.panel-slot[data-account-id="${payload.accountId}"]`);
    if (slot) {
      const titleEl = slot.querySelector('.panel-title');
      const domainEl = slot.querySelector('.panel-domain');
      if (titleEl && editingUrlFor !== payload.accountId) {
        titleEl.textContent = payload.title || titleEl.textContent;
      }
      if (domainEl && payload.domain) domainEl.textContent = payload.domain;
      const buttons = slot.querySelectorAll('.panel-header-actions .btn.icon');
      if (buttons[0]) buttons[0].disabled = !payload.canGoBack;
      if (buttons[1]) buttons[1].disabled = !payload.canGoForward;
      const muteBtn = [...slot.querySelectorAll('.btn.icon')].find((b) => b.title === 'Mudo');
      if (muteBtn) muteBtn.innerHTML = svg(payload.muted ? ICO.mute : ICO.unmute);
      const loadSt = slot.querySelector('.panel-load-status');
      if (loadSt) loadSt.classList.add('hidden');
    }
  }
});

function statusBarShouldRun() {
  try {
    return !document.hidden && (!window.matchMedia || !window.matchMedia('(display-mode)').matches);
  } catch {
    return !document.hidden;
  }
}

function tickStatusBar() {
  if (document.hidden) return;
  updateStatusBar();
}

statusTimer = setInterval(tickStatusBar, 2000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateStatusBar();
});
void statusBarShouldRun;

/** Exposed for selftests */
window.__multiheizUi = {
  workspaceDeleteConfirmMessage,
  openAccountDialog: () => openAccountDialog(null),
  closeAccountDialog: () => {
    if (el.dlgAccount.open) el.dlgAccount.close();
  },
  openSettings: () => openSettings(),
  setClockSkewBanner,
  closeSettings: () => {
    if (el.dlgSettings.open) el.dlgSettings.close();
  },
  openMemPopover: () => openMemPopover(),
  closeMemPopover: () => closeMemPopover(),
  syncNow: () => {
    syncViews();
    return true;
  },
  getSlotRects: () => {
    return [...el.grid.querySelectorAll('.panel-content')].map((node) => {
      const r = node.getBoundingClientRect();
      return {
        accountId: node.dataset.accountId,
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      };
    });
  },
  /** Rects matching what syncViews sends to WebContentsView (includes handle insets). */
  getViewTargetRects: () => {
    return [...el.grid.querySelectorAll('.panel-content')].map((node) => {
      const r = node.getBoundingClientRect();
      return contentRectToViewSlot(node.dataset.accountId, r);
    });
  },
  getHandleHitPoints: () => {
    const points = [];
    for (const slot of el.grid.querySelectorAll('.panel-slot')) {
      const accountId = slot.dataset.accountId;
      for (const sel of ['.resize-handle.e', '.resize-handle.s', '.resize-handle.se']) {
        const node = slot.querySelector(sel);
        if (!node) continue;
        const r = node.getBoundingClientRect();
        points.push({
          accountId,
          role: sel.replace('.resize-handle.', ''),
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        });
      }
    }
    return { points, handleInset: HANDLE_INSET, livreEdit: isLivreEditMode() };
  },
  getPanelChromeRect: (accountId, role) => {
    const slot = el.grid.querySelector(`.panel-slot[data-account-id="${accountId}"]`);
    if (!slot) return null;
    let node = null;
    if (role === 'header') node = slot.querySelector('.panel-header');
    else if (role === 'title') node = slot.querySelector('.panel-title-block');
    else if (role === 'se') node = slot.querySelector('.resize-handle.se');
    else if (role === 'e') node = slot.querySelector('.resize-handle.e');
    else if (role === 's') node = slot.querySelector('.resize-handle.s');
    else if (role === 'reload') node = slot.querySelector('[data-role="panel-reload"]');
    else if (role === 'menu') node = slot.querySelector('[data-role="panel-menu"]');
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, accountId, role };
  },
  closeMenus,
  isLivreEditMode,
  HANDLE_INSET,
  getChromeInsets: () => {
    const topbarEl = el.topbar;
    const statusEl = document.getElementById('statusbar');
    return {
      topbar: topbarEl ? topbarEl.getBoundingClientRect().height : 0,
      statusbar: statusEl ? statusEl.getBoundingClientRect().height : 0,
      sidebar: el.sidebar.getBoundingClientRect().width,
    };
  },
  isChromeHidden: () => document.body.classList.contains('is-chrome-hidden'),
  getChromeVisibility: () => {
    const topbarEl = el.topbar;
    const statusEl = document.getElementById('statusbar');
    const measure = (node) => {
      if (!node) return { display: 'none', offsetHeight: 0, offsetWidth: 0 };
      const cs = getComputedStyle(node);
      return {
        display: cs.display,
        offsetHeight: node.offsetHeight,
        offsetWidth: node.offsetWidth,
        transform: cs.transform || '',
      };
    };
    const sb = measure(el.sidebar);
    const sbRect = el.sidebar ? el.sidebar.getBoundingClientRect() : null;
    return {
      chromeHidden: document.body.classList.contains('is-chrome-hidden'),
      topbar: measure(topbarEl),
      sidebar: {
        ...sb,
        // Overlay off-screen: width may be non-zero while visually hidden (translateX).
        visuallyOpen: !!(el.sidebar && el.sidebar.classList.contains('auto-hide-open')),
        rectLeft: sbRect ? sbRect.left : null,
      },
      statusbar: measure(statusEl),
    };
  },
  getSidebarMode: () => {
    const cs = el.sidebar ? getComputedStyle(el.sidebar) : null;
    const hz = el.sidebarHotzone;
    const hzCs = hz ? getComputedStyle(hz) : null;
    const head = el.sidebar ? el.sidebar.querySelector('.sidebar-head') : null;
    const headCs = head ? getComputedStyle(head) : null;
    const pin = el.btnSidebarToggle;
    const pinRect = pin ? pin.getBoundingClientRect() : null;
    const pinCs = pin ? getComputedStyle(pin) : null;
    const appRegionOf = (style) =>
      style ? style.webkitAppRegion || style.getPropertyValue('-webkit-app-region') || '' : '';
    return {
      legacyAlwaysActive: isSidebarLegacyAlwaysActive(),
      autoHide: isSidebarAutoHide(),
      open: !!sidebarAutoHideOpen,
      collapsed: isSidebarEffectivelyCollapsed(),
      chromeHidden: isChromeHiddenMode(),
      fsPinned: !!sidebarFsPinned,
      overlayMode: usesSidebarOverlay(),
      toggleTitle: el.btnSidebarToggle ? el.btnSidebarToggle.title : '',
      sidebarWidth: el.sidebar ? el.sidebar.getBoundingClientRect().width : 0,
      hotzoneWidth: hz && !hz.classList.contains('hidden') ? hz.getBoundingClientRect().width : 0,
      hotzoneHidden: !hz || hz.classList.contains('hidden'),
      transform: cs ? cs.transform : '',
      appClassAutoHide: !!(el.app && el.app.classList.contains('sidebar-auto-hide')),
      hotzoneDisplay: hzCs ? hzCs.display : 'none',
      delays: { showMs: SIDEBAR_SHOW_DELAY_MS, hideMs: SIDEBAR_HIDE_DELAY_MS },
      hotzonePx: SIDEBAR_HOTZONE_PX,
      cursorInside: sidebarCursorInside,
      headAppRegion: appRegionOf(headCs),
      pinAppRegion: appRegionOf(pinCs),
      pinPointerEvents: pinCs ? pinCs.pointerEvents : '',
      pinDisabled: pin ? !!pin.disabled : true,
      pinCenter: pinRect
        ? { x: pinRect.left + pinRect.width / 2, y: pinRect.top + pinRect.height / 2 }
        : null,
    };
  },
  /**
   * Selftest: fire a real DOM click on #btn-sidebar-toggle (not a direct collapse helper).
   * Programmatic HTMLElement.click() still goes through the button's click listener.
   */
  clickSidebarToggleButton: async () => {
    const btn = document.getElementById('btn-sidebar-toggle');
    if (!btn) return { ok: false, reason: 'missing-button' };
    btn.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
    );
    await new Promise((r) => setTimeout(r, 80));
    return { ok: true, mode: window.__multiheizUi.getSidebarMode() };
  },
  syncSidebarAfterLegacyChange: async () => {
    clearSidebarHoverTimers();
    if (!isSidebarLegacyAlwaysActive()) {
      sidebarAutoHideOpen = false;
      if (state.ui?.sidebarCollapsed) {
        applyState(await window.multiheiz.updateUi({ sidebarCollapsed: false }));
      }
    } else {
      sidebarAutoHideOpen = false;
    }
    updateSidebarCollapseClasses();
    await syncSidebarOverlayBounds(!!(isSidebarAutoHide() && sidebarAutoHideOpen));
    scheduleSync();
    return window.__multiheizUi.getSidebarMode();
  },
  setSidebarAlwaysActive: async (on) => {
    clearSidebarHoverTimers();
    const st = await window.multiheiz.updateSettings({ sidebarAlwaysActive: !!on });
    applyState(st);
    await window.__multiheizUi.syncSidebarAfterLegacyChange();
    await new Promise((r) => setTimeout(r, 50));
    return window.__multiheizUi.getSidebarMode();
  },
  /** Simulate hot-zone / leave for selftests (bypasses real mouse over WebContentsView). */
  sidebarHotzoneEnter: () => {
    requestSidebarShow();
    return true;
  },
  sidebarHotzoneLeave: () => {
    clearSidebarHoverTimers();
    return true;
  },
  sidebarMouseLeave: () => {
    sidebarCursorInside = false;
    requestSidebarHide();
    return true;
  },
  setSidebarAutoHideOpen: (open) => {
    clearSidebarHoverTimers();
    setSidebarAutoHideOpen(!!open);
    return !!sidebarAutoHideOpen;
  },
  /** Selftest: pretend native menu / hold is active so hide delay re-arms. */
  setSidebarNativeMenuOpen: (open) => {
    sidebarNativeMenuOpen = !!open;
    if (!sidebarNativeMenuOpen && usesSidebarOverlay() && sidebarAutoHideOpen) {
      requestSidebarHide();
    }
    return !!sidebarNativeMenuOpen;
  },
  /** Selftest: temporary F11 pin state (does not touch saved prefs). */
  getSidebarFsPinned: () => !!sidebarFsPinned,
  setSidebarFsPinned: (on) => {
    sidebarFsPinned = !!on;
    if (sidebarFsPinned) {
      setSidebarAutoHideOpen(true, { force: true });
    } else {
      setSidebarAutoHideOpen(false, { force: true });
    }
    updateSidebarCollapseClasses();
    return !!sidebarFsPinned;
  },
  toggleSidebarAutoHide: async () => {
    if (el.btnSidebarToggle) el.btnSidebarToggle.click();
    await new Promise((r) => setTimeout(r, 80));
    return window.__multiheizUi.getSidebarMode();
  },
  getTitlebarMetrics: () => {
    const bar = el.topbar;
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    const spacer = bar.querySelector('.spacer');
    const spacerRegion = spacer ? getComputedStyle(spacer).webkitAppRegion || getComputedStyle(spacer).getPropertyValue('-webkit-app-region') : '';
    const tab = bar.querySelector('.tab');
    const tabRegion = tab
      ? getComputedStyle(tab).webkitAppRegion || getComputedStyle(tab).getPropertyValue('-webkit-app-region')
      : '';
    const settingsBtn = el.btnSettings;
    const btnRegion = settingsBtn
      ? getComputedStyle(settingsBtn).webkitAppRegion ||
        getComputedStyle(settingsBtn).getPropertyValue('-webkit-app-region')
      : '';
    const padRight = parseFloat(cs.paddingRight) || 0;
    let wco = null;
    try {
      if (navigator.windowControlsOverlay) {
        wco = {
          visible: !!navigator.windowControlsOverlay.visible,
          rect: navigator.windowControlsOverlay.getTitlebarAreaRect
            ? (() => {
                const r = navigator.windowControlsOverlay.getTitlebarAreaRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              })()
            : null,
        };
      }
    } catch {
      /* ignore */
    }
    return {
      height: rect.height,
      bottom: rect.bottom,
      top: rect.top,
      width: rect.width,
      appRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
      spacerRegion,
      tabRegion,
      settingsBtnRegion: btnRegion,
      paddingRight: padRight,
      hasAppIcon: !!bar.querySelector('#app-icon'),
      winControlsVisible: !!(el.winControls && !el.winControls.hidden),
      platformFrameless: document.body.classList.contains('platform-frameless'),
      wco,
    };
  },
  getPanelTopVsRow: () => {
    const bar = el.topbar;
    const slot = el.grid.querySelector('.panel-slot');
    const grid = el.grid;
    if (!bar || !grid) return null;
    const barBottom = bar.getBoundingClientRect().bottom;
    // Grid / panel-slot top sits directly under the title row (content is lower due to panel header).
    const slotTop = (slot || grid).getBoundingClientRect().top;
    const gridTop = grid.getBoundingClientRect().top;
    return {
      barBottom,
      panelTop: slotTop,
      gridTop,
      delta: Math.abs(slotTop - barBottom),
      gridDelta: Math.abs(gridTop - barBottom),
    };
  },
  getOverlaySnapshots: () => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [id, url] of overlaySnapMap) {
      if (url) out[id] = url;
      else out[id] = '';
    }
    return out;
  },
  getUiStrings: () => {
    return {
      addButton: el.btnAddAccount.textContent,
      emptyHint: el.grid.querySelector('.empty-hint')?.textContent || '',
      accountDialogTitle: el.dlgAccountTitle.textContent,
    };
  },
  applyThemePreset: async (preset) => {
    const p = THEME_PRESETS[preset] || THEME_PRESETS.escuro;
    applyState(await window.multiheiz.updateAppearance(p));
    return {
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      theme: document.documentElement.getAttribute('data-theme'),
    };
  },
  applyCustomAccent: async (accent) => {
    const a = { ...(state.appearance || THEME_PRESETS.escuro), preset: 'custom', accent };
    applyState(await window.multiheiz.updateAppearance(a));
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  },
  setLivreTiles: async (tiles) => {
    const check = proposeTiles(tiles);
    if (!check.ok) return check;
    applyState(await window.multiheiz.setFreeTiles(state.activeWorkspaceId, tiles));
    applyState(await window.multiheiz.setLayout('livre'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    syncViews();
    return { ok: true, tiles: workspaceTiles() };
  },
  setLayoutLocked: async (locked) => {
    applyState(await window.multiheiz.updateUi({ layoutLocked: !!locked }));
    return !!state.ui.layoutLocked;
  },
  getFreeTiles: () => workspaceTiles(),
  proposeTiles,
  THEME_PRESETS,
  /** Selftest: prompt de permissão visível no painel. */
  getPermissionPrompt: (accountId) => {
    const id = accountId || focusedAccountId;
    const bar = id
      ? document.querySelector(`.panel-slot[data-account-id="${id}"] .panel-perm-bar`)
      : document.querySelector('.panel-perm-bar');
    if (!bar) return null;
    const label = bar.querySelector('.panel-perm-bar-label');
    return {
      accountId: bar.dataset.accountId || id,
      requestId: bar.dataset.requestId || '',
      message: label ? label.textContent : '',
    };
  },
  clickPermissionAllow: (accountId) => {
    const id = accountId || focusedAccountId;
    const btn = document.querySelector(
      `.panel-slot[data-account-id="${id}"] .panel-perm-bar [data-role="perm-allow"]`
    );
    if (btn) btn.click();
    return !!btn;
  },
  clickPermissionDeny: (accountId) => {
    const id = accountId || focusedAccountId;
    const btn = document.querySelector(
      `.panel-slot[data-account-id="${id}"] .panel-perm-bar [data-role="perm-deny"]`
    );
    if (btn) btn.click();
    return !!btn;
  },
  openSitePermissions: async (accountId) => {
    const id = accountId || focusedAccountId;
    const btn = document.querySelector(
      `.panel-slot[data-account-id="${id}"] [data-role="panel-site-info"]`
    );
    const r = btn ? btn.getBoundingClientRect() : { left: 80, bottom: 80 };
    await openSitePermissionsPopover(id, Math.round(r.left), Math.round(r.bottom + 4));
    await new Promise((res) => setTimeout(res, 80));
    const pop = document.querySelector('.panel-site-perm-popover');
    if (!pop) return null;
    const rows = [...pop.querySelectorAll('.panel-site-perm-row')].map((row) => {
      const name = row.querySelector('.panel-site-perm-name');
      const sel = row.querySelector('select');
      return {
        name: name ? name.textContent : '',
        permission: sel ? sel.dataset.permission : '',
        value: sel ? sel.value : '',
      };
    });
    return {
      origin: (pop.querySelector('.panel-site-perm-origin') || {}).textContent || '',
      rows,
    };
  },
  clickPermissionReset: () => {
    const btn = document.querySelector('.panel-site-perm-popover [data-role="perm-reset"]');
    if (btn) btn.click();
    return !!btn;
  },
  getMediaUseIcons: (accountId) => {
    const id = accountId || focusedAccountId;
    const fromMap = mediaUseByPanel.get(id) || { microphone: false, camera: false };
    const ind = document.querySelector(
      `.panel-slot[data-account-id="${id}"] .panel-media-use`
    );
    return {
      microphone: !!(fromMap.microphone || (ind && !ind.hidden && ind.querySelector('.is-mic'))),
      camera: !!(fromMap.camera || (ind && !ind.hidden && ind.querySelector('.is-cam'))),
      map: fromMap,
      dom: ind
        ? { hidden: !!ind.hidden, html: ind.innerHTML.slice(0, 80) }
        : null,
    };
  },
  /** Selftest: puxar estado de mídia do main se o evento tiver sido perdido. */
  syncMediaUseFromMain: async (accountId) => {
    const id = accountId || focusedAccountId;
    if (!id || !window.multiheiz.permissionsMediaUseGet) return null;
    const flags = await window.multiheiz.permissionsMediaUseGet(id);
    if (flags) applyMediaUseToPanel(id, flags);
    return flags;
  },
};

/** @type {string} */
let appPlatform = 'win32';
/** Frameless platforms show HTML window controls (Linux). */
let usesCustomFrame = false;

function setWindowMaximizedUi(maximized) {
  document.body.classList.toggle('is-maximized', !!maximized);
  if (el.btnWinMax) {
    el.btnWinMax.title = maximized ? 'Restaurar' : 'Maximizar';
    el.btnWinMax.setAttribute('aria-label', maximized ? 'Restaurar' : 'Maximizar');
  }
}

function isTopbarInteractiveTarget(target) {
  if (!target || !target.closest) return false;
  return !!target.closest(
    'button, select, input, a, label, .tabs, .tab, .layout-label, .pager, .win-controls, .app-icon'
  );
}

async function initWindowChrome() {
  try {
    const info = await window.multiheiz.getAppInfo();
    if (info) {
      appPlatform = info.platform || appPlatform;
      usesCustomFrame = !!info.usesCustomFrame;
      appVersion = info.version || '—';
      if (info.startedAt) appStartedAt = info.startedAt;
      updateStatusBar();
    }
  } catch {
    /* ignore */
  }
  document.body.classList.toggle('platform-frameless', usesCustomFrame);
  document.body.classList.toggle('platform-win', appPlatform === 'win32');
  if (el.winControls) {
    el.winControls.hidden = !usesCustomFrame;
  }
  try {
    const max = await window.multiheiz.windowIsMaximized();
    setWindowMaximizedUi(!!max);
  } catch {
    /* ignore */
  }
}

initWindowChrome();

if (el.btnWinMin) {
  el.btnWinMin.addEventListener('click', () => {
    window.multiheiz.windowMinimize();
  });
}
if (el.btnWinMax) {
  el.btnWinMax.addEventListener('click', () => {
    window.multiheiz.windowToggleMaximize().then((r) => {
      if (r && typeof r.maximized === 'boolean') setWindowMaximizedUi(r.maximized);
    });
  });
}
if (el.btnWinClose) {
  el.btnWinClose.addEventListener('click', () => {
    window.multiheiz.windowClose();
  });
}

if (el.topbar) {
  el.topbar.addEventListener('dblclick', (e) => {
    if (isTopbarInteractiveTarget(e.target)) return;
    // Windows: Chromium handles double-click on drag regions natively.
    // Linux (frameless): toggle maximize ourselves.
    if (!usesCustomFrame) return;
    window.multiheiz.windowToggleMaximize().then((r) => {
      if (r && typeof r.maximized === 'boolean') setWindowMaximizedUi(r.maximized);
    });
  });
}

window.__mhV16Hooks = {
  pushOverlay,
  popOverlay,
  getState: () => state,
  applyState,
  toast: showToast,
  scheduleSync,
  renderGrid,
  fillAppearanceForm,
  readAppearanceFromForm,
  updateAppearanceLive: applyAppearance,
  syncSidebarAfterLegacyChange: (...args) => window.__multiheizUi.syncSidebarAfterLegacyChange(...args),
  getAppVersion: () => appVersion,
  focusAccount: async (id, opts) => {
    const st = state;
    const acc = (st.accounts || []).find((a) => a.id === id);
    if (!acc) return { ok: false, reason: 'missing' };
    // Switch workspace/page if needed — never navigate/reload the panel
    if (acc.workspaceId && acc.workspaceId !== st.activeWorkspaceId) {
      applyState(await window.multiheiz.setWorkspace(acc.workspaceId));
    }
    focusedAccountId = id;
    await window.multiheiz.panelFocus(id);
    if (state.layout !== 'livre' && !visiblePageAccounts().some((a) => a.id === id)) {
      const all = accountsInWorkspace();
      const slots = slotsForLayout(state.layout, all.length || 1);
      const idx = all.findIndex((a) => a.id === id);
      if (idx >= 0) applyState(await window.multiheiz.setPage(Math.floor(idx / slots)));
    }
    if (!(opts && opts.skipRender)) renderSidebar();
    scheduleSync();
    return { ok: true, accountId: id, reloaded: false };
  },
  getFocusedNav: () => {
    const id = focusedAccountId || (state.accounts[0] && state.accounts[0].id);
    if (!id) return null;
    const acc = state.accounts.find((a) => a.id === id);
    const nav = navState.get(id) || {};
    return {
      accountId: id,
      url: nav.url || (acc && (acc.lastUrl || acc.startUrl)) || '',
      title: nav.title || (acc && acc.name) || '',
    };
  },
};

if (window.MultiHeizV16 && window.MultiHeizV16.init) {
  window.MultiHeizV16.init();
}

Object.assign(window.__multiheizUi, {
  openFavorites: () => window.MultiHeizV16 && window.MultiHeizV16.openManager('favorites'),
  openHistory: () => window.MultiHeizV16 && window.MultiHeizV16.openManager('history'),
  openDownloads: () => window.MultiHeizV16 && window.MultiHeizV16.openManager('downloads'),
  openModule: (id) => window.MultiHeizV16 && window.MultiHeizV16.openModule(id),
  closeModule: () => window.MultiHeizV16 && window.MultiHeizV16.closeModule(),
  closeManager: () => window.MultiHeizV16 && window.MultiHeizV16.closeManager(),
  favoriteCurrent: () => window.MultiHeizV16 && window.MultiHeizV16.favoriteCurrentUrl(),
  getActiveModule: () => (window.MultiHeizV16 && window.MultiHeizV16.getActiveModule()) || null,
  isKofiVisible: () => {
    const btn = document.getElementById('btn-kofi');
    return !!(btn && !btn.classList.contains('hidden'));
  },
  isKofiHeartVisible: () => {
    const btn = document.getElementById('btn-kofi-status');
    return !!(btn && !btn.classList.contains('hidden'));
  },
  clickKofiButton: () => {
    const btn = document.getElementById('btn-kofi');
    if (btn) btn.click();
  },
  clickKofiHeart: () => {
    const btn = document.getElementById('btn-kofi-status');
    if (btn) btn.click();
  },
  refreshKofiVisibility: () =>
    window.MultiHeizV16 && window.MultiHeizV16.refreshKofiVisibility(),
  getModulesSidebarLabels: () =>
    [...document.querySelectorAll('#sidebar-modules-list .sidebar-module-btn')].map(
      (b) => b.dataset.label || b.getAttribute('title') || (b.textContent || '').trim()
    ),
  getSidebarMetrics: () => {
    const sb = el.sidebar;
    const r = sb.getBoundingClientRect();
    const overflow = [];
    for (const node of sb.querySelectorAll('*')) {
      if (node.classList && node.classList.contains('sidebar-resize-handle')) continue;
      const nr = node.getBoundingClientRect();
      if (nr.width <= 0 || nr.height <= 0) continue;
      // Allow 1px subpixel / border rounding
      if (nr.right > r.right + 1.5) {
        overflow.push({
          tag: node.tagName,
          className: String(node.className || ''),
          right: nr.right,
          sideRight: r.right,
        });
      }
    }
    return {
      width: r.width,
      clientWidth: sb.clientWidth,
      scrollWidth: sb.scrollWidth,
      collapsed: sb.classList.contains('collapsed') || sb.classList.contains('auto-collapsed'),
      autoCollapsed: sb.classList.contains('auto-collapsed'),
      overflowCount: overflow.length,
      overflow: overflow.slice(0, 8),
      windowWidth: window.innerWidth,
    };
  },
  getFocusZoomUi: () => {
    const focused = [...el.grid.querySelectorAll('.panel-slot.focused')].map(
      (s) => s.dataset.accountId
    );
    const topZoom = document.getElementById('zoom-control');
    const topAdd = document.querySelector('#topbar #btn-add-account');
    const chip = focusedAccountId
      ? el.grid.querySelector(
          `.panel-slot[data-account-id="${focusedAccountId}"] .panel-zoom-chip`
        )
      : null;
    return {
      focusedAccountId,
      focusedSlots: focused,
      zoomLabel: chip ? chip.textContent : '',
      zoomHidden: !chip,
      zoomPct: Math.round((focusedZoom || 1) * 100),
      topBarHasZoom: !!topZoom,
      topBarHasNewWindow: !!topAdd,
      sidebarHasNewWindow: !!(el.btnAddAccount && el.sidebar && el.sidebar.contains(el.btnAddAccount)),
      settingsIconHtml: el.btnSettings ? el.btnSettings.innerHTML : '',
    };
  },
  setSidebarForceExpanded: (v) => {
    sidebarForceExpanded = !!v;
    updateSidebarCollapseClasses();
    scheduleSync();
    return isSidebarEffectivelyCollapsed();
  },
  FOCUS_FRAME,
  SIDEBAR_AUTO_BREAKPOINT,
});

refresh();
