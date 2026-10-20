'use strict';

/**
 * Feature flag helpers for MV3 service-worker extension compatibility.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Global settings.extensions.abuCompat (default ON).
 * @returns {boolean}
 */
function isAbuCompatSettingOn() {
  try {
    const { getState } = require('../state');
    const s = getState();
    const ext = s && s.settings && s.settings.extensions;
    return !(ext && ext.abuCompat === false);
  } catch {
    return true;
  }
}

/**
 * @param {string} extDir
 * @returns {boolean}
 */
function manifestHasServiceWorker(extDir) {
  try {
    const manifestPath = path.join(extDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bg = manifest && manifest.background;
    return !!(bg && bg.service_worker);
  } catch {
    return false;
  }
}

/**
 * True when abuCompat applies to this install.
 * @param {object|null|undefined} record
 * @returns {boolean}
 */
function abuCompatApplies(record) {
  if (!record || !record.path || !isAbuCompatSettingOn()) return false;
  return manifestHasServiceWorker(record.path);
}

/**
 * Extension id from a chrome-extension:// scope or URL.
 * @param {string} scopeOrUrl
 * @returns {string|null}
 */
function extensionIdFromScope(scopeOrUrl) {
  if (!scopeOrUrl || typeof scopeOrUrl !== 'string') return null;
  try {
    const u = new URL(scopeOrUrl);
    if (u.protocol !== 'chrome-extension:') return null;
    const id = String(u.hostname || '').toLowerCase();
    return /^[a-p]{32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

module.exports = {
  isAbuCompatSettingOn,
  manifestHasServiceWorker,
  abuCompatApplies,
  extensionIdFromScope,
};
