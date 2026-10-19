'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, shell, dialog, BrowserWindow } = require('electron');
const { createJsonStore } = require('./json-store');

function defaultDownloads() {
  return {
    version: 1,
    items: [],
    settings: {
      defaultFolder: '',
      askWhereToSave: false,
    },
  };
}

const store = createJsonStore('downloads.json', defaultDownloads, 500);

/** @type {Map<string, import('electron').DownloadItem>} */
const activeItems = new Map();

/** @type {((payload: object) => void) | null} */
let emitFn = null;

/** @type {Set<string>} */
const hookedSessions = new Set();

function makeId() {
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function load() {
  const data = store.load();
  if (!data.settings) data.settings = defaultDownloads().settings;
  // Mark in-progress as interrupted on restart
  for (const it of data.items || []) {
    if (it.state === 'progressing' || it.state === 'paused') {
      it.state = 'interrupted';
      it.receivedBytes = it.receivedBytes || 0;
    }
  }
  store.scheduleSave();
  return data;
}

function init(emit) {
  emitFn = emit;
}

function emit(payload) {
  if (emitFn) emitFn(payload);
}

function getSettings() {
  const data = store.get();
  return {
    defaultFolder: (data.settings && data.settings.defaultFolder) || app.getPath('downloads'),
    askWhereToSave: !!(data.settings && data.settings.askWhereToSave),
  };
}

function updateSettings(partial) {
  store.update((d) => {
    if (!d.settings) d.settings = defaultDownloads().settings;
    Object.assign(d.settings, partial || {});
  });
  return getSettings();
}

function list() {
  return [...(store.get().items || [])].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function activeCount() {
  return [...(store.get().items || [])].filter(
    (it) => it.state === 'progressing' || it.state === 'paused'
  ).length;
}

function findItem(id) {
  return (store.get().items || []).find((it) => it.id === id) || null;
}

function upsertItem(item) {
  store.update((d) => {
    if (!d.items) d.items = [];
    const idx = d.items.findIndex((x) => x.id === item.id);
    if (idx >= 0) d.items[idx] = item;
    else d.items.unshift(item);
    // Keep completed list bounded
    if (d.items.length > 500) d.items = d.items.slice(0, 500);
  });
  emit({ type: 'downloads:changed', items: list(), activeCount: activeCount() });
}

function hookSession(ses, getSourceMeta) {
  if (!ses) return;
  const key = ses.storagePath || ses.partition || String(ses);
  if (hookedSessions.has(key)) return;
  hookedSessions.add(key);

  ses.on('will-download', async (event, item, webContents) => {
    const id = makeId();
    const meta = typeof getSourceMeta === 'function' ? getSourceMeta(webContents) || {} : {};
    const settings = getSettings();
    let savePath = path.join(settings.defaultFolder, item.getFilename());

    if (settings.askWhereToSave) {
      const win = BrowserWindow.fromWebContents(webContents) || BrowserWindow.getFocusedWindow();
      const result = await dialog.showSaveDialog(win || undefined, {
        defaultPath: savePath,
      });
      if (result.canceled || !result.filePath) {
        item.cancel();
        return;
      }
      savePath = result.filePath;
    } else {
      try {
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
      } catch {
        /* ignore */
      }
      // Avoid overwrite
      if (fs.existsSync(savePath)) {
        const ext = path.extname(savePath);
        const base = path.basename(savePath, ext);
        const dir = path.dirname(savePath);
        let n = 1;
        while (fs.existsSync(path.join(dir, `${base} (${n})${ext}`))) n += 1;
        savePath = path.join(dir, `${base} (${n})${ext}`);
      }
    }

    item.setSavePath(savePath);
    activeItems.set(id, item);

    const record = {
      id,
      filename: path.basename(savePath),
      savePath,
      url: item.getURL(),
      mimeType: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'progressing',
      speed: 0,
      windowId: meta.windowId || null,
      windowName: meta.windowName || '',
      startedAt: Date.now(),
      endedAt: null,
      error: null,
    };
    upsertItem(record);

    let lastBytes = 0;
    let lastAt = Date.now();

    item.on('updated', (_e, state) => {
      const now = Date.now();
      const received = item.getReceivedBytes();
      const dt = Math.max(1, now - lastAt);
      const speed = Math.round(((received - lastBytes) * 1000) / dt);
      lastBytes = received;
      lastAt = now;
      const cur = findItem(id) || record;
      cur.receivedBytes = received;
      cur.totalBytes = item.getTotalBytes();
      cur.speed = speed;
      cur.state = state === 'interrupted' ? 'paused' : 'progressing';
      if (item.isPaused()) cur.state = 'paused';
      upsertItem(cur);
    });

    item.once('done', (_e, state) => {
      activeItems.delete(id);
      const cur = findItem(id) || record;
      cur.receivedBytes = item.getReceivedBytes();
      cur.totalBytes = item.getTotalBytes();
      cur.endedAt = Date.now();
      cur.speed = 0;
      if (state === 'completed') cur.state = 'completed';
      else if (state === 'cancelled') cur.state = 'cancelled';
      else cur.state = 'failed';
      upsertItem(cur);
    });
  });
}

function pause(id) {
  const item = activeItems.get(id);
  if (item && !item.isPaused()) item.pause();
  return true;
}

function resume(id) {
  const item = activeItems.get(id);
  if (item && item.canResume()) item.resume();
  return true;
}

function cancel(id) {
  const item = activeItems.get(id);
  if (item) item.cancel();
  const cur = findItem(id);
  if (cur && (cur.state === 'progressing' || cur.state === 'paused')) {
    cur.state = 'cancelled';
    cur.endedAt = Date.now();
    upsertItem(cur);
  }
  return true;
}

function openFile(id) {
  const cur = findItem(id);
  if (!cur || !cur.savePath) return { ok: false };
  return shell.openPath(cur.savePath).then((err) => ({ ok: !err, error: err || null }));
}

function showInFolder(id) {
  const cur = findItem(id);
  if (!cur || !cur.savePath) return { ok: false };
  shell.showItemInFolder(cur.savePath);
  return { ok: true };
}

function removeFromList(id) {
  activeItems.delete(id);
  store.update((d) => {
    d.items = (d.items || []).filter((it) => it.id !== id);
  });
  emit({ type: 'downloads:changed', items: list(), activeCount: activeCount() });
  return true;
}

function flush() {
  store.flush();
}

module.exports = {
  load,
  init,
  hookSession,
  list,
  activeCount,
  getSettings,
  updateSettings,
  pause,
  resume,
  cancel,
  openFile,
  showInFolder,
  removeFromList,
  flush,
  findItem,
};
