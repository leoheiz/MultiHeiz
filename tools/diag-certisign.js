'use strict';

/**
 * Diagnostic: client-certificate picker against Certisign test page.
 * Uso: npm run diag:certisign
 * NOT part of the selftest suite. Never selects a certificate — cancels if picker opens.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const logDir = path.join(root, '_local', 'logs-131');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'fix3-diag-certisign.log');

function run() {
  return new Promise((resolve, reject) => {
    const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-diag-cert-'));
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'diag-certisign',
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1280',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz diag:certisign');
    console.log('userdata:', userdata);
    console.log('log:', logPath);
    fs.writeFileSync(logPath, '', 'utf8');
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
      try {
        fs.appendFileSync(logPath, s);
      } catch {
        /* ignore */
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('diag:certisign timed out'));
    }, 120000);
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
      else reject(new Error('diag:certisign exited with code ' + code));
    });
  });
}

run()
  .then(() => {
    console.log('PASS: diag:certisign complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL:', err.message);
    process.exit(1);
  });
