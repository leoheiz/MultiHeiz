'use strict';

/**
 * Self-test MultiHeiz: isolamento de cookies + persistência + screenshots.
 * Uso: npm run selftest
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-selftest-'));

function runPhase(phase) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: '1',
      MULTIHEIZ_SELFTEST_PHASE: String(phase),
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
      reject(new Error(`phase ${phase} timed out`));
    }, 120000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`phase ${phase} exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest');
  console.log('userData:', userdata);
  try {
    await runPhase(1);
    await runPhase(2);

    const shots = path.join(root, 'docs', 'screenshots');
    const needed = ['panel-a.png', 'panel-b.png', 'window-chrome.png'];
    for (const f of needed) {
      const p = path.join(shots, f);
      if (!fs.existsSync(p) || fs.statSync(p).size < 100) {
        console.log(`FAIL: missing screenshot ${f}`);
        process.exit(1);
      }
    }
    console.log('PASS: all screenshots present');
    console.log('PASS: selftest complete');
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
