'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { session } = require('electron');
const store = require('./store');
const dnr = require('./dnr-shim');
const { readManifestForDnr } = require('./dnr-prepare');
const swBridge = require('./sw-bridge');
const { abuCompatApplies } = require('./abu-compat');

/** @type {Map<string, Map<string, string>>} accountId -> extId -> electronExtensionId */
const loadedByAccount = new Map();

/** In-flight loadOne promises: `${accountId}::${installId}` -> Promise */
/** @type {Map<string, Promise<string|null>>} */
const inflightLoads = new Map();

/**
 * @param {object} record
 */
function ensureDnrLoaded(record) {
  if (!record || !record.path || !fs.existsSync(path.join(record.path, 'manifest.json'))) {
    return null;
  }
  if (dnr.getEngine(record.id)) return dnr.getEngine(record.id);
  try {
    const manifest = readManifestForDnr(record.path);
    if (!manifest.declarative_net_request) return null;
    const eng = dnr.loadExtensionRules(record.id, record.path, manifest);
    console.log(
      '[extensions] DNR loaded',
      record.id,
      'rules=',
      eng.ruleCount,
      'in',
      eng.loadMs + 'ms'
    );
    return eng;
  } catch (err) {
    console.warn('[extensions] DNR load', record.id, err && err.message);
    return null;
  }
}

/**
 * Refresh which DNR engines apply per account and attach hub listener.
 * @param {string} accountId
 */
function syncDnrForAccount(accountId) {
  const records = store.listRecords();
  const ids = [];
  for (const rec of records) {
    if (!appliesToAccount(rec, accountId)) continue;
    const eng = ensureDnrLoaded(rec);
    if (eng) ids.push(rec.id);
  }
  dnr.setApplies(accountId, ids);
  try {
    const ses = getSession(accountId);
    dnr.attachSession(ses, accountId);
  } catch (err) {
    console.warn('[extensions] DNR attach', accountId, err && err.message);
  }
}

/**
 * @param {string} accountId
 */
function partitionFor(accountId) {
  try {
    const panels = require('../panels');
    if (panels && typeof panels.partitionFor === 'function') {
      return panels.partitionFor(accountId);
    }
  } catch {
    /* ignore circular / early load */
  }
  try {
    const { getState } = require('../state');
    const part = require('../partition');
    const acc = (getState().accounts || []).find((a) => a && a.id === accountId);
    if (acc) return part.partitionForAccount(acc);
    return part.partitionString(accountId);
  } catch {
    return `persist:acc-${accountId}`;
  }
}

/**
 * @param {object} record
 * @param {string} accountId
 */
function appliesToAccount(record, accountId) {
  if (!record || !record.enabled) return false;
  if (record.applyTo === 'all' || record.applyTo == null) return true;
  if (Array.isArray(record.applyTo)) return record.applyTo.includes(accountId);
  return false;
}

/**
 * @param {string} accountId
 */
function getSession(accountId) {
  return session.fromPartition(partitionFor(accountId));
}

/**
 * @param {string} accountId
 * @param {object} record
 */
async function loadOne(accountId, record) {
  if (!appliesToAccount(record, accountId)) return null;
  let map = loadedByAccount.get(accountId);
  if (!map) {
    map = new Map();
    loadedByAccount.set(accountId, map);
  }
  if (map.has(record.id)) return map.get(record.id);

  const inflightKey = `${accountId}::${record.id}`;
  const existing = inflightLoads.get(inflightKey);
  if (existing) return existing;

  const promise = (async () => {
    // Re-check after winning the inflight slot (another caller may have finished).
    map = loadedByAccount.get(accountId) || map;
    if (map.has(record.id)) return map.get(record.id);
    const ses = getSession(accountId);
    try {
      ensureDnrLoaded(record);
      // SW API shim preload must be registered before loadExtension.
      if (abuCompatApplies(record)) {
        swBridge.prepareForLoad(ses, accountId, record);
      }
      // allowFileAccess: false — extensions must not read arbitrary file:// pages.
      // Content scripts / DNR on http(s) panels do not need file access.
      const ext = await ses.extensions.loadExtension(record.path, {
        allowFileAccess: false,
      });
      const eid = ext && ext.id ? ext.id : record.id;
      map.set(record.id, eid);
      try {
        dnr.setRuntimeId(record.id, eid);
      } catch {
        /* ignore */
      }
      if (abuCompatApplies(record)) {
        swBridge.afterLoad(ses, accountId, record, eid);
      }
      syncDnrForAccount(accountId);
      if (Array.isArray(record.warnings) && record.warnings.length) {
        console.warn(
          `[extensions] ${record.name} (${record.id}) warnings:`,
          record.warnings.join('; ')
        );
      }
      return eid;
    } catch (err) {
      console.warn(
        '[extensions] load failed',
        record.id,
        accountId,
        err && err.message ? err.message : err
      );
      return null;
    }
  })();

  inflightLoads.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    inflightLoads.delete(inflightKey);
  }
}

/**
 * @param {string} accountId
 * @param {string} installId
 */
async function unloadOne(accountId, installId) {
  const map = loadedByAccount.get(accountId);
  if (!map || !map.has(installId)) return;
  const eid = map.get(installId);
  map.delete(installId);
  try {
    const ses = getSession(accountId);
    ses.extensions.removeExtension(eid);
  } catch (err) {
    console.warn('[extensions] unload', installId, err && err.message);
  }
  syncDnrForAccount(accountId);
}

/**
 * Load all enabled extensions that apply to this account.
 * @param {string} accountId
 */
async function loadForAccount(accountId) {
  const records = store.listRecords();
  for (const rec of records) {
    if (appliesToAccount(rec, accountId)) {
      await loadOne(accountId, rec);
    } else {
      await unloadOne(accountId, rec.id);
    }
  }
}

/**
 * @param {string[]} accountIds
 */
async function loadForAccounts(accountIds) {
  for (const id of accountIds) {
    await loadForAccount(id);
  }
}

/**
 * Reload a single extension across all known accounts (and given list).
 * @param {string} installId
 * @param {string[]} accountIds
 */
async function syncExtension(installId, accountIds) {
  const rec = store.getRecord(installId);
  for (const accountId of accountIds) {
    await unloadOne(accountId, installId);
    if (rec && appliesToAccount(rec, accountId)) {
      await loadOne(accountId, rec);
    }
  }
}

/**
 * @param {string} installId
 * @param {string[]} accountIds
 */
async function unloadEverywhere(installId, accountIds) {
  for (const accountId of accountIds) {
    await unloadOne(accountId, installId);
  }
  for (const accountId of loadedByAccount.keys()) {
    if (!accountIds.includes(accountId)) {
      await unloadOne(accountId, installId);
    }
  }
  dnr.unloadExtensionRules(installId);
}

/**
 * Electron runtime id for an install on a given account (if loaded).
 * @param {string} accountId
 * @param {string} installId
 */
function runtimeId(accountId, installId) {
  const map = loadedByAccount.get(accountId);
  return map && map.get(installId) ? map.get(installId) : null;
}

/**
 * @param {string} accountId
 */
function listLoaded(accountId) {
  const map = loadedByAccount.get(accountId);
  if (!map) return [];
  return [...map.entries()].map(([installId, electronId]) => ({
    installId,
    electronId,
  }));
}

function resetLoadedState() {
  loadedByAccount.clear();
  inflightLoads.clear();
}

/** @returns {number} */
function inflightLoadCount() {
  return inflightLoads.size;
}

module.exports = {
  appliesToAccount,
  loadOne,
  unloadOne,
  loadForAccount,
  loadForAccounts,
  syncExtension,
  unloadEverywhere,
  runtimeId,
  listLoaded,
  resetLoadedState,
  inflightLoadCount,
  partitionFor,
  ensureDnrLoaded,
  syncDnrForAccount,
};
