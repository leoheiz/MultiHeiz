'use strict';

/**
 * Remove a pasta dist/ antes do electron-builder (cross-platform).
 */

const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');

try {
  fs.rmSync(DIST, { recursive: true, force: true });
  console.log('[clean-dist] removido:', DIST);
} catch (err) {
  console.error('[clean-dist] falha ao remover dist/:', err.message);
  process.exit(1);
}