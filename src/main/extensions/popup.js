'use strict';

const path = require('node:path');
const { BrowserWindow, session } = require('electron');
const store = require('./store');
const loader = require('./loader');
const dnrApi = require('./dnr-api-stub');

/**
 * @param {Electron.BrowserWindow} win
 * @param {string} installId
 */
async function injectDnrStub(win, installId) {
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(dnrApi.pageStubSource(installId), true);
  } catch {
    /* extension pages may CSP-block; static DNR still works in main */
  }
}

/** @type {BrowserWindow | null} */
let actionWin = null;
/** @type {BrowserWindow | null} */
let optionsWin = null;

/**
 * @param {string} accountId
 * @param {string} installId
 * @param {{ x?: number, y?: number, parent?: Electron.BrowserWindow|null }} [opts]
 */
async function openActionPopup(accountId, installId, opts = {}) {
  const rec = store.getRecord(installId);
  if (!rec || !rec.enabled) {
    return { ok: false, error: 'Extensão não encontrada ou desligada' };
  }
  if (!rec.actionPopup) {
    return { ok: false, error: 'Esta extensão não tem popup de ação' };
  }
  if (!loader.appliesToAccount(rec, accountId)) {
    return { ok: false, error: 'Extensão não aplicada a esta janela' };
  }

  await loader.loadOne(accountId, rec);
  const eid = loader.runtimeId(accountId, installId) || rec.id;
  const ses = session.fromPartition(loader.partitionFor(accountId));
  const url = `chrome-extension://${eid}/${String(rec.actionPopup).replace(/^\//, '')}`;

  if (actionWin && !actionWin.isDestroyed()) {
    actionWin.close();
  }

  actionWin = new BrowserWindow({
    width: 380,
    height: 520,
    x: typeof opts.x === 'number' ? Math.round(opts.x) : undefined,
    y: typeof opts.y === 'number' ? Math.round(opts.y) : undefined,
    parent: opts.parent || undefined,
    modal: false,
    show: false,
    autoHideMenuBar: true,
    title: rec.actionTitle || rec.name || 'Extensão',
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  actionWin.on('closed', () => {
    actionWin = null;
  });

  try {
    await actionWin.loadURL(url);
    await injectDnrStub(actionWin, installId);
    actionWin.show();
    return { ok: true, url };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    try {
      actionWin.close();
    } catch {
      /* ignore */
    }
    return { ok: false, error: msg, url };
  }
}

/**
 * @param {string} accountId
 * @param {string} installId
 * @param {{ parent?: Electron.BrowserWindow|null }} [opts]
 */
async function openOptionsPage(accountId, installId, opts = {}) {
  const rec = store.getRecord(installId);
  if (!rec) return { ok: false, error: 'Extensão não encontrada' };
  if (!rec.optionsPage) {
    return { ok: false, error: 'Esta extensão não tem página de opções' };
  }

  // Options use a chosen account session (or first apply target)
  let targetAccount = accountId;
  if (!loader.appliesToAccount(rec, targetAccount)) {
    if (rec.applyTo === 'all') {
      /* keep */
    } else if (Array.isArray(rec.applyTo) && rec.applyTo.length) {
      targetAccount = rec.applyTo[0];
    }
  }

  await loader.loadOne(targetAccount, rec);
  const eid = loader.runtimeId(targetAccount, installId) || rec.id;
  const ses = session.fromPartition(loader.partitionFor(targetAccount));
  const page = String(rec.optionsPage).replace(/^\//, '');
  const url = `chrome-extension://${eid}/${page}`;

  if (optionsWin && !optionsWin.isDestroyed()) {
    optionsWin.focus();
    try {
      await optionsWin.loadURL(url);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
    return { ok: true, url };
  }

  optionsWin = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    title: `Opções — ${rec.name}`,
    parent: opts.parent || undefined,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  optionsWin.on('closed', () => {
    optionsWin = null;
  });

  try {
    await optionsWin.loadURL(url);
    await injectDnrStub(optionsWin, installId);
    optionsWin.show();
    return { ok: true, url };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    try {
      optionsWin.close();
    } catch {
      /* ignore */
    }
    return { ok: false, error: msg, url };
  }
}

/**
 * Resolve absolute file under extension dir (for tests).
 * @param {string} installId
 * @param {string} rel
 */
function resolveExtFile(installId, rel) {
  const rec = store.getRecord(installId);
  if (!rec) return null;
  return path.join(rec.path, rel);
}

function closeAllPopups() {
  try {
    if (actionWin && !actionWin.isDestroyed()) actionWin.close();
  } catch {
    /* ignore */
  }
  try {
    if (optionsWin && !optionsWin.isDestroyed()) optionsWin.close();
  } catch {
    /* ignore */
  }
}

module.exports = {
  openActionPopup,
  openOptionsPage,
  resolveExtFile,
  closeAllPopups,
  getActionWindow: () => actionWin,
  getOptionsWindow: () => optionsWin,
};
