'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { session } = require('electron');
const store = require('./store');
const dnr = require('./dnr-shim');
const { readManifestForDnr } = require('./dnr-prepare');

/** @type {Map<string, Map<string, string>>} accountId -> extId -> electronExtensionId */
const loadedByAccount = new Map();

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
  return `persist:acc-${accountId}`;
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
  const ses = getSession(accountId);
  let map = loadedByAccount.get(accountId);
  if (!map) {
    map = new Map();
    loadedByAccount.set(accountId, map);
  }
  if (map.has(record.id)) return map.get(record.id);

  try {
    ensureDnrLoaded(record);
    const ext = await ses.extensions.loadExtension(record.path, {
      allowFileAccess: true,
    });
    const eid = ext && ext.id ? ext.id : record.id;
    map.set(record.id, eid);
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
  partitionFor,
  ensureDnrLoaded,
  syncDnrForAccount,
};
