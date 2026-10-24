'use strict';

/**
 * Focused-panel browser shortcuts (before-input-event) + find-in-page bar.
 * Print is mocked under MULTIHEIZ_SELFTEST (never opens a real printer dialog).
 */

const path = require('node:path');
const { BrowserWindow, dialog, ipcMain } = require('electron');
const keymap = require('./keymap');
const { getState } = require('./state');
const { isViewSourceOfHttpUrl } = require('./url-policy');

/** @type {(() => import('electron').BrowserWindow | null) | null} */
let getMainWindow = null;
/** @type {((payload: object) => void) | null} */
let emitToRenderer = null;
/** @type {object | null} */
let panelsApi = null;
/** @type {object | null} */
let chromeFullscreenApi = null;
/** @type {(() => void) | null} */
let rebuildMenu = null;

/** @type {Map<string, { query: string, open: boolean }>} */
const findStateByAccount = new Map();

/** Detached view-source windows (same session as the source panel). */
/** @type {Set<import('electron').BrowserWindow>} */
const viewSourceWindows = new Set();

/** Selftest: mocked print invocations */
/** @type {Array<{ accountId: string, at: number }>} */
let printMockLog = [];
/** @type {Array<{ action: string, accountId: string, detail?: object, at: number }>} */
let actionLog = [];

function selftestOn() {
  return !!process.env.MULTIHEIZ_SELFTEST;
}

function clearSelftestLogs() {
  printMockLog = [];
  actionLog = [];
}

function getPrintMockLog() {
  return printMockLog.slice();
}

function getActionLog() {
  return actionLog.slice();
}

function noteAction(action, accountId, detail) {
  if (!selftestOn()) return;
  actionLog.push({ action, accountId, detail: detail || undefined, at: Date.now() });
}

/**
 * @param {{
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   emitToRenderer: (payload: object) => void,
 *   panels: object,
 *   chromeFullscreen: object,
 *   rebuildApplicationMenu?: () => void,
 *   handleAppMenuKeys?: (event: Electron.Event, input: Electron.Input, accountId: string|null) => boolean,
 * }} deps
 */
function configure(deps) {
  getMainWindow = deps.getMainWindow;
  emitToRenderer = deps.emitToRenderer;
  panelsApi = deps.panels;
  chromeFullscreenApi = deps.chromeFullscreen;
  rebuildMenu = typeof deps.rebuildApplicationMenu === 'function' ? deps.rebuildApplicationMenu : null;
  handleAppMenuKeys =
    typeof deps.handleAppMenuKeys === 'function' ? deps.handleAppMenuKeys : null;
}

/** @type {((event: Electron.Event, input: Electron.Input, accountId: string|null) => boolean)|null} */
let handleAppMenuKeys = null;

function keyboardSettings() {
  try {
    const s = getState();
    return (s && s.settings && s.settings.keyboardShortcuts) || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} accountId
 * @returns {import('electron').WebContents | null}
 */
function wcFor(accountId) {
  if (!panelsApi || typeof panelsApi.getPanelCapture !== 'function') return null;
  try {
    const wc = panelsApi.getPanelCapture(accountId);
    if (wc && !wc.isDestroyed()) return wc;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {string} accountId
 */
function panelPrint(accountId) {
  const wc = wcFor(accountId);
  if (!wc) return;
  noteAction('print', accountId);
  if (selftestOn()) {
    printMockLog.push({ accountId, at: Date.now() });
    return;
  }
  try {
    wc.print({ silent: false, printBackground: true });
  } catch (err) {
    console.warn('[print]', err && err.message ? err.message : err);
  }
}

/**
 * @param {string} accountId
 */
async function panelSavePage(accountId) {
  const wc = wcFor(accountId);
  if (!wc) return;
  noteAction('savePage', accountId);
  if (selftestOn()) {
    return;
  }
  const win = getMainWindow && getMainWindow();
  let dest = '';
  try {
    const r = await dialog.showSaveDialog(win || undefined, {
      title: 'Salvar página',
      defaultPath: 'pagina.html',
      filters: [
        { name: 'Página completa', extensions: ['html', 'htm'] },
        { name: 'Somente HTML', extensions: ['html', 'htm'] },
        { name: 'Arquivo MHTML', extensions: ['mhtml'] },
      ],
    });
    if (r.canceled || !r.filePath) return;
    dest = r.filePath;
  } catch {
    return;
  }
  const lower = dest.toLowerCase();
  /** @type {'HTMLComplete'|'HTMLOnly'|'MHTML'} */
  let saveType = 'HTMLComplete';
  if (lower.endsWith('.mhtml')) saveType = 'MHTML';
  try {
    await wc.savePage(dest, saveType);
  } catch (err) {
    console.warn('[savePage]', err && err.message ? err.message : err);
  }
}

/**
 * Open page source in a detached BrowserWindow (panel URL unchanged).
 * Same session/partition as the panel; only http(s) → view-source:http(s).
 * @param {string} accountId
 */
function panelViewSource(accountId) {
  const wc = wcFor(accountId);
  if (!wc) return;
  let url = '';
  try {
    url = wc.getURL() || '';
  } catch {
    url = '';
  }
  if (!url || url === 'about:blank') return;
  if (/^view-source:/i.test(url)) return;
  // Only http(s) pages have a useful view-source.
  if (!/^https?:\/\//i.test(url)) return;
  const src = 'view-source:' + url;
  noteAction('viewSource', accountId, { url: src });

  let ses = null;
  try {
    ses = wc.session;
  } catch {
    ses = null;
  }

  const hide = selftestOn();
  /** @type {import('electron').BrowserWindowConstructorOptions} */
  const opts = {
    width: 960,
    height: 720,
    show: !hide,
    autoHideMenuBar: true,
    title: 'Código-fonte',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(ses ? { session: ses } : {}),
    },
  };
  if (hide) {
    opts.x = -20000;
    opts.y = 0;
    opts.skipTaskbar = true;
  }

  let win;
  try {
    win = new BrowserWindow(opts);
  } catch {
    return;
  }
  viewSourceWindows.add(win);
  win.on('closed', () => {
    viewSourceWindows.delete(win);
  });

  const childWc = win.webContents;
  childWc.on('will-navigate', (e, navUrl) => {
    if (!isViewSourceOfHttpUrl(navUrl)) e.preventDefault();
  });
  childWc.on('will-redirect', (e, navUrl) => {
    if (!isViewSourceOfHttpUrl(navUrl)) e.preventDefault();
  });
  childWc.setWindowOpenHandler(() => ({ action: 'deny' }));

  try {
    childWc.loadURL(src).catch(() => {});
  } catch {
    /* ignore */
  }
}

/**
 * Live detached view-source windows (selftest / diagnostics).
 * @returns {import('electron').BrowserWindow[]}
 */
function getViewSourceWindows() {
  const out = [];
  for (const w of viewSourceWindows) {
    if (w && !w.isDestroyed()) out.push(w);
  }
  return out;
}

/**
 * @param {string} accountId
 * @param {boolean} [forward]
 */
function findNext(accountId, forward = true) {
  const st = findStateByAccount.get(accountId);
  const wc = wcFor(accountId);
  if (!wc || !st || !st.open || !st.query) return;
  try {
    // Follow-up: findNext false per Electron docs (continue session).
    wc.findInPage(st.query, { forward: !!forward, findNext: false, matchCase: false });
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} accountId
 */
function closeFindBar(accountId) {
  const wc = wcFor(accountId);
  findStateByAccount.delete(accountId);
  if (wc) {
    try {
      wc.stopFindInPage('clearSelection');
    } catch {
      /* ignore */
    }
    try {
      wc.send('mh-find-bar', { type: 'close' });
    } catch {
      /* ignore */
    }
  }
  noteAction('findClose', accountId);
}

/**
 * @param {string} accountId
 * @param {string} [initialQuery]
 */
function openFindBar(accountId, initialQuery) {
  const wc = wcFor(accountId);
  if (!wc) return;
  const prev = findStateByAccount.get(accountId);
  const query = initialQuery != null ? String(initialQuery) : (prev && prev.query) || '';
  findStateByAccount.set(accountId, { query, open: true });
  try {
    wc.send('mh-find-bar', { type: 'open', query });
  } catch {
    /* ignore */
  }
  if (query) {
    try {
      // Initial session must use findNext:true (Electron); false often never emits found-in-page.
      wc.findInPage(query, { forward: true, findNext: true, matchCase: false });
    } catch {
      /* ignore */
    }
  }
  noteAction('findOpen', accountId, { query });
}

/**
 * @param {string} accountId
 * @param {string} query
 */
function findQuery(accountId, query) {
  const wc = wcFor(accountId);
  if (!wc) return;
  const q = String(query || '');
  const prev = findStateByAccount.get(accountId);
  findStateByAccount.set(accountId, { query: q, open: true });
  if (!q) {
    try {
      wc.stopFindInPage('clearSelection');
    } catch {
      /* ignore */
    }
    try {
      wc.send('mh-find-bar', { type: 'result', active: 0, matches: 0 });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    // New query: tear down prior session then start with findNext:true
    // (findNext:false as "new session" is buggy on several Electron versions).
    if (!prev || prev.query !== q) {
      try {
        wc.stopFindInPage('clearSelection');
      } catch {
        /* ignore */
      }
    }
    wc.findInPage(q, { forward: true, findNext: true, matchCase: false });
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('electron').WebContents} wc
 * @param {string} accountId
 */
function wireFindInPage(wc, accountId) {
  if (!wc || typeof wc.on !== 'function') return;
  wc.on('found-in-page', (_e, result) => {
    const st = findStateByAccount.get(accountId);
    if (!st || !st.open) return;
    try {
      wc.send('mh-find-bar', {
        type: 'result',
        active: (result && result.activeMatchOrdinal) || 0,
        matches: (result && result.matches) || 0,
      });
    } catch {
      /* ignore */
    }
    noteAction('findResult', accountId, {
      active: (result && result.activeMatchOrdinal) || 0,
      matches: (result && result.matches) || 0,
    });
  });
}

let ipcWired = false;

function ensureIpc() {
  if (ipcWired) return;
  ipcWired = true;

  ipcMain.on('mh-find-bar:from-panel', (event, msg) => {
    const wc = event.sender;
    if (!wc || wc.isDestroyed()) return;
    let accountId = null;
    if (panelsApi && typeof panelsApi.accountIdForWebContents === 'function') {
      accountId = panelsApi.accountIdForWebContents(wc);
    }
    if (!accountId && panelsApi && typeof panelsApi.getFocusedAccountId === 'function') {
      accountId = panelsApi.getFocusedAccountId();
    }
    if (!accountId) return;
    const type = msg && msg.type;
    if (type === 'query') findQuery(accountId, msg.query || '');
    else if (type === 'next') findNext(accountId, true);
    else if (type === 'prev') findNext(accountId, false);
    else if (type === 'close') closeFindBar(accountId);
  });
}

/**
 * @param {string} accountId
 * @param {string} actionId
 * @returns {boolean} handled
 */
function runAction(accountId, actionId) {
  if (!panelsApi) return false;
  switch (actionId) {
    case 'print':
      panelPrint(accountId);
      return true;
    case 'find':
      openFindBar(accountId);
      return true;
    case 'findNext':
      if (findStateByAccount.get(accountId)?.open) findNext(accountId, true);
      else openFindBar(accountId);
      return true;
    case 'findPrev':
      if (findStateByAccount.get(accountId)?.open) findNext(accountId, false);
      else openFindBar(accountId);
      return true;
    case 'savePage':
      void panelSavePage(accountId);
      return true;
    case 'viewSource':
      panelViewSource(accountId);
      return true;
    case 'reload':
    case 'reloadF5':
      panelsApi.panelReload(accountId);
      noteAction('reload', accountId);
      return true;
    case 'hardReload':
    case 'hardReloadCtrlF5':
      panelsApi.panelHardReload(accountId);
      noteAction('hardReload', accountId);
      return true;
    case 'back':
      panelsApi.panelBack(accountId);
      noteAction('back', accountId);
      return true;
    case 'forward':
      panelsApi.panelForward(accountId);
      noteAction('forward', accountId);
      return true;
    case 'home':
      if (typeof panelsApi.panelGoHome === 'function') panelsApi.panelGoHome(accountId);
      noteAction('home', accountId);
      return true;
    case 'focusUrl':
      if (emitToRenderer) emitToRenderer({ type: 'focus:url' });
      noteAction('focusUrl', accountId);
      return true;
    case 'zoomIn':
      panelsApi.panelZoom(accountId, 0.1);
      noteAction('zoomIn', accountId);
      return true;
    case 'zoomOut':
      panelsApi.panelZoom(accountId, -0.1);
      noteAction('zoomOut', accountId);
      return true;
    case 'zoomReset':
      panelsApi.panelZoom(accountId, 0);
      noteAction('zoomReset', accountId);
      return true;
    case 'fullscreen':
      if (chromeFullscreenApi && typeof chromeFullscreenApi.toggle === 'function') {
        chromeFullscreenApi.toggle();
      }
      noteAction('fullscreen', accountId);
      return true;
    case 'devtools':
    case 'devtoolsPanel':
      panelsApi.panelOpenDevTools(accountId);
      noteAction('devtools', accountId);
      return true;
    case 'aiWrite':
      try {
        const aiWrite = require('./ai-write');
        const cfg = aiWrite.currentConfig();
        if (cfg.enabled) void aiWrite.openFromFocused({});
      } catch {
        /* ignore */
      }
      return true;
    case 'pictureInPicture':
      try {
        const pip = require('./picture-in-picture');
        void pip.togglePip(accountId);
        noteAction('pictureInPicture', accountId);
      } catch {
        /* ignore */
      }
      return true;
    case 'miniPlayerLock':
      try {
        const mini = require('./mini-player');
        if (mini.isOpen()) mini.toggleLock();
        noteAction('miniPlayerLock', accountId);
      } catch {
        /* ignore */
      }
      return true;
    case 'newWindow':
      if (emitToRenderer) emitToRenderer({ type: 'ui:new-account' });
      return true;
    case 'favorite':
      if (emitToRenderer) emitToRenderer({ type: 'ui:favorite' });
      return true;
    case 'history':
      if (emitToRenderer) emitToRenderer({ type: 'ui:history' });
      return true;
    case 'downloads':
      if (emitToRenderer) emitToRenderer({ type: 'ui:downloads' });
      return true;
    default:
      return false;
  }
}

/**
 * Esc: close find → exit chrome FS → stop loading. Else leave to page.
 * @param {Electron.Event} event
 * @param {string} accountId
 * @returns {boolean}
 */
function handleEscape(event, accountId) {
  const find = findStateByAccount.get(accountId);
  if (find && find.open) {
    event.preventDefault();
    closeFindBar(accountId);
    return true;
  }
  if (chromeFullscreenApi && typeof chromeFullscreenApi.handleBeforeInput === 'function') {
    // Let chrome-fullscreen own Esc when in focus mode (it preventDefaults itself).
    const fake = { type: 'keyDown', key: 'Escape', control: false, alt: false, meta: false, shift: false };
    // Actually call the real handler with the real event for FS exit.
  }
  if (
    chromeFullscreenApi &&
    typeof chromeFullscreenApi.isChromeHidden === 'function' &&
    chromeFullscreenApi.isChromeHidden()
  ) {
    const inHtml =
      chromeFullscreenApi.isAnyHtmlFullscreen && chromeFullscreenApi.isAnyHtmlFullscreen();
    if (!inHtml) {
      event.preventDefault();
      if (typeof chromeFullscreenApi.exit === 'function') chromeFullscreenApi.exit();
      else if (typeof chromeFullscreenApi.toggle === 'function') chromeFullscreenApi.toggle();
      noteAction('exitFullscreen', accountId);
      return true;
    }
    return false;
  }
  const wc = wcFor(accountId);
  if (wc) {
    let loading = false;
    try {
      loading = !!wc.isLoading();
    } catch {
      loading = false;
    }
    if (loading) {
      event.preventDefault();
      try {
        wc.stop();
      } catch {
        /* ignore */
      }
      noteAction('stop', accountId);
      return true;
    }
  }
  return false;
}

/**
 * @param {Electron.Event} event
 * @param {Electron.Input} input
 * @param {string} accountId
 * @returns {boolean}
 */
function handleBeforeInput(event, input, accountId) {
  ensureIpc();
  if (!input) return false;

  if (handleAppMenuKeys && handleAppMenuKeys(event, input, accountId)) {
    return true;
  }

  if (input.type !== 'keyDown') return false;

  // Escape is special (find / FS / stop)
  const keyName = keymap.inputKeyName(input);
  if (
    keyName === 'Escape' &&
    !input.control &&
    !input.alt &&
    !input.meta &&
    !input.shift
  ) {
    const stopResolved = keymap.resolveShortcut(keyboardSettings(), 'stop');
    if (!stopResolved.disabled) {
      return handleEscape(event, accountId);
    }
  }

  // When find bar is open, Enter / Shift+Enter find next/prev (if not remapped away)
  const findOpen = findStateByAccount.get(accountId)?.open;
  if (findOpen && keyName === 'Enter' && !input.control && !input.alt && !input.meta) {
    event.preventDefault();
    findNext(accountId, !input.shift);
    return true;
  }

  const matched = keymap.matchInput(keyboardSettings(), input, { scope: 'panel' });
  if (!matched) return false;

  // F11 / Esc already partially handled; fullscreen id:
  if (matched === 'fullscreen') {
    event.preventDefault();
    return runAction(accountId, matched);
  }
  if (matched === 'stop') {
    return handleEscape(event, accountId);
  }

  event.preventDefault();
  return runAction(accountId, matched);
}

/**
 * Print from context menu.
 * @param {import('electron').WebContents} wc
 * @param {string} [accountId]
 */
function printFromWebContents(wc, accountId) {
  let id = accountId;
  if (!id && panelsApi && typeof panelsApi.accountIdForWebContents === 'function') {
    id = panelsApi.accountIdForWebContents(wc);
  }
  if (!id && panelsApi && typeof panelsApi.getFocusedAccountId === 'function') {
    id = panelsApi.getFocusedAccountId();
  }
  if (id) panelPrint(id);
  else if (wc && !wc.isDestroyed()) {
    if (selftestOn()) {
      printMockLog.push({ accountId: '?', at: Date.now() });
      return;
    }
    try {
      wc.print({ silent: false, printBackground: true });
    } catch {
      /* ignore */
    }
  }
}

function onShortcutsChanged() {
  if (rebuildMenu) {
    try {
      rebuildMenu();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} accountId
 * @returns {boolean}
 */
function isFindBarOpen(accountId) {
  return !!(findStateByAccount.get(accountId) && findStateByAccount.get(accountId).open);
}

/**
 * @param {string} accountId
 * @returns {{ query: string, open: boolean }|null}
 */
function getFindState(accountId) {
  return findStateByAccount.get(accountId) || null;
}

module.exports = {
  configure,
  handleBeforeInput,
  wireFindInPage,
  panelPrint,
  printFromWebContents,
  panelViewSource,
  getViewSourceWindows,
  openFindBar,
  closeFindBar,
  findQuery,
  findNext,
  isFindBarOpen,
  getFindState,
  runAction,
  onShortcutsChanged,
  clearSelftestLogs,
  getPrintMockLog,
  getActionLog,
  ensureIpc,
};
