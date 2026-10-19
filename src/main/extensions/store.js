'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const REGISTRY_NAME = 'extensions-registry.json';

/** @type {{ version: number, extensions: object[] } | null} */
let cache = null;

function extensionsRoot() {
  return path.join(app.getPath('userData'), 'extensions');
}

function registryPath() {
  return path.join(app.getPath('userData'), REGISTRY_NAME);
}

function defaultRegistry() {
  return { version: 1, extensions: [] };
}

function loadRegistry() {
  if (cache) return cache;
  const p = registryPath();
  if (!fs.existsSync(p)) {
    cache = defaultRegistry();
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    cache = {
      version: 1,
      extensions: Array.isArray(parsed.extensions) ? parsed.extensions : [],
    };
  } catch {
    cache = defaultRegistry();
  }
  return cache;
}

function saveRegistry() {
  const reg = loadRegistry();
  fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
  const tmp = registryPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
  fs.renameSync(tmp, registryPath());
}

function listRecords() {
  return loadRegistry().extensions.slice();
}

/**
 * @param {string} id
 */
function getRecord(id) {
  return loadRegistry().extensions.find((e) => e.id === id) || null;
}

/**
 * @param {object} record
 */
function upsertRecord(record) {
  const reg = loadRegistry();
  const i = reg.extensions.findIndex((e) => e.id === record.id);
  if (i >= 0) reg.extensions[i] = record;
  else reg.extensions.push(record);
  saveRegistry();
  return record;
}

/**
 * @param {string} id
 * @param {object} patch
 */
function patchRecord(id, patch) {
  const rec = getRecord(id);
  if (!rec) return null;
  Object.assign(rec, patch);
  saveRegistry();
  return rec;
}

/**
 * @param {string} id
 */
function removeRecord(id) {
  const reg = loadRegistry();
  const before = reg.extensions.length;
  reg.extensions = reg.extensions.filter((e) => e.id !== id);
  if (reg.extensions.length === before) return false;
  saveRegistry();
  return true;
}

/**
 * @param {string} id
 * @param {string} version
 */
function installDirFor(id, version) {
  const safeVer = String(version || '0').replace(/[^\w.-]+/g, '_');
  return path.join(extensionsRoot(), id, safeVer);
}

function reloadFromDisk() {
  cache = null;
  return loadRegistry();
}

module.exports = {
  extensionsRoot,
  registryPath,
  loadRegistry,
  saveRegistry,
  listRecords,
  getRecord,
  upsertRecord,
  patchRecord,
  removeRecord,
  installDirFor,
  reloadFromDisk,
};
