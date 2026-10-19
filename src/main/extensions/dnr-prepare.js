'use strict';

/**
 * Electron's session.extensions.loadExtension may reject or ignore
 * declarative_net_request. We snapshot DNR metadata for the shim and strip
 * it from manifest.json so content scripts / action popup still load.
 */

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT = 'multiheiz-dnr.json';

/**
 * @param {string} extDir
 * @returns {{ manifest: object, snapshot: object|null }}
 */
function prepareExtensionDir(extDir) {
  const manifestPath = path.join(extDir, 'manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  if (!manifest.declarative_net_request && !hasDnrPermission(manifest)) {
    return { manifest, snapshot: null };
  }

  const snapshot = {
    version: 1,
    declarative_net_request: manifest.declarative_net_request || null,
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions.slice() : [],
  };
  fs.writeFileSync(path.join(extDir, SNAPSHOT), JSON.stringify(snapshot, null, 2), 'utf8');

  const cleaned = { ...manifest };
  delete cleaned.declarative_net_request;
  if (Array.isArray(cleaned.permissions)) {
    cleaned.permissions = cleaned.permissions.filter(
      (p) =>
        p !== 'declarativeNetRequest' &&
        p !== 'declarativeNetRequestWithHostAccess' &&
        p !== 'declarativeNetRequestFeedback'
    );
  }
  if (Array.isArray(cleaned.optional_permissions)) {
    cleaned.optional_permissions = cleaned.optional_permissions.filter(
      (p) =>
        p !== 'declarativeNetRequest' &&
        p !== 'declarativeNetRequestWithHostAccess' &&
        p !== 'declarativeNetRequestFeedback'
    );
  }
  fs.writeFileSync(manifestPath, JSON.stringify(cleaned, null, 2), 'utf8');
  return { manifest: cleaned, snapshot };
}

/**
 * @param {object} manifest
 */
function hasDnrPermission(manifest) {
  const perms = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
  ];
  return perms.some(
    (p) =>
      p === 'declarativeNetRequest' ||
      p === 'declarativeNetRequestWithHostAccess' ||
      p === 'declarativeNetRequestFeedback'
  );
}

/**
 * Manifest view for DNR shim (restores rule_resources from snapshot if stripped).
 * @param {string} extDir
 */
function readManifestForDnr(extDir) {
  const snapPath = path.join(extDir, SNAPSHOT);
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  if (fs.existsSync(snapPath)) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      if (snap.declarative_net_request) {
        return { ...manifest, declarative_net_request: snap.declarative_net_request };
      }
    } catch {
      /* ignore */
    }
  }
  return manifest;
}

module.exports = {
  SNAPSHOT,
  prepareExtensionDir,
  readManifestForDnr,
  hasDnrPermission,
};
