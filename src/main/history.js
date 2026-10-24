'use strict';

const { createJsonStore } = require('./json-store');

const MAX_ENTRIES = 50000;
const MAX_CLOSED = 100;
/** Ignore duplicate navigations within this window (ms). */
const DEDUPE_MS = 2000;
/** Collapse consecutive same-URL visits in the same window within this window (ms). */
const COLLAPSE_MS = 10 * 60 * 1000;

/** Param names (exact or substring) stripped before save — case-insensitive. */
const SENSITIVE_EXACT = new Set([
  'token',
  'auth',
  'signature',
  'sig',
  'session',
  'sid',
  'key',
  'apikey',
  'api_key',
  'password',
  'pass',
  'secret',
  'code',
  'access_token',
  'accesstoken',
  'refresh_token',
  'id_token',
  'authtoken',
  'auth_token',
]);

function defaultHistory() {
  return { version: 1, entries: [], recentlyClosed: [], sensitiveMigrated: false };
}

const store = createJsonStore('history.json', defaultHistory, 600);

/** @type {Map<string, number>} */
const lastRecordAt = new Map();

function isSensitiveParamName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (SENSITIVE_EXACT.has(n)) return true;
  return /token|auth|signature|secret|password|apikey|access_token|session/.test(n);
}

/**
 * Strip sensitive query params; keep other search params.
 * @param {string} url
 * @returns {string}
 */
function stripSensitiveUrl(url) {
  const raw = String(url || '');
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    const toDelete = [];
    for (const key of u.searchParams.keys()) {
      if (isSensitiveParamName(key)) toDelete.push(key);
    }
    for (const key of toDelete) u.searchParams.delete(key);
    return u.toString();
  } catch {
    // Non-URL: drop query-ish tail if it looks like sensitive
    const q = raw.indexOf('?');
    if (q < 0) return raw;
    return raw.slice(0, q);
  }
}

/**
 * URL without query string or fragment (for tooltips).
 * @param {string} url
 * @returns {string}
 */
function urlWithoutQuery(url) {
  try {
    const u = new URL(String(url || ''));
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return String(url || '').split(/[?#]/)[0];
  }
}

/**
 * Hostname/domain for row display.
 * @param {string} url
 * @returns {string}
 */
function domainOf(url) {
  try {
    return new URL(String(url || '')).hostname || '';
  } catch {
    return '';
  }
}

function migrateSensitiveOnce() {
  const d = store.get();
  if (d.sensitiveMigrated) return;
  store.update((data) => {
    if (data.sensitiveMigrated) return;
    let changed = false;
    for (const e of data.entries || []) {
      if (!e || !e.url) continue;
      const cleaned = stripSensitiveUrl(e.url);
      if (cleaned !== e.url) {
        e.url = cleaned;
        changed = true;
      }
    }
    for (const e of data.recentlyClosed || []) {
      if (!e || !e.url) continue;
      const cleaned = stripSensitiveUrl(e.url);
      if (cleaned !== e.url) {
        e.url = cleaned;
        changed = true;
      }
    }
    data.sensitiveMigrated = true;
    void changed;
  });
}

function load() {
  const d = store.load();
  if (!Array.isArray(d.recentlyClosed)) d.recentlyClosed = [];
  if (typeof d.sensitiveMigrated !== 'boolean') d.sensitiveMigrated = false;
  migrateSensitiveOnce();
  return store.get();
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

/**
 * True when title is a real page title (not empty, not a raw URL/path).
 * @param {string} title
 * @param {string} [url]
 * @returns {boolean}
 */
function isUsefulTitle(title, url) {
  const t = String(title || '').trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && t.includes('://')) return false;
  const rawUrl = String(url || '');
  if (rawUrl && (t === rawUrl || t === stripSensitiveUrl(rawUrl))) return false;
  try {
    const u = new URL(rawUrl || t);
    if (t === u.href || t === u.origin || t === u.host || t === u.hostname) return false;
    if (t === u.pathname || t === u.pathname + u.search) return false;
    const host = u.hostname.replace(/^www\./i, '');
    if (t === host || t === `www.${host}`) return false;
  } catch {
    /* title may not be a URL */
  }
  // Path-like chrome default before real title arrives
  if (t.startsWith('/') && t.length > 1) return false;
  return true;
}

/**
 * Title for UI rows: useful title, else domain only (never path/query).
 * @param {{ title?: string, url?: string }|null|undefined} entry
 * @returns {string}
 */
function displayTitle(entry) {
  if (!entry) return 'Página';
  const url = entry.url || '';
  if (isUsefulTitle(entry.title, url)) return String(entry.title).trim();
  return domainOf(url) || 'Página';
}

/**
 * Normalize title for storage: empty when not useful (updated later via page-title-updated).
 * @param {string} title
 * @param {string} [url]
 * @returns {string}
 */
function cleanTitle(title, url) {
  return isUsefulTitle(title, url) ? String(title).trim() : '';
}

/**
 * Update the latest matching history row when the real page title arrives (SPA-friendly).
 * @param {{ windowId?: string|null, url?: string, title?: string }} opts
 * @returns {boolean}
 */
function updateTitle({ windowId, url, title } = {}) {
  const wid = windowId || null;
  const safeUrl = url ? stripSensitiveUrl(url) : '';
  const nextTitle = cleanTitle(title, safeUrl || url);
  if (!nextTitle) return false;
  let updated = false;
  store.update((d) => {
    if (!d.entries || !d.entries.length) return;
    for (let i = d.entries.length - 1; i >= 0; i--) {
      const e = d.entries[i];
      if (!e) continue;
      if (wid != null && e.windowId !== wid) continue;
      if (safeUrl && e.url !== safeUrl) continue;
      if (e.title === nextTitle) {
        updated = true;
        return;
      }
      e.title = nextTitle;
      updated = true;
      return;
    }
  });
  return updated;
}

function record({ url, title, favicon, windowId, windowName }) {
  if (shouldIgnoreUrl(url)) return null;
  const safeUrl = stripSensitiveUrl(url);
  const key = `${windowId || ''}|${safeUrl}`;
  const now = Date.now();
  const storedTitle = cleanTitle(title, safeUrl);
  /** @type {object|null} */
  let result = null;
  /** @type {'collapsed'|'created'|'skipped'} */
  let outcome = 'skipped';

  store.update((d) => {
    if (!d.entries) d.entries = [];
    // Collapse consecutive same-URL visits (same window) within ~10 min.
    for (let i = d.entries.length - 1; i >= 0; i--) {
      const e = d.entries[i];
      if (!e) continue;
      const sameWindow = (e.windowId || null) === (windowId || null);
      if (!sameWindow) continue;
      if (e.url === safeUrl && now - (e.time || 0) <= COLLAPSE_MS) {
        e.time = now;
        e.visitCount = (Number(e.visitCount) || 1) + 1;
        if (storedTitle) e.title = storedTitle;
        if (favicon) e.favicon = favicon;
        if (windowName) e.windowName = windowName;
        result = e;
        outcome = 'collapsed';
        return;
      }
      // Different URL in this window → not consecutive
      break;
    }
    const prevAt = lastRecordAt.get(key) || 0;
    if (now - prevAt < DEDUPE_MS) {
      outcome = 'skipped';
      return;
    }
    const entry = {
      id: `hist-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      url: safeUrl,
      title: storedTitle,
      favicon: favicon || '',
      windowId: windowId || null,
      windowName: windowName || '',
      time: now,
      visitCount: 1,
    };
    d.entries.push(entry);
    if (d.entries.length > MAX_ENTRIES) {
      d.entries = d.entries.slice(d.entries.length - MAX_ENTRIES);
    }
    result = entry;
    outcome = 'created';
  });

  if (outcome === 'collapsed' || outcome === 'created') {
    lastRecordAt.set(key, now);
  } else if (storedTitle) {
    updateTitle({ windowId, url: safeUrl, title });
  }
  return result;
}

/**
 * Record a closed page/window for "Fechadas recentemente".
 */
function recordClosed({ url, title, favicon, windowId, windowName }) {
  if (shouldIgnoreUrl(url)) return null;
  const safeUrl = stripSensitiveUrl(url);
  const now = Date.now();
  const entry = {
    id: `closed-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    url: safeUrl,
    title: String(title || ''),
    favicon: favicon || '',
    windowId: windowId || null,
    windowName: windowName || '',
    time: now,
  };
  store.update((d) => {
    if (!Array.isArray(d.recentlyClosed)) d.recentlyClosed = [];
    d.recentlyClosed.unshift(entry);
    if (d.recentlyClosed.length > MAX_CLOSED) {
      d.recentlyClosed = d.recentlyClosed.slice(0, MAX_CLOSED);
    }
  });
  return entry;
}

function query({ search, windowId, limit, closed } = {}) {
  const source = closed
    ? [...(store.get().recentlyClosed || [])]
    : [...(store.get().entries || [])].reverse();
  let entries = source;
  if (windowId) {
    entries = entries.filter((e) => e.windowId === windowId);
  }
  if (search) {
    const q = String(search).toLowerCase();
    entries = entries.filter(
      (e) =>
        (e.url && e.url.toLowerCase().includes(q)) ||
        (e.title && e.title.toLowerCase().includes(q)) ||
        (e.windowName && e.windowName.toLowerCase().includes(q)) ||
        (domainOf(e.url) && domainOf(e.url).toLowerCase().includes(q))
    );
  }
  if (limit && limit > 0) entries = entries.slice(0, limit);
  return entries;
}

function deleteEntry(id) {
  store.update((d) => {
    d.entries = (d.entries || []).filter((e) => e.id !== id);
    d.recentlyClosed = (d.recentlyClosed || []).filter((e) => e.id !== id);
  });
  return true;
}

function deleteEntries(ids) {
  const set = new Set((ids || []).map(String));
  if (!set.size) return true;
  store.update((d) => {
    d.entries = (d.entries || []).filter((e) => !set.has(e.id));
    d.recentlyClosed = (d.recentlyClosed || []).filter((e) => !set.has(e.id));
  });
  return true;
}

function clearAll() {
  store.update((d) => {
    d.entries = [];
    d.recentlyClosed = [];
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
  recordClosed,
  query,
  updateTitle,
  deleteEntry,
  deleteEntries,
  clearAll,
  clearByWindow,
  clearByRange,
  flush,
  getPath,
  shouldIgnoreUrl,
  stripSensitiveUrl,
  urlWithoutQuery,
  domainOf,
  isUsefulTitle,
  cleanTitle,
  displayTitle,
  migrateSensitiveOnce,
  MAX_ENTRIES,
  COLLAPSE_MS,
  DEDUPE_MS,
};
