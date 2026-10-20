'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  session,
  Menu,
  screen,
  desktopCapturer,
  dialog,
} = require('electron');
const {
  loadState,
  getState,
  setState,
  updateState,
  flushSave,
  normalizeLayout,
} = require('./state');
const panels = require('./panels');
const memory = require('./memory');
const { APP_USER_MODEL_ID, APP_DISPLAY_NAME, envGet } = require('./config');
const { initV16 } = require('./v16-bridge');
const adblock = require('./adblock');
const extensions = require('./extensions');
const userAgent = require('./user-agent');
const sessionPersist = require('./session-persist');
const logger = require('./logger');
const recovery = require('./recovery');
const changelog = require('./changelog');
const updater = require('./updater');
const { clampBoundsToDisplays, ensureWindowOnDisplay } = require('./window-bounds');
const windowChrome = require('./window-chrome');
const chromeFullscreen = require('./chrome-fullscreen');
const sidebarCursor = require('./sidebar-cursor');
const ipcGuard = require('./ipc-guard');
const permissions = require('./permissions');
const { sanitizeUserStartUrl } = require('./url-policy');
const catalog = require('./catalog');
const proxy = require('./proxy');
const doh = require('./doh');
const settingsApply = require('./settings-apply');
// selftest-*.js are required lazily only inside MULTIHEIZ_SELFTEST branches
// (never at top-level) so a corrupted/UTF-16 selftest file cannot break npm start.

try {
  app.setName(APP_DISPLAY_NAME);
} catch {
  /* ignore */
}

try {
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
} catch {
  /* ignore */
}

const userDataOverride = envGet('MULTIHEIZ_USERDATA');
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
}

/**
 * Electron shows a modal for uncaught main-process exceptions. Network/undici
 * races (e.g. AssertionError assert(!this.paused) under Node fetch) must not
 * block the UI — log and ignore those only; other errors keep the dialog.
 */
function isIgnorableNetworkUncaught(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  const name = String(err.name || '');
  const code = String(err.code || '');
  const stack = String(err.stack || '');
  if (name === 'AssertionError' && /assert\(!this\.paused\)/.test(msg)) return true;
  if (/node:internal\/deps\/undici|\/deps\/undici\//.test(stack)) return true;
  if (/^UND_ERR_/.test(code) || /UND_ERR_/.test(msg)) return true;
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    code === 'ERR_NETWORK_CHANGED'
  ) {
    return true;
  }
  return false;
}

process.on('uncaughtException', (err) => {
  if (isIgnorableNetworkUncaught(err)) {
    try {
      logger.warn('uncaughtException ignored (network/undici)', {
        name: err && err.name,
        code: err && err.code,
        message: String(err && err.message ? err.message : err),
      });
    } catch {
      /* ignore */
    }
    console.warn(
      '[main] uncaughtException ignored (network/undici):',
      err && err.message ? err.message : err
    );
    return;
  }
  console.error('[main] uncaughtException:', err);
  try {
    logger.error('uncaughtException', {
      name: err && err.name,
      message: String(err && err.message ? err.message : err),
      stack: err && err.stack ? String(err.stack).slice(0, 4000) : undefined,
    });
  } catch {
    /* ignore */
  }
  try {
    dialog.showErrorBox(
      'A JavaScript error occurred in the main process',
      'Uncaught Exception:\n' + (err && err.stack ? err.stack : String(err))
    );
  } catch {
    /* ignore */
  }
});

/*
 * Occlusion / renderer-backgrounding switches (process-wide).
 * Needed so per-window "Manter ativa em segundo plano" (park + setBackgroundThrottling(false))
 * can keep media/timers alive when opted in — Win occlusion would freeze parked panels otherwise.
 * Intentionally NOT setting disable-background-timer-throttling: without the per-window option,
 * Chromium + webContents.setBackgroundThrottling(true) must be able to limit hidden panels.
 * CalculateNativeWinOcclusion and force_high_performance_gpu are Windows-only.
 */
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');
} else {
  app.commandLine.appendSwitch('disable-features', 'IntensiveWakeUpThrottling');
}

/*
 * Force Chromium's sandboxed renderer client even when the process was started
 * with --no-sandbox (common for Linux AppImage). Required for session
 * registerPreloadScript({ type: 'service-worker' }) used by MV3 extension
 * compatibility (extensions.abuCompat). Must run before app.whenReady().
 */
try {
  app.enableSandbox();
} catch (err) {
  console.warn(
    '[main] enableSandbox failed:',
    err && err.message ? err.message : err
  );
}

// DNR redirect.extensionPath fallback scheme (multiheiz-extres://) — before ready.
try {
  require('./extensions/dnr-shim').registerExtresScheme();
} catch (err) {
  console.warn(
    '[main] dnr extres scheme',
    err && err.message ? err.message : err
  );
}

// Prefer high-performance GPU when enabled (needs restart to take effect) — Windows only
if (process.platform === 'win32') {
  try {
    const fsEarly = require('node:fs');
    const stateFile = path.join(app.getPath('userData'), 'multiheiz-state.json');
    if (fsEarly.existsSync(stateFile)) {
      const raw = fsEarly.readFileSync(stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.settings && parsed.settings.preferHighPerfGpu) {
        app.commandLine.appendSwitch('force_high_performance_gpu');
      }
    }
  } catch {
    /* ignore */
  }
}

const selftestMode = envGet('MULTIHEIZ_SELFTEST') || '';
const SELFTEST = selftestMode === '1';
const SELFTEST_MEM = selftestMode === 'mem';
const SELFTEST_UI = selftestMode === 'ui';
const SELFTEST_BG = selftestMode === 'bg';
const SELFTEST_V14 = selftestMode === 'v14';
const SELFTEST_INPUT = selftestMode === 'input';
const SELFTEST_V16 = selftestMode === 'v16';
const SELFTEST_ADBLOCK = selftestMode === 'adblock';
const SELFTEST_ADBLOCK_REAL = selftestMode === 'adblock-real';
const SELFTEST_ADBLOCK_PACKAGED = selftestMode === 'adblock-packaged';
const SELFTEST_V18 = selftestMode === 'v18';
const SELFTEST_V19 = selftestMode === 'v19';
const SELFTEST_V110 = selftestMode === 'v110';
const SELFTEST_V120 = selftestMode === 'v120';
const SELFTEST_TITLEBAR = selftestMode === 'titlebar';
const SELFTEST_FULLSCREEN = selftestMode === 'fullscreen';
const SELFTEST_EXT = selftestMode === 'ext';
const SELFTEST_ABU = selftestMode === 'abu';
const SELFTEST_ABU_YT = selftestMode === 'abu-yt';
const SELFTEST_BUILTIN_YT = selftestMode === 'builtin-yt';
const SELFTEST_SECURITY = selftestMode === 'security';
const SELFTEST_UA = selftestMode === 'ua';
const SELFTEST_GIS = selftestMode === 'gis';
const SELFTEST_STORE = selftestMode === 'store';
const SELFTEST_SIDEBAR = selftestMode === 'sidebar';
const SELFTEST_REALCLICK_SIDEBAR = selftestMode === 'realclick-sidebar';
const SELFTEST_REALCLICK_SIDEBAR2 = selftestMode === 'realclick-sidebar2';
const SELFTEST_REALCLICK_LEGACY_COMPACT = selftestMode === 'realclick-legacy-compact';
const SELFTEST_REALDRAG_TOPBAR = selftestMode === 'realdrag-topbar';
const SELFTEST_REALHOVER_FULLSCREEN = selftestMode === 'realhover-fullscreen';
const SELFTEST_SHOTS_SIDEBAR2 = selftestMode === 'shots-sidebar2';
const SELFTEST_WORKSPACE_DELETE = selftestMode === 'workspace-delete';
const SELFTEST_CONTEXTMENU = selftestMode === 'contextmenu';
const SELFTEST_PROXY = selftestMode === 'proxy';
const SELFTEST_DOH = selftestMode === 'doh';
const SELFTEST_SETTINGS_PERF = selftestMode === 'settings-perf';
const SELFTEST_PERMISSIONS = selftestMode === 'permissions';
const SELFTEST_CATALOG = selftestMode === 'catalog';
const SELFTEST_SHOTS_TOOLS = selftestMode === 'shots-tools';
const SELFTEST_NOTES = selftestMode === 'notes';
const SELFTEST_REMINDERS = selftestMode === 'reminders';
const SELFTEST_SHEET = selftestMode === 'sheet';
const SELFTEST_VOLUME = selftestMode === 'volume';
const SELFTEST_SHOTS_VOLUME = selftestMode === 'shots-volume';
const SELFTEST_LAYOUT_WORKSPACE = selftestMode === 'layout-workspace';
const ANY_SELFTEST =
  SELFTEST ||
  SELFTEST_MEM ||
  SELFTEST_UI ||
  SELFTEST_BG ||
  SELFTEST_V14 ||
  SELFTEST_INPUT ||
  SELFTEST_V16 ||
  SELFTEST_ADBLOCK ||
  SELFTEST_ADBLOCK_REAL ||
  SELFTEST_ADBLOCK_PACKAGED ||
  SELFTEST_V18 ||
  SELFTEST_V19 ||
  SELFTEST_V110 ||
  SELFTEST_V120 ||
  SELFTEST_TITLEBAR ||
  SELFTEST_FULLSCREEN ||
  SELFTEST_EXT ||
  SELFTEST_ABU ||
  SELFTEST_ABU_YT ||
  SELFTEST_BUILTIN_YT ||
  SELFTEST_SECURITY ||
  SELFTEST_UA ||
  SELFTEST_GIS ||
  SELFTEST_STORE ||
  SELFTEST_SIDEBAR ||
  SELFTEST_REALCLICK_SIDEBAR ||
  SELFTEST_REALCLICK_SIDEBAR2 ||
  SELFTEST_REALCLICK_LEGACY_COMPACT ||
  SELFTEST_REALDRAG_TOPBAR ||
  SELFTEST_REALHOVER_FULLSCREEN ||
  SELFTEST_WORKSPACE_DELETE ||
  SELFTEST_CONTEXTMENU ||
  SELFTEST_PROXY ||
  SELFTEST_DOH ||
  SELFTEST_SETTINGS_PERF ||
  SELFTEST_PERMISSIONS ||
  SELFTEST_CATALOG ||
  SELFTEST_SHOTS_TOOLS ||
  SELFTEST_SHOTS_SIDEBAR2 ||
  SELFTEST_NOTES ||
  SELFTEST_REMINDERS ||
  SELFTEST_SHEET ||
  SELFTEST_VOLUME ||
  SELFTEST_SHOTS_VOLUME ||
  SELFTEST_LAYOUT_WORKSPACE;

// Selftest de permissões: dispositivo de mídia fake (NÃO use-fake-ui — queremos o prompt do app).
if (SELFTEST_PERMISSIONS) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
}

// Volume selftest: permite tom/Oscillator sem gesto do usuário.
if (SELFTEST_VOLUME) {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

// YouTube selftests: map YT hosts to loopback (local HTTPS page-server).
if (SELFTEST_ABU_YT || SELFTEST_BUILTIN_YT) {
  app.commandLine.appendSwitch(
    'host-resolver-rules',
    'MAP www.youtube.com 127.0.0.1, MAP m.youtube.com 127.0.0.1, MAP www.youtube-nocookie.com 127.0.0.1'
  );
}

/** @type {object|null} recorded BrowserWindow chrome options for selftests / diagnostics */
let recordedWindowChrome = null;
/** @type {object|null} last titleBarOverlay applied */
let lastTitleBarOverlay = null;

/** @type {ReturnType<typeof initV16> | null} */
let v16 = null;

/** @type {BrowserWindow | null} */
let mainWindow = null;

const APP_STARTED_AT = Date.now();

/**
 * Last native account menu popup (for selftests). When SELFTEST_INPUT is set,
 * Menu.popup is intercepted (not shown) so the test can assert labels/coords.
 * @type {{ accountId: string, x: number, y: number, labels: string[], at: number } | null}
 */
let lastAccountMenuPopup = null;
/** @type {{ x: number, y: number, labels: string[], at: number } | null} */
let lastTopMenuPopup = null;

function whichLabelForStoreUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h.includes('microsoftedge') || h.includes('edge.microsoft')) {
      return 'Loja do Edge';
    }
    if (h.includes('chromewebstore') || h.includes('chrome.google')) {
      return 'Chrome Web Store';
    }
  } catch {
    /* ignore */
  }
  return 'Janela';
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function iconPath() {
  const png = path.join(__dirname, '..', '..', 'build', 'icon.png');
  return png;
}

function emitToRenderer(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('event', payload);
  }
}

function notifyDisplayOrChromeChange() {
  emitToRenderer({ type: 'layout:recompute' });
}

function setupApplicationMenu() {
  const focusedPanel = () => panels.getFocusedAccountId();

  const template = [
    {
      label: 'Arquivo',
      submenu: [{ role: 'quit', label: 'Sair' }],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer', accelerator: 'CmdOrCtrl+Z' },
        { role: 'redo', label: 'Refazer', accelerator: 'CmdOrCtrl+Y' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar', accelerator: 'CmdOrCtrl+X' },
        { role: 'copy', label: 'Copiar', accelerator: 'CmdOrCtrl+C' },
        { role: 'paste', label: 'Colar', accelerator: 'CmdOrCtrl+V' },
        { role: 'selectAll', label: 'Selecionar tudo', accelerator: 'CmdOrCtrl+A' },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        {
          label: 'Recarregar painel',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelReload(id);
          },
        },
        {
          label: 'Recarregar painel',
          accelerator: 'F5',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelReload(id);
          },
        },
        {
          label: 'Recarregar forçado',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelHardReload(id);
          },
        },
        { type: 'separator' },
        {
          label: 'Aumentar zoom do painel',
          accelerator: 'CmdOrCtrl+Plus',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelZoom(id, 0.1);
          },
        },
        {
          label: 'Aumentar zoom do painel',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelZoom(id, 0.1);
          },
        },
        {
          label: 'Diminuir zoom do painel',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelZoom(id, -0.1);
          },
        },
        {
          label: 'Zoom padrão do painel',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelZoom(id, 0);
          },
        },
        { type: 'separator' },
        {
          label: 'Tela cheia',
          accelerator: 'F11',
          click: () => {
            chromeFullscreen.toggle();
          },
        },
        { type: 'separator' },
        {
          label: 'Ferramentas de desenvolvedor (painel)',
          accelerator: 'F12',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelOpenDevTools(id);
          },
        },
        {
          label: 'Ferramentas de desenvolvedor (painel)',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelOpenDevTools(id);
          },
        },
        {
          label: 'Ferramentas de desenvolvedor (app)',
          accelerator: 'CmdOrCtrl+Shift+Alt+I',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.openDevTools({ mode: 'detach' });
            }
          },
        },
      ],
    },
    {
      label: 'Navegação',
      submenu: [
        {
          label: 'Focar barra de URL',
          accelerator: 'CmdOrCtrl+L',
          click: () => emitToRenderer({ type: 'focus:url' }),
        },
        {
          label: 'Voltar',
          accelerator: 'Alt+Left',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelBack(id);
          },
        },
        {
          label: 'Avançar',
          accelerator: 'Alt+Right',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelForward(id);
          },
        },
        { type: 'separator' },
        {
          label: 'Início',
          accelerator: 'Alt+Home',
          click: () => {
            const id = focusedPanel();
            if (id) panels.panelGoHome(id);
          },
        },
        {
          label: 'Favoritar página',
          accelerator: 'CmdOrCtrl+D',
          click: () => emitToRenderer({ type: 'ui:favorite' }),
        },
        {
          label: 'Histórico',
          accelerator: 'CmdOrCtrl+H',
          click: () => emitToRenderer({ type: 'ui:history' }),
        },
        {
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+J',
          click: () => emitToRenderer({ type: 'ui:downloads' }),
        },
      ],
    },
    {
      label: 'Janela',
      submenu: [
        {
          label: 'Nova janela',
          accelerator: 'CmdOrCtrl+T',
          click: () => emitToRenderer({ type: 'ui:new-account' }),
        },
        {
          label: 'Abrir login no navegador padrão',
          click: () => {
            const id = focusedPanel();
            if (id) {
              const r = panels.openLoginInSystemBrowser(id);
              if (r && r.ok) {
                emitToRenderer({
                  type: 'toast',
                  message: 'Abrindo no navegador padrão…',
                });
              }
            }
          },
        },
        { type: 'separator' },
        { role: 'minimize', label: 'Minimizar' },
        { role: 'close', label: 'Fechar' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const st = loadState();
  const bounds = st.windowBounds || {};
  const uiSize =
    SELFTEST_UI ||
    SELFTEST_V14 ||
    SELFTEST_INPUT ||
    SELFTEST_V16 ||
    SELFTEST_V19 ||
    SELFTEST_V110 ||
    SELFTEST_V120 ||
    SELFTEST_TITLEBAR ||
    SELFTEST_FULLSCREEN ||
    SELFTEST_SIDEBAR ||
    SELFTEST_REALCLICK_SIDEBAR ||
    SELFTEST_REALCLICK_SIDEBAR2 ||
    SELFTEST_REALCLICK_LEGACY_COMPACT ||
    SELFTEST_REALDRAG_TOPBAR ||
    SELFTEST_REALHOVER_FULLSCREEN ||
    SELFTEST_CONTEXTMENU ||
    SELFTEST_SETTINGS_PERF ||
    SELFTEST_WORKSPACE_DELETE ||
    SELFTEST_PERMISSIONS ||
    SELFTEST_CATALOG ||
    SELFTEST_SHOTS_TOOLS ||
    SELFTEST_SHOTS_SIDEBAR2 ||
    SELFTEST_NOTES ||
    SELFTEST_REMINDERS ||
    SELFTEST_SHEET ||
    SELFTEST_VOLUME ||
    SELFTEST_SHOTS_VOLUME ||
    SELFTEST_LAYOUT_WORKSPACE
      ? {
          width: Number(envGet('MULTIHEIZ_UI_WIDTH')) || 1600,
          height: Number(envGet('MULTIHEIZ_UI_HEIGHT')) || 900,
        }
      : null;

  // adblock-real / sidebar / workspace-delete: keep window off-screen so nothing
  // pops on the desktop, but still paint (layout / WebContentsView bounds).
  // realclick-* / realdrag-topbar / realhover-fullscreen must be on-screen for a real OS mouse.
  const offscreenSelftest =
    SELFTEST_ADBLOCK_REAL ||
    SELFTEST_SIDEBAR ||
    SELFTEST_WORKSPACE_DELETE ||
    SELFTEST_CATALOG ||
    SELFTEST_SHOTS_TOOLS ||
    SELFTEST_SHOTS_SIDEBAR2 ||
    SELFTEST_NOTES ||
    SELFTEST_REMINDERS ||
    SELFTEST_SHEET ||
    SELFTEST_VOLUME ||
    SELFTEST_SHOTS_VOLUME ||
    SELFTEST_LAYOUT_WORKSPACE;
  let winX = uiSize
    ? undefined
    : typeof bounds.x === 'number'
      ? bounds.x
      : undefined;
  let winY = uiSize
    ? undefined
    : typeof bounds.y === 'number'
      ? bounds.y
      : undefined;
  let winW = uiSize ? uiSize.width : bounds.width || 1280;
  let winH = uiSize ? uiSize.height : bounds.height || 800;
  if (!offscreenSelftest && !uiSize) {
    try {
      const clamped = clampBoundsToDisplays(
        { x: winX, y: winY, width: winW, height: winH },
        screen.getAllDisplays()
      );
      winX = clamped.x;
      winY = clamped.y;
      winW = clamped.width;
      winH = clamped.height;
    } catch {
      /* ignore */
    }
  }
  const chrome = windowChrome.getChromeConstructorOptions(st.appearance);
  recordedWindowChrome = chrome.recorded;
  lastTitleBarOverlay = chrome.titleBarOverlay || null;
  const winOpts = {
    width: winW,
    height: winH,
    x: offscreenSelftest ? -20000 : winX,
    y: offscreenSelftest ? -20000 : winY,
    // note: uiSize (incl. sidebar) still gets width/height from MULTIHEIZ_UI_* above
    minWidth: 800,
    minHeight: 500,
    title: APP_DISPLAY_NAME,
    backgroundColor: (st.appearance && st.appearance.surface) || '#1a1d23',
    // Keep bg/v18 selftest window shown — hidden BrowserWindow makes offscreen
    // WebContentsView rAF intermittently fall to ~1 Hz despite anti-throttle.
    // adblock-real stays hidden/off-screen (paintWhenInitiallyHidden keeps rendering).
    show:
      !ANY_SELFTEST ||
      SELFTEST_BG ||
      SELFTEST_V18 ||
      SELFTEST_V19 ||
      SELFTEST_V110 ||
      SELFTEST_V120 ||
      SELFTEST_TITLEBAR ||
      SELFTEST_FULLSCREEN ||
      SELFTEST_SIDEBAR ||
      SELFTEST_REALCLICK_SIDEBAR ||
      SELFTEST_REALCLICK_SIDEBAR2 ||
      SELFTEST_REALCLICK_LEGACY_COMPACT ||
      SELFTEST_REALDRAG_TOPBAR ||
      SELFTEST_REALHOVER_FULLSCREEN ||
      SELFTEST_CONTEXTMENU ||
      SELFTEST_SETTINGS_PERF ||
      SELFTEST_WORKSPACE_DELETE ||
      SELFTEST_LAYOUT_WORKSPACE ||
      SELFTEST_CATALOG ||
      SELFTEST_SHOTS_SIDEBAR2 ||
      SELFTEST_ADBLOCK ||
      SELFTEST_EXT ||
      SELFTEST_UA,
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: 1,
    },
  };
  if (chrome.usesOverlay) {
    winOpts.titleBarStyle = chrome.titleBarStyle;
    winOpts.titleBarOverlay = chrome.titleBarOverlay;
  }
  if (chrome.usesFrameFalse) {
    winOpts.frame = false;
  }
  mainWindow = new BrowserWindow(winOpts);

  try {
    mainWindow.setMenuBarVisibility(false);
  } catch {
    /* ignore */
  }

  try {
    const img = nativeImage.createFromPath(iconPath());
    if (!img.isEmpty()) mainWindow.setIcon(img);
  } catch {
    /* ignore */
  }

  if (!offscreenSelftest && st.windowMaximized) {
    try {
      mainWindow.maximize();
    } catch {
      /* ignore */
    }
  }

  panels.initPanels(mainWindow, emitToRenderer, { getPublicState: publicState });
  chromeFullscreen.init(mainWindow, emitToRenderer, notifyDisplayOrChromeChange, {
    getFocusedPanelId: () => panels.getFocusedAccountId(),
    focusPanelById: (accountId) => {
      if (!accountId) return;
      panels.setFocusedAccount(accountId);
      const wc = panels.getPanelCapture(accountId);
      if (wc && !wc.isDestroyed()) {
        try {
          wc.focus();
        } catch {
          /* ignore */
        }
      }
    },
  });
  sidebarCursor.init(mainWindow, emitToRenderer, {
    isChromeHidden: () => chromeFullscreen.isChromeHidden(),
  });
  memory.initMemory(emitToRenderer);

  // Harden main UI: stay on local index.html; no webviews / window.open
  try {
    const allowMainNav = (url) => ipcGuard.isAppRendererUrl(url);
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (!allowMainNav(url)) e.preventDefault();
    });
    mainWindow.webContents.on('will-redirect', (e, url) => {
      if (!allowMainNav(url)) e.preventDefault();
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-attach-webview', (e) => {
      e.preventDefault();
    });
  } catch (err) {
    console.warn('[main] ui navigation guards', err && err.message);
  }

  mainWindow.webContents.setZoomFactor(1);
  try {
    if (typeof mainWindow.webContents.setVisualZoomLevelLimits === 'function') {
      mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
    }
  } catch {
    /* ignore */
  }
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
    const b = mainWindow.getBounds();
    updateState((s) => {
      s.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    });
  };
  const persistMaximized = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    updateState((s) => {
      s.windowMaximized = mainWindow.isMaximized();
    });
  };
  mainWindow.on('resize', () => {
    persistBounds();
    notifyDisplayOrChromeChange();
  });
  mainWindow.on('move', persistBounds);
  mainWindow.on('maximize', () => {
    persistMaximized();
    notifyDisplayOrChromeChange();
    emitToRenderer({ type: 'window:maximized', maximized: true });
  });
  mainWindow.on('unmaximize', () => {
    persistMaximized();
    persistBounds();
    notifyDisplayOrChromeChange();
    emitToRenderer({ type: 'window:maximized', maximized: false });
  });
  mainWindow.on('enter-full-screen', () => {
    notifyDisplayOrChromeChange();
    emitToRenderer({ type: 'window:fullscreen', fullscreen: true });
  });
  mainWindow.on('leave-full-screen', () => {
    chromeFullscreen.onLeaveFullScreen();
    notifyDisplayOrChromeChange();
    emitToRenderer({ type: 'window:fullscreen', fullscreen: false });
  });

  // F11 / Esc when focus is on the main UI (not a panel WebContentsView)
  mainWindow.webContents.on('before-input-event', (e, input) => {
    chromeFullscreen.handleBeforeInput(e, input, null);
  });

  // Sync overlay colors if appearance was loaded after options snapshot
  lastTitleBarOverlay = windowChrome.applyTitleBarOverlay(mainWindow, st.appearance) || lastTitleBarOverlay;

  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      try {
        recovery.flushRecoveryToast(emitToRenderer);
      } catch {
        /* ignore */
      }
      try {
        changelog.setEmit(emitToRenderer);
        if (!ANY_SELFTEST) {
          changelog.maybeEmitNovidades({
            getState,
            appVersion: app.getVersion(),
            emit: emitToRenderer,
          });
        }
        const skew = changelog.getClockSkew();
        if (skew && skew.skewed) {
          emitToRenderer({
            type: 'clock:skew',
            skewed: true,
            skewMs: skew.skewMs,
            message:
              'Relógio do sistema incorreto — logins e certificados podem falhar',
          });
        }
      } catch {
        /* ignore */
      }
    }, 400);
  });

  mainWindow.on('closed', () => {
    memory.stopMemory();
    panels.destroyAllPanels();
    mainWindow = null;
  });

  if (SELFTEST) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => runSelftest().catch(failSelftest), 500);
    });
  } else if (SELFTEST_MEM) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => runMemSelftest().catch(failSelftest), 500);
    });
  } else if (SELFTEST_UI) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => runUiSelftest().catch(failSelftest), 500);
    });
  } else if (SELFTEST_BG) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => runBgSelftest().catch(failSelftest), 500);
    });
  } else if (SELFTEST_V14) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => runV14Selftest().catch(failSelftest), 500);
    });
  } else if (SELFTEST_INPUT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => runInputSelftest().catch(failSelftest), 500);
    });
  } else if (SELFTEST_V16) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runV16Selftest } = require('./selftest-v16');
          runV16Selftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            v16,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_ADBLOCK) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runAdblockSelftest } = require('./selftest-adblock');
          runAdblockSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            adblock,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_ADBLOCK_PACKAGED) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          if (!require('electron').app.isPackaged) {
            failSelftest(new Error('adblock-packaged only allowed in packaged builds'));
            return;
          }
          // Included in asar (not selftest-*.js) so packaged builds can run this check.
          const { runPackagedAdblockCheck } = require('./adblock/packaged-check');
          runPackagedAdblockCheck({
            mainWindow,
            panels,
            getState,
            updateState,
            flushSave,
            sleep,
            waitForUrl,
            adblock,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_ADBLOCK_REAL) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runAdblockRealCheck } = require('./selftest-adblock-real');
          runAdblockRealCheck({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            adblock,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 1500);
    });
  } else if (SELFTEST_V18) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runV18Selftest } = require('./selftest-v18');
          runV18Selftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            adblock,
            userAgent,
            sessionPersist,
            popupAdblockMenu,
            popupTopMenu,
            clampBoundsToDisplays,
            ensureWindowOnDisplay,
            recovery,
            loadState,
            v16,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_V19) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runV19Selftest } = require('./selftest-v19');
          runV19Selftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            popupTopMenu,
            popupAccountMenu,
            compositeWindowShot,
            waitForLayoutSettle,
            waitForPanels,
          }).catch(failSelftest); // publicState + emitToRenderer required for UI sync
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_TITLEBAR) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runTitlebarSelftest } = require('./selftest-titlebar');
          runTitlebarSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            compositeWindowShot,
            waitForLayoutSettle,
            waitForPanels,
            recordedWindowChrome: () => recordedWindowChrome,
            lastTitleBarOverlay: () => lastTitleBarOverlay,
            applyTitleBarOverlay: (appearance) => {
              lastTitleBarOverlay =
                windowChrome.applyTitleBarOverlay(mainWindow, appearance) || lastTitleBarOverlay;
              return lastTitleBarOverlay;
            },
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_V110) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runV110Selftest } = require('./selftest-v110');
          runV110Selftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            popupTopMenu,
            popupAccountMenu,
            waitForLayoutSettle,
            waitForPanels,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_V120) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runV120Selftest } = require('./selftest-v120');
          runV120Selftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_FULLSCREEN) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runFullscreenSelftest } = require('./selftest-fullscreen');
          runFullscreenSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            chromeFullscreen,
            sidebarCursor,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_SIDEBAR) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runSidebarSelftest } = require('./selftest-sidebar');
          runSidebarSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            chromeFullscreen,
            sidebarCursor,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_REALCLICK_SIDEBAR) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runRealclickSidebarSelftest } = require('./selftest-realclick-sidebar');
          runRealclickSidebarSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            chromeFullscreen,
            sidebarCursor,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_REALCLICK_SIDEBAR2) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runRealclickSidebar2Selftest } = require('./selftest-realclick-sidebar2');
          runRealclickSidebar2Selftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            chromeFullscreen,
            sidebarCursor,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_REALCLICK_LEGACY_COMPACT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runRealclickLegacyCompactSelftest } = require('./selftest-realclick-legacy-compact');
          runRealclickLegacyCompactSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            chromeFullscreen,
            sidebarCursor,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_REALDRAG_TOPBAR) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runRealdragTopbarSelftest } = require('./selftest-realdrag-topbar');
          runRealdragTopbarSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            chromeFullscreen,
            sidebarCursor,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_REALHOVER_FULLSCREEN) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runRealhoverFullscreenSelftest } = require('./selftest-realhover-fullscreen');
          runRealhoverFullscreenSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            chromeFullscreen,
            sidebarCursor,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_WORKSPACE_DELETE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runWorkspaceDeleteSelftest } = require('./selftest-workspace-delete');
          runWorkspaceDeleteSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_EXT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runExtSelftest } = require('./selftest-ext');
          runExtSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            extensions,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_ABU) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runAbuSelftest } = require('./selftest-abu');
          runAbuSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            extensions,
            adblock,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_ABU_YT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runAbuYtSelftest } = require('./selftest-abu-yt');
          runAbuYtSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            extensions,
            adblock,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_BUILTIN_YT) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runBuiltinYtSelftest } = require('./selftest-builtin-yt');
          runBuiltinYtSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            extensions,
            adblock,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_SECURITY) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runSecuritySelftest } = require('./selftest-security');
          runSecuritySelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            ipcGuard,
            permissions,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_UA) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runUaSelftest } = require('./selftest-ua');
          runUaSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            adblock,
            userAgent,
            sessionPersist,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_CONTEXTMENU) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runContextMenuSelftest } = require('./selftest-contextmenu');
          runContextMenuSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            app,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_PROXY) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runProxySelftest } = require('./selftest-proxy');
          runProxySelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            app,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_DOH) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runDohSelftest } = require('./selftest-doh');
          runDohSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            app,
            doh,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_SETTINGS_PERF) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runSettingsPerfSelftest } = require('./selftest-settings-perf');
          runSettingsPerfSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            app,
            doh,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_PERMISSIONS) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runPermissionsSelftest } = require('./selftest-permissions');
          runPermissionsSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            app,
            permissions,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_CATALOG) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runCatalogSelftest } = require('./selftest-catalog');
          runCatalogSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            app,
            catalog,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_SHOTS_SIDEBAR2) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runShotsSidebar2 } = require('./selftest-shots-sidebar2');
          runShotsSidebar2({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            chromeFullscreen,
            sidebarCursor,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_SHOTS_TOOLS) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runShotsToolsSelftest } = require('./selftest-shots-tools');
          runShotsToolsSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            app,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_NOTES) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runNotesSelftest } = require('./selftest-notes');
          runNotesSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            app,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_REMINDERS) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runRemindersSelftest } = require('./selftest-reminders');
          runRemindersSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            app,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_SHEET) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runSheetSelftest } = require('./selftest-sheet');
          runSheetSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            app,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_VOLUME) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runVolumeSelftest } = require('./selftest-volume');
          runVolumeSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            app,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_SHOTS_VOLUME) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runShotsVolumeSelftest } = require('./selftest-shots-volume');
          runShotsVolumeSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            app,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_LAYOUT_WORKSPACE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runLayoutWorkspaceSelftest } = require('./selftest-layout-workspace');
          runLayoutWorkspaceSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            waitForLayoutSettle,
            waitForPanels,
            app,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_GIS) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runGisSelftest } = require('./selftest-gis');
          runGisSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            adblock,
            userAgent,
            sessionPersist,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  } else if (SELFTEST_STORE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        try {
          const { runStoreSelftest } = require('./selftest-store');
          runStoreSelftest({
            mainWindow,
            panels,
            getState,
            setState,
            updateState,
            flushSave,
            publicState,
            emitToRenderer,
            sleep,
            waitForUrl,
            rendererEval,
            extensions,
          }).catch(failSelftest);
        } catch (err) {
          failSelftest(err);
        }
      }, 800);
    });
  }

  return mainWindow;
}

function publicState() {
  const s = getState();
  const accounts = Array.isArray(s.accounts)
    ? s.accounts.map((a) => catalog.enrichAccountPublic(proxy.sanitizeAccountProxyForPublic(a)))
    : [];
  // Always expose a valid select option (heal legacy object layouts etc.).
  const layout = normalizeLayout(s.layout);
  return {
    workspaces: s.workspaces,
    activeWorkspaceId: s.activeWorkspaceId,
    accounts,
    layout,
    page: s.page,
    maximizedAccountId: s.maximizedAccountId,
    settings: s.settings,
    ui: s.ui || { sidebarCollapsed: false, sidebarAutoHide: false, layoutLocked: true },
    appearance: s.appearance,
    freeTiles: s.freeTiles || {},
  };
}

/**
 * Same cleanup path as UI "remove window": destroy WebContentsView,
 * clear partition/session data, drop account + freeTiles refs.
 * Used by account:remove and workspace:delete.
 * @param {string} id
 */
async function removeAccountById(id) {
  panels.markAccountRemoving(id);
  try {
    await panels.clearAccountSession(id);
    updateState((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== id);
      if (s.maximizedAccountId === id) s.maximizedAccountId = null;
      if (s.freeTiles && typeof s.freeTiles === 'object') {
        for (const wsId of Object.keys(s.freeTiles)) {
          if (s.freeTiles[wsId] && s.freeTiles[wsId][id]) {
            delete s.freeTiles[wsId][id];
          }
        }
      }
    });
  } finally {
    panels.unmarkAccountRemoving(id);
  }
}

function registerIpc() {
  ipcMain.handle('state:get', () => publicState());

  ipcMain.handle('state:set-layout', (_e, layout) => {
    const normalized = normalizeLayout(layout);
    updateState((s) => {
      if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
        s.layoutByWorkspace = {};
      }
      s.layout = normalized;
      s.layoutByWorkspace[s.activeWorkspaceId] = normalized;
      s.page = 0;
      if (!s.pageByWorkspace) s.pageByWorkspace = {};
      s.pageByWorkspace[s.activeWorkspaceId] = 0;
      s.maximizedAccountId = null;
      if (!s.maximizedByWorkspace) s.maximizedByWorkspace = {};
      s.maximizedByWorkspace[s.activeWorkspaceId] = null;
    });
    return publicState();
  });

  ipcMain.handle('state:set-page', (_e, page) => {
    const p = Math.max(0, Number(page) || 0);
    updateState((s) => {
      s.page = p;
      if (!s.pageByWorkspace) s.pageByWorkspace = {};
      s.pageByWorkspace[s.activeWorkspaceId] = p;
    });
    return publicState();
  });

  ipcMain.handle('state:set-workspace', (_e, workspaceId) => {
    const s = getState();
    if (!s.workspaces.some((w) => w.id === workspaceId)) return publicState();
    updateState((st) => {
      if (!st.maximizedByWorkspace) st.maximizedByWorkspace = {};
      if (!st.pageByWorkspace) st.pageByWorkspace = {};
      if (!st.layoutByWorkspace || typeof st.layoutByWorkspace !== 'object') {
        st.layoutByWorkspace = {};
      }
      const prev = st.activeWorkspaceId;
      st.maximizedByWorkspace[prev] = st.maximizedAccountId || null;
      st.pageByWorkspace[prev] = st.page || 0;
      st.layoutByWorkspace[prev] = normalizeLayout(st.layout);
      st.activeWorkspaceId = workspaceId;
      st.maximizedAccountId =
        st.maximizedByWorkspace[workspaceId] != null
          ? st.maximizedByWorkspace[workspaceId]
          : null;
      st.page =
        typeof st.pageByWorkspace[workspaceId] === 'number'
          ? st.pageByWorkspace[workspaceId]
          : 0;
      st.layout = normalizeLayout(
        st.layoutByWorkspace[workspaceId] != null
          ? st.layoutByWorkspace[workspaceId]
          : 'auto'
      );
      st.layoutByWorkspace[workspaceId] = st.layout;
    });
    return publicState();
  });

  ipcMain.handle('state:set-maximized', (_e, accountId) => {
    updateState((s) => {
      s.maximizedAccountId = accountId || null;
      if (!s.maximizedByWorkspace) s.maximizedByWorkspace = {};
      s.maximizedByWorkspace[s.activeWorkspaceId] = s.maximizedAccountId;
    });
    return publicState();
  });

  ipcMain.handle('settings:update', async (_e, partial) => {
    const prof = settingsApply.shouldProfileSettings()
      ? settingsApply.createSettingsProfile()
      : null;
    if (prof) prof.mark('enter');

    const prevSettings = { ...(getState().settings || {}) };
    // UI may send the whole form; keep only keys that actually changed.
    const changed = settingsApply.diffSettingsPartial(prevSettings, partial || {});
    const effects = settingsApply.classifySettingsSideEffects(changed);

    const adblockPartial =
      effects.needAdblock && changed.adblock && typeof changed.adblock === 'object'
        ? changed.adblock
        : null;
    const extensionsPartial =
      changed.extensions && typeof changed.extensions === 'object' ? changed.extensions : null;
    const dohPartial = effects.needDoh && changed.doh && typeof changed.doh === 'object'
      ? changed.doh
      : null;

    let dohError = null;
    if (dohPartial) {
      const prevDoh = doh.normalizeDoh(prevSettings.doh);
      const mergedDoh = doh.normalizeDoh({ ...prevDoh, ...dohPartial });
      const check = doh.validateDohSettings(mergedDoh);
      if (!check.ok) {
        dohError = check.error || 'Configuração de DNS criptografado inválida.';
      }
    }

    if (Object.keys(changed).length === 0 && !dohError) {
      if (prof) prof.mark('empty');
      const st = publicState();
      if (prof) {
        st._settingsProfile = prof.finish();
        st._settingsProfile.changedKeys = [];
      }
      return st;
    }

    updateState((s) => {
      const next = { ...changed };
      delete next.adblock;
      delete next.extensions;
      delete next.doh;
      if (next.homepage != null) {
        next.homepage = sanitizeUserStartUrl(
          next.homepage,
          (s.settings && s.settings.homepage) || 'https://www.google.com'
        );
      }
      s.settings = { ...s.settings, ...next };
      if (adblockPartial) {
        const prevAb = s.settings.adblock || adblock.defaultAdblockSettings();
        s.settings.adblock = {
          ...prevAb,
          ...adblockPartial,
          lists: {
            ...(prevAb.lists || {}),
            ...(adblockPartial.lists || {}),
          },
          allowlist: Array.isArray(adblockPartial.allowlist)
            ? adblockPartial.allowlist
            : prevAb.allowlist || [],
          customLists: Array.isArray(adblockPartial.customLists)
            ? adblockPartial.customLists
            : prevAb.customLists || [],
          userRules:
            typeof adblockPartial.userRules === 'string'
              ? adblockPartial.userRules
              : prevAb.userRules || '',
        };
      }
      if (extensionsPartial) {
        const prevExt = s.settings.extensions || { abuCompat: true };
        s.settings.extensions = {
          ...prevExt,
          ...extensionsPartial,
        };
      }
      if (dohPartial && !dohError) {
        const prevDoh = doh.normalizeDoh(s.settings.doh);
        s.settings.doh = doh.normalizeDoh({ ...prevDoh, ...dohPartial });
      }
    });
    if (prof) prof.mark('state');

    // Adblock rebuild is heavy — never block the IPC return path.
    if (adblockPartial) {
      const abPartial = adblockPartial;
      setImmediate(() => {
        adblock.applySettings(abPartial).catch((err) => {
          console.warn('[settings] adblock apply', err && err.message ? err.message : err);
        });
      });
    }
    if (prof) prof.mark('adblockQueued');

    if (dohPartial && !dohError) {
      const nextDoh = doh.normalizeDoh(getState().settings.doh);
      const prevDoh = doh.normalizeDoh(prevSettings.doh);
      if (!settingsApply.stableEqual(prevDoh, nextDoh)) {
        doh.applyDohSettings(nextDoh);
      }
    }
    if (prof) prof.mark('doh');

    if (effects.needUa) {
      setImmediate(() => {
        try {
          userAgent.applyAppUserAgentFallback();
          for (const ses of panels.getAccountSessions()) {
            userAgent.applySessionUserAgent(ses);
          }
        } catch (err) {
          console.warn('[settings] ua apply', err && err.message ? err.message : err);
        }
      });
    }
    if (prof) prof.mark('uaQueued');

    // Park/throttle only when related keys changed — never on DoH/appearance-only.
    if (effects.needPanelSync) {
      setImmediate(() => {
        try {
          const info = panels.getPanelDebugInfo();
          if (info.lastSlots && info.lastSlots.length) {
            panels.syncVisiblePanels(info.lastSlots);
          } else {
            panels.applyThrottling();
          }
        } catch (err) {
          console.warn('[settings] panel sync', err && err.message ? err.message : err);
        }
      });
    }
    if (prof) prof.mark('done');

    if (dohError) {
      const out = { dohError, state: publicState() };
      if (prof) out._settingsProfile = prof.finish();
      return out;
    }
    const st = publicState();
    if (prof) {
      st._settingsProfile = prof.finish();
      st._settingsProfile.changedKeys = Object.keys(changed);
      st._settingsProfile.effects = effects;
    }
    return st;
  });

  ipcMain.handle('doh:set', (_e, partial) => {
    const r = doh.setDohSettings(partial || {}, { getState, updateState });
    if (!r.ok) {
      return { ok: false, error: r.error, state: publicState(), doh: r.doh };
    }
    return {
      ok: true,
      doh: r.doh,
      applied: r.applied,
      options: r.options,
      state: publicState(),
    };
  });

  ipcMain.handle('doh:get-selftest-calls', () => {
    if (!SELFTEST_DOH && envGet('MULTIHEIZ_SELFTEST') !== 'doh') {
      return { ok: false, calls: [] };
    }
    return { ok: true, calls: doh.getSelftestCalls() };
  });

  ipcMain.handle('adblock:status', () => adblock.getStatus());
  ipcMain.handle('adblock:diagnostics', () => adblock.getDiagnostics());
  ipcMain.handle('adblock:focused-diagnostics', (_e, payload) => {
    const accountId =
      (payload && payload.accountId) ||
      panels.getFocusedAccountId() ||
      null;
    const pageUrl = (payload && payload.url) || '';
    return adblock.getFocusedPanelDiagnostics(accountId, pageUrl);
  });
  ipcMain.handle('adblock:stats', (_e, accountId) => adblock.getPageStats(accountId));
  ipcMain.handle('adblock:recent', (_e, accountId) => adblock.getRecentBlocked(accountId));
  ipcMain.handle('adblock:update-lists', async () => adblock.updateListsNow());
  ipcMain.handle('adblock:set-window', (_e, { accountId, enabled }) => {
    adblock.setWindowEnabled(accountId, enabled);
    return publicState();
  });
  ipcMain.handle('adblock:allowlist-add', (_e, domain) => {
    adblock.addAllowlistDomain(domain);
    return { allowlist: adblock.readAdblockSettings().allowlist, state: publicState() };
  });
  ipcMain.handle('adblock:allowlist-remove', (_e, domain) => {
    adblock.removeAllowlistDomain(domain);
    return { allowlist: adblock.readAdblockSettings().allowlist, state: publicState() };
  });
  ipcMain.handle('adblock:allow-site', (_e, { accountId, url }) => {
    const site = adblock.siteKeyFromUrl(url || '') || '';
    if (site) adblock.addAllowlistDomain(site);
    return { site, allowlist: adblock.readAdblockSettings().allowlist, state: publicState() };
  });
  ipcMain.handle('adblock:popup-menu', (_e, payload) => popupAdblockMenu(payload));
  ipcMain.handle('adblock:report', (_e, payload) => {
    const r = adblock.writeAdReport({
      accountId: payload && payload.accountId,
      pageUrl: (payload && payload.url) || '',
    });
    if (r && r.ok) {
      emitToRenderer({
        type: 'toast',
        message: `Relatório salvo: ${r.path}`,
        action: { label: 'Abrir pasta', path: r.dir },
      });
    }
    return r;
  });
  ipcMain.handle('adblock:custom-list-add', async (_e, url) => adblock.addCustomList(url));
  ipcMain.handle('adblock:custom-list-remove', async (_e, id) => {
    await adblock.removeCustomList(id);
    return { status: adblock.getStatus(), state: publicState() };
  });
  ipcMain.handle('adblock:set-user-rules', async (_e, text) => {
    const status = await adblock.setUserRules(text);
    return { status, state: publicState() };
  });
  ipcMain.handle('adblock:inject-test-filters', async (_e, text) => {
    if (
      !SELFTEST_ADBLOCK &&
      !SELFTEST_ADBLOCK_REAL &&
      !SELFTEST_V18 &&
      envGet('MULTIHEIZ_ADBLOCK_TEST') !== '1'
    ) {
      return { ok: false };
    }
    return adblock.injectTestFilters(text);
  });
  ipcMain.handle('panel:home', (_e, accountId) => {
    panels.panelGoHome(accountId);
    return { ok: true };
  });
  ipcMain.handle('panel:open-login-browser', (_e, accountId) => {
    return panels.openLoginInSystemBrowser(accountId);
  });
  ipcMain.handle('app:open-path', async (_e, target) => {
    const { openAllowedPath } = require('./safe-open-path');
    return openAllowedPath(target);
  });

  ipcMain.handle('ui:update', (_e, partial) => {
    updateState((s) => {
      s.ui = { ...(s.ui || {}), ...(partial || {}) };
    });
    return publicState();
  });

  ipcMain.handle('appearance:update', (_e, partial) => {
    updateState((s) => {
      s.appearance = { ...(s.appearance || {}), ...(partial || {}) };
    });
    const next = publicState();
    lastTitleBarOverlay =
      windowChrome.applyTitleBarOverlay(mainWindow, next.appearance) || lastTitleBarOverlay;
    return next;
  });

  ipcMain.handle('appearance:reset', () => {
    const { defaultAppearance } = require('./state');
    updateState((s) => {
      s.appearance = defaultAppearance();
    });
    const next = publicState();
    lastTitleBarOverlay =
      windowChrome.applyTitleBarOverlay(mainWindow, next.appearance) || lastTitleBarOverlay;
    return next;
  });

  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return { ok: true };
  });

  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });

  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return { ok: true };
  });

  ipcMain.handle('window:is-maximized', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isMaximized();
  });

  ipcMain.handle('window:chrome-info', () => {
    const maximized =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false;
    const fullscreen =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.isFullScreen() : false;
    return {
      ...(recordedWindowChrome || {}),
      isMaximizable: mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximizable() : false,
      isMaximized: maximized,
      isFullScreen: fullscreen,
      chromeHidden: chromeFullscreen.isChromeHidden(),
      lastOverlay: lastTitleBarOverlay,
      topbarHeight: windowChrome.TOPBAR_HEIGHT,
    };
  });

  ipcMain.handle('free-tiles:set', (_e, { workspaceId, tiles }) => {
    updateState((s) => {
      if (!s.freeTiles || typeof s.freeTiles !== 'object') s.freeTiles = {};
      s.freeTiles[workspaceId || s.activeWorkspaceId] = tiles || {};
    });
    return publicState();
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    startedAt: APP_STARTED_AT,
    kofiUrl: require('./config').KOFI_URL || '',
    platform: process.platform,
    usesCustomFrame: !!(recordedWindowChrome && recordedWindowChrome.frame === false),
    usesTitleBarOverlay: !!(recordedWindowChrome && recordedWindowChrome.titleBarStyle === 'hidden'),
  }));

  ipcMain.handle('workspace:create', (_e, name) => {
    const id = makeId('ws');
    updateState((s) => {
      s.workspaces.push({ id, name: name || 'Nova categoria' });
      // New area starts with a copy of the current area's layout (documented default).
      if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
        s.layoutByWorkspace = {};
      }
      s.layoutByWorkspace[id] = normalizeLayout(s.layout);
    });
    return publicState();
  });

  ipcMain.handle('workspace:rename', (_e, { id, name }) => {
    updateState((s) => {
      const w = s.workspaces.find((x) => x.id === id);
      if (w && name) w.name = String(name).trim() || w.name;
    });
    return publicState();
  });

  ipcMain.handle('workspace:delete', async (_e, id) => {
    const s0 = getState();
    if (s0.workspaces.length <= 1) return publicState();
    const fallback = s0.workspaces.find((w) => w.id !== id);
    if (!fallback) return publicState();
    if (!s0.workspaces.some((w) => w.id === id)) return publicState();

    const toRemove = s0.accounts.filter((a) => a.workspaceId === id).map((a) => a.id);
    for (const accId of toRemove) {
      await removeAccountById(accId);
    }

    updateState((s) => {
      s.workspaces = s.workspaces.filter((w) => w.id !== id);
      if (s.freeTiles && typeof s.freeTiles === 'object' && s.freeTiles[id]) {
        delete s.freeTiles[id];
      }
      if (s.pageByWorkspace && typeof s.pageByWorkspace === 'object') {
        delete s.pageByWorkspace[id];
      }
      if (s.maximizedByWorkspace && typeof s.maximizedByWorkspace === 'object') {
        delete s.maximizedByWorkspace[id];
      }
      if (s.layoutByWorkspace && typeof s.layoutByWorkspace === 'object') {
        delete s.layoutByWorkspace[id];
      }
      if (s.activeWorkspaceId === id) {
        if (!s.maximizedByWorkspace) s.maximizedByWorkspace = {};
        if (!s.pageByWorkspace) s.pageByWorkspace = {};
        if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
          s.layoutByWorkspace = {};
        }
        s.activeWorkspaceId = fallback.id;
        s.maximizedAccountId =
          s.maximizedByWorkspace[fallback.id] != null
            ? s.maximizedByWorkspace[fallback.id]
            : null;
        s.page =
          typeof s.pageByWorkspace[fallback.id] === 'number'
            ? s.pageByWorkspace[fallback.id]
            : 0;
        s.layout = normalizeLayout(
          s.layoutByWorkspace[fallback.id] != null
            ? s.layoutByWorkspace[fallback.id]
            : 'auto'
        );
        s.layoutByWorkspace[fallback.id] = s.layout;
      }
    });
    return publicState();
  });

  ipcMain.handle('catalog:list', () => catalog.listAppsPublic());

  ipcMain.handle('account:create', (_e, data) => {
    const s = getState();
    const id = makeId('acc');
    const colors = ['#2bb8a6', '#3d8bfd', '#e8a54b', '#e83e8c', '#6f42c1', '#20c997'];
    const homepageFallback =
      (s.settings && s.settings.homepage) || 'https://www.google.com';
    let pauseInBackground = !!(data && data.pauseInBackground);
    let keepAliveInBackground = !!(data && data.keepAliveInBackground);
    if (pauseInBackground && keepAliveInBackground) {
      keepAliveInBackground = false;
    }
    const workspaceId = (data && data.workspaceId) || s.activeWorkspaceId;
    const catalogId = data && data.catalogId ? String(data.catalogId).trim() : '';
    const catalogApp = catalogId ? catalog.getAppById(catalogId) : null;
    let name = (data && data.name) || `Janela ${s.accounts.length + 1}`;
    let color = (data && data.color) || colors[s.accounts.length % colors.length];
    let startUrl = sanitizeUserStartUrl(
      (data && data.startUrl) || homepageFallback,
      homepageFallback
    );
    /** @type {string|undefined} */
    let catalogIcon;
    if (catalogApp) {
      name = catalog.uniqueNameInWorkspace(
        catalogApp.defaultName || catalogApp.name,
        s.accounts,
        workspaceId
      );
      color = catalogApp.color || color;
      startUrl = catalogApp.url;
      catalogIcon = catalogApp.icon;
      // tweaks.userAgent: UA Chrome já é global — não aplica override por janela.
    }
    const account = {
      id,
      name,
      color,
      startUrl,
      workspaceId,
      muted: false,
      volume: 100,
      pauseInBackground,
      keepAliveInBackground,
      privateHistory: !!(data && data.privateHistory),
      adblockEnabled: data && data.adblockEnabled === false ? false : true,
      lastUrl: null,
      zoomFactor: 1,
    };
    if (catalogApp) {
      account.catalogId = catalogApp.id;
      account.catalogIcon = catalogIcon;
    }
    updateState((st) => {
      st.accounts.push(account);
    });
    try {
      adblock.attachAllAccountSessions();
    } catch {
      /* ignore */
    }
    try {
      extensions.loadForAccount(id).catch(() => {});
    } catch {
      /* ignore */
    }
    const next = publicState();
    const publicAccount = (next.accounts || []).find((a) => a.id === id) || account;
    emitToRenderer({ type: 'state:changed', state: next });
    return { state: next, account: publicAccount };
  });

  ipcMain.handle('account:update', (_e, { id, ...fields }) => {
    updateState((s) => {
      const a = s.accounts.find((x) => x.id === id);
      if (!a) return;
      if (fields.name != null) a.name = String(fields.name).trim() || a.name;
      if (fields.color != null) a.color = fields.color;
      if (fields.startUrl != null) {
        a.startUrl = sanitizeUserStartUrl(fields.startUrl, a.startUrl || 'https://www.google.com');
      }
      if (fields.workspaceId != null) a.workspaceId = fields.workspaceId;
      if (typeof fields.muted === 'boolean') a.muted = fields.muted;
      if (typeof fields.pauseInBackground === 'boolean') {
        a.pauseInBackground = fields.pauseInBackground;
        if (a.pauseInBackground) a.keepAliveInBackground = false;
      }
      if (typeof fields.keepAliveInBackground === 'boolean') {
        a.keepAliveInBackground = fields.keepAliveInBackground;
        if (a.keepAliveInBackground) a.pauseInBackground = false;
      }
      if (a.pauseInBackground && a.keepAliveInBackground) {
        a.keepAliveInBackground = false;
      }
      if (typeof fields.privateHistory === 'boolean') {
        a.privateHistory = fields.privateHistory;
      }
      if (typeof fields.adblockEnabled === 'boolean') {
        a.adblockEnabled = fields.adblockEnabled;
      }
    });
    panels.applyThrottling();
    if (typeof fields.adblockEnabled === 'boolean') {
      adblock.setWindowEnabled(id, fields.adblockEnabled);
    }
    return publicState();
  });

  ipcMain.handle('account:remove', async (_e, id) => {
    await removeAccountById(id);
    return publicState();
  });

  ipcMain.handle('layout:sync', (_e, slots) => {
    if (!Array.isArray(slots)) return;
    panels.syncVisiblePanels(slots);
  });

  ipcMain.handle('sidebar:set-overlay', (_e, widthPx) => {
    panels.setSidebarOverlayWidth(widthPx);
    return { ok: true, width: panels.getSidebarOverlayWidth() };
  });

  ipcMain.handle('sidebar:set-auto-hide-tracking', (_e, opts) => {
    return sidebarCursor.setTracking(opts || {});
  });

  ipcMain.handle('overlay:set', async (_e, { id, active }) => {
    return panels.setOverlay(id, !!active);
  });

  ipcMain.handle('overlay:set-ids', async (_e, ids) => {
    return panels.setOverlayCount(ids);
  });

  ipcMain.handle('overlay:count', () => panels.getOverlayCount());

  ipcMain.handle('menu:account', (_e, payload) => {
    return popupAccountMenu(payload || {});
  });

  ipcMain.handle('menu:top', (_e, payload) => {
    return popupTopMenu(payload || {});
  });

  ipcMain.handle('panel:zoom', (_e, payload) => {
    const accountId = (payload && payload.accountId) || panels.getFocusedAccountId();
    const delta = payload && typeof payload.delta === 'number' ? payload.delta : 0;
    if (!accountId) return { ok: false, zoom: 1 };
    const zoom = panels.panelZoom(accountId, delta);
    return { ok: true, zoom, accountId };
  });

  ipcMain.handle('selftest:last-account-menu', () => lastAccountMenuPopup);

  ipcMain.handle('selftest:clear-account-menu', () => {
    lastAccountMenuPopup = null;
    return true;
  });

  ipcMain.handle('panel:navigate', (_e, { accountId, url }) => {
    panels.panelNavigate(accountId, url);
  });

  ipcMain.handle('panel:back', (_e, accountId) => panels.panelBack(accountId));
  ipcMain.handle('panel:forward', (_e, accountId) => panels.panelForward(accountId));
  ipcMain.handle('panel:reload', (_e, accountId) => panels.panelReload(accountId));

  ipcMain.handle('proxy:get', (_e, accountId) => {
    const acc = (getState().accounts || []).find((a) => a.id === accountId);
    if (!acc) return { ok: false, error: 'Janela não encontrada.' };
    return {
      ok: true,
      proxy: proxy.publicProxyView(acc.proxy),
      encryptionAvailable: proxy.safeStorageApi().available,
    };
  });

  ipcMain.handle('proxy:set', async (_e, payload) => {
    const accountId = payload && payload.accountId;
    if (!accountId) return { ok: false, error: 'accountId obrigatório.' };
    const result = await proxy.setProxyForAccount(accountId, payload || {});
    if (!result.ok) return result;
    return {
      ...result,
      state: publicState(),
    };
  });

  ipcMain.handle('proxy:remove', async (_e, accountId) => {
    const result = await proxy.removeProxyForAccount(accountId);
    if (!result.ok) return result;
    return { ...result, state: publicState() };
  });

  ipcMain.handle('proxy:test', async (_e, accountId) => {
    return proxy.testProxyForAccount(accountId);
  });
  ipcMain.handle('panel:set-muted', (_e, { accountId, muted }) => {
    panels.panelSetMuted(accountId, muted);
    return publicState();
  });

  ipcMain.handle('panel:set-volume', (_e, { accountId, percent }) => {
    const volume = panels.panelSetVolume(accountId, percent);
    return { state: publicState(), volume };
  });

  ipcMain.handle('panel:get-volume', (_e, accountId) => {
    return { volume: panels.panelGetVolume(accountId) };
  });

  ipcMain.handle('panel:focus', (_e, accountId) => {
    panels.setFocusedAccount(accountId || null);
  });

  ipcMain.handle('panel:reactivate', (_e, accountId) => {
    return panels.reactivatePanel(accountId);
  });

  ipcMain.handle('panel:suspend', (_e, accountId) => {
    panels.suspendForMemory(accountId, { force: true });
    return { ok: true };
  });

  ipcMain.handle('memory:metrics', () => memory.getLatestMetrics());

  ipcMain.handle('memory:free', async () => memory.freeMemory());

  ipcMain.handle('selftest:capture', async (_e, accountId) => {
    const wc = panels.getPanelCapture(accountId);
    if (!wc) return null;
    const img = await wc.capturePage();
    return img.toPNG();
  });

  ipcMain.handle('selftest:capture-window', async () => {
    if (!mainWindow) return null;
    const img = await mainWindow.webContents.capturePage();
    return img.toPNG();
  });

  ipcMain.handle('selftest:panel-info', () => panels.getPanelDebugInfo());

  ipcMain.handle('selftest:content-size', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const [width, height] = mainWindow.getContentSize();
    return { width, height };
  });

  // Arbitrary renderer JS — only when MULTIHEIZ_SELFTEST is set (never in normal / packaged use)
  if (process.env.MULTIHEIZ_SELFTEST) {
    ipcMain.handle('selftest:renderer', async (_e, code) => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      return mainWindow.webContents.executeJavaScript(code, true);
    });
    ipcMain.handle('selftest:sidebar-cursor-override', (_e, point) => {
      return sidebarCursor.setCursorOverride(point == null ? null : point);
    });
    ipcMain.handle('selftest:sidebar-cursor-tracking', () => sidebarCursor.getTracking());
    ipcMain.handle('selftest:sidebar-cursor-classify', () => sidebarCursor.classifyCursor());
    ipcMain.handle('selftest:permissions-respond', (_e, payload) => {
      const accountId = payload && payload.accountId;
      const action = payload && payload.action;
      return permissions.selftestRespond(accountId, action);
    });
    ipcMain.handle('selftest:permissions-peek', (_e, accountId) => {
      return permissions.selftestPeekPrompt(accountId);
    });
  }
}

/* ---------- Self-test runner (in-process) ---------- */

function failSelftest(err) {
  console.error('SELFTEST FAIL', err && err.stack ? err.stack : err);
  console.log('FAIL: unexpected error');
  app.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForUrl(accountId, pred, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const wc = panels.getPanelCapture(accountId);
    if (wc) {
      try {
        const url = wc.getURL();
        if (pred(url)) return url;
      } catch {
        /* ignore */
      }
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for URL on ${accountId}`);
}

async function readCookiesJson(accountId) {
  const wc = panels.getPanelCapture(accountId);
  if (!wc) throw new Error(`no panel ${accountId}`);
  await wc.loadURL('https://httpbin.org/cookies');
  await waitForUrl(accountId, (u) => u.includes('/cookies') && !u.includes('/set'), 20000);
  await sleep(500);
  const text = await wc.executeJavaScript('document.body.innerText');
  return JSON.parse(text);
}

async function runSelftest() {
  const fs = require('node:fs');
  const phase = envGet('MULTIHEIZ_SELFTEST_PHASE') || '1';
  const shotDir = path.join(__dirname, '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });

  console.log(`SELFTEST phase=${phase}`);

  if (phase === '1') {
    // Fresh profile expected
    updateState((s) => {
      s.accounts = [];
      s.workspaces = [{ id: 'ws-default', name: 'Principal' }];
      s.activeWorkspaceId = 'ws-default';
      s.layout = '2';
      if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
        s.layoutByWorkspace = {};
      }
      s.layoutByWorkspace['ws-default'] = '2';
      s.page = 0;
      s.maximizedAccountId = null;
    });

    const accA = {
      id: 'acc-selftest-a',
      name: 'Conta A',
      color: '#3d8bfd',
      startUrl: 'https://httpbin.org/cookies',
      workspaceId: 'ws-default',
      muted: false,
      lastUrl: null,
    };
    const accB = {
      id: 'acc-selftest-b',
      name: 'Conta B',
      color: '#20c997',
      startUrl: 'https://httpbin.org/cookies',
      workspaceId: 'ws-default',
      muted: false,
      lastUrl: null,
    };
    updateState((s) => {
      s.accounts.push(accA, accB);
    });

    mainWindow.webContents.send('event', { type: 'state:changed', state: publicState() });
    await sleep(800);

    // Force create panels and layout
    const [bw, bh] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: accA.id, x: 0, y: 80, width: Math.floor(bw / 2), height: bh - 80 },
      { accountId: accB.id, x: Math.floor(bw / 2), y: 80, width: Math.floor(bw / 2), height: bh - 80 },
    ]);

    await waitForUrl(accA.id, (u) => u.includes('httpbin.org'), 30000);
    await waitForUrl(accB.id, (u) => u.includes('httpbin.org'), 30000);

    const wcA = panels.getPanelCapture(accA.id);
    await wcA.loadURL('https://httpbin.org/cookies/set?x=1');
    await waitForUrl(accA.id, (u) => u.includes('/cookies'), 20000);
    await sleep(800);

    const cookiesA = await readCookiesJson(accA.id);
    const cookiesB = await readCookiesJson(accB.id);

    const aHas = cookiesA && cookiesA.cookies && String(cookiesA.cookies.x) === '1';
    const bEmpty =
      !cookiesB.cookies ||
      Object.keys(cookiesB.cookies).length === 0 ||
      cookiesB.cookies.x === undefined;

    if (aHas) console.log('PASS: account A has cookie x=1');
    else {
      console.log('FAIL: account A missing cookie x=1', JSON.stringify(cookiesA));
      app.exit(1);
      return;
    }
    if (bEmpty) console.log('PASS: account B has no cookie x');
    else {
      console.log('FAIL: account B should not have cookie x', JSON.stringify(cookiesB));
      app.exit(1);
      return;
    }

    // Screenshots (needs a visible surface on Windows)
    try {
      if (mainWindow) {
        mainWindow.setOpacity(1);
        mainWindow.show();
        mainWindow.focus();
        await sleep(800);
      }

      async function captureWc(wc, fileName, retries = 5) {
        let lastErr;
        for (let i = 0; i < retries; i++) {
          try {
            const img = await wc.capturePage();
            const buf = img.toPNG();
            if (buf && buf.length > 100) {
              fs.writeFileSync(path.join(shotDir, fileName), buf);
              return;
            }
          } catch (err) {
            lastErr = err;
          }
          await sleep(400);
        }
        throw lastErr || new Error(`capture failed for ${fileName}`);
      }

      await captureWc(wcA, 'panel-a.png');
      const wcB = panels.getPanelCapture(accB.id);
      if (wcB) await captureWc(wcB, 'panel-b.png');
      if (mainWindow) await captureWc(mainWindow.webContents, 'window-chrome.png');
      console.log('PASS: screenshots saved to docs/screenshots/');
    } catch (err) {
      console.log('FAIL: screenshot', err.message);
      app.exit(1);
      return;
    }

    flushSave();
    // Session cookies do httpbin podem não sobreviver ao restart; reforçar com expiração
    {
      const ses = session.fromPartition(panels.partitionFor('acc-selftest-a'));
      const existing = await ses.cookies.get({ url: 'https://httpbin.org' });
      for (const c of existing) {
        await ses.cookies.set({
          url: 'https://httpbin.org',
          name: c.name,
          value: c.value,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          expirationDate: Math.floor(Date.now() / 1000) + 7 * 86400,
        });
      }
      try {
        const flush = ses.cookies.flushStore();
        if (flush && typeof flush.then === 'function') {
          await Promise.race([flush, sleep(1500)]);
        }
      } catch {
        /* ignore */
      }
    }
    panels.destroyAllPanels();
    await sleep(400);
    console.log('PASS: phase 1 cookie isolation + persist');
    app.exit(0);
    return;
  }

  if (phase === '2') {
    const s = getState();
    const hasA = s.accounts.some((a) => a.id === 'acc-selftest-a');
    const hasB = s.accounts.some((a) => a.id === 'acc-selftest-b');
    const layoutOk = s.layout === '2';
    const wsOk = s.activeWorkspaceId === 'ws-default';

    if (hasA && hasB) console.log('PASS: accounts restored');
    else {
      console.log('FAIL: accounts not restored', JSON.stringify(s.accounts.map((a) => a.id)));
      app.exit(1);
      return;
    }
    if (layoutOk) console.log('PASS: layout restored');
    else {
      console.log('FAIL: layout not restored', s.layout);
      app.exit(1);
      return;
    }
    if (wsOk) console.log('PASS: workspace restored');
    else {
      console.log('FAIL: workspace not restored', s.activeWorkspaceId);
      app.exit(1);
      return;
    }

    const sesA = session.fromPartition(panels.partitionFor('acc-selftest-a'));
    const stored = await sesA.cookies.get({ url: 'https://httpbin.org' });
    const hasStored = stored.some((c) => c.name === 'x' && String(c.value) === '1');
    if (hasStored) {
      console.log('PASS: cookie x=1 persisted in partition A (cookies API)');
    } else {
      // fallback: carregar página
      const [bw, bh] = mainWindow.getContentSize();
      panels.syncVisiblePanels([
        {
          accountId: 'acc-selftest-a',
          x: 0,
          y: 80,
          width: Math.floor(bw / 2),
          height: bh - 80,
        },
        {
          accountId: 'acc-selftest-b',
          x: Math.floor(bw / 2),
          y: 80,
          width: Math.floor(bw / 2),
          height: bh - 80,
        },
      ]);
      await waitForUrl('acc-selftest-a', (u) => !!u && u !== 'about:blank', 30000);
      const cookiesA = await readCookiesJson('acc-selftest-a');
      const aHas = cookiesA && cookiesA.cookies && String(cookiesA.cookies.x) === '1';
      if (aHas) console.log('PASS: cookie x=1 persisted in partition A');
      else {
        console.log(
          'FAIL: cookie not persisted',
          JSON.stringify({ page: cookiesA, stored })
        );
        app.exit(1);
        return;
      }
    }

    console.log('PASS: phase 2 restore');
    app.exit(0);
    return;
  }

  console.log('FAIL: unknown phase');
  app.exit(1);
}

/* ---------- Memory self-test ---------- */

async function runMemSelftest() {
  console.log('SELFTEST mem');

  updateState((s) => {
    s.accounts = [];
    s.workspaces = [{ id: 'ws-default', name: 'Principal' }];
    s.activeWorkspaceId = 'ws-default';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = {
      ...s.settings,
      openLastPage: true,
      // Keep hidden panels alive so the RAM limiter (not suspendHidden) suspends them
      suspendHidden: false,
      suspendDelayMs: 0,
      keepBackgroundRunning: true,
      memoryLimitMb: 0,
      panelMemoryLimitMb: 0,
      hardMemoryLimit: false,
      backgroundThrottling: false,
      backgroundFps: 5,
    };
  });

  const accounts = [
    {
      id: 'acc-mem-a',
      name: 'Mem A',
      color: '#3d8bfd',
      startUrl: 'https://httpbin.org/cookies',
      workspaceId: 'ws-default',
      muted: false,
      pauseInBackground: false,
      lastUrl: null,
    },
    {
      id: 'acc-mem-b',
      name: 'Mem B',
      color: '#20c997',
      startUrl: 'https://httpbin.org/cookies',
      workspaceId: 'ws-default',
      muted: false,
      pauseInBackground: false,
      lastUrl: null,
    },
    {
      id: 'acc-mem-c',
      name: 'Mem C',
      color: '#fd7e14',
      startUrl: 'https://httpbin.org/cookies',
      workspaceId: 'ws-default',
      muted: false,
      pauseInBackground: false,
      lastUrl: null,
    },
  ];
  updateState((s) => {
    s.accounts.push(...accounts);
  });

  mainWindow.webContents.send('event', { type: 'state:changed', state: publicState() });
  await sleep(600);

  const [bw, bh] = mainWindow.getContentSize();
  // Layout 1: only A visible; B and C "on other pages" - sync only A
  panels.syncVisiblePanels([
    { accountId: 'acc-mem-a', x: 0, y: 80, width: bw, height: bh - 80 },
  ]);
  await waitForUrl('acc-mem-a', (u) => u.includes('httpbin.org'), 30000);

  // Create B and C briefly to set cookies, then hide them
  panels.syncVisiblePanels([
    { accountId: 'acc-mem-a', x: 0, y: 80, width: Math.floor(bw / 3), height: bh - 80 },
    {
      accountId: 'acc-mem-b',
      x: Math.floor(bw / 3),
      y: 80,
      width: Math.floor(bw / 3),
      height: bh - 80,
    },
    {
      accountId: 'acc-mem-c',
      x: Math.floor((2 * bw) / 3),
      y: 80,
      width: Math.floor(bw / 3),
      height: bh - 80,
    },
  ]);
  await waitForUrl('acc-mem-b', (u) => u.includes('httpbin.org'), 30000);
  await waitForUrl('acc-mem-c', (u) => u.includes('httpbin.org'), 30000);

  const wcB = panels.getPanelCapture('acc-mem-b');
  await wcB.loadURL('https://httpbin.org/cookies/set?mem=1');
  await waitForUrl('acc-mem-b', (u) => u.includes('/cookies'), 20000);
  await sleep(600);

  // Persist cookie with expiration for partition B
  {
    const ses = session.fromPartition(panels.partitionFor('acc-mem-b'));
    const existing = await ses.cookies.get({ url: 'https://httpbin.org' });
    for (const c of existing) {
      await ses.cookies.set({
        url: 'https://httpbin.org',
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expirationDate: Math.floor(Date.now() / 1000) + 7 * 86400,
      });
    }
    try {
      const flush = ses.cookies.flushStore();
      if (flush && typeof flush.then === 'function') {
        await Promise.race([flush, sleep(1500)]);
      }
    } catch {
      /* ignore */
    }
  }

  // Mark B/C as older LRU, A as focused/recent
  panels.touchAccount('acc-mem-b');
  await sleep(50);
  panels.touchAccount('acc-mem-c');
  await sleep(50);
  panels.setFocusedAccount('acc-mem-a');
  panels.touchAccount('acc-mem-a');

  // Only A visible; B/C stay alive because suspendHidden=false
  panels.syncVisiblePanels([
    { accountId: 'acc-mem-a', x: 0, y: 80, width: bw, height: bh - 80 },
  ]);
  await sleep(300);

  const beforeActive = panels.listActivePanelIds();
  if (beforeActive.length < 3) {
    console.log('FAIL: expected 3 active panels before enforce', JSON.stringify(beforeActive));
    app.exit(1);
    return;
  }

  updateState((s) => {
    s.settings.memoryLimitMb = 1;
  });
  panels.setFocusedAccount('acc-mem-a');

  let metrics = memory.getLatestMetrics();
  await memory.enforce(metrics);
  await sleep(500);
  metrics = memory.getLatestMetrics();

  const active = new Set(panels.listActivePanelIds());
  const hiddenSuspended = !active.has('acc-mem-b') && !active.has('acc-mem-c');
  if (hiddenSuspended && active.has('acc-mem-a')) {
    console.log('PASS: hidden panels suspended under low RAM limit');
  } else {
    console.log(
      'FAIL: expected B/C suspended and A active',
      JSON.stringify([...active]),
      'totalMb=',
      metrics.totalRamMb
    );
    app.exit(1);
    return;
  }

  // Metrics must return numbers
  if (
    typeof metrics.totalRamMb === 'number' &&
    metrics.totalRamMb >= 0 &&
    Array.isArray(metrics.panels) &&
    metrics.panels.length === 3
  ) {
    const aRow = metrics.panels.find((p) => p.accountId === 'acc-mem-a');
    if (aRow && typeof aRow.ramMb === 'number' && typeof aRow.cpu === 'number') {
      console.log('PASS: metrics return numbers', {
        totalRamMb: metrics.totalRamMb,
        aRam: aRow.ramMb,
        aCpu: aRow.cpu,
      });
    } else {
      console.log('FAIL: panel metrics missing numbers', JSON.stringify(aRow));
      app.exit(1);
      return;
    }
  } else {
    console.log('FAIL: metrics shape invalid', JSON.stringify(metrics));
    app.exit(1);
    return;
  }

  // Reactivate B and verify cookie
  panels.syncVisiblePanels([
    { accountId: 'acc-mem-a', x: 0, y: 80, width: Math.floor(bw / 2), height: bh - 80 },
    {
      accountId: 'acc-mem-b',
      x: Math.floor(bw / 2),
      y: 80,
      width: Math.floor(bw / 2),
      height: bh - 80,
    },
  ]);
  panels.reactivatePanel('acc-mem-b');
  await waitForUrl('acc-mem-b', (u) => !!u && u !== 'about:blank', 30000);

  const sesB = session.fromPartition(panels.partitionFor('acc-mem-b'));
  const stored = await sesB.cookies.get({ url: 'https://httpbin.org' });
  const hasStored = stored.some((c) => c.name === 'mem' && String(c.value) === '1');
  if (hasStored) {
    console.log('PASS: cookie mem=1 survived suspend/reactivate');
  } else {
    const cookiesB = await readCookiesJson('acc-mem-b');
    const ok = cookiesB && cookiesB.cookies && String(cookiesB.cookies.mem) === '1';
    if (ok) console.log('PASS: cookie mem=1 survived suspend/reactivate (page)');
    else {
      console.log('FAIL: cookie lost after reactivate', JSON.stringify({ stored, cookiesB }));
      app.exit(1);
      return;
    }
  }

  console.log('PASS: mem selftest complete');
  app.exit(0);
}

/* ---------- UI self-test (v1.2) ---------- */

function areaOf(b) {
  return Math.max(0, b.width) * Math.max(0, b.height);
}

function nearlyEqual(a, b, tol = 4) {
  return Math.abs(a - b) <= tol;
}

function boundsMatch(a, b, tol = 4) {
  return (
    nearlyEqual(a.x, b.x, tol) &&
    nearlyEqual(a.y, b.y, tol) &&
    nearlyEqual(a.width, b.width, tol) &&
    nearlyEqual(a.height, b.height, tol)
  );
}

async function waitForPanels(pred, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = panels.getPanelDebugInfo();
    if (pred(info)) return info;
    await sleep(100);
  }
  throw new Error('timeout waiting for panel state');
}

async function rendererEval(code) {
  return mainWindow.webContents.executeJavaScript(code, true);
}

async function waitForLayoutSettle() {
  await rendererEval('window.__multiheizUi && window.__multiheizUi.syncNow()');
  await sleep(250);
  await rendererEval('window.__multiheizUi && window.__multiheizUi.syncNow()');
  await sleep(200);
}

async function compositeWindowShot(filePath) {
  const fs = require('node:fs');
  // Prefer desktopCapturer of the whole window (includes WebContentsViews)
  try {
    if (mainWindow) {
      mainWindow.setOpacity(1);
      mainWindow.show();
      mainWindow.focus();
      await sleep(400);
    }
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: {
        width: Math.max(800, (mainWindow && mainWindow.getBounds().width) || 1600),
        height: Math.max(500, (mainWindow && mainWindow.getBounds().height) || 900),
      },
    });
    const title = mainWindow ? mainWindow.getTitle() : APP_DISPLAY_NAME;
    const match =
      sources.find(
        (s) =>
          s.name.includes('MultiHeiz') ||
          s.name.includes(title)
      ) || sources[0];
    if (match && match.thumbnail && !match.thumbnail.isEmpty()) {
      fs.writeFileSync(filePath, match.thumbnail.toPNG());
      return true;
    }
  } catch (err) {
    console.log('desktopCapturer fallback:', err.message);
  }

  // Fallback: main chrome + panel captures (overlay-hidden shots still OK)
  const chrome = await mainWindow.webContents.capturePage();
  fs.writeFileSync(filePath, chrome.toPNG());
  return false;
}

async function runUiSelftest() {
  const fs = require('node:fs');
  const scale = envGet('MULTIHEIZ_UI_SCALE') || '1';
  const shotDir = path.join(__dirname, '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });

  console.log(`SELFTEST ui scale=${scale}`);

  updateState((s) => {
    s.accounts = [];
    s.workspaces = [{ id: 'ws-default', name: 'Principal' }];
    s.activeWorkspaceId = 'ws-default';
    s.layout = '4';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = {
      ...s.settings,
      openLastPage: true,
      suspendHidden: false,
      suspendDelayMs: 0,
    };
  });

  const accA = {
    id: 'acc-ui-a',
    name: 'UI A',
    color: '#3d8bfd',
    startUrl: 'https://httpbin.org/html',
    workspaceId: 'ws-default',
    muted: false,
    lastUrl: null,
  };
  updateState((s) => {
    s.accounts.push(accA);
  });

  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();

  const content = (() => {
    const [width, height] = mainWindow.getContentSize();
    return { width, height };
  })();
  const chrome = await rendererEval('window.__multiheizUi.getChromeInsets()');
  const gridW = Math.max(1, content.width - (chrome?.sidebar || 0));
  const gridH = Math.max(1, content.height - (chrome?.topbar || 48) - (chrome?.statusbar || 28));
  const contentArea = gridW * gridH;

  let info = await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-ui-a'));
  let panelA = info.panels.find((p) => p.accountId === 'acc-ui-a');
  if (!panelA || !panelA.visible || panelA.parked) {
    console.log('FAIL: panel A not visible with 1 account', JSON.stringify(info));
    app.exit(1);
    return;
  }

  const slotA = info.lastSlots.find((s) => s.accountId === 'acc-ui-a');
  if (!slotA || !boundsMatch(panelA.bounds, slotA, 6)) {
    console.log(
      'FAIL: panel bounds not near slot rect',
      JSON.stringify({ bounds: panelA.bounds, slot: slotA })
    );
    app.exit(1);
    return;
  }

  const fillRatio = areaOf(panelA.bounds) / contentArea;
  if (fillRatio < 0.9) {
    console.log('FAIL: 1 account in layout 4 should fill >90% content area', {
      fillRatio,
      bounds: panelA.bounds,
      content,
      chrome,
      contentArea,
    });
    app.exit(1);
    return;
  }
  console.log('PASS: 1 account layout 4 fills area', {
    fillRatio: Number(fillRatio.toFixed(3)),
    bounds: panelA.bounds,
  });

  await waitForUrl('acc-ui-a', (u) => u.includes('httpbin.org'), 30000);
  const urlBeforeOverlay = panels.getPanelCapture('acc-ui-a').getURL();

  const shotOne = path.join(shotDir, scale === '1' ? 'v1.2-layout4-one.png' : `v1.2-layout4-one-scale${scale}.png`);
  await compositeWindowShot(shotOne);
  console.log('PASS: screenshot saved', path.basename(shotOne));

  // 2 accounts - side by side
  const accB = {
    id: 'acc-ui-b',
    name: 'UI B',
    color: '#20c997',
    startUrl: 'https://httpbin.org/html',
    workspaceId: 'ws-default',
    muted: false,
    lastUrl: null,
  };
  updateState((s) => {
    s.accounts.push(accB);
  });
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(500);
  await waitForLayoutSettle();

  info = await waitForPanels(
    (i) =>
      i.panels.filter((p) => p.visible && !p.parked).length >= 2 &&
      i.lastSlots.length === 2
  );
  const vis = info.panels.filter((p) => p.visible && !p.parked);
  const bA = vis.find((p) => p.accountId === 'acc-ui-a');
  const bB = vis.find((p) => p.accountId === 'acc-ui-b');
  if (!bA || !bB) {
    console.log('FAIL: expected 2 visible panels', JSON.stringify(info));
    app.exit(1);
    return;
  }
  const sideBySide =
    nearlyEqual(bA.bounds.y, bB.bounds.y, 8) &&
    nearlyEqual(bA.bounds.height, bB.bounds.height, 8) &&
    Math.abs(bA.bounds.x - bB.bounds.x) > 40;
  if (!sideBySide) {
    console.log('FAIL: 2 accounts should be side by side', {
      a: bA.bounds,
      b: bB.bounds,
    });
    app.exit(1);
    return;
  }
  console.log('PASS: 2 accounts side by side', { a: bA.bounds, b: bB.bounds });

  // Keep one account for overlay checks (simpler bounds restore)
  updateState((s) => {
    s.accounts = s.accounts.filter((a) => a.id === 'acc-ui-a');
  });
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();
  info = await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-ui-a' && p.visible));
  panelA = info.panels.find((p) => p.accountId === 'acc-ui-a');
  const boundsBefore = { ...panelA.bounds };
  const urlStable = panels.getPanelCapture('acc-ui-a').getURL();

  async function assertOverlayHidesAndRestores(name, openCode, closeCode) {
    await rendererEval(openCode);
    await sleep(400);
    let mid = panels.getPanelDebugInfo();
    if (mid.overlayCount < 1) {
      console.log(`FAIL: ${name} did not raise overlay count`, JSON.stringify(mid));
      app.exit(1);
      return false;
    }
    // v1.4: views stay "visible" but parked offscreen (media keeps running)
    const onScreen = mid.panels.some(
      (p) => p.visible && !p.parked && (p.bounds?.x ?? 0) > -1000
    );
    if (onScreen) {
      console.log(`FAIL: ${name} should park panel views offscreen`, JSON.stringify(mid.panels));
      app.exit(1);
      return false;
    }
    const parked = mid.panels.some((p) => p.parked || (p.bounds?.x ?? 0) <= -1000);
    if (!parked && mid.panels.length) {
      console.log(`FAIL: ${name} expected parked panels`, JSON.stringify(mid.panels));
      app.exit(1);
      return false;
    }
    console.log(`PASS: ${name} parks panel views (overlayCount=${mid.overlayCount})`);

    if (name === 'account-modal' && scale === '1') {
      const shotModal = path.join(shotDir, 'v1.2-modal-open.png');
      await compositeWindowShot(shotModal);
      console.log('PASS: screenshot saved', path.basename(shotModal));
    }

    await rendererEval(closeCode);
    await sleep(400);
    mid = await waitForPanels(
      (i) =>
        i.overlayCount === 0 &&
        i.panels.some((p) => p.accountId === 'acc-ui-a' && p.visible && !p.parked)
    );
    const restored = mid.panels.find((p) => p.accountId === 'acc-ui-a');
    if (!restored || !boundsMatch(restored.bounds, boundsBefore, 6)) {
      console.log(`FAIL: ${name} restore bounds mismatch`, {
        before: boundsBefore,
        after: restored && restored.bounds,
      });
      app.exit(1);
      return false;
    }
    const urlAfter = panels.getPanelCapture('acc-ui-a').getURL();
    if (urlAfter !== urlStable && urlAfter !== urlBeforeOverlay) {
      // Allow same document; fail only if clearly reloaded to blank/other
      if (!urlAfter || urlAfter === 'about:blank') {
        console.log(`FAIL: ${name} panel URL lost after restore`, { urlStable, urlAfter });
        app.exit(1);
        return false;
      }
    }
    // Ensure no reload to a different navigation entry count suddenly blank
    if (urlAfter !== urlStable) {
      console.log(`WARN: ${name} URL changed slightly`, { urlStable, urlAfter });
    }
    console.log(`PASS: ${name} restored bounds+session`);
    return true;
  }

  const okAccount = await assertOverlayHidesAndRestores(
    'account-modal',
    'window.__multiheizUi.openAccountDialog()',
    'window.__multiheizUi.closeAccountDialog()'
  );
  if (!okAccount) return;

  const okSettings = await assertOverlayHidesAndRestores(
    'settings',
    'window.__multiheizUi.openSettings()',
    'window.__multiheizUi.closeSettings()'
  );
  if (!okSettings) return;

  const okMem = await assertOverlayHidesAndRestores(
    'mem-popover',
    'window.__multiheizUi.openMemPopover()',
    'window.__multiheizUi.closeMemPopover()'
  );
  if (!okMem) return;

  console.log('PASS: ui selftest complete', { scale });
  app.exit(0);
}

/* ---------- Background / Liberar memória self-test (v1.3) ---------- */

function bgProbeHtml() {
  // Local test page: JS timer + rAF + WebAudio oscillator (no YouTube).
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>bg-probe</title></head><body>
<canvas id="c" width="40" height="40"></canvas>
<script>
window.__bg = {
  t0: performance.now(),
  ticks: 0,
  raf: 0,
  audioTime: 0,
  lastVis: document.visibilityState,
  samples: []
};
setInterval(function () { window.__bg.ticks++; }, 50);
(function loop() {
  window.__bg.raf++;
  requestAnimationFrame(loop);
})();
try {
  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = new AC();
  var osc = ctx.createOscillator();
  var gain = ctx.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  window.__bg._ctx = ctx;
  setInterval(function () {
    window.__bg.audioTime = ctx.currentTime;
  }, 100);
} catch (e) {
  window.__bg.audioErr = String(e);
}
document.addEventListener('visibilitychange', function () {
  window.__bg.lastVis = document.visibilityState;
});
</script></body></html>`;
}

function bgProbeDataUrl() {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(bgProbeHtml());
}

async function readBgProbe(accountId) {
  const wc = panels.getPanelCapture(accountId);
  if (!wc) return null;
  return wc.executeJavaScript(
    `({
      ticks: window.__bg && window.__bg.ticks,
      raf: window.__bg && window.__bg.raf,
      audioTime: window.__bg && window.__bg.audioTime,
      visibility: document.visibilityState,
      lastVis: window.__bg && window.__bg.lastVis,
      elapsedMs: window.__bg ? (performance.now() - window.__bg.t0) : 0
    })`,
    true
  );
}

async function runBgSelftest() {
  console.log('SELFTEST bg');

  updateState((s) => {
    s.accounts = [];
    s.workspaces = [
      { id: 'ws-1', name: 'Principal' },
      { id: 'ws-2', name: 'teste' },
    ];
    s.activeWorkspaceId = 'ws-1';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = {
      ...s.settings,
      openLastPage: false,
      suspendHidden: false,
      suspendDelayMs: 0,
      keepBackgroundRunning: false,
      memoryLimitMb: 0,
      panelMemoryLimitMb: 0,
      hardMemoryLimit: false,
      backgroundThrottling: false,
      backgroundFps: 5,
    };
  });

  const probeUrl = bgProbeDataUrl();
  updateState((s) => {
    s.accounts.push(
      {
        id: 'acc-bg-a',
        name: 'BG A',
        color: '#3d8bfd',
        startUrl: probeUrl,
        workspaceId: 'ws-1',
        muted: false,
        pauseInBackground: false,
        keepAliveInBackground: true,
        lastUrl: null,
      },
      {
        id: 'acc-bg-b',
        name: 'BG B',
        color: '#20c997',
        startUrl: probeUrl,
        workspaceId: 'ws-2',
        muted: false,
        pauseInBackground: false,
        keepAliveInBackground: true,
        lastUrl: null,
      }
    );
  });

  async function showWorkspace(wsId, accountId) {
    setState({ activeWorkspaceId: wsId, page: 0, maximizedAccountId: null });
    mainWindow.webContents.send('event', { type: 'state:changed', state: publicState() });
    await sleep(200);
    // Force DIP slots (renderer also syncs; this wins if race)
    const [bw, bh] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId, x: 0, y: 80, width: bw, height: bh - 80 },
    ]);
    await sleep(200);
    // Ask renderer to sync its DOM slots for the active workspace
    await mainWindow.webContents.executeJavaScript(
      'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()',
      true
    );
    await sleep(300);
  }

  mainWindow.webContents.send('event', { type: 'state:changed', state: publicState() });
  await sleep(400);

  // Show A (workspace 1)
  await showWorkspace('ws-1', 'acc-bg-a');
  await waitForUrl('acc-bg-a', (u) => u.startsWith('data:text/html'), 20000);
  await sleep(800);

  let probe0 = await readBgProbe('acc-bg-a');
  if (!probe0 || typeof probe0.ticks !== 'number') {
    console.log('FAIL: bg probe not ready on A', JSON.stringify(probe0));
    app.exit(1);
    return;
  }
  console.log('bg probe0', JSON.stringify(probe0));

  // Switch to workspace 2 (~5 s) - A must keep advancing while parked
  await showWorkspace('ws-2', 'acc-bg-b');
  await waitForUrl('acc-bg-b', (u) => u.startsWith('data:text/html'), 20000);

  // Confirm A is parked (not in visible set) before the 5s wait
  {
    const info = panels.getPanelDebugInfo();
    const a = info.panels.find((p) => p.accountId === 'acc-bg-a');
    const visibleIds = [...panels.getVisibleAccountIds()];
    if (visibleIds.includes('acc-bg-a') || !a || !a.parked) {
      console.log('FAIL: expected A parked offscreen after workspace switch', {
        visibleIds,
        a,
      });
      app.exit(1);
      return;
    }
    console.log('bg A parked before wait', JSON.stringify(a.bounds));
  }

  panels.forceNoThrottle('acc-bg-a');
  await sleep(50);
  panels.forceNoThrottle('acc-bg-a');
  await sleep(5200);

  const probeHidden = await readBgProbe('acc-bg-a');
  const infoHidden = panels.getPanelDebugInfo();
  const aHidden = infoHidden.panels.find((p) => p.accountId === 'acc-bg-a');
  console.log('bg probeHidden', JSON.stringify(probeHidden), 'parked=', aHidden && aHidden.parked);

  if (!probeHidden) {
    console.log('FAIL: panel A destroyed while hidden');
    app.exit(1);
    return;
  }

  const dtSec = Math.max(0.1, (probeHidden.elapsedMs - probe0.elapsedMs) / 1000);
  const tickRate = (probeHidden.ticks - probe0.ticks) / dtSec;
  const rafRate = (probeHidden.raf - probe0.raf) / dtSec;
  const audioDelta = (probeHidden.audioTime || 0) - (probe0.audioTime || 0);

  // Not throttled to ~1/s: expect timers ~20/s (50ms) and rAF well above 5/s
  const timersOk = tickRate >= 8;
  const rafOk = rafRate >= 10;
  const audioOk = audioDelta >= 3.5;
  if (timersOk && rafOk && audioOk) {
    console.log('PASS: hidden panel kept advancing', {
      tickRate: Math.round(tickRate * 10) / 10,
      rafRate: Math.round(rafRate * 10) / 10,
      audioDelta: Math.round(audioDelta * 100) / 100,
      visibility: probeHidden.visibility,
    });
  } else {
    console.log('FAIL: hidden panel throttled', {
      tickRate,
      rafRate,
      audioDelta,
      visibility: probeHidden.visibility,
      probe0,
      probeHidden,
    });
    app.exit(1);
    return;
  }

  // Switch back - A visible with correct bounds (match renderer slot, not hardcoded chrome)
  await showWorkspace('ws-1', 'acc-bg-a');
  await waitForLayoutSettle();
  const infoBack = panels.getPanelDebugInfo();
  const aBack = infoBack.panels.find((p) => p.accountId === 'acc-bg-a');
  const slotBack =
    (infoBack.lastSlots || []).find((s) => s.accountId === 'acc-bg-a') ||
    (await rendererEval(
      `(window.__multiheizUi.getSlotRects() || []).find(s => s.accountId === 'acc-bg-a')`
    ));
  if (
    aBack &&
    aBack.visible &&
    !aBack.parked &&
    slotBack &&
    boundsMatch(aBack.bounds, slotBack, 8)
  ) {
    console.log('PASS: panel A restored visible with correct bounds');
  } else {
    console.log('FAIL: panel A bounds/visibility after return', JSON.stringify(aBack), slotBack);
    app.exit(1);
    return;
  }

  // pauseInBackground ON - best effort throttling when hidden
  updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-bg-a');
    if (a) a.pauseInBackground = true;
  });
  await showWorkspace('ws-2', 'acc-bg-b');
  await sleep(1500);
  const pauseProbe1 = await readBgProbe('acc-bg-a');
  await sleep(3000);
  const pauseProbe2 = await readBgProbe('acc-bg-a');
  const pauseDt =
    Math.max(
      0.1,
      ((pauseProbe2 && pauseProbe2.elapsedMs) || 0) - ((pauseProbe1 && pauseProbe1.elapsedMs) || 0)
    ) / 1000;
  const pauseRafRate =
    (((pauseProbe2 && pauseProbe2.raf) || 0) - ((pauseProbe1 && pauseProbe1.raf) || 0)) / pauseDt;
  const aPauseInfo = panels.getPanelDebugInfo().panels.find((p) => p.accountId === 'acc-bg-a');
  // Best effort: not parked (setVisible false), visibility hidden, or rAF clearly slower
  if (
    (aPauseInfo && !aPauseInfo.parked && !aPauseInfo.visible) ||
    (pauseProbe2 && pauseProbe2.visibility === 'hidden') ||
    pauseRafRate < 20
  ) {
    console.log('PASS: pauseInBackground throttles/pauses when hidden (best effort)', {
      visibility: pauseProbe2 && pauseProbe2.visibility,
      pauseRafRate: Math.round(pauseRafRate * 10) / 10,
      parked: aPauseInfo && aPauseInfo.parked,
      visible: aPauseInfo && aPauseInfo.visible,
    });
  } else {
    console.log('FAIL: pauseInBackground did not throttle', {
      pauseRafRate,
      pauseProbe1,
      pauseProbe2,
      aPauseInfo,
    });
    app.exit(1);
    return;
  }

  // Reset pause flag; prepare Liberar memória with 1 visible + 1 hidden
  updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-bg-a');
    if (a) {
      a.pauseInBackground = false;
      a.keepAliveInBackground = true;
    }
    s.settings.keepBackgroundRunning = false;
    s.settings.suspendHidden = false;
  });
  // Ensure B exists then show A (B parked)
  await showWorkspace('ws-2', 'acc-bg-b');
  await waitForUrl('acc-bg-b', (u) => u.startsWith('data:text/html'), 20000);
  await showWorkspace('ws-1', 'acc-bg-a');
  await sleep(300);

  panels.enableViewMutationLog(true);
  panels.clearViewMutationLog();
  const beforeBounds = panels.snapshotVisiblePanelBounds();
  const freeRes = await memory.freeMemory();
  const afterBounds = panels.snapshotVisiblePanelBounds();
  const mutations = panels.getViewMutationLog();
  const visibleMutations = mutations.filter(
    (m) =>
      m.accountId === 'acc-bg-a' &&
      (m.action === 'hide' || m.action === 'destroy' || m.action === 'bounds')
  );

  const stillActiveB = panels.isPanelActive('acc-bg-b');
  const visibleOk =
    freeRes.visibleUnchanged &&
    panels.compareBoundsMaps(beforeBounds, afterBounds) &&
    visibleMutations.length === 0;

  if (visibleOk && !stillActiveB) {
    console.log('PASS: Liberar memória left visible panel untouched and suspended hidden', {
      beforeMb: freeRes.beforeMb,
      afterMb: freeRes.afterMb,
      freedMb: freeRes.freedMb,
    });
  } else {
    console.log('FAIL: Liberar memória affected visible or did not suspend hidden', {
      visibleOk,
      stillActiveB,
      freeRes,
      beforeBounds,
      afterBounds,
      visibleMutations,
    });
    app.exit(1);
    return;
  }

  if (typeof freeRes.freedMb === 'number' && freeRes.freedMb >= 0) {
    const expected = Math.max(0, freeRes.beforeMb - freeRes.afterMb);
    if (freeRes.freedMb === expected) {
      console.log('PASS: freed value = before-after (clamped at 0)', freeRes.freedMb);
    } else {
      console.log('FAIL: freed mismatch', { freeRes, expected });
      app.exit(1);
      return;
    }
  } else {
    console.log('FAIL: freedMb invalid', freeRes);
    app.exit(1);
    return;
  }

  // Metrics breakdown
  const metrics = memory.getLatestMetrics();
  const b = metrics.breakdown || {};
  const partsSum = (b.panelsMb || 0) + (b.interfaceMb || 0) + (b.gpuMb || 0) + (b.outrosMb || 0);
  const sumOk = Math.abs(partsSum - metrics.totalRamMb) <= 1;
  const panelSum = (metrics.panels || []).reduce((n, p) => n + (p.ramMb || 0), 0);
  const panelLeq = panelSum <= (b.panelsMb || 0) + 1;
  if (sumOk && panelLeq) {
    console.log('PASS: metrics breakdown sums to total', {
      totalRamMb: metrics.totalRamMb,
      breakdown: b,
      panelSum,
      metric: metrics.metric,
    });
  } else {
    console.log('FAIL: metrics breakdown', {
      totalRamMb: metrics.totalRamMb,
      partsSum,
      breakdown: b,
      panelSum,
    });
    app.exit(1);
    return;
  }

  console.log('PASS: bg selftest complete');
  app.exit(0);
}

/* ---------- Top bar overflow menu (v1.8 B5) ---------- */

/**
 * Native Menu.popup for top-bar "›" overflow.
 * @param {{ x?: number, y?: number }} opts
 */
function popupTopMenu(opts) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, reason: 'missing' };
  }
  const x = Math.round(Number(opts && opts.x) || 0);
  const y = Math.round(Number(opts && opts.y) || 0);
  const st = getState();

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: 'Recarregar todas',
      click: () => panels.panelReloadAll(st.activeWorkspaceId),
    },
    {
      label: 'Som',
      submenu: [
        {
          label: 'Silenciar todas',
          click: () => {
            panels.panelMuteAll(true, st.activeWorkspaceId);
            emitToRenderer({ type: 'state:changed', state: publicState() });
          },
        },
        {
          label: 'Ativar som',
          click: () => {
            panels.panelMuteAll(false, st.activeWorkspaceId);
            emitToRenderer({ type: 'state:changed', state: publicState() });
          },
        },
      ],
    },
    {
      label: 'Layout',
      submenu: ['1', '2', '4', '6', 'auto', 'livre'].map((layout) => ({
        label: layout === 'livre' ? 'Livre' : layout === 'auto' ? 'Auto' : layout,
        type: 'radio',
        checked: normalizeLayout(st.layout) === layout,
        click: () => {
          updateState((s) => {
            if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
              s.layoutByWorkspace = {};
            }
            s.layout = layout;
            s.layoutByWorkspace[s.activeWorkspaceId] = layout;
            s.page = 0;
            if (!s.pageByWorkspace) s.pageByWorkspace = {};
            s.pageByWorkspace[s.activeWorkspaceId] = 0;
            s.maximizedAccountId = null;
            if (!s.maximizedByWorkspace) s.maximizedByWorkspace = {};
            s.maximizedByWorkspace[s.activeWorkspaceId] = null;
          });
          emitToRenderer({ type: 'state:changed', state: publicState() });
        },
      })),
    },
    {
      label: 'Downloads',
      click: () => emitToRenderer({ type: 'ui:downloads' }),
    },
    {
      label: 'Tela cheia (F11)',
      click: () => {
        chromeFullscreen.toggle();
      },
    },
    {
      label: 'Ajuda',
      submenu: [
        {
          label: 'Novidades',
          click: () => emitToRenderer({ type: 'ui:novidades', reason: 'menu', auto: false }),
        },
        {
          label: 'Atalhos',
          click: () => emitToRenderer({ type: 'ui:help-shortcuts' }),
        },
      ],
    },
  ];

  const labels = [];
  for (const t of template) {
    labels.push(String(t.label || ''));
    if (Array.isArray(t.submenu)) {
      for (const sub of t.submenu) {
        labels.push(String(sub.label || ''));
      }
    }
  }
  lastTopMenuPopup = { x, y, labels, at: Date.now() };

  if (
    SELFTEST_INPUT ||
    SELFTEST_V18 ||
    SELFTEST_V19 ||
    SELFTEST_V110 ||
    envGet('MULTIHEIZ_MENU_INTERCEPT') === '1'
  ) {
    return { ok: true, intercepted: true, labels, x, y };
  }

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: mainWindow, x, y });
  return { ok: true, intercepted: false, labels, x, y };
}

/* ---------- Native account menu (v1.4.1) ---------- */

/**
 * Build + show (or intercept) the per-window --/ sidebar context menu.
 * Native Menu stays above WebContentsViews - no overlay/snapshot needed.
 * @param {{ accountId: string, x?: number, y?: number }} opts
 */
function popupAccountMenu(opts) {
  const accountId = opts && opts.accountId;
  const st = getState();
  const acc = (st.accounts || []).find((a) => a.id === accountId);
  if (!acc || !mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, reason: 'missing' };
  }

  const x = Math.round(Number(opts.x) || 0);
  const y = Math.round(Number(opts.y) || 0);
  const suspended = panels.isForceSuspended(accountId);
  const muted = !!acc.muted;
  const maximized = st.maximizedAccountId === accountId;

  const zoomPct = Math.round((panels.panelGetZoom(accountId) || 1) * 100);

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: 'Renomear',
      click: () => emitToRenderer({ type: 'ui:edit-account', accountId }),
    },
    {
      label: 'Cor',
      click: () => emitToRenderer({ type: 'ui:edit-account', accountId }),
    },
    {
      label: 'Editar URL inicial',
      click: () => emitToRenderer({ type: 'ui:edit-account', accountId, focusUrl: true }),
    },
    {
      label: `Zoom  ${zoomPct}%`,
      submenu: [
        {
          label: 'Aumentar (+)',
          click: () => panels.panelZoom(accountId, 0.1),
        },
        {
          label: 'Diminuir (−)',
          click: () => panels.panelZoom(accountId, -0.1),
        },
        {
          label: 'Redefinir (100%)',
          click: () => panels.panelZoom(accountId, 0),
        },
      ],
    },
    {
      label: 'Proxy…',
      click: () => emitToRenderer({ type: 'ui:open-proxy', accountId }),
    },
    {
      label: 'Recarregar',
      click: () => panels.panelReload(accountId),
    },
    {
      label: muted ? 'Ativar som' : 'Mudo',
      click: () => {
        panels.panelSetMuted(accountId, !muted);
        emitToRenderer({ type: 'state:changed', state: publicState() });
      },
    },
    {
      label: suspended ? 'Reativar' : 'Suspender',
      click: () => {
        if (suspended) {
          panels.reactivatePanel(accountId);
        } else {
          panels.suspendForMemory(accountId, { force: true });
        }
        emitToRenderer({ type: 'state:changed', state: publicState() });
        emitToRenderer({
          type: 'layout:recompute',
        });
      },
    },
    {
      type: 'checkbox',
      label: 'Manter ativa em segundo plano',
      checked: !!acc.keepAliveInBackground,
      click: (item) => {
        updateState((s) => {
          const a = s.accounts.find((x) => x.id === accountId);
          if (!a) return;
          a.keepAliveInBackground = !!item.checked;
          if (a.keepAliveInBackground) a.pauseInBackground = false;
        });
        panels.applyThrottling();
        emitToRenderer({ type: 'state:changed', state: publicState() });
      },
    },
    {
      type: 'checkbox',
      label: 'Pausar em segundo plano',
      checked: !!acc.pauseInBackground,
      click: (item) => {
        updateState((s) => {
          const a = s.accounts.find((x) => x.id === accountId);
          if (!a) return;
          a.pauseInBackground = !!item.checked;
          if (a.pauseInBackground) a.keepAliveInBackground = false;
        });
        panels.applyThrottling();
        emitToRenderer({ type: 'state:changed', state: publicState() });
      },
    },
    {
      type: 'checkbox',
      label: 'Modo privado (não salvar histórico)',
      checked: !!acc.privateHistory,
      click: (item) => {
        updateState((s) => {
          const a = s.accounts.find((x) => x.id === accountId);
          if (a) a.privateHistory = !!item.checked;
        });
        emitToRenderer({ type: 'state:changed', state: publicState() });
      },
    },
    {
      type: 'checkbox',
      label: 'Bloqueio de anúncios nesta janela',
      checked: acc.adblockEnabled !== false,
      click: (item) => {
        adblock.setWindowEnabled(accountId, !!item.checked);
        emitToRenderer({ type: 'state:changed', state: publicState() });
      },
    },
    {
      label: maximized ? 'Restaurar' : 'Maximizar',
      click: () => {
        updateState((s) => {
          s.maximizedAccountId = maximized ? null : accountId;
          if (!s.maximizedByWorkspace) s.maximizedByWorkspace = {};
          s.maximizedByWorkspace[s.activeWorkspaceId] = s.maximizedAccountId;
        });
        emitToRenderer({ type: 'state:changed', state: publicState() });
      },
    },
    {
      label: 'Início',
      click: () => panels.panelGoHome(accountId),
    },
    {
      label: 'Abrir login no navegador padrão',
      click: () => {
        const r = panels.openLoginInSystemBrowser(accountId);
        if (r && r.ok) {
          emitToRenderer({ type: 'toast', message: 'Abrindo no navegador padrão…' });
        }
      },
    },
    {
      label: 'Abrir DevTools',
      click: () => panels.panelOpenDevTools(accountId),
    },
    {
      label: 'Remover janela',
      click: () => emitToRenderer({ type: 'ui:confirm-remove-account', accountId }),
    },
  ];

  const labels = template.map((t) => String(t.label || ''));
  lastAccountMenuPopup = { accountId, x, y, labels, at: Date.now() };

  if (
    SELFTEST_INPUT ||
    SELFTEST_V18 ||
    SELFTEST_V19 ||
    SELFTEST_V110 ||
    envGet('MULTIHEIZ_MENU_INTERCEPT') === '1'
  ) {
    return { ok: true, intercepted: true, labels, x, y, accountId };
  }

  const menu = Menu.buildFromTemplate(template);
  emitToRenderer({ type: 'sidebar:native-menu', open: true });
  menu.once('menu-will-close', () => {
    emitToRenderer({ type: 'sidebar:native-menu', open: false });
  });
  menu.popup({ window: mainWindow, x, y });
  return { ok: true, intercepted: false, labels, x, y, accountId };
}

function popupAdblockMenu(payload) {
  const accountId = payload && payload.accountId;
  const x = Math.round(Number(payload && payload.x) || 0);
  const y = Math.round(Number(payload && payload.y) || 0);
  const pageUrl = (payload && payload.url) || '';
  const st = getState();
  const acc = st.accounts.find((a) => a.id === accountId);
  if (!acc || !mainWindow || mainWindow.isDestroyed()) return { ok: false };

  const site = adblock.siteKeyFromUrl(pageUrl) || '';
  const stats = adblock.getPageStats(accountId);
  const recent = adblock.getRecentBlocked(accountId);
  const focusDiag = adblock.getFocusedPanelDiagnostics(accountId, pageUrl);
  const earlyLabel = focusDiag.scriptletsInjected
    ? `Scriptlets cedo: sim (${focusDiag.scriptletCount}, ${
        focusDiag.earlySyncMs != null ? focusDiag.earlySyncMs.toFixed(1) + 'ms' : '?'
      })`
    : 'Scriptlets cedo: não / pendente';
  const cssLabel = focusDiag.earlyCss ? 'CSS cedo: sim' : 'CSS cedo: não / pendente';

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      type: 'checkbox',
      label: 'Bloqueio nesta janela',
      checked: acc.adblockEnabled !== false,
      click: (item) => {
        adblock.setWindowEnabled(accountId, !!item.checked);
        emitToRenderer({ type: 'state:changed', state: publicState() });
        emitToRenderer({ type: 'adblock:stats', accountId, ...adblock.getPageStats(accountId) });
      },
    },
    {
      label: site ? `Permitir anúncios em ${site}` : 'Permitir anúncios neste site',
      enabled: !!site,
      click: () => {
        if (site) adblock.addAllowlistDomain(site);
        emitToRenderer({ type: 'state:changed', state: publicState() });
      },
    },
    { type: 'separator' },
    {
      label: `Ver bloqueados (${stats.pageBlocked})`,
      submenu: recent.length
        ? recent.slice(0, 15).map((u) => ({
            label: u.length > 72 ? `${u.slice(0, 69)}…` : u,
            enabled: false,
          }))
        : [{ label: 'Nenhum nesta página', enabled: false }],
    },
    {
      label: 'Diagnóstico do painel',
      submenu: [
        { label: earlyLabel, enabled: false },
        { label: cssLabel, enabled: false },
        {
          label: `Regras host: ~${focusDiag.rulesApplied.cosmeticApprox} cos + ${focusDiag.rulesApplied.scriptlets} js`,
          enabled: false,
        },
        {
          label: `Motor: ${focusDiag.engineSource || '?'} · res ${focusDiag.resourcesLoaded}`,
          enabled: false,
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Relatar anúncio aqui',
      click: () => {
        const r = adblock.writeAdReport({ accountId, pageUrl });
        if (r && r.ok) {
          emitToRenderer({
            type: 'toast',
            message: `Relatório: ${r.path}`,
            action: { label: 'Abrir pasta', path: r.dir },
          });
        }
      },
    },
  ];

  if (
    SELFTEST_ADBLOCK ||
    SELFTEST_V18 ||
    SELFTEST_INPUT ||
    envGet('MULTIHEIZ_MENU_INTERCEPT') === '1'
  ) {
    return {
      ok: true,
      intercepted: true,
      labels: template.map((t) => String(t.label || t.type || '')),
      accountId,
    };
  }

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: mainWindow, x, y });
  return { ok: true, intercepted: false, accountId };
}

/* ---------- v1.4.1 input self-test ---------- */

function pointInBounds(px, py, b) {
  if (!b) return false;
  return px >= b.x && py >= b.y && px < b.x + b.width && py < b.y + b.height;
}

async function sendMouse(type, x, y, extras = {}) {
  mainWindow.webContents.sendInputEvent({
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: 1,
    ...extras,
  });
}

async function dragPath(fromX, fromY, toX, toY, steps = 12) {
  await sendMouse('mouseDown', fromX, fromY);
  await sleep(40);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = fromX + (toX - fromX) * t;
    const y = fromY + (toY - fromY) * t;
    await sendMouse('mouseMove', x, y);
    await sleep(16);
  }
  await sendMouse('mouseUp', toX, toY);
  await sleep(80);
}

async function runInputSelftest() {
  const fs = require('node:fs');
  const shotDir = path.join(__dirname, '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  console.log('SELFTEST input (v1.4.1)');

  const ids = ['acc-in-1', 'acc-in-2', 'acc-in-3', 'acc-in-4'];
  const about = 'data:text/html,' + encodeURIComponent('<html><body bgcolor="#222"><h1>p</h1></body></html>');

  updateState((s) => {
    s.accounts = [];
    s.workspaces = [{ id: 'ws-default', name: 'Principal' }];
    s.activeWorkspaceId = 'ws-default';
    s.layout = 'livre';
    s.page = 0;
    s.maximizedAccountId = null;
    // Leave free cells so drag/resize can land without overlap rejection
    s.freeTiles = {
      'ws-default': {
        'acc-in-1': { c: 0, r: 0, w: 3, h: 3 },
        'acc-in-2': { c: 5, r: 0, w: 3, h: 3 },
        'acc-in-3': { c: 0, r: 5, w: 3, h: 3 },
        'acc-in-4': { c: 5, r: 5, w: 3, h: 3 },
      },
    };
    s.ui = { sidebarCollapsed: false, layoutLocked: false };
    s.settings = {
      ...s.settings,
      openLastPage: false,
      suspendHidden: false,
      keepBackgroundRunning: true,
      backgroundThrottling: false,
    };
  });

  updateState((s) => {
    for (let i = 0; i < ids.length; i++) {
      s.accounts.push({
        id: ids[i],
        name: `Janela ${i + 1}`,
        color: ['#2bb8a6', '#e8a54b', '#6c8cff', '#e25c5c'][i],
        startUrl: about,
        workspaceId: 'ws-default',
        muted: false,
        pauseInBackground: false,
        lastUrl: null,
      });
    }
  });

  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();
  await waitForPanels(
    (i) => i.panels.filter((p) => p.visible && !p.parked).length >= 4
  );

  // Hit-test: handle coords must not sit under any WebContentsView
  const hit = await rendererEval('window.__multiheizUi.getHandleHitPoints()');
  if (!hit || !hit.points || !hit.points.length) {
    console.log('FAIL: no handle hit points', hit);
    app.exit(1);
    return;
  }
  const info0 = panels.getPanelDebugInfo();
  for (const pt of hit.points) {
    const covering = (info0.panels || []).filter(
      (p) => p.visible && !p.parked && pointInBounds(pt.x, pt.y, p.bounds)
    );
    if (covering.length) {
      console.log('FAIL: handle covered by WebContentsView', { pt, covering });
      app.exit(1);
      return;
    }
  }
  console.log('PASS: handle coords not covered by views');

  await compositeWindowShot(path.join(shotDir, 'v1.4.1-livre-edit.png'));
  console.log('PASS: screenshot v1.4.1-livre-edit.png');

  const tilesBefore = await rendererEval('window.__multiheizUi.getFreeTiles()');
  const header1 = await rendererEval(
    `window.__multiheizUi.getPanelChromeRect(${JSON.stringify(ids[0])}, 'header')`
  );
  if (!header1 || header1.width < 10) {
    console.log('FAIL: header rect missing', header1);
    app.exit(1);
    return;
  }

  // Non-button point in header (extra chrome buttons broke the old 35% hit-test)
  const dragPt = await rendererEval(
    `(function(){var id=${JSON.stringify(ids[0])};var h=document.querySelector('.panel-slot[data-account-id="'+id+'"] .panel-header');if(!h)return null;var r=h.getBoundingClientRect();for(var i=0;i<24;i++){var x=r.left+r.width*(0.12+i*0.03);var y=r.top+r.height*0.5;var el=document.elementFromPoint(Math.round(x),Math.round(y));if(el&&h.contains(el)&&!el.closest('button')&&!el.closest('input'))return{x:x,y:y};}return{x:r.left+10,y:r.top+r.height*0.5};})()`
  );
  if (!dragPt) {
    console.log('FAIL: no drag point in header', header1);
    app.exit(1);
    return;
  }

  const fromX = dragPt.x;
  const fromY = dragPt.y;
  const toX = fromX + 180;
  const toY = fromY + 90;
  await dragPath(fromX, fromY, toX, toY, 16);
  await sleep(200);
  await waitForLayoutSettle();

  const tilesAfterMove = await rendererEval('window.__multiheizUi.getFreeTiles()');
  const t1 = tilesAfterMove?.[ids[0]];
  const t1b = tilesBefore?.[ids[0]];
  if (!t1 || (t1.c === t1b.c && t1.r === t1b.r)) {
    console.log('FAIL: move via input did not change tile', { t1b, t1, header1, dragPt });
    app.exit(1);
    return;
  }
  console.log('PASS: move window 1 via sendInputEvent', { from: t1b, to: t1 });

  // Resize window 2 via SE corner grip
  const se2 = await rendererEval(
    `window.__multiheizUi.getPanelChromeRect(${JSON.stringify(ids[1])}, 'se')`
  );
  if (!se2) {
    console.log('FAIL: se handle missing', se2);
    app.exit(1);
    return;
  }
  const tilesBeforeResize = await rendererEval('window.__multiheizUi.getFreeTiles()');
  const rx0 = se2.x + se2.width * 0.5;
  const ry0 = se2.y + se2.height * 0.5;
  await dragPath(rx0, ry0, rx0 + 140, ry0 + 100, 14);
  await sleep(200);
  await waitForLayoutSettle();

  const tilesAfterResize = await rendererEval('window.__multiheizUi.getFreeTiles()');
  const t2 = tilesAfterResize?.[ids[1]];
  const t2b = tilesBeforeResize?.[ids[1]];
  if (!t2 || (t2.w === t2b.w && t2.h === t2b.h)) {
    console.log('FAIL: resize via input did not change tile', { t2b, t2, se2 });
    app.exit(1);
    return;
  }
  console.log('PASS: resize window 2 via corner grip', { from: t2b, to: t2 });

  // View bounds must match new tile content rects (with handle insets while unlocked)
  const slotRects = await rendererEval('window.__multiheizUi.getViewTargetRects()');
  const info1 = panels.getPanelDebugInfo();
  for (const p of info1.panels.filter((x) => x.visible && !x.parked)) {
    const slot = (slotRects || []).find((s) => s.accountId === p.accountId);
    if (!slot || !boundsMatch(p.bounds, slot, 8)) {
      console.log('FAIL: view bounds != target rect after drag', { p, slot });
      app.exit(1);
      return;
    }
  }
  console.log('PASS: view bounds match tile targets after drag/resize');

  // Locked: same input does nothing
  await rendererEval('window.__multiheizUi.setLayoutLocked(true)');
  await sleep(200);
  await waitForLayoutSettle();
  const lockedTiles = await rendererEval('window.__multiheizUi.getFreeTiles()');
  const h1locked = await rendererEval(
    `window.__multiheizUi.getPanelChromeRect(${JSON.stringify(ids[0])}, 'header')`
  );
  if (h1locked) {
    await dragPath(
      h1locked.x + 40,
      h1locked.y + 10,
      h1locked.x + 200,
      h1locked.y + 80,
      10
    );
    await sleep(150);
  }
  const afterLockDrag = await rendererEval('window.__multiheizUi.getFreeTiles()');
  if (JSON.stringify(afterLockDrag?.[ids[0]]) !== JSON.stringify(lockedTiles?.[ids[0]])) {
    console.log('FAIL: locked layout still moved', { lockedTiles, afterLockDrag });
    app.exit(1);
    return;
  }
  console.log('PASS: locked layout ignores drag input');

  // Unlock again for button / menu tests
  await rendererEval('window.__multiheizUi.setLayoutLocked(false)');
  await sleep(200);
  await waitForLayoutSettle();

  // Header button (reload) must not start a drag
  const tilesPreBtn = await rendererEval('window.__multiheizUi.getFreeTiles()');
  const reloadBtn = await rendererEval(
    `window.__multiheizUi.getPanelChromeRect(${JSON.stringify(ids[0])}, 'reload')`
  );
  if (!reloadBtn) {
    console.log('FAIL: reload button rect missing');
    app.exit(1);
    return;
  }
  const bx = reloadBtn.x + reloadBtn.width / 2;
  const by = reloadBtn.y + reloadBtn.height / 2;
  await sendMouse('mouseDown', bx, by);
  await sleep(30);
  await sendMouse('mouseMove', bx + 2, by + 2);
  await sleep(30);
  await sendMouse('mouseUp', bx + 2, by + 2);
  await sleep(150);
  const tilesPostBtn = await rendererEval('window.__multiheizUi.getFreeTiles()');
  if (JSON.stringify(tilesPostBtn?.[ids[0]]) !== JSON.stringify(tilesPreBtn?.[ids[0]])) {
    console.log('FAIL: reload click started a drag', { tilesPreBtn, tilesPostBtn });
    app.exit(1);
    return;
  }
  const overlayAfterBtn = panels.getOverlayCount();
  if (overlayAfterBtn !== 0) {
    console.log('FAIL: overlay stuck after reload click', overlayAfterBtn);
    app.exit(1);
    return;
  }
  console.log('PASS: header button click does not start drag');

  // native menu (click via DOM — WebContentsView can steal sendInputEvent at header edge)
  lastAccountMenuPopup = null;
  const menuBtn = await rendererEval(
    `window.__multiheizUi.getPanelChromeRect(${JSON.stringify(ids[0])}, 'menu')`
  );
  if (!menuBtn) {
    console.log('FAIL: menu button rect missing');
    app.exit(1);
    return;
  }
  const clicked = await rendererEval(
    `(function(){var b=document.querySelector('.panel-slot[data-account-id="${ids[0]}"] [data-role="panel-menu"]');if(!b)return false;b.click();return true;})()`
  );
  if (!clicked) {
    console.log('FAIL: menu button not clickable in DOM');
    app.exit(1);
    return;
  }
  await sleep(200);

  const expectedLabels = [
    'Renomear',
    'Cor',
    'Editar URL inicial',
    'Recarregar',
    'Mudo',
    'Suspender',
    'Manter ativa em segundo plano',
    'Pausar em segundo plano',
    'Maximizar',
    'Abrir DevTools',
    'Remover janela',
  ];
  if (!lastAccountMenuPopup || lastAccountMenuPopup.accountId !== ids[0]) {
    console.log('FAIL: Menu.popup was not recorded', lastAccountMenuPopup);
    app.exit(1);
    return;
  }
  for (const label of expectedLabels) {
    if (!lastAccountMenuPopup.labels.includes(label)) {
      console.log('FAIL: menu missing label', label, lastAccountMenuPopup.labels);
      app.exit(1);
      return;
    }
  }
  const overlayMenu = panels.getOverlayCount();
  if (overlayMenu !== 0) {
    console.log('FAIL: overlay not 0 after native menu', overlayMenu, panels.getPanelDebugInfo());
    app.exit(1);
    return;
  }
  console.log('PASS: native menu popup hook + overlay stays 0', {
    labels: lastAccountMenuPopup.labels.length,
  });

  // Esc / close path: native menu was intercepted (never opened), state already clean
  await rendererEval('window.__multiheizUi.closeMenus && window.__multiheizUi.closeMenus()');
  await sleep(100);
  if (panels.getOverlayCount() !== 0) {
    console.log('FAIL: overlay stuck after menu close');
    app.exit(1);
    return;
  }
  console.log('PASS: menu close leaves overlay count 0');

  console.log('PASS: input selftest complete');
  app.exit(0);
}

/* ---------- v1.4 self-test ---------- */

async function runV14Selftest() {
  const fs = require('node:fs');
  const shotDir = path.join(__dirname, '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  console.log('SELFTEST v14');

  const probeUrl = bgProbeDataUrl();

  updateState((s) => {
    s.accounts = [];
    s.workspaces = [{ id: 'ws-default', name: 'Principal' }];
    s.activeWorkspaceId = 'ws-default';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.freeTiles = {};
    s.ui = { sidebarCollapsed: false, layoutLocked: true };
    s.appearance = {
      preset: 'escuro',
      accent: '#2bb8a6',
      background: '#14181f',
      surface: '#1e2430',
      text: '#e6ebea',
      panelHeader: '#243040',
      sidebar: '#181c24',
    };
    s.settings = {
      ...s.settings,
      openLastPage: false,
      suspendHidden: false,
      keepBackgroundRunning: true,
      backgroundThrottling: false,
    };
  });

  updateState((s) => {
    s.accounts.push(
      {
        id: 'acc-v14-a',
        name: 'Janela A',
        color: '#2bb8a6',
        startUrl: probeUrl,
        workspaceId: 'ws-default',
        muted: false,
        pauseInBackground: false,
        lastUrl: null,
      },
      {
        id: 'acc-v14-b',
        name: 'Janela B',
        color: '#e8a54b',
        startUrl: 'https://httpbin.org/html',
        workspaceId: 'ws-default',
        muted: false,
        pauseInBackground: false,
        lastUrl: null,
      }
    );
  });

  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(800);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-v14-a' && p.visible && !p.parked));

  // Wait for probe page
  for (let i = 0; i < 40; i++) {
    const probe = await readBgProbe('acc-v14-a');
    if (probe && typeof probe.ticks === 'number') break;
    await sleep(200);
  }

  await compositeWindowShot(path.join(shotDir, 'v1.4-main-dark.png'));
  console.log('PASS: screenshot v1.4-main-dark.png');

  // --- Overlay snapshots ---
  const beforeOpen = await readBgProbe('acc-v14-a');
  await rendererEval('window.__multiheizUi.openAccountDialog()');
  await sleep(500);
  let info = panels.getPanelDebugInfo();
  if (info.overlayCount < 1) {
    console.log('FAIL: modal did not raise overlay', JSON.stringify(info));
    app.exit(1);
    return;
  }
  const snaps = await rendererEval('window.__multiheizUi.getOverlaySnapshots()');
  const snapA = snaps && snaps['acc-v14-a'];
  const snapB = snaps && snaps['acc-v14-b'];
  // At least one visible slot should have a non-empty snapshot (or empty fallback key present)
  const hasSnapKeys = snaps && (Object.prototype.hasOwnProperty.call(snaps, 'acc-v14-a') ||
    Object.prototype.hasOwnProperty.call(snaps, 'acc-v14-b'));
  if (!hasSnapKeys) {
    console.log('FAIL: no overlay snapshot keys', snaps);
    app.exit(1);
    return;
  }
  // Prefer non-empty image; allow color fallback if capture timed out
  const anyNonEmpty = !!(snapA || snapB);
  if (!anyNonEmpty) {
    console.log('WARN: snapshots empty (capture timeout) - fallback color path');
  } else {
    console.log('PASS: overlay snapshots set', {
      aLen: (snapA || '').length,
      bLen: (snapB || '').length,
    });
  }

  const parked = info.panels.filter((p) => p.parked || (p.bounds && p.bounds.x <= -1000));
  if (parked.length < 1) {
    console.log('FAIL: expected parked views during modal', JSON.stringify(info.panels));
    app.exit(1);
    return;
  }
  console.log('PASS: views parked during modal', parked.length);

  await sleep(2000);
  const during = await readBgProbe('acc-v14-a');
  if (!during || !beforeOpen) {
    console.log('FAIL: could not read bg probe during modal');
    app.exit(1);
    return;
  }
  const tickDelta = (during.ticks || 0) - (beforeOpen.ticks || 0);
  const rafDelta = (during.raf || 0) - (beforeOpen.raf || 0);
  if (tickDelta < 20 || rafDelta < 60) {
    console.log('FAIL: media/timers stalled during modal', { tickDelta, rafDelta, during, beforeOpen });
    app.exit(1);
    return;
  }
  console.log('PASS: background media advanced during modal', { tickDelta, rafDelta });

  await compositeWindowShot(path.join(shotDir, 'v1.4-modal-snapshots.png'));
  console.log('PASS: screenshot v1.4-modal-snapshots.png');

  const boundsBefore = info.lastSlots.find((s) => s.accountId === 'acc-v14-a');
  await rendererEval('window.__multiheizUi.closeAccountDialog()');
  await sleep(450);
  info = await waitForPanels(
    (i) =>
      i.overlayCount === 0 &&
      i.panels.some((p) => p.accountId === 'acc-v14-a' && p.visible && !p.parked)
  );
  const restored = info.panels.find((p) => p.accountId === 'acc-v14-a');
  if (!restored || !boundsBefore || !boundsMatch(restored.bounds, boundsBefore, 8)) {
    console.log('FAIL: restore bounds after modal', {
      before: boundsBefore,
      after: restored && restored.bounds,
    });
    app.exit(1);
    return;
  }
  const snapsAfter = await rendererEval('window.__multiheizUi.getOverlaySnapshots()');
  const stillHas = snapsAfter && (snapsAfter['acc-v14-a'] || snapsAfter['acc-v14-b']);
  if (stillHas) {
    console.log('FAIL: snapshots not cleared after close', snapsAfter);
    app.exit(1);
    return;
  }
  console.log('PASS: views restored and snapshots cleared');

  // --- UI strings ---
  const strings = await rendererEval('window.__multiheizUi.getUiStrings()');
  if (!strings || !String(strings.addButton || '').includes('Nova janela')) {
    console.log('FAIL: + Nova janela button missing', strings);
    app.exit(1);
    return;
  }
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const badConta =
    /\+ Conta|Nova conta|Editar conta|Nenhuma conta nesta|Remover a conta/.test(appSrc + htmlSrc);
  if (badConta) {
    console.log('FAIL: residual Conta UI strings in renderer');
    app.exit(1);
    return;
  }
  console.log('PASS: janela wording');

  // --- Theme ---
  const themeClaro = await rendererEval('window.__multiheizUi.applyThemePreset("claro")');
  await sleep(200);
  if (!themeClaro || themeClaro.theme !== 'claro') {
    console.log('FAIL: claro theme not applied', themeClaro);
    app.exit(1);
    return;
  }
  await compositeWindowShot(path.join(shotDir, 'v1.4-theme-light.png'));
  console.log('PASS: screenshot v1.4-theme-light.png');

  const accent = await rendererEval('window.__multiheizUi.applyCustomAccent("#ff5500")');
  await sleep(100);
  const accentNorm = String(accent || '').toLowerCase().replace(/\s/g, '');
  if (!accentNorm.includes('ff5500') && accentNorm !== '#f50' && !accentNorm.includes('255, 85, 0')) {
    // getComputedStyle may return rgb()
    const okRgb = /rgb\(\s*255\s*,\s*85\s*,\s*0\s*\)/.test(accentNorm);
    if (!okRgb) {
      console.log('FAIL: custom accent not applied', accent);
      app.exit(1);
      return;
    }
  }
  const stTheme = getState();
  if (stTheme.appearance?.accent?.toLowerCase() !== '#ff5500') {
    console.log('FAIL: accent not persisted in state', stTheme.appearance);
    app.exit(1);
    return;
  }
  flushSave();
  console.log('PASS: theme claro + custom accent', { themeClaro, accent });

  // Restore dark for livre shots
  await rendererEval('window.__multiheizUi.applyThemePreset("escuro")');

  // --- Livre layout ---
  const tiles = {
    'acc-v14-a': { c: 0, r: 0, w: 6, h: 4 },
    'acc-v14-b': { c: 6, r: 0, w: 6, h: 4 },
  };
  const setRes = await rendererEval(
    `window.__multiheizUi.setLivreTiles(${JSON.stringify(tiles)})`
  );
  if (!setRes || !setRes.ok) {
    console.log('FAIL: setLivreTiles', setRes);
    app.exit(1);
    return;
  }
  await sleep(400);
  await waitForLayoutSettle();
  info = await waitForPanels(
    (i) =>
      i.lastSlots.length >= 2 &&
      i.panels.filter((p) => p.visible && !p.parked).length >= 2
  );
  const slotRects = await rendererEval('window.__multiheizUi.getSlotRects()');
  for (const p of info.panels.filter((x) => x.visible && !x.parked)) {
    const slot = (slotRects || []).find((s) => s.accountId === p.accountId);
    if (!slot || !boundsMatch(p.bounds, slot, 8)) {
      console.log('FAIL: livre view bounds != tile rect', { p, slot });
      app.exit(1);
      return;
    }
  }
  console.log('PASS: livre tile bounds match views');

  const overlap = await rendererEval(
    `window.__multiheizUi.proposeTiles(${JSON.stringify({
      'acc-v14-a': { c: 0, r: 0, w: 8, h: 4 },
      'acc-v14-b': { c: 4, r: 0, w: 6, h: 4 },
    })})`
  );
  if (!overlap || overlap.ok !== false) {
    console.log('FAIL: overlapping placement should be rejected', overlap);
    app.exit(1);
    return;
  }
  console.log('PASS: overlapping tiles rejected');

  await rendererEval('window.__multiheizUi.setLayoutLocked(false)');
  await sleep(200);
  await compositeWindowShot(path.join(shotDir, 'v1.4-livre-editing.png'));
  console.log('PASS: screenshot v1.4-livre-editing.png');

  await rendererEval('window.__multiheizUi.setLayoutLocked(true)');
  flushSave();
  await sleep(300);

  const st = getState();
  if (st.layout !== 'livre') {
    console.log('FAIL: layout not livre after save', st.layout);
    app.exit(1);
    return;
  }
  if (st.ui?.layoutLocked !== true) {
    console.log('FAIL: layoutLocked not true', st.ui);
    app.exit(1);
    return;
  }
  const savedTiles = st.freeTiles?.['ws-default'];
  if (
    !savedTiles?.['acc-v14-a'] ||
    savedTiles['acc-v14-a'].c !== 0 ||
    savedTiles['acc-v14-a'].w !== 6 ||
    !savedTiles?.['acc-v14-b'] ||
    savedTiles['acc-v14-b'].c !== 6
  ) {
    console.log('FAIL: free tiles not persisted', savedTiles);
    app.exit(1);
    return;
  }
  console.log('PASS: livre tiles + lock persisted');

  // Simulate relaunch restore: re-emit state and verify tiles still applied
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();
  const tilesAgain = await rendererEval('window.__multiheizUi.getFreeTiles()');
  if (!tilesAgain?.['acc-v14-a'] || tilesAgain['acc-v14-a'].w !== 6) {
    console.log('FAIL: tiles not restored after state reload', tilesAgain);
    app.exit(1);
    return;
  }
  console.log('PASS: tiles restored after state:changed');

  console.log('PASS: v14 selftest complete');
  app.exit(0);
}


app.whenReady().then(async () => {
  loadState();
  try {
    require('./extensions/dnr-shim').ensureExtresProtocol();
  } catch (err) {
    console.warn('[main] dnr extres protocol', err && err.message ? err.message : err);
  }
  // IPC frame guard must wrap ipcMain before any handle/on registration
  ipcGuard.install({
    getMainWindow: () => mainWindow,
    isPanelWebContents: (wc) => panels.isPanelWebContents(wc),
  });
  permissions.initPermissions({
    getMainWindow: () => mainWindow,
    emit: emitToRenderer,
    resolveAccountIdFromWebContents: (wc) => panels.accountIdForWebContents(wc),
  });
  userAgent.applyAppUserAgentFallback();
  sessionPersist.startPeriodicFlush(() => panels.getAccountSessions());
  proxy.initProxy({
    emit: emitToRenderer,
    getState,
    updateState,
    reloadPanel: (id) => panels.panelReload(id),
  });
  proxy.installLoginHandler(app);
  try {
    await proxy.applyAllAccountProxies();
  } catch (err) {
    console.warn('[proxy] applyAll', err && err.message ? err.message : err);
  }
  try {
    doh.applyDohSettings(getState().settings && getState().settings.doh);
  } catch (err) {
    console.warn('[doh] apply', err && err.message ? err.message : err);
  }
  v16 = initV16({
    getMainWindow: () => mainWindow,
    emitToRenderer,
    publicState,
    panels,
  });
  setupApplicationMenu();
  registerIpc();
  v16.register();
  try {
    updater.initUpdater({
      getState,
      updateState,
      emitToRenderer,
      skipAutoCheck: ANY_SELFTEST,
    });
  } catch (err) {
    console.warn('[updater] init error', err && err.message ? err.message : err);
  }
  // Wait for engine so first panel sessions get hub + preload (v1.7.1)
  adblock
    .init({ emit: emitToRenderer })
    .catch((err) => {
      console.warn('[adblock] init error', err && err.message ? err.message : err);
    })
    .finally(() => {
      try {
        extensions.init({
          emit: emitToRenderer,
          getAccountIds: () => (getState().accounts || []).map((a) => a.id),
          getMainWindow: () => mainWindow,
          openUrlInNewWindow: (url) => {
            const raw = String(url || '').trim();
            const { sanitizeUserStartUrl, isNavigableUrl } = require('./url-policy');
            if (!isNavigableUrl(raw)) return { ok: false, reason: 'blocked-scheme' };
            const st = getState();
            const id =
              'acc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
            const colors = ['#2bb8a6', '#3d8bfd', '#e8a54b', '#e83e8c', '#6f42c1', '#20c997'];
            const account = {
              id,
              name: whichLabelForStoreUrl(raw),
              color: colors[st.accounts.length % colors.length],
              startUrl: sanitizeUserStartUrl(raw, 'https://www.google.com'),
              workspaceId: st.activeWorkspaceId,
              muted: false,
              pauseInBackground: false,
              keepAliveInBackground: false,
              privateHistory: false,
              lastUrl: null,
            };
            updateState((s) => {
              s.accounts.push(account);
            });
            emitToRenderer({ type: 'state:changed', state: publicState() });
            panels.panelNavigate(id, raw);
            return { ok: true, windowId: id, state: publicState() };
          },
        });
      } catch (err) {
        console.warn('[extensions] init error', err && err.message ? err.message : err);
      }
      createWindow();
    });

  try {
    screen.on('display-metrics-changed', notifyDisplayOrChromeChange);
    screen.on('display-removed', () => {
      ensureWindowOnDisplay(mainWindow, () => screen.getAllDisplays());
      notifyDisplayOrChromeChange();
    });
  } catch {
    /* ignore */
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  flushSave();
  if (v16) v16.flushAll();
  try {
    logger.flushQueue();
  } catch {
    /* ignore */
  }
  try {
    sessionPersist.stopPeriodicFlush();
    sessionPersist.flushAllSessions(panels.getAccountSessions()).catch(() => {});
  } catch {
    /* ignore */
  }
  memory.stopMemory();
  try {
    adblock.shutdown();
  } catch {
    /* ignore */
  }
  try {
    extensions.shutdown();
  } catch {
    /* ignore */
  }
  panels.destroyAllPanels();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
