'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, shell } = require('electron');

/** Extensions that must never be executed via shell.openPath. */
const DANGEROUS_EXTS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.ps1',
  '.psm1',
  '.psd1',
  '.lnk',
  '.js',
  '.mjs',
  '.cjs',
  '.vbs',
  '.vbe',
  '.jse',
  '.wsf',
  '.wsh',
  '.msi',
  '.msp',
  '.scr',
  '.pif',
  '.cpl',
  '.hta',
  '.reg',
  '.inf',
  '.dll',
  '.sys',
  '.sh',
  '.bash',
  '.jar',
  '.app',
  '.command',
  '.apk',
]);

/**
 * @param {string} root
 * @param {string} candidate
 */
function isInsideRoot(root, candidate) {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  const rCmp = process.platform === 'win32' ? r.toLowerCase() : r;
  const cCmp = process.platform === 'win32' ? c.toLowerCase() : c;
  const rel = path.relative(rCmp, cCmp);
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve to realpath when possible (handles missing leaf for show-in-folder).
 * @param {string} target
 */
function resolveReal(target) {
  const resolved = path.resolve(String(target || ''));
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Parent may exist; resolve as far as possible
    try {
      const parent = path.dirname(resolved);
      const realParent = fs.realpathSync(parent);
      return path.join(realParent, path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/**
 * Allowed roots: userData (+subs), downloads (system + configured), logs, portable update temp.
 * @returns {string[]}
 */
function getAllowedRoots() {
  const roots = [];
  const push = (p) => {
    if (!p) return;
    const abs = path.resolve(String(p));
    if (!roots.some((r) => isInsideRoot(r, abs) && r.length === abs.length)) {
      // de-dupe exact; still allow nested distinct roots
      if (!roots.includes(abs)) roots.push(abs);
    }
  };

  try {
    push(app.getPath('userData'));
  } catch {
    /* ignore */
  }
  try {
    push(app.getPath('downloads'));
  } catch {
    /* ignore */
  }
  try {
    const downloads = require('./downloads');
    const settings = downloads.getSettings && downloads.getSettings();
    if (settings && settings.defaultFolder) push(settings.defaultFolder);
  } catch {
    /* ignore */
  }
  try {
    const logger = require('./logger');
    if (logger.logsDir) push(logger.logsDir());
  } catch {
    /* ignore */
  }
  try {
    push(path.join(app.getPath('temp'), 'MultiHeiz-update'));
  } catch {
    /* ignore */
  }
  // Optional releases folder under userData (if app creates one later)
  try {
    push(path.join(app.getPath('userData'), 'releases'));
  } catch {
    /* ignore */
  }

  return roots;
}

/**
 * @param {string} target
 * @returns {{ ok: true, real: string } | { ok: false, error: string }}
 */
function assertAllowedPath(target) {
  if (target == null || String(target).trim() === '') {
    return { ok: false, error: 'Caminho vazio' };
  }
  const raw = String(target);
  // Reject null bytes / obvious traversal tokens before resolve
  if (raw.includes('\0')) {
    return { ok: false, error: 'Caminho inválido' };
  }
  const real = resolveReal(raw);
  const roots = getAllowedRoots();
  for (const root of roots) {
    let rootReal = root;
    try {
      rootReal = fs.realpathSync(root);
    } catch {
      rootReal = path.resolve(root);
    }
    if (isInsideRoot(rootReal, real)) {
      return { ok: true, real };
    }
  }
  return { ok: false, error: 'Caminho fora das pastas permitidas do aplicativo' };
}

/**
 * Open a path under app allowlist. Directories: openPath. Files: showItemInFolder
 * (never execute dangerous extensions).
 * @param {string} target
 */
async function openAllowedPath(target) {
  const check = assertAllowedPath(target);
  if (!check.ok) {
    return { ok: false, error: check.error };
  }
  const real = check.real;
  let st = null;
  try {
    st = fs.statSync(real);
  } catch {
    return { ok: false, error: 'Caminho não encontrado' };
  }

  if (st.isDirectory()) {
    const err = await shell.openPath(real);
    return { ok: !err, error: err || null };
  }

  // Files: reveal in folder — never shell-execute
  const ext = path.extname(real).toLowerCase();
  if (DANGEROUS_EXTS.has(ext)) {
    shell.showItemInFolder(real);
    return { ok: true, revealed: true, dangerous: true };
  }
  shell.showItemInFolder(real);
  return { ok: true, revealed: true };
}

module.exports = {
  openAllowedPath,
  assertAllowedPath,
  getAllowedRoots,
  isInsideRoot,
  DANGEROUS_EXTS,
};
