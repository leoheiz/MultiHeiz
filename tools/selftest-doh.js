'use strict';

/**
 * Self-test MultiHeiz 1.3.0 — DNS criptografado (DoH)
 * Uso: npm run selftest:doh
 *
 * Phase 1: configureHostResolver spy, providers, invalid custom URL, disk persist.
 * Phase 2: same MULTIHEIZ_USERDATA — DoH still applied after restart.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-doh-'));

function runPhase(phase) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'doh',
      MULTIHEIZ_SELFTEST_PHASE: String(phase),
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1200',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log(`\n=== selftest:doh phase=${phase} ===`);
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
      reject(new Error(`doh selftest phase=${phase} timed out`));
    }, 120000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`doh selftest phase=${phase} exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:doh');
  console.log('userdata:', userdata);
  try {
    await runPhase('1');
    await runPhase('2');
    console.log('PASS: selftest:doh complete');
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
