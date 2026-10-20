'use strict';

/**
 * Auditoria de lag (main event-loop + RAF gap no renderer).
 * Uso: npm run check:lag-audit
 * Fases: MULTIHEIZ_LAG_PHASE=before|after|check (padrão: check)
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

const phaseArg = (process.argv.find((a) => a.startsWith('--phase=')) || '').slice(8);
const phase = String(
  phaseArg || process.env.MULTIHEIZ_LAG_PHASE || 'check'
).toLowerCase();

const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-lag-audit-'));

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'lag-audit',
      MULTIHEIZ_LAG_PHASE: phase,
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1400',
      MULTIHEIZ_UI_HEIGHT: '900',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz check:lag-audit phase=' + phase);
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
      reject(new Error('lag-audit timed out'));
    }, 360000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('lag-audit exited with code ' + code));
    });
  });
}

async function main() {
  try {
    await run();
    console.log('PASS: check:lag-audit complete (phase=' + phase + ')');
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
