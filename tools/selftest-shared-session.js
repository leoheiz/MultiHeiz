'use strict';

/**
 * Self-test MultiHeiz 1.3.0 — sessões compartilhadas
 * Uso: npm run selftest:shared-session
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-shared-sess-'));

// Old-format state (sem partitionId / sessionType) for migration assert.
const oldState = {
  version: 1,
  workspaces: [{ id: 'ws-mig', name: 'Legado' }],
  activeWorkspaceId: 'ws-mig',
  accounts: [
    {
      id: 'acc-mig-a',
      name: 'Mig A',
      color: '#3d8bfd',
      startUrl: 'https://example.invalid/mig',
      workspaceId: 'ws-mig',
      muted: false,
      volume: 100,
      lastUrl: null,
      zoomFactor: 1,
    },
  ],
  layout: 'auto',
  page: 0,
  maximizedAccountId: null,
  freeTiles: {},
  ui: { sidebarCollapsed: false, sidebarAutoHide: false, layoutLocked: true },
  settings: {},
};

fs.writeFileSync(
  path.join(userdata, 'multiheiz-state.json'),
  JSON.stringify(oldState, null, 2),
  'utf8'
);

function run() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'shared-session',
      MULTIHEIZ_MENU_INTERCEPT: '1',
      MULTIHEIZ_UI_WIDTH: '1200',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz selftest:shared-session');
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
      reject(new Error('shared-session selftest timed out'));
    }, 240000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('shared-session selftest exited with code ' + code));
    });
  });
}

async function main() {
  try {
    await run();
    console.log('PASS: selftest:shared-session complete');
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
