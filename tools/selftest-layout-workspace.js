'use strict';

/**
 * Self-test MultiHeiz 1.3.0 — layout por área de trabalho
 * Uso: npm run selftest:layout-workspace
 *
 * Phase migrate: estado antigo com layout global → migração one-shot.
 * Phase 1: layouts distintos por área, troca, seletor, bounds, nova/exclusão.
 * Phase 2: mesma MULTIHEIZ_USERDATA — persistência após reinício.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-layout-ws-'));
const STATE_FILE = 'multiheiz-state.json';

function writeLegacyState() {
  const file = path.join(userdata, STATE_FILE);
  const legacy = {
    version: 1,
    workspaces: [
      { id: 'ws-main', name: 'Principal' },
      { id: 'ws-extra', name: 'Extra' },
    ],
    activeWorkspaceId: 'ws-main',
    accounts: [],
    layout: '4',
    page: 0,
    maximizedAccountId: null,
    settings: {
      migrations: { keepAlive120: true },
      homepage: 'https://www.google.com',
      language: 'pt-BR',
    },
    ui: { sidebarCollapsed: false, layoutLocked: true },
    appearance: {},
    freeTiles: {},
  };
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');
  console.log('Wrote legacy state (global layout=4, no layoutByWorkspace):', file);
}

function runPhase(phase) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'layout-workspace',
      MULTIHEIZ_SELFTEST_PHASE: String(phase),
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1200',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log(`\n=== selftest:layout-workspace phase=${phase} ===`);
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
      reject(new Error(`layout-workspace selftest phase=${phase} timed out`));
    }, 240000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`layout-workspace selftest phase=${phase} exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:layout-workspace');
  console.log('userdata:', userdata);
  try {
    writeLegacyState();
    await runPhase('migrate');
    await runPhase('1');
    await runPhase('2');
    console.log('PASS: selftest:layout-workspace complete');
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
