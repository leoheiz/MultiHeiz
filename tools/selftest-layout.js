'use strict';

/**
 * Self-test: layout at several window sizes / zoom (MULTIHEIZ_SELFTEST=layout).
 * Uso: npm run selftest:layout
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

function run() {
  return new Promise((resolve, reject) => {
    const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-layout-'));
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'layout',
      MULTIHEIZ_UI_WIDTH: '1280',
      MULTIHEIZ_UI_HEIGHT: '720',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz selftest:layout');
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
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('layout selftest timed out'));
    }, 300000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.rmSync(userdata, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (code === 0) resolve(out);
      else reject(new Error('layout selftest exited with code ' + code));
    });
  });
}

run()
  .then(() => {
    console.log('PASS: selftest:layout complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
