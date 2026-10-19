'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { idFromManifestKey, idFromBytes } = require('./crx');

/** Permissions / APIs Electron typically cannot honour (warn only). */
const UNSUPPORTED = new Set([
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
  'declarativeNetRequestFeedback',
  'sidePanel',
  'offscreen',
  'proxy',
  'debugger',
  'vpnProvider',
  'enterprise.deviceAttributes',
  'printing',
  'certificateProvider',
  'webRequestBlocking',
]);

/**
 * @param {string} dir
 */
function readManifest(dir) {
  const p = path.join(dir, 'manifest.json');
  const raw = fs.readFileSync(p, 'utf8');
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest.json inválido');
  }
  return manifest;
}

/**
 * @param {object} manifest
 * @returns {string[]}
 */
function collectWarnings(manifest) {
  /** @type {string[]} */
  const out = [];
  const perms = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
  ].map(String);

  for (const p of perms) {
    if (UNSUPPORTED.has(p)) {
      out.push(`Permissão/API não suportada no Electron: ${p}`);
    }
  }
  if (manifest.declarative_net_request) {
    out.push(
      'declarative_net_request — regras estáticas aplicadas via shim DNR do MultiHeiz'
    );
  }
  if (Number(manifest.manifest_version) === 2) {
    out.push('Manifest V2 — suporte limitado no Chromium atual');
  }
  const bg = manifest.background;
  if (bg && bg.service_worker) {
    // Electron supports SW extensions with caveats
  }
  return [...new Set(out)];
}

/**
 * @param {object} manifest
 * @param {string} dir
 * @param {string} [preferredId]
 */
function resolveInstallId(manifest, dir, preferredId) {
  if (preferredId && /^[a-p]{32}$/.test(preferredId)) return preferredId;
  if (manifest.key) {
    try {
      return idFromManifestKey(manifest.key);
    } catch {
      /* fall through */
    }
  }
  return idFromBytes(Buffer.from(path.resolve(dir), 'utf8'));
}

/**
 * @param {object} manifest
 * @param {string} dir
 * @returns {string|null} data URL or null
 */
function readIconDataUrl(manifest, dir) {
  const icons = manifest.icons || {};
  const keys = Object.keys(icons)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  let rel = keys.length ? icons[String(keys[0])] : null;
  if (!rel && manifest.action && manifest.action.default_icon) {
    const di = manifest.action.default_icon;
    if (typeof di === 'string') rel = di;
    else if (di && typeof di === 'object') {
      const ks = Object.keys(di)
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => b - a);
      if (ks.length) rel = di[String(ks[0])];
    }
  }
  if (!rel) return null;
  const abs = path.join(dir, rel);
  if (!fs.existsSync(abs)) return null;
  try {
    const buf = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === '.svg'
        ? 'image/svg+xml'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * @param {object} manifest
 */
function actionInfo(manifest) {
  const action = manifest.action || manifest.browser_action || manifest.page_action || null;
  if (!action) {
    return { hasAction: false, popup: null, title: null };
  }
  return {
    hasAction: true,
    popup: action.default_popup || null,
    title: action.default_title || manifest.name || null,
  };
}

/**
 * @param {object} manifest
 */
function optionsPage(manifest) {
  if (manifest.options_ui && manifest.options_ui.page) return String(manifest.options_ui.page);
  if (manifest.options_page) return String(manifest.options_page);
  return null;
}

/**
 * Localized name fallback (no full _locales resolve).
 * @param {object} manifest
 * @param {string} dir
 */
function displayName(manifest, dir) {
  let name = String(manifest.name || 'Extensão');
  if (name.startsWith('__MSG_') && name.endsWith('__')) {
    const key = name.slice(6, -2);
    const locales = ['pt_BR', 'pt_PT', 'en', 'en_US'];
    for (const loc of locales) {
      const p = path.join(dir, '_locales', loc, 'messages.json');
      if (!fs.existsSync(p)) continue;
      try {
        const msg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (msg[key] && msg[key].message) return String(msg[key].message);
      } catch {
        /* ignore */
      }
    }
  }
  return name;
}

/**
 * @param {string} dir
 * @param {{ preferredId?: string, source?: string, storeId?: string }} [meta]
 */
/**
 * Heuristic: extension that filters network (DNR / known blockers).
 * @param {object} manifest
 * @param {string[]} permissions
 */
function isNetworkBlocker(manifest, permissions) {
  if (manifest.declarative_net_request) return true;
  const perms = new Set(permissions.map(String));
  if (perms.has('declarativeNetRequest') || perms.has('declarativeNetRequestWithHostAccess')) {
    return true;
  }
  const name = String(manifest.name || '').toLowerCase();
  if (/adblock|ad block|ublock|adguard/.test(name)) return true;
  return false;
}

function buildRecord(dir, meta = {}) {
  const manifest = readManifest(dir);
  let dnrSnap = null;
  const snapPath = path.join(dir, 'multiheiz-dnr.json');
  if (fs.existsSync(snapPath)) {
    try {
      dnrSnap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    } catch {
      dnrSnap = null;
    }
  }
  const manifestForWarn = dnrSnap && dnrSnap.declarative_net_request
    ? { ...manifest, declarative_net_request: dnrSnap.declarative_net_request }
    : manifest;
  const id = resolveInstallId(manifest, dir, meta.preferredId || meta.storeId);
  const act = actionInfo(manifest);
  const version = String(manifest.version || '0');
  const permissions = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
    ...(dnrSnap && Array.isArray(dnrSnap.permissions) ? dnrSnap.permissions : []),
  ].map(String);
  const uniqPerms = [...new Set(permissions)];
  const hasDnr = !!(
    (dnrSnap && dnrSnap.declarative_net_request) ||
    manifest.declarative_net_request
  );
  return {
    id,
    name: displayName(manifest, dir),
    version,
    description: String(manifest.description || ''),
    manifestVersion: Number(manifest.manifest_version) || 2,
    path: path.resolve(dir),
    enabled: true,
    applyTo: 'all',
    source: meta.source || 'unpacked',
    storeId: meta.storeId || null,
    iconDataUrl: readIconDataUrl(manifest, dir),
    hasAction: act.hasAction,
    actionPopup: act.popup,
    actionTitle: act.title,
    optionsPage: optionsPage(manifest),
    warnings: collectWarnings(manifestForWarn),
    permissions: uniqPerms,
    networkBlocker: isNetworkBlocker(manifestForWarn, uniqPerms) || hasDnr,
    hasDnr,
    installedAt: Date.now(),
  };
}

module.exports = {
  readManifest,
  collectWarnings,
  buildRecord,
  resolveInstallId,
  isNetworkBlocker,
  UNSUPPORTED,
};
