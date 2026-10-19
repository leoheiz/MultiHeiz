'use strict';

/**
 * Self-test MultiHeiz v1.9 phase 3a — third-party extensions (offline)
 * Uso: npm run selftest:ext
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-ext-'));

function runPhase(phase) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'ext',
      MULTIHEIZ_SELFTEST_PHASE: String(phase),
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log(`\n=== selftest:ext phase=${phase} ===`);
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
      reject(new Error(`ext selftest phase=${phase} timed out`));
    }, 600000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ext selftest phase=${phase} exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:ext');
  console.log('userdata:', userdata);
  try {
    await runPhase('1');
    await runPhase('2');
    console.log('PASS: selftest:ext complete');
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
