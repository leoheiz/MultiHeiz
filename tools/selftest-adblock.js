'use strict';

/**
 * Self-test MultiHeiz v1.7 — adblock (offline)
 * Uso: npm run selftest:adblock
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-adblock-'));

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'adblock',
      MULTIHEIZ_ADBLOCK_TEST: '1',
      MULTIHEIZ_UI_WIDTH: '1400',
      MULTIHEIZ_UI_HEIGHT: '900',
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
      reject(new Error('adblock selftest timed out'));
    }, 300000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`adblock selftest exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:adblock');
  console.log('userData:', userdata);
  try {
    await run();
    console.log('PASS: selftest:adblock complete');
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
