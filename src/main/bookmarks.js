'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { createJsonStore } = require('./json-store');

const FOLDER_BAR = 'folder-bar';
const FOLDER_OTHER = 'folder-other';
const FOLDER_DEFAULT_LEGACY = 'folder-default';

function defaultBookmarks() {
  return {
    version: 2,
    folders: [
      { id: FOLDER_BAR, name: 'Barra de favoritos', order: 0, builtIn: 'bar' },
      { id: FOLDER_OTHER, name: 'Outros favoritos', order: 1, builtIn: 'other' },
    ],
    items: [],
    expandedFolders: [FOLDER_BAR, FOLDER_OTHER],
  };
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @type {boolean} */
let migratedBakOnce = false;

/**
 * Ids that earlier builds / imports used for the favorites bar. Items still
 * pointing at one of these (and no such folder exists) belong in folder-bar.
 * @param {unknown} id
 */
function looksLikeLegacyBarId(id) {
  const s = String(id || '').toLowerCase();
  if (!s || s === FOLDER_OTHER || s === FOLDER_DEFAULT_LEGACY) return false;
  if (/other|outros/.test(s)) return false;
  return /(^|[-_ .])(bar|favbar|toolbar)([-_ .]|$)/.test(s) || /^(favorites|bookmarks)[-_ ]?bar$/.test(s);
}

/**
 * Migração não destrutiva: formatos antigos (array / flat / v1) → árvore v2.
 * Mantém campos extras; não remove chaves. Cria .bak uma vez.
 * @param {unknown} raw
 */
function migrateBookmarksData(raw) {
  const base = defaultBookmarks();
  let parsed = raw;

  // Old: bare array of bookmarks
  if (Array.isArray(parsed)) {
    parsed = { version: 1, items: parsed, folders: [] };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { data: base, migrated: false };
  }

  // Old: { bookmarks: [...] }
  if (Array.isArray(parsed.bookmarks) && !Array.isArray(parsed.items)) {
    parsed = {
      ...parsed,
      items: parsed.bookmarks,
      folders: parsed.folders || [],
    };
  }

  const wasFlat =
    !Array.isArray(parsed.folders) ||
    parsed.folders.length === 0 ||
    Number(parsed.version) < 2 ||
    (Array.isArray(parsed.items) &&
      parsed.items.some((it) => it && !it.folderId));

  let folders = Array.isArray(parsed.folders) ? parsed.folders.map((f) => ({ ...f })) : [];
  let items = Array.isArray(parsed.items) ? parsed.items.map((it) => ({ ...it })) : [];

  // Ensure built-in bar + other
  let bar = folders.find((f) => f.id === FOLDER_BAR || f.builtIn === 'bar');
  let other = folders.find((f) => f.id === FOLDER_OTHER || f.builtIn === 'other');

  // Root cause of the "empty favorites bar": built-in folders whose id was not
  // folder-bar / folder-other got renamed below, but their items kept the OLD id
  // and were then swept into folder-other as orphans. Record old → new ids FIRST
  // and remap items (and child folders' parentId) before any orphan handling.
  /** @type {Record<string, string>} */
  const idRemap = {};
  for (const f of folders) {
    if (!f || !f.id) continue;
    if (f.builtIn === 'bar' && f.id !== FOLDER_BAR) idRemap[String(f.id)] = FOLDER_BAR;
    else if (f.builtIn === 'other' && f.id !== FOLDER_OTHER) idRemap[String(f.id)] = FOLDER_OTHER;
  }
  if (bar && bar.id !== FOLDER_BAR && bar.id) idRemap[String(bar.id)] = FOLDER_BAR;
  if (other && other.id !== FOLDER_OTHER && other.id) idRemap[String(other.id)] = FOLDER_OTHER;
  // Persisted from earlier migrations so later loads can still heal strays.
  const persistedLegacy =
    parsed.legacyFolderIds && typeof parsed.legacyFolderIds === 'object'
      ? parsed.legacyFolderIds
      : {};
  for (const [oldId, newId] of Object.entries(persistedLegacy)) {
    const userFolderWithThatId = folders.some(
      (f) => f && f.id === oldId && f.builtIn !== 'bar' && f.builtIn !== 'other'
    );
    if (
      oldId &&
      !userFolderWithThatId &&
      (newId === FOLDER_BAR || newId === FOLDER_OTHER) &&
      !Object.prototype.hasOwnProperty.call(idRemap, oldId)
    ) {
      idRemap[oldId] = newId;
    }
  }
  const remapFolderId = (id) => {
    const key = String(id || '');
    return key && Object.prototype.hasOwnProperty.call(idRemap, key) ? idRemap[key] : id;
  };
  for (const it of items) {
    if (it && it.folderId) it.folderId = remapFolderId(it.folderId);
  }
  for (const f of folders) {
    if (f && f.parentId) f.parentId = remapFolderId(f.parentId);
  }

  // Map legacy folder-default → other
  const legacy = folders.find((f) => f.id === FOLDER_DEFAULT_LEGACY);
  if (legacy && !other) {
    other = {
      ...legacy,
      id: FOLDER_OTHER,
      name: legacy.name === 'Favoritos' ? 'Outros favoritos' : legacy.name || 'Outros favoritos',
      builtIn: 'other',
      order: legacy.order != null ? legacy.order : 1,
    };
    folders = folders.filter((f) => f.id !== FOLDER_DEFAULT_LEGACY);
    folders.push(other);
    for (const it of items) {
      if (it.folderId === FOLDER_DEFAULT_LEGACY) it.folderId = FOLDER_OTHER;
    }
  }

  if (!bar) {
    bar = { id: FOLDER_BAR, name: 'Barra de favoritos', order: 0, builtIn: 'bar' };
    folders.unshift(bar);
  } else {
    bar.builtIn = 'bar';
    if (!bar.name) bar.name = 'Barra de favoritos';
    bar.id = FOLDER_BAR;
  }

  if (!other) {
    other = { id: FOLDER_OTHER, name: 'Outros favoritos', order: 1, builtIn: 'other' };
    folders.push(other);
  } else {
    other.builtIn = 'other';
    if (!other.name) other.name = 'Outros favoritos';
    other.id = FOLDER_OTHER;
  }

  // Ensure bar/other ids after rename (items were already remapped above)
  folders = folders.map((f) => {
    if (!f) return f;
    if (f.builtIn === 'bar') return { ...f, id: FOLDER_BAR };
    if (f.builtIn === 'other') return { ...f, id: FOLDER_OTHER };
    return f;
  });

  // Deduplicate by id
  const seen = new Set();
  folders = folders.filter((f) => {
    if (!f || !f.id || seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  const folderIds = new Set(folders.map((f) => f.id));
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (!it.id) it.id = makeId('bm');
    if (!it.folderId || !folderIds.has(it.folderId)) {
      // Heal: items pointing at a missing id that looks like the OLD bar id go to
      // the bar (not "other"); everything else still falls back to other.
      it.folderId = it.folderId && looksLikeLegacyBarId(it.folderId) ? FOLDER_BAR : FOLDER_OTHER;
    }
    if (it.name == null && it.title) it.name = it.title;
    if (it.title == null && it.name) it.title = it.name;
  }
  items = items.filter((it) => it && typeof it.url === 'string' && it.url.trim());

  let expandedFolders = Array.isArray(parsed.expandedFolders)
    ? parsed.expandedFolders.map(String)
    : [FOLDER_BAR, FOLDER_OTHER];

  // After migrating legacy data into folder-other, expand folders that actually
  // have items so the popover/page are not stuck on an empty "Barra de favoritos".
  const foldersWithItems = new Set(
    items.filter((it) => it && it.folderId).map((it) => it.folderId)
  );
  if (wasFlat || Number(parsed.version) < 2 || !Array.isArray(parsed.expandedFolders)) {
    for (const id of foldersWithItems) {
      if (!expandedFolders.includes(id)) expandedFolders.push(id);
    }
    if (!expandedFolders.length) {
      expandedFolders = [FOLDER_BAR, FOLDER_OTHER];
    }
  }

  // Old built-in ids are kept so later loads / imports can still remap strays.
  const legacyFolderIds = { ...persistedLegacy };
  for (const [oldId, newId] of Object.entries(idRemap)) {
    if (oldId !== newId) legacyFolderIds[oldId] = newId;
  }
  expandedFolders = [...new Set(expandedFolders.map((id) => String(remapFolderId(id))))];
  const remappedBuiltIns = Object.keys(idRemap).some((k) => !(k in persistedLegacy));

  const data = {
    ...parsed,
    version: 2,
    folders,
    items,
    expandedFolders,
  };
  if (Object.keys(legacyFolderIds).length) data.legacyFolderIds = legacyFolderIds;

  return { data, migrated: wasFlat || Number(parsed.version) < 2 || remappedBuiltIns };
}

/**
 * Heal profiles already damaged by the old migration (bar items swept into
 * "other"): compare with the one-shot .bak copy. Items whose URL lived in the bar
 * (or one of its sub-folders) in the backup, but now sit in folder-other, move back.
 * Pure + idempotent; only runs when the bar currently has no direct items.
 * @param {object} data migrated data (mutated)
 * @param {unknown} bakRaw parsed contents of bookmarks.json.bak
 * @returns {boolean} true when anything changed
 */
function healFromBackup(data, bakRaw) {
  if (!data || typeof data !== 'object' || !bakRaw || typeof bakRaw !== 'object') return false;
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.some((it) => it && it.folderId === FOLDER_BAR)) return false;
  const bakFolders = Array.isArray(bakRaw.folders) ? bakRaw.folders : [];
  const bakItems = Array.isArray(bakRaw.items) ? bakRaw.items : Array.isArray(bakRaw) ? bakRaw : [];
  const barIds = new Set([FOLDER_BAR]);
  for (const f of bakFolders) {
    if (f && f.builtIn === 'bar' && f.id) barIds.add(String(f.id));
  }
  for (const it of bakItems) {
    if (it && it.folderId && looksLikeLegacyBarId(it.folderId)) barIds.add(String(it.folderId));
  }
  const curFolderIds = new Set((data.folders || []).map((f) => f && f.id));
  const wantByUrl = new Map();
  for (const it of bakItems) {
    if (!it || typeof it.url !== 'string') continue;
    const fid = String(it.folderId || '');
    if (barIds.has(fid)) wantByUrl.set(it.url, FOLDER_BAR);
    else if (curFolderIds.has(fid) && fid !== FOLDER_OTHER) wantByUrl.set(it.url, fid);
  }
  let changed = false;
  for (const it of items) {
    if (!it || it.folderId !== FOLDER_OTHER) continue;
    const want = wantByUrl.get(it.url);
    if (want && want !== FOLDER_OTHER) {
      it.folderId = want;
      changed = true;
    }
  }
  if (changed) {
    const exp = Array.isArray(data.expandedFolders) ? data.expandedFolders : [];
    if (!exp.includes(FOLDER_BAR)) exp.unshift(FOLDER_BAR);
    data.expandedFolders = exp;
  }
  return changed;
}

/**
 * Heal already-migrated profiles: empty expanded bar + items only in "other"
 * looked like zero favorites in the popover/page.
 * @param {object} data
 */
function healExpandedFolders(data) {
  if (!data || typeof data !== 'object') return data;
  const items = Array.isArray(data.items) ? data.items : [];
  let expanded = Array.isArray(data.expandedFolders) ? data.expandedFolders.map(String) : [];
  const withItems = new Set(
    items.filter((it) => it && it.folderId).map((it) => String(it.folderId))
  );
  let changed = false;
  if (withItems.size) {
    const anyVisible = [...withItems].some((id) => expanded.includes(id));
    if (!anyVisible) {
      for (const id of withItems) {
        if (!expanded.includes(id)) {
          expanded.push(id);
          changed = true;
        }
      }
    }
  }
  if (!expanded.length) {
    expanded = [FOLDER_BAR, FOLDER_OTHER];
    changed = true;
  }
  if (changed) data.expandedFolders = expanded;
  return data;
}

function backupOnce(filePath) {
  if (migratedBakOnce) return;
  try {
    if (fs.existsSync(filePath)) {
      const bak = `${filePath}.bak`;
      if (!fs.existsSync(bak)) {
        fs.copyFileSync(filePath, bak);
      }
      migratedBakOnce = true;
    }
  } catch {
    /* ignore */
  }
}

/** One-shot heal using bookmarks.json.bak (see healFromBackup). */
function healFromBackupFile(data, filePath) {
  if (!data || data.healedFromBak || !filePath) return;
  try {
    const bak = `${filePath}.bak`;
    if (!fs.existsSync(bak)) return;
    const raw = JSON.parse(fs.readFileSync(bak, 'utf8'));
    healFromBackup(data, raw);
    data.healedFromBak = true;
  } catch {
    /* ignore */
  }
}

const store = createJsonStore('bookmarks.json', defaultBookmarks);

function load() {
  let filePath = null;
  try {
    filePath = path.join(app.getPath('userData'), 'bookmarks.json');
  } catch {
    filePath = null;
  }
  let raw = null;
  if (filePath && fs.existsSync(filePath)) {
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      raw = null;
    }
  }
  // Array / flat: migrate before json-store object-merge
  if (raw != null && (Array.isArray(raw) || (raw && typeof raw === 'object'))) {
    const { data: migrated, migrated: did } = migrateBookmarksData(raw);
    if (did && filePath) backupOnce(filePath);
    healFromBackupFile(migrated, filePath);
    healExpandedFolders(migrated);
    store.set(migrated);
    return migrated;
  }
  const data = store.load();
  const { data: migrated, migrated: did } = migrateBookmarksData(data);
  if (did && filePath) backupOnce(filePath);
  healFromBackupFile(migrated, filePath);
  healExpandedFolders(migrated);
  store.set(migrated);
  return migrated;
}

function get() {
  return store.get();
}

function list() {
  const data = store.get();
  return {
    version: data.version || 2,
    folders: [...(data.folders || [])].sort((a, b) => (a.order || 0) - (b.order || 0)),
    items: [...(data.items || [])],
    expandedFolders: [...(data.expandedFolders || [])],
  };
}

function findByUrl(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  return (store.get().items || []).find((it) => it.url === u) || null;
}

function addFavorite({ url, title, folderId, defaultWindowId, name }) {
  const data = store.get();
  const existing = (data.items || []).find((it) => it.url === url);
  if (existing) {
    if (name != null) existing.name = String(name).trim() || existing.name;
    if (title != null) existing.title = String(title);
    if (folderId != null) existing.folderId = folderId;
    if (defaultWindowId !== undefined) existing.defaultWindowId = defaultWindowId || null;
    store.scheduleSave();
    return existing;
  }
  const folders = data.folders || [];
  const fid =
    folderId && folders.some((f) => f.id === folderId)
      ? folderId
      : FOLDER_BAR;
  const item = {
    id: makeId('bm'),
    url: String(url || '').trim(),
    name: String(name || title || url || 'Favorito').trim(),
    title: String(title || name || '').trim(),
    folderId: fid,
    defaultWindowId: defaultWindowId || null,
    createdAt: Date.now(),
  };
  if (!data.items) data.items = [];
  data.items.push(item);
  store.scheduleSave();
  return item;
}

function updateFavorite(id, fields) {
  const item = (store.get().items || []).find((it) => it.id === id);
  if (!item) return null;
  if (fields.name != null) item.name = String(fields.name).trim() || item.name;
  if (fields.url != null) item.url = String(fields.url).trim() || item.url;
  if (fields.title != null) item.title = String(fields.title);
  if (fields.folderId != null) item.folderId = fields.folderId;
  if (fields.defaultWindowId !== undefined) item.defaultWindowId = fields.defaultWindowId || null;
  store.scheduleSave();
  return item;
}

function removeFavorite(id) {
  store.update((d) => {
    d.items = (d.items || []).filter((it) => it.id !== id);
  });
  return true;
}

function createFolder(name, parentId) {
  const folder = {
    id: makeId('folder'),
    name: String(name || 'Nova pasta').trim() || 'Nova pasta',
    order: (store.get().folders || []).length,
    parentId: parentId || null,
  };
  store.update((d) => {
    if (!d.folders) d.folders = [];
    d.folders.push(folder);
  });
  return folder;
}

function renameFolder(id, name) {
  const folder = (store.get().folders || []).find((f) => f.id === id);
  if (!folder) return null;
  if (folder.builtIn) {
    // Allow rename of display name but keep builtIn
  }
  folder.name = String(name || '').trim() || folder.name;
  store.scheduleSave();
  return folder;
}

function deleteFolder(id) {
  const data = store.get();
  const folder = (data.folders || []).find((f) => f.id === id);
  if (!folder) return { ok: false, reason: 'missing' };
  if (folder.builtIn) return { ok: false, reason: 'builtin' };
  const fallback =
    (data.folders || []).find((f) => f.id === FOLDER_OTHER) ||
    (data.folders || []).find((f) => f.id !== id);
  if (!fallback) return { ok: false, reason: 'last' };
  store.update((d) => {
    d.folders = (d.folders || []).filter((f) => f.id !== id);
    for (const it of d.items || []) {
      if (it.folderId === id) it.folderId = fallback.id;
    }
    for (const f of d.folders || []) {
      if (f.parentId === id) f.parentId = null;
    }
  });
  return { ok: true };
}

function moveFavorite(id, folderId) {
  return updateFavorite(id, { folderId });
}

function setExpandedFolders(ids) {
  store.update((d) => {
    d.expandedFolders = Array.isArray(ids) ? ids.map(String) : [];
  });
  return list();
}

function exportJson() {
  return JSON.stringify(list(), null, 2);
}

function importJson(raw) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: 'parse', message: 'JSON inválido — importação rejeitada' };
  }
  // Bare array of bookmarks is a supported legacy shape (migrateBookmarksData).
  if (Array.isArray(parsed)) {
    /* ok */
  } else if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      reason: 'schema',
      message: 'Formato inválido — esperado objeto com folders/items',
    };
  } else {
    // Reject clearly invalid typed fields before lenient migrate fills defaults
    // (e.g. { folders: 'x', items: [] } must not become ok:true count:0).
    if (
      Object.prototype.hasOwnProperty.call(parsed, 'folders') &&
      !Array.isArray(parsed.folders)
    ) {
      return {
        ok: false,
        reason: 'schema',
        message: 'Formato inválido — esperado objeto com folders/items',
      };
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'items') && !Array.isArray(parsed.items)) {
      return {
        ok: false,
        reason: 'schema',
        message: 'Formato inválido — esperado objeto com folders/items',
      };
    }
    if (
      Object.prototype.hasOwnProperty.call(parsed, 'bookmarks') &&
      !Array.isArray(parsed.bookmarks)
    ) {
      return {
        ok: false,
        reason: 'schema',
        message: 'Formato inválido — esperado objeto com folders/items',
      };
    }
  }
  const { data } = migrateBookmarksData(parsed);
  // Validate
  for (const f of data.folders || []) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || typeof f.name !== 'string') {
      return {
        ok: false,
        reason: 'schema',
        message: 'Importação rejeitada: pasta sem id/nome válidos',
      };
    }
  }
  for (const it of data.items || []) {
    if (!it || typeof it !== 'object' || typeof it.url !== 'string' || !it.url.trim()) {
      return {
        ok: false,
        reason: 'schema',
        message: 'Importação rejeitada: favorito sem URL válida',
      };
    }
  }
  store.set(data);
  return { ok: true, count: (data.items || []).length };
}

function flush() {
  store.flush();
}

module.exports = {
  load,
  get,
  list,
  findByUrl,
  addFavorite,
  updateFavorite,
  removeFavorite,
  createFolder,
  renameFolder,
  deleteFolder,
  moveFavorite,
  setExpandedFolders,
  exportJson,
  importJson,
  flush,
  makeId,
  migrateBookmarksData,
  healFromBackup,
  looksLikeLegacyBarId,
  defaultBookmarks,
  FOLDER_BAR,
  FOLDER_OTHER,
};
