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
    expandedFolders: [FOLDER_BAR],
  };
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @type {boolean} */
let migratedBakOnce = false;

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

  // Deduplicate by id
  const seen = new Set();
  folders = folders.filter((f) => {
    if (!f || !f.id || seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });

  // Ensure bar/other ids after rename
  folders = folders.map((f) => {
    if (f.builtIn === 'bar') return { ...f, id: FOLDER_BAR };
    if (f.builtIn === 'other') return { ...f, id: FOLDER_OTHER };
    return f;
  });

  const folderIds = new Set(folders.map((f) => f.id));
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (!it.id) it.id = makeId('bm');
    if (!it.folderId || !folderIds.has(it.folderId)) {
      it.folderId = FOLDER_OTHER;
    }
    if (it.name == null && it.title) it.name = it.title;
    if (it.title == null && it.name) it.title = it.name;
  }
  items = items.filter((it) => it && typeof it.url === 'string' && it.url.trim());

  const expandedFolders = Array.isArray(parsed.expandedFolders)
    ? parsed.expandedFolders
    : [FOLDER_BAR];

  const data = {
    ...parsed,
    version: 2,
    folders,
    items,
    expandedFolders,
  };

  return { data, migrated: wasFlat || Number(parsed.version) < 2 };
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
    store.set(migrated);
    return migrated;
  }
  const data = store.load();
  const { data: migrated, migrated: did } = migrateBookmarksData(data);
  if (did && filePath) backupOnce(filePath);
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
      : FOLDER_OTHER;
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
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      reason: 'schema',
      message: 'Formato inválido — esperado objeto com folders/items',
    };
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
  defaultBookmarks,
  FOLDER_BAR,
  FOLDER_OTHER,
};
