'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { createJsonStore } = require('./json-store');

const MAX_ENTRIES = 50000;
const DEDUPE_MS = 2000;

function defaultHistory() {
  return { version: 1, entries: [] };
}

const store = createJsonStore('history.json', defaultHistory, 600);

/** @type {Map<string, number>} */
const lastRecordAt = new Map();

function load() {
  return store.load();
}

function get() {
  return store.get();
}

function shouldIgnoreUrl(url) {
  const u = String(url || '');
  if (!u) return true;
  if (u.startsWith('about:') || u.startsWith('data:') || u.startsWith('devtools:')) return true;
  if (u.startsWith('chrome:') || u.startsWith('chrome-extension:')) return true;
  return false;
}

function record({ url, title, favicon, windowId, windowName }) {
  if (shouldIgnoreUrl(url)) return null;
  const key = `${windowId || ''}|${url}`;
  const now = Date.now();
  const prev = lastRecordAt.get(key) || 0;
  if (now - prev < DEDUPE_MS) return null;
  lastRecordAt.set(key, now);

  const entry = {
    id: `hist-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    url: String(url),
    title: String(title || ''),
    favicon: favicon || '',
    windowId: windowId || null,
    windowName: windowName || '',
    time: now,
  };

  store.update((d) => {
    if (!d.entries) d.entries = [];
    d.entries.push(entry);
    if (d.entries.length > MAX_ENTRIES) {
      d.entries = d.entries.slice(d.entries.length - MAX_ENTRIES);
    }
  });
  return entry;
}

function query({ search, windowId, limit } = {}) {
  let entries = [...(store.get().entries || [])].reverse();
  if (windowId) {
    entries = entries.filter((e) => e.windowId === windowId);
  }
  if (search) {
    const q = String(search).toLowerCase();
    entries = entries.filter(
      (e) =>
        (e.url && e.url.toLowerCase().includes(q)) ||
        (e.title && e.title.toLowerCase().includes(q)) ||
        (e.windowName && e.windowName.toLowerCase().includes(q))
    );
  }
  if (limit && limit > 0) entries = entries.slice(0, limit);
  return entries;
}

function deleteEntry(id) {
  store.update((d) => {
    d.entries = (d.entries || []).filter((e) => e.id !== id);
  });
  return true;
}

function clearAll() {
  store.update((d) => {
    d.entries = [];
  });
  return true;
}

function clearByWindow(windowId) {
  store.update((d) => {
    d.entries = (d.entries || []).filter((e) => e.windowId !== windowId);
  });
  return true;
}

/**
 * @param {'hour'|'today'|'7days'|'all'} range
 */
function clearByRange(range) {
  const now = Date.now();
  let cutoff = 0;
  if (range === 'hour') cutoff = now - 60 * 60 * 1000;
  else if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    cutoff = d.getTime();
  } else if (range === '7days') cutoff = now - 7 * 24 * 60 * 60 * 1000;
  else if (range === 'all') {
    return clearAll();
  } else {
    return false;
  }
  store.update((d) => {
    d.entries = (d.entries || []).filter((e) => (e.time || 0) < cutoff);
  });
  return true;
}

function flush() {
  store.flush();
}

function getPath() {
  return store.getPath();
}

module.exports = {
  load,
  get,
  record,
  query,
  deleteEntry,
  clearAll,
  clearByWindow,
  clearByRange,
  flush,
  getPath,
  shouldIgnoreUrl,
  MAX_ENTRIES,
};
