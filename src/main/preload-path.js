'use strict';

/**
 * Resolve preload script paths for packaged builds.
 *
 * Chromium/Electron session + sandboxed preloads are more reliable with a real
 * filesystem path. electron-builder asarUnpack places copies under
 * app.asar.unpacked/; prefer those when present, else fall back to the asar path
 * (Electron 37 can read asar for some preload entry points).
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} candidate Absolute path that may point into app.asar
 * @returns {{ path: string, exists: boolean, inAsar: boolean, unpacked: boolean }}
 */
function resolvePreloadPath(candidate) {
  const abs = path.resolve(candidate);
  const inAsar = abs.includes(`${path.sep}app.asar${path.sep}`) || abs.includes('/app.asar/');
  let resolved = abs;
  let unpacked = false;
  if (inAsar) {
    const unpackedPath = abs.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
      .replace('/app.asar/', '/app.asar.unpacked/');
    if (unpackedPath !== abs && fs.existsSync(unpackedPath)) {
      resolved = unpackedPath;
      unpacked = true;
    }
  }
  const exists = fs.existsSync(resolved);
  return { path: resolved, exists, inAsar, unpacked };
}

module.exports = { resolvePreloadPath };
