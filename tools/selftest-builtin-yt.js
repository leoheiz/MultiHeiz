'use strict';

/**
 * Self-test MultiHeiz — built-in YouTube scriptlets (FEATURE B)
 * Uso: npm run selftest:builtin-yt
 *
 * ABU extension NOT installed; built-in adblock ON (MIT YT set).
 * Fake HTTPS youtube.com via local page-server + host-resolver-rules.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-builtin-yt-'));

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'builtin-yt',
      MULTIHEIZ_UI_WIDTH: '400',
      MULTIHEIZ_UI_HEIGHT: '300',
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
      reject(new Error('builtin-yt selftest timed out'));
    }, 300000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`builtin-yt selftest exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:builtin-yt');
  console.log('userData:', userdata);
  try {
    await run();
    console.log('PASS: selftest:builtin-yt complete');
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
