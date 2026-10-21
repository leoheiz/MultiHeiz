'use strict';

/**
 * Write dist/SHA256SUMS.txt for release artifacts present in dist/
 * (setup, portable, AppImage, deb, blockmaps). Also used by tools/release.js.
 *
 * Usage: node tools/sha256sums.js
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const INTERESTING = [
  /^MultiHeiz-.*-setup\.exe$/i,
  /^MultiHeiz-.*-portable\.exe$/i,
  /^MultiHeiz-.*\.AppImage$/i,
  /^multiheiz_.*_amd64\.deb$/i,
  /\.blockmap$/i,
  /^latest\.yml$/i,
  /^latest-linux\.yml$/i,
];

function want(name) {
  return INTERESTING.some((re) => re.test(name));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.warn('[sha256sums] dist/ inexistente — nada a fazer');
    return null;
  }
  const names = fs
    .readdirSync(DIST)
    .filter((n) => want(n) && fs.statSync(path.join(DIST, n)).isFile())
    .sort((a, b) => a.localeCompare(b));

  if (!names.length) {
    console.warn('[sha256sums] nenhum artefato correspondente em dist/');
    return null;
  }

  const lines = names.map((n) => {
    const h = sha256File(path.join(DIST, n));
    console.log('[sha256sums]', h, n);
    return h + '  ' + n;
  });
  const out = path.join(DIST, 'SHA256SUMS.txt');
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log('[sha256sums] escrito:', path.relative(ROOT, out));
  return out;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[sha256sums] erro:', err.message || err);
    process.exit(1);
  }
}

module.exports = { main, sha256File, want };
