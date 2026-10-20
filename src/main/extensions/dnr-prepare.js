'use strict';

/**
 * Snapshot declarative_net_request metadata for MultiHeiz's dnr-shim while
 * keeping the section (and DNR permissions) in manifest.json so Electron's
 * native chrome.declarativeNetRequest object exists for MV3 service workers.
 *
 * prepareVersion 1 (pre-1.3.0): stripped DNR from the on-disk manifest.
 * prepareVersion 2+: keep DNR in the manifest; restore from snapshot when an
 * older stripped install is detected. Original CRX bytes are not kept after
 * install — if the snapshot is missing and the manifest was already stripped,
 * a reinstall from the store/CRX is required (no scary UI; DNR simply stays
 * unavailable until then).
 */

const fs = require('node:fs');
const path = require('node:path');

const SNAPSHOT = 'multiheiz-dnr.json';
/** Bump when prepare behaviour changes so already-installed dirs are re-derived. */
const PREPARE_VERSION = 2;

const DNR_PERMS = [
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
  'declarativeNetRequestFeedback',
];

/**
 * @param {object} manifest
 */
function hasDnrPermission(manifest) {
  const perms = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
  ];
  return perms.some((p) => DNR_PERMS.includes(p));
}

/**
 * @param {string} snapPath
 * @returns {object|null}
 */
function readSnapshot(snapPath) {
  if (!fs.existsSync(snapPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Merge DNR permission names from snapshot into a permissions array.
 * @param {string[]|undefined} list
 * @param {string[]} fromSnap
 */
function mergeDnrPerms(list, fromSnap) {
  const out = Array.isArray(list) ? list.slice() : [];
  const have = new Set(out);
  for (const p of fromSnap) {
    if (DNR_PERMS.includes(p) && !have.has(p)) {
      out.push(p);
      have.add(p);
    }
  }
  return out;
}

/**
 * Ensure manifest carries declarative_net_request + DNR permissions from snap.
 * @param {object} manifest
 * @param {object} snapshot
 * @returns {{ manifest: object, changed: boolean }}
 */
function restoreDnrIntoManifest(manifest, snapshot) {
  let changed = false;
  const next = { ...manifest };

  if (snapshot.declarative_net_request && !next.declarative_net_request) {
    next.declarative_net_request = snapshot.declarative_net_request;
    changed = true;
  }

  const snapPerms = Array.isArray(snapshot.permissions) ? snapshot.permissions : [];
  const dnrFromSnap = snapPerms.filter((p) => DNR_PERMS.includes(p));
  if (dnrFromSnap.length) {
    const before = JSON.stringify(next.permissions || []);
    next.permissions = mergeDnrPerms(next.permissions, dnrFromSnap);
    if (JSON.stringify(next.permissions || []) !== before) changed = true;
  }

  return { manifest: next, changed };
}

/**
 * @param {string} extDir
 * @returns {{ manifest: object, snapshot: object|null, restored: boolean, needsReinstall: boolean }}
 */
function prepareExtensionDir(extDir) {
  const manifestPath = path.join(extDir, 'manifest.json');
  const snapPath = path.join(extDir, SNAPSHOT);
  const raw = fs.readFileSync(manifestPath, 'utf8');
  let manifest = JSON.parse(raw);
  let snap = readSnapshot(snapPath);
  let restored = false;
  let needsReinstall = false;

  const manifestHasDnr = !!(manifest.declarative_net_request || hasDnrPermission(manifest));
  const snapHasDnr = !!(snap && (snap.declarative_net_request || hasDnrPermission({
    permissions: snap.permissions || [],
  })));

  // Already-stripped install (prepare v1): restore DNR from snapshot.
  if (!manifestHasDnr && snapHasDnr) {
    const r = restoreDnrIntoManifest(manifest, snap);
    manifest = r.manifest;
    restored = r.changed;
  } else if (!manifestHasDnr && !snapHasDnr) {
    // Nothing to prepare; possibly a non-DNR extension, or a stripped install
    // whose snapshot was lost (reinstall required for DNR APIs).
    if (snap && Number(snap.prepareVersion || 1) < PREPARE_VERSION) {
      needsReinstall = true;
    }
    return { manifest, snapshot: snap, restored: false, needsReinstall };
  }

  // Prefer live manifest as snapshot source; fall back to existing snap fields.
  const dnrSection =
    manifest.declarative_net_request ||
    (snap && snap.declarative_net_request) ||
    null;
  if (!dnrSection && !hasDnrPermission(manifest)) {
    return { manifest, snapshot: snap, restored: false, needsReinstall: false };
  }

  const snapshot = {
    version: 1,
    prepareVersion: PREPARE_VERSION,
    declarative_net_request: dnrSection,
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions.slice() : [],
  };
  // Preserve any DNR perms that only lived in an older snapshot
  if (snap && Array.isArray(snap.permissions)) {
    snapshot.permissions = mergeDnrPerms(snapshot.permissions, snap.permissions);
  }

  const snapJson = JSON.stringify(snapshot, null, 2);
  const prevSnapJson = snap ? JSON.stringify(snap, null, 2) : '';
  if (snapJson !== prevSnapJson) {
    fs.writeFileSync(snapPath, snapJson, 'utf8');
  }

  // Keep DNR in the manifest (do not strip). Write only if we restored or
  // permissions were merged back.
  if (restored) {
    // Also ensure permissions array includes snapshot DNR perms
    const r2 = restoreDnrIntoManifest(manifest, snapshot);
    manifest = r2.manifest;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  return { manifest, snapshot, restored, needsReinstall: false };
}

/**
 * Re-prepare every installed extension dir (idempotent). Call on init so
 * prepareVersion-1 stripped installs regain declarative_net_request.
 * @param {Array<{ id?: string, path?: string, name?: string }>} records
 * @returns {{ restored: string[], needsReinstall: string[] }}
 */
function reprepareInstalled(records) {
  const restored = [];
  const needsReinstall = [];
  for (const rec of records || []) {
    if (!rec || !rec.path) continue;
    const man = path.join(rec.path, 'manifest.json');
    if (!fs.existsSync(man)) continue;
    try {
      const r = prepareExtensionDir(rec.path);
      if (r.restored) restored.push(rec.id || rec.path);
      if (r.needsReinstall) needsReinstall.push(rec.id || rec.path);
    } catch (err) {
      console.warn(
        '[extensions] reprepare',
        rec.id || rec.path,
        err && err.message ? err.message : err
      );
    }
  }
  return { restored, needsReinstall };
}

/**
 * Manifest view for DNR shim (restores rule_resources from snapshot if needed).
 * @param {string} extDir
 */
function readManifestForDnr(extDir) {
  const snapPath = path.join(extDir, SNAPSHOT);
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  if (fs.existsSync(snapPath)) {
    try {
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      if (snap.declarative_net_request && !manifest.declarative_net_request) {
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
  PREPARE_VERSION,
  prepareExtensionDir,
  reprepareInstalled,
  readManifestForDnr,
  hasDnrPermission,
};
