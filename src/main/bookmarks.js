'use strict';

const { createJsonStore } = require('./json-store');

function defaultBookmarks() {
  return {
    version: 1,
    folders: [{ id: 'folder-default', name: 'Favoritos', order: 0 }],
    items: [],
  };
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const store = createJsonStore('bookmarks.json', defaultBookmarks);

function load() {
  return store.load();
}

function get() {
  return store.get();
}

function list() {
  const data = store.get();
  return {
    folders: [...(data.folders || [])].sort((a, b) => (a.order || 0) - (b.order || 0)),
    items: [...(data.items || [])],
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
      : (folders[0] && folders[0].id) || 'folder-default';
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

function createFolder(name) {
  const folder = {
    id: makeId('folder'),
    name: String(name || 'Nova pasta').trim() || 'Nova pasta',
    order: (store.get().folders || []).length,
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
  folder.name = String(name || '').trim() || folder.name;
  store.scheduleSave();
  return folder;
}

function deleteFolder(id) {
  const data = store.get();
  if ((data.folders || []).length <= 1) return { ok: false, reason: 'last' };
  const fallback = (data.folders || []).find((f) => f.id !== id);
  if (!fallback) return { ok: false, reason: 'last' };
  store.update((d) => {
    d.folders = (d.folders || []).filter((f) => f.id !== id);
    for (const it of d.items || []) {
      if (it.folderId === id) it.folderId = fallback.id;
    }
  });
  return { ok: true };
}

function moveFavorite(id, folderId) {
  return updateFavorite(id, { folderId });
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'schema',
      message: 'Formato inválido — esperado objeto com folders/items',
    };
  }
  if (parsed.folders != null && !Array.isArray(parsed.folders)) {
    return {
      ok: false,
      reason: 'schema',
      message: 'Importação rejeitada: folders deve ser um array',
    };
  }
  if (parsed.items != null && !Array.isArray(parsed.items)) {
    return {
      ok: false,
      reason: 'schema',
      message: 'Importação rejeitada: items deve ser um array',
    };
  }
  const folders = Array.isArray(parsed.folders) ? parsed.folders : [];
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  // Reject clearly malformed folder/item entries
  for (const f of folders) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || typeof f.name !== 'string') {
      return {
        ok: false,
        reason: 'schema',
        message: 'Importação rejeitada: pasta sem id/nome válidos',
      };
    }
  }
  for (const it of items) {
    if (!it || typeof it !== 'object' || typeof it.url !== 'string' || !it.url.trim()) {
      return {
        ok: false,
        reason: 'schema',
        message: 'Importação rejeitada: favorito sem URL válida',
      };
    }
  }
  store.set({
    version: 1,
    folders: folders.length ? folders : defaultBookmarks().folders,
    items,
  });
  return { ok: true, count: items.length };
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
  exportJson,
  importJson,
  flush,
  makeId,
};
