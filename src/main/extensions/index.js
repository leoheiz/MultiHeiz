'use strict';

/**
 * MultiHeiz third-party extensions — minimal own layer (MIT).
 * See ./LICENSE.md for why we did not adopt electron-chrome-extensions (GPL-3).
 *
 * Network filtering stays in src/main/adblock/ (DNR shim = phase 3b).
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, dialog } = require('electron');
const store = require('./store');
const { buildRecord } = require('./manifest');
const { unpackCrxToDir, packDirAsCrx3 } = require('./crx');
const { parseStoreInput, downloadCrx } = require('./download');
const loader = require('./loader');
const popup = require('./popup');
const dnr = require('./dnr-shim');
const dnrApi = require('./dnr-api-stub');
const { prepareExtensionDir } = require('./dnr-prepare');

/** @type {{ emit?: (p: object) => void, getAccountIds?: () => string[], getMainWindow?: () => Electron.BrowserWindow|null } | null} */
let deps = null;
let ipcRegistered = false;

function emit(payload) {
  if (deps && typeof deps.emit === 'function') deps.emit(payload);
}

function accountIds() {
  if (deps && typeof deps.getAccountIds === 'function') {
    return deps.getAccountIds() || [];
  }
  return [];
}

function publicList() {
  return store.listRecords().map((r) => ({
    id: r.id,
    name: r.name,
    version: r.version,
    description: r.description,
    manifestVersion: r.manifestVersion,
    enabled: !!r.enabled,
    applyTo: r.applyTo === 'all' || r.applyTo == null ? 'all' : r.applyTo,
    source: r.source,
    storeId: r.storeId,
    iconDataUrl: r.iconDataUrl,
    hasAction: !!r.hasAction,
    actionPopup: r.actionPopup,
    actionTitle: r.actionTitle,
    optionsPage: r.optionsPage,
    warnings: r.warnings || [],
    permissions: r.permissions || [],
    networkBlocker: !!r.networkBlocker,
    hasDnr: !!r.hasDnr,
    dnrRuleCount: (() => {
      const eng = dnr.getEngine(r.id);
      return eng ? eng.ruleCount : 0;
    })(),
    path: r.path,
    installedAt: r.installedAt,
  }));
}

/**
 * Any enabled extension that acts as a network blocker (DNR / known adblockers).
 */
function activeNetworkBlockers() {
  return publicList().filter((r) => r.enabled && r.networkBlocker);
}

/**
 * Suggest turning off built-in adblock when an extension blocker is active.
 * @returns {{ suggest: boolean, blockers: object[], message: string }}
 */
function coexistenceHint() {
  const blockers = activeNetworkBlockers();
  if (!blockers.length) {
    return { suggest: false, blockers: [], message: '' };
  }
  const names = blockers.map((b) => b.name || b.id).join(', ');
  return {
    suggest: true,
    blockers,
    message:
      'Extensão bloqueadora ativa (' +
      names +
      '). Recomenda-se desligar o bloqueador embutido em Configurações → Bloqueio de anúncios para evitar regras duplicadas (ambos podem ficar ligados: o hub combina decisões; bloqueio vence; lista de permissão respeitada).',
  };
}

/**
 * Copy or move unpacked dir into userData/extensions/<id>/<version>/
 * @param {string} srcDir
 * @param {object} record
 */
function materializeInstall(srcDir, record) {
  const dest = store.installDirFor(record.id, record.version);
  if (path.resolve(srcDir) === path.resolve(dest)) {
    record.path = dest;
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(srcDir, dest, { recursive: true });
  record.path = dest;
  return dest;
}

/**
 * @param {string} srcDir
 * @param {{ source?: string, storeId?: string, preferredId?: string, applyTo?: string|string[] }} [opts]
 */
async function installFromUnpacked(srcDir, opts = {}) {
  const abs = path.resolve(srcDir);
  if (!fs.existsSync(path.join(abs, 'manifest.json'))) {
    throw new Error('Pasta sem manifest.json');
  }
  const record = buildRecord(abs, {
    source: opts.source || 'unpacked',
    storeId: opts.storeId,
    preferredId: opts.preferredId || opts.storeId,
  });
  if (opts.applyTo != null) record.applyTo = opts.applyTo;
  materializeInstall(abs, record);
  // Snapshot DNR for shim, strip from manifest so Electron loadExtension works
  prepareExtensionDir(record.path);
  // Rebuild warnings/icons from final path (reads multiheiz-dnr.json if present)
  const finalRec = buildRecord(record.path, {
    source: record.source,
    storeId: record.storeId,
    preferredId: record.id,
  });
  finalRec.enabled = true;
  finalRec.applyTo = record.applyTo;
  finalRec.installedAt = Date.now();
  // Preserve blocker flags from pre-strip record when snapshot was written
  if (record.networkBlocker) finalRec.networkBlocker = true;
  if (record.hasDnr) finalRec.hasDnr = true;
  store.upsertRecord(finalRec);
  loader.ensureDnrLoaded(finalRec);
  await loader.syncExtension(finalRec.id, accountIds());
  emit({
    type: 'extensions:changed',
    extensions: publicList(),
    coexistence: coexistenceHint(),
  });
  return finalRec;
}

/**
 * @param {string} crxPath
 * @param {{ source?: string, storeId?: string, applyTo?: string|string[] }} [opts]
 */
async function installFromCrxFile(crxPath, opts = {}) {
  const buf = fs.readFileSync(crxPath);
  return installFromCrxBuffer(buf, {
    source: opts.source || 'crx',
    storeId: opts.storeId,
    applyTo: opts.applyTo,
  });
}

/**
 * @param {Buffer} buf
 * @param {{ source?: string, storeId?: string, applyTo?: string|string[] }} [opts]
 */
async function installFromCrxBuffer(buf, opts = {}) {
  const tmpRoot = path.join(app.getPath('temp'), 'multiheiz-crx-' + Date.now());
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    unpackCrxToDir(buf, tmpRoot);
    return await installFromUnpacked(tmpRoot, {
      source: opts.source || 'crx',
      storeId: opts.storeId,
      preferredId: opts.storeId,
      applyTo: opts.applyTo,
    });
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} input URL or ID
 * @param {{ applyTo?: string|string[] }} [opts]
 */
async function installFromStore(input, opts = {}) {
  const parsed = parseStoreInput(input);
  if (!parsed) {
    throw new Error('URL ou ID da Chrome Web Store / Edge Add-ons inválido');
  }
  const chromeVer = process.versions.chrome || '137.0.0.0';
  const { buffer } = await downloadCrx(parsed.store, parsed.id, chromeVer);
  return installFromCrxBuffer(buffer, {
    source: parsed.store === 'edge' ? 'edge-addons' : 'chrome-web-store',
    storeId: parsed.id,
    applyTo: opts.applyTo,
  });
}

/**
 * @param {string} id
 * @param {boolean} enabled
 */
async function setEnabled(id, enabled) {
  const rec = store.patchRecord(id, { enabled: !!enabled });
  if (!rec) return null;
  await loader.syncExtension(id, accountIds());
  emit({ type: 'extensions:changed', extensions: publicList() });
  return rec;
}

/**
 * @param {string} id
 * @param {'all'|string[]} applyTo
 */
async function setApplyTo(id, applyTo) {
  const value = applyTo === 'all' || applyTo == null ? 'all' : applyTo;
  const rec = store.patchRecord(id, { applyTo: value });
  if (!rec) return null;
  await loader.syncExtension(id, accountIds());
  emit({ type: 'extensions:changed', extensions: publicList() });
  return rec;
}

/**
 * @param {string} id
 */
async function removeExtension(id) {
  const rec = store.getRecord(id);
  if (!rec) return false;
  await loader.unloadEverywhere(id, accountIds());
  store.removeRecord(id);
  try {
    const dir = path.join(store.extensionsRoot(), id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[extensions] remove files', err && err.message);
  }
  emit({ type: 'extensions:changed', extensions: publicList() });
  return true;
}

async function loadForAccount(accountId) {
  await loader.loadForAccount(accountId);
}

async function loadAllAccountSessions() {
  await loader.loadForAccounts(accountIds());
}

/**
 * @param {object} options
 */
function init(options) {
  deps = options || {};
  store.reloadFromDisk();
  registerIpc();
  // Load after a tick so accounts exist
  setTimeout(() => {
    loadAllAccountSessions().catch((err) => {
      console.warn('[extensions] initial load', err && err.message);
    });
  }, 0);
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle('extensions:list', () => publicList());
  ipcMain.handle('extensions:coexistence', () => coexistenceHint());
  ipcMain.handle('extensions:dnr-stats', () => dnr.listEngines());
  ipcMain.handle('extensions:dnr-bridge', (_e, method, payload) =>
    dnrApi.handleBridge(String(method || ''), payload || {})
  );

  ipcMain.handle('extensions:install-unpacked', async () => {
    const win = deps && deps.getMainWindow ? deps.getMainWindow() : null;
    const r = await dialog.showOpenDialog(win || undefined, {
      title: 'Instalar extensão (pasta descompactada)',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
    try {
      const rec = await installFromUnpacked(r.filePaths[0]);
      return { ok: true, extension: rec, extensions: publicList() };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('extensions:install-crx', async () => {
    const win = deps && deps.getMainWindow ? deps.getMainWindow() : null;
    const r = await dialog.showOpenDialog(win || undefined, {
      title: 'Instalar extensão (.crx)',
      properties: ['openFile'],
      filters: [{ name: 'Chrome Extension', extensions: ['crx'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
    try {
      const rec = await installFromCrxFile(r.filePaths[0]);
      return { ok: true, extension: rec, extensions: publicList() };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('extensions:install-store', async (_e, input) => {
    try {
      const rec = await installFromStore(String(input || ''));
      return { ok: true, extension: rec, extensions: publicList() };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('extensions:set-enabled', async (_e, { id, enabled }) => {
    const rec = await setEnabled(id, enabled);
    return { ok: !!rec, extension: rec, extensions: publicList() };
  });

  ipcMain.handle('extensions:set-apply-to', async (_e, { id, applyTo }) => {
    const rec = await setApplyTo(id, applyTo);
    return { ok: !!rec, extension: rec, extensions: publicList() };
  });

  ipcMain.handle('extensions:remove', async (_e, id) => {
    const ok = await removeExtension(id);
    return { ok, extensions: publicList() };
  });

  ipcMain.handle('extensions:open-options', async (_e, { id, accountId }) => {
    const win = deps && deps.getMainWindow ? deps.getMainWindow() : null;
    return popup.openOptionsPage(accountId || accountIds()[0] || 'acc', id, {
      parent: win,
    });
  });

  ipcMain.handle('extensions:open-action', async (_e, { id, accountId, x, y }) => {
    const win = deps && deps.getMainWindow ? deps.getMainWindow() : null;
    return popup.openActionPopup(accountId, id, { x, y, parent: win });
  });

  ipcMain.handle('extensions:actions-for', (_e, accountId) => {
    return publicList().filter(
      (r) =>
        r.enabled &&
        r.hasAction &&
        loader.appliesToAccount(
          store.getRecord(r.id),
          accountId
        )
    );
  });

  // Selftest helpers (always registered; harmless in production)
  ipcMain.handle('extensions:selftest-install-unpacked', async (_e, dirPath) => {
    try {
      const rec = await installFromUnpacked(String(dirPath));
      return { ok: true, extension: rec };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  ipcMain.handle('extensions:selftest-install-crx', async (_e, crxPath) => {
    try {
      const rec = await installFromCrxFile(String(crxPath));
      return { ok: true, extension: rec };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  ipcMain.handle('extensions:selftest-loaded', (_e, accountId) => {
    return loader.listLoaded(accountId);
  });
  ipcMain.handle('extensions:selftest-pack-crx3', (_e, { dir, outPath }) => {
    try {
      packDirAsCrx3(dir, outPath);
      return { ok: true, outPath };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  ipcMain.handle('extensions:selftest-dnr-match', (_e, { installId, url, resourceType, initiator }) => {
    const rule = dnr.matchUrl(installId, url, { resourceType, initiator });
    return {
      ok: true,
      matched: !!rule,
      action: rule ? rule.actionType : null,
      ruleId: rule ? rule.id : null,
      priority: rule ? rule.priority : null,
      engines: dnr.listEngines(),
    };
  });
  ipcMain.handle('extensions:selftest-dnr-measure', (_e, { installId, urls }) => {
    return dnr.measureLookup(installId, urls || []);
  });
}

function shutdown() {
  popup.closeAllPopups();
}

module.exports = {
  init,
  shutdown,
  list: publicList,
  installFromUnpacked,
  installFromCrxFile,
  installFromCrxBuffer,
  installFromStore,
  setEnabled,
  setApplyTo,
  removeExtension,
  loadForAccount,
  loadAllAccountSessions,
  openActionPopup: (...args) => popup.openActionPopup(...args),
  openOptionsPage: (...args) => popup.openOptionsPage(...args),
  packDirAsCrx3,
  unpackCrxToDir,
  parseStoreInput,
  coexistenceHint,
  activeNetworkBlockers,
  loader,
  store,
  dnr,
};
