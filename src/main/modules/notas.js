'use strict';

const path = require('node:path');
const { app } = require('electron');
const { createJsonStore } = require('../json-store');

function defaultNotas() {
  return { version: 1, notes: [] };
}

function makeId() {
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

let store = null;

function getStore() {
  if (!store) {
    const file = path.join('modules', 'notas.json');
    // createJsonStore joins userData — use relative path under userData
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
  return getStore().load();
}

function list() {
  return [...(getStore().get().notes || [])].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
}

function get(id) {
  return (getStore().get().notes || []).find((n) => n.id === id) || null;
}

function create(title = 'Nova nota') {
  const note = {
    id: makeId(),
    title: String(title || 'Nova nota').trim() || 'Nova nota',
    body: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  getStore().update((d) => {
    if (!d.notes) d.notes = [];
    d.notes.unshift(note);
  });
  return note;
}

function update(id, fields) {
  const note = get(id);
  if (!note) return null;
  if (fields.title != null) note.title = String(fields.title).trim() || note.title;
  if (fields.body != null) note.body = String(fields.body);
  note.updatedAt = Date.now();
  getStore().scheduleSave();
  return note;
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
  // code blocks
  html = html.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code}</code></pre>`);
  // inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // bold / italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  // links [text](url) — only http(s)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  // lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`);
  // paragraphs
  html = html
    .split(/\n{2,}/)
    .map((p) => {
      if (/^<(h[1-3]|ul|pre|li)/.test(p.trim())) return p;
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  // Strip any leftover raw tags that aren't in allowlist (defense in depth)
  // Already escaped input so only our tags exist.
  return html;
}

/** Reject raw HTML in stored body for tests */
function bodyContainsRawHtml(body) {
  return /<[a-zA-Z][^>]*>/.test(String(body || ''));
}

function flush() {
  if (store) store.flush();
}

module.exports = {
  load,
  list,
  get,
  create,
  update,
  remove,
  sanitizeAndRender,
  bodyContainsRawHtml,
  flush,
};
