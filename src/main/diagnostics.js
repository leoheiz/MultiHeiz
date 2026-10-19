'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, BrowserWindow } = require('electron');
const logger = require('./logger');
const { getState } = require('./state');

function stripQuery(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return String(url || '').split('?')[0];
  }
}

function sanitizeState(state) {
  const s = JSON.parse(JSON.stringify(state || {}));
  delete s._cookies;
  if (Array.isArray(s.accounts)) {
    for (const a of s.accounts) {
      if (a.lastUrl) a.lastUrl = stripQuery(a.lastUrl);
      if (a.startUrl) a.startUrl = stripQuery(a.startUrl);
      delete a.cookies;
      delete a.cookie;
    }
  }
  return s;
}

function openDataFolder() {
  const { shell } = require('electron');
  return shell.openPath(app.getPath('userData'));
}

async function exportDiagnostics(mainWindow, extra = {}) {
  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(win || undefined, {
    title: 'Exportar diagnóstico',
    defaultPath: path.join(app.getPath('documents'), `multiheiz-diag-${Date.now()}`),
    buttonLabel: 'Exportar',
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  const dest = result.filePath;
  fs.mkdirSync(dest, { recursive: true });

  const sanitized = sanitizeState(getState());
  fs.writeFileSync(path.join(dest, 'state-sanitized.json'), JSON.stringify(sanitized, null, 2), 'utf8');

  const logsSrc = logger.logsDir();
  const logsDest = path.join(dest, 'logs');
  fs.mkdirSync(logsDest, { recursive: true });
  if (fs.existsSync(logsSrc)) {
    for (const f of fs.readdirSync(logsSrc)) {
      try {
        fs.copyFileSync(path.join(logsSrc, f), path.join(logsDest, f));
      } catch {
        /* ignore */
      }
    }
  }

  const meta = {
    exportedAt: new Date().toISOString(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    ...extra,
  };
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  // Ensure no cookie dumps
  const raw = fs.readFileSync(path.join(dest, 'state-sanitized.json'), 'utf8');
  if (/"cookies"\s*:/.test(raw) || /"cookie"\s*:\s*"/.test(raw)) {
    // Strip any accidental cookie fields by re-writing without them
    const cleaned = JSON.parse(raw);
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      for (const k of Object.keys(obj)) {
        if (/cookie/i.test(k)) delete obj[k];
        else walk(obj[k]);
      }
    };
    walk(cleaned);
    fs.writeFileSync(path.join(dest, 'state-sanitized.json'), JSON.stringify(cleaned, null, 2), 'utf8');
  }

  return { ok: true, path: dest };
}

module.exports = {
  stripQuery,
  sanitizeState,
  openDataFolder,
  exportDiagnostics,
};
