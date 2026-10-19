'use strict';

/**
 * Self-test MultiHeiz 1.1.0
 * Uso: npm run selftest:v110
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

function run() {
  return new Promise((resolve, reject) => {
    const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-v110-'));
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'v110',
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1400',
      MULTIHEIZ_UI_HEIGHT: '900',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz selftest:v110');
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
      reject(new Error('v110 selftest timed out'));
    }, 360000);
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
      else reject(new Error('v110 selftest exited with code ' + code));
    });
  });
}

run()
  .then(() => {
    console.log('PASS: selftest:v110 complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
