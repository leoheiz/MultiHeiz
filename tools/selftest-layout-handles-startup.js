'use strict';

/**
 * Self-test: alças de redimensionar no modo livre desde a inicialização
 * Uso: npm run selftest:layout-handles-startup
 *
 * Windows: real OS drag via tools/realdrag.ps1 (handshake).
 * Outros OS: Electron selftest usa caminho sintético e marca SKIP.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-layout-handles-'));
const handshakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-layout-handles-hs-'));
const STATE_FILE = 'multiheiz-state.json';
const isWin = process.platform === 'win32';

function seedUserData() {
  fs.mkdirSync(userdata, { recursive: true });
  const state = {
    version: 1,
    workspaces: [{ id: 'ws-default', name: 'Principal' }],
    activeWorkspaceId: 'ws-default',
    accounts: [
      {
        id: 'acc-h1',
        name: 'H1',
        color: '#2bb8a6',
        startUrl: 'about:blank',
        workspaceId: 'ws-default',
        muted: false,
        lastUrl: null,
      },
      {
        id: 'acc-h2',
        name: 'H2',
        color: '#3d8bfd',
        startUrl: 'about:blank',
        workspaceId: 'ws-default',
        muted: false,
        lastUrl: null,
      },
    ],
    layout: 'livre',
    layoutByWorkspace: { 'ws-default': 'livre' },
    page: 0,
    maximizedAccountId: null,
    freeTiles: {
      'ws-default': {
        'acc-h1': { c: 0, r: 0, w: 4, h: 4 },
        'acc-h2': { c: 8, r: 0, w: 4, h: 4 },
      },
    },
    ui: {
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      layoutLocked: false,
      sidebarWidth: 240,
    },
    settings: {
      openLastPage: false,
      homepage: 'about:blank',
      language: 'pt-BR',
      migrations: { keepAlive120: true, layoutPerWorkspace130: true },
    },
    appearance: {},
  };
  fs.writeFileSync(path.join(userdata, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
  console.log('Seeded livre/unlocked userdata:', userdata);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForReady(timeoutMs, seenTokens) {
  const readyPath = path.join(handshakeDir, 'ready.json');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(readyPath)) {
      try {
        const obj = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
        if (obj && obj.token && !seenTokens.has(obj.token)) return obj;
      } catch {
        /* retry */
      }
    }
    await sleep(40);
  }
  return null;
}

function runPsDrag(ready) {
  return new Promise((resolve, reject) => {
    const ps1 = path.join(root, 'tools', 'realdrag.ps1');
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ps1,
      '-Mode',
      'Drag',
      '-X',
      String(ready.physical.x),
      '-Y',
      String(ready.physical.y),
      '-DeltaX',
      String(ready.deltaPhys.x),
      '-DeltaY',
      String(ready.deltaPhys.y),
      '-Steps',
      String(ready.steps || 10),
    ];
    const child = spawn('powershell.exe', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => {
      out += b.toString();
    });
    child.stderr.on('data', (b) => {
      out += b.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error('realdrag.ps1 exited ' + code + ': ' + out));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:layout-handles-startup');
  console.log('platform:', process.platform, 'realInput:', isWin);
  seedUserData();

  /** @type {number | null} */
  let electronExitCode = null;
  const env = {
    ...process.env,
    MULTIHEIZ_USERDATA: userdata,
    MULTIHEIZ_SELFTEST: 'layout-handles-startup',
    MULTIHEIZ_UI_WIDTH: '1400',
    MULTIHEIZ_UI_HEIGHT: '900',
    ELECTRON_ENABLE_LOGGING: '1',
  };
  if (isWin) env.MULTIHEIZ_REALCLICK_DIR = handshakeDir;

  const child = spawn(electronBin, ['.'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => process.stdout.write(b.toString()));
  child.stderr.on('data', (b) => process.stdout.write(b.toString()));
  child.on('close', (code) => {
    electronExitCode = code;
  });

  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }, 180000);

  try {
    if (isWin) {
      const seen = new Set();
      const ready = await waitForReady(90000, seen);
      if (ready) {
        seen.add(ready.token);
        console.log('Orchestrator: running realdrag.ps1…');
        const out = await runPsDrag(ready);
        console.log(out);
        fs.writeFileSync(
          path.join(handshakeDir, 'done.json'),
          JSON.stringify({ ok: true, at: Date.now() }),
          'utf8'
        );
      } else if (electronExitCode === null) {
        console.log('WARN: no ready.json (selftest may use synthetic only)');
      }
    }

    await new Promise((resolve, reject) => {
      if (electronExitCode !== null) {
        if (electronExitCode === 0) resolve();
        else reject(new Error('electron exited ' + electronExitCode));
        return;
      }
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('electron exited ' + code));
      });
    });

    console.log('PASS: selftest:layout-handles-startup complete');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    process.exit(1);
  } finally {
    clearTimeout(timer);
    try {
      fs.rmSync(userdata, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(handshakeDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main();
