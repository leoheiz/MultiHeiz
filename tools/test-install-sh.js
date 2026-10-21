'use strict';

/**
 * npm entry for tools/test-install-sh.sh.
 * SKIP (exit 0) on Windows if bash is missing; the .sh itself SKIPs without python3.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function findBash() {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
          'bash',
        ]
      : ['bash'];
  for (const b of candidates) {
    if ((b.includes('\\') || b.includes('/')) && !fs.existsSync(b)) continue;
    const r = spawnSync(b, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return b;
  }
  return null;
}

const bash = findBash();
if (!bash) {
  console.log('SKIP: bash indisponível');
  process.exit(0);
}

const script = path.join(__dirname, 'test-install-sh.sh');
const r = spawnSync(bash, [script], { stdio: 'inherit', env: process.env });
process.exit(r.status == null ? 1 : r.status);
