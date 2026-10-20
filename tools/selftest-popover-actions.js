'use strict';

/**
 * Self-test ações dos popovers no overlay.
 * Uso: npm run selftest:popover-actions
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-popover-actions-'));

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'popover-actions',
      MULTIHEIZ_UI_WIDTH: '1280',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz selftest:popover-actions');
    console.log('userdata:', userdata);
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
      reject(new Error('popover-actions selftest timed out'));
    }, 240000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('popover-actions selftest exited with code ' + code));
    });
  });
}

async function main() {
  try {
    await run();
    console.log('PASS: selftest:popover-actions complete');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  } finally {
    try {
      fs.rmSync(userdata, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main();
