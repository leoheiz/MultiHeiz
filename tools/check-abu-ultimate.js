'use strict';

/**
 * Install AdBlocker Ultimate into TEMP userData and write docs/ADBLOCKER-ULTIMATE.md
 * Uso: node tools/check-abu-ultimate.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-abu-'));

console.log('MultiHeiz AdBlocker Ultimate check');
console.log('userdata (TEMP, not Leo profile):', userdata);

const env = {
  ...process.env,
  MULTIHEIZ_USERDATA: userdata,
  MULTIHEIZ_SELFTEST: 'abu',
  ELECTRON_ENABLE_LOGGING: '1',
};

const child = spawn(electronBin, ['.'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
const onData = (buf) => {
  const s = buf.toString();
  out += s;
  process.stdout.write(s);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);

const timer = setTimeout(() => {
  child.kill();
  console.error('TIMEOUT');
  process.exit(1);
}, 600000);

child.on('close', (code) => {
  clearTimeout(timer);
  const doc = path.join(root, 'docs', 'ADBLOCKER-ULTIMATE.md');
  if (fs.existsSync(doc)) {
    console.log('\nResult doc:', doc);
  }
  try {
    fs.rmSync(userdata, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(code === 0 ? 0 : code || 1);
});
