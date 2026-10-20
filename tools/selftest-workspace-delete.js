'use strict';

/**
 * Self-test MultiHeiz 1.3.0 — excluir área de trabalho fecha/exclui suas janelas
 * Uso: npm run selftest:workspace-delete
 *
 * Phase 1: create 2–3 areas with windows; delete non-active / active / last;
 *   confirm message counts; clearAccountSession path.
 * Phase 2: same MULTIHEIZ_USERDATA — no orphan workspaces/accounts/refs.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-wsdel-'));

function runPhase(phase) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'workspace-delete',
      MULTIHEIZ_SELFTEST_PHASE: String(phase),
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1200',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log(`\n=== selftest:workspace-delete phase=${phase} ===`);
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
      reject(new Error(`workspace-delete selftest phase=${phase} timed out`));
    }, 240000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`workspace-delete selftest phase=${phase} exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:workspace-delete');
  console.log('userdata:', userdata);
  try {
    await runPhase('1');
    await runPhase('2');
    console.log('PASS: selftest:workspace-delete complete');
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
