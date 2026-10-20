'use strict';

const path = require('node:path');
const { app } = require('electron');
const { createJsonStore } = require('../json-store');

/** Cores estilo Keep (id estável). Tons claros/escuros para fundo + texto legível. */
const NOTE_COLORS = [
  {
    id: 'padrao',
    label: 'Padrão',
    light: { bg: '#ffffff', text: '#202124' },
    dark: { bg: '#2d3139', text: '#e8eaed' },
  },
  {
    id: 'vermelho',
    label: 'Vermelho',
    light: { bg: '#f28b82', text: '#202124' },
    dark: { bg: '#5c2b29', text: '#f8d7d4' },
  },
  {
    id: 'laranja',
    label: 'Laranja',
    light: { bg: '#fbbc04', text: '#202124' },
    dark: { bg: '#614a19', text: '#fde7a8' },
  },
  {
    id: 'amarelo',
    label: 'Amarelo',
    light: { bg: '#fff475', text: '#202124' },
    dark: { bg: '#635d19', text: '#fff9c4' },
  },
  {
    id: 'verde',
    label: 'Verde',
    light: { bg: '#ccff90', text: '#202124' },
    dark: { bg: '#345920', text: '#d7f7b8' },
  },
  {
    id: 'petroleo',
    label: 'Azul-petróleo',
    light: { bg: '#a7ffeb', text: '#202124' },
    dark: { bg: '#16504b', text: '#b2f5ea' },
  },
  {
    id: 'azul',
    label: 'Azul',
    light: { bg: '#aecbfa', text: '#202124' },
    dark: { bg: '#2a4365', text: '#c3dafe' },
  },
  {
    id: 'roxo',
    label: 'Roxo',
    light: { bg: '#d7aefb', text: '#202124' },
    dark: { bg: '#42275a', text: '#e9d5ff' },
  },
  {
    id: 'rosa',
    label: 'Rosa',
    light: { bg: '#fdcfe8', text: '#202124' },
    dark: { bg: '#5b2c46', text: '#fbcfe8' },
  },
];

const COLOR_IDS = new Set(NOTE_COLORS.map((c) => c.id));
const STORE_VERSION = 2;

function defaultNotas() {
  return { version: STORE_VERSION, notes: [] };
}

function makeId() {
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Derive title from first non-empty line of body, else "Sem título".
 * @param {string} body
 * @param {string} [fallbackTitle]
 */
function deriveTitle(body, fallbackTitle) {
  const existing = String(fallbackTitle || '').trim();
  if (existing) return existing;
  const first = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  if (!first) return 'Sem título';
  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}

function normalizeColor(color) {
  const id = String(color || 'padrao');
  return COLOR_IDS.has(id) ? id : 'padrao';
}

/**
 * Relative luminance of hex color (sRGB).
 * @param {string} hex
 */
function hexLuminance(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return 0;
  const toLin = (c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = toLin(h.slice(0, 2));
  const g = toLin(h.slice(2, 4));
  const b = toLin(h.slice(4, 6));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Contrast ratio between two hex colors (WCAG).
 * @param {string} a
 * @param {string} b
 */
function contrastRatio(a, b) {
  const L1 = hexLuminance(a);
  const L2 = hexLuminance(b);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pick readable text for a background (prefer palette text; fallback black/white).
 * @param {string} bgHex
 * @param {string} [preferredText]
 */
function readableTextColor(bgHex, preferredText) {
  const candidates = [preferredText, '#202124', '#e8eaed', '#000000', '#ffffff'].filter(Boolean);
  let best = candidates[0] || '#202124';
  let bestRatio = 0;
  for (const c of candidates) {
    const r = contrastRatio(bgHex, c);
    if (r > bestRatio) {
      bestRatio = r;
      best = c;
    }
  }
  return best;
}

/**
 * Resolve theme tones for a color id.
 * @param {string} colorId
 * @param {'claro'|'escuro'|string} theme
 */
function resolveColorTone(colorId, theme) {
  const entry = NOTE_COLORS.find((c) => c.id === normalizeColor(colorId)) || NOTE_COLORS[0];
  const dark = theme === 'escuro' || theme === 'grafite' || theme === 'dark';
  const tone = dark ? entry.dark : entry.light;
  const text = readableTextColor(tone.bg, tone.text);
  return { id: entry.id, label: entry.label, bg: tone.bg, text, contrast: contrastRatio(tone.bg, text) };
}

function migrateNote(raw) {
  const body = raw && raw.body != null ? String(raw.body) : '';
  const title = deriveTitle(body, raw && raw.title);
  return {
    id: (raw && raw.id) || makeId(),
    title,
    body,
    color: normalizeColor(raw && raw.color),
    pinned: !!(raw && raw.pinned),
    createdAt: Number((raw && raw.createdAt) || Date.now()),
    updatedAt: Number((raw && raw.updatedAt) || Date.now()),
  };
}

function migrateData(data) {
  const notes = Array.isArray(data && data.notes) ? data.notes.map(migrateNote) : [];
  return { version: STORE_VERSION, notes };
}

let store = null;

function getStore() {
  if (!store) {
    const file = path.join('modules', 'notas.json');
    store = createJsonStore(file, defaultNotas, 400);
  }
  return store;
}

function ensureDir() {
  const dir = path.join(app.getPath('userData'), 'modules');
  require('node:fs').mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir();
  const data = getStore().load();
  const needsMigrate =
    !data ||
    data.version !== STORE_VERSION ||
    (data.notes || []).some(
      (n) =>
        n.color == null ||
        n.pinned == null ||
        !String(n.title || '').trim() ||
        !COLOR_IDS.has(normalizeColor(n.color))
    );
  if (needsMigrate) {
    const migrated = migrateData(data || defaultNotas());
    getStore().set(migrated);
    getStore().flush();
    return migrated;
  }
  // Normalize in place without rewriting titles that already exist
  getStore().update((d) => {
    d.version = STORE_VERSION;
    d.notes = (d.notes || []).map((n) => ({
      ...n,
      title: String(n.title || '').trim() || deriveTitle(n.body, ''),
      color: normalizeColor(n.color),
      pinned: !!n.pinned,
    }));
  });
  return getStore().get();
}

/**
 * List notes: pinned first (Fixadas), then others; within each group by updatedAt desc.
 * Order of pinned relative to each other preserved by updatedAt (stable enough).
 */
function list() {
  const notes = [...(getStore().get().notes || [])];
  const pinned = notes.filter((n) => n.pinned).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const others = notes.filter((n) => !n.pinned).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return [...pinned, ...others];
}

function get(id) {
  return (getStore().get().notes || []).find((n) => n.id === id) || null;
}

function create(title = 'Nova nota') {
  const note = {
    id: makeId(),
    title: String(title || 'Nova nota').trim() || 'Nova nota',
    body: '',
    color: 'padrao',
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  getStore().update((d) => {
    if (!d.notes) d.notes = [];
    d.notes.unshift(note);
    d.version = STORE_VERSION;
  });
  return { ...note };
}

function update(id, fields) {
  let updated = null;
  getStore().update((d) => {
    const note = (d.notes || []).find((n) => n.id === id);
    if (!note) return;
    if (fields.title != null) {
      const t = String(fields.title).trim();
      note.title = t || deriveTitle(note.body, 'Sem título');
    }
    if (fields.body != null) note.body = String(fields.body);
    if (fields.color != null) note.color = normalizeColor(fields.color);
    if (fields.pinned != null) note.pinned = !!fields.pinned;
    note.updatedAt = Date.now();
    updated = { ...note };
  });
  return updated;
}

function setPinned(id, pinned) {
  return update(id, { pinned: !!pinned });
}

function remove(id) {
  getStore().update((d) => {
    d.notes = (d.notes || []).filter((n) => n.id !== id);
  });
  return true;
}

/**
 * Sanitize markdown-ish text: escape HTML, then apply safe markdown.
 */
function sanitizeAndRender(md) {
  const escaped = String(md || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  let html = escaped;
  html = html.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
  html = html
    .split(/\n{2,}/)
    .map((p) => {
      if (/^<(h[1-3]|ul|pre|li)/.test(p.trim())) return p;
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  return html;
}

/** Reject raw HTML in stored body for tests */
function bodyContainsRawHtml(body) {
  return /<[a-zA-Z][^>]*>/.test(String(body || ''));
}

function flush() {
  if (store) store.flush();
}

function getColorPalette() {
  return NOTE_COLORS.map((c) => ({ id: c.id, label: c.label }));
}

module.exports = {
  load,
  list,
  get,
  create,
  update,
  setPinned,
  remove,
  sanitizeAndRender,
  bodyContainsRawHtml,
  flush,
  deriveTitle,
  migrateNote,
  migrateData,
  normalizeColor,
  resolveColorTone,
  readableTextColor,
  contrastRatio,
  hexLuminance,
  getColorPalette,
  NOTE_COLORS,
  STORE_VERSION,
};
