'use strict';

/**
 * Self-test: ad-block ativo desde a inicialização
 * Uso: npm run selftest:adblock-startup
 *
 * Phase 1: USERDATA pré-semeado (adblock on, test-filters, sem engine.bin).
 * Phase 2: mesma USERDATA — motor do cache.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-adblock-startup-'));
const STATE_FILE = 'multiheiz-state.json';

const TEST_FILTERS = [
  '! MultiHeiz adblock-startup filters',
  '||ads.test.local^',
  '/adserver/*',
  '/tracker.js',
  '##.ad-banner',
].join('\n');

function seedUserData() {
  fs.mkdirSync(userdata, { recursive: true });
  const adDir = path.join(userdata, 'adblock');
  fs.mkdirSync(adDir, { recursive: true });
  fs.writeFileSync(path.join(adDir, 'test-filters.txt'), TEST_FILTERS, 'utf8');
  // Cold start: no serialized engine
  for (const name of ['engine.bin', 'meta.json']) {
    try {
      fs.unlinkSync(path.join(adDir, name));
    } catch {
      /* ignore */
    }
  }

  const state = {
    version: 1,
    workspaces: [{ id: 'ws-default', name: 'Principal' }],
    activeWorkspaceId: 'ws-default',
    accounts: [
      {
        id: 'acc-startup-ad',
        name: 'Startup Ad',
        color: '#2bb8a6',
        startUrl: 'about:blank',
        workspaceId: 'ws-default',
        muted: false,
        adblockEnabled: true,
        lastUrl: null,
      },
    ],
    layout: '1',
    layoutByWorkspace: { 'ws-default': '1' },
    page: 0,
    maximizedAccountId: null,
    freeTiles: {},
    ui: {
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      layoutLocked: true,
      sidebarWidth: 240,
    },
    settings: {
      openLastPage: false,
      homepage: 'about:blank',
      language: 'pt-BR',
      migrations: { keepAlive120: true, layoutPerWorkspace130: true },
      adblock: {
        enabled: true,
        antiTracking: true,
        cosmetic: true,
        youtubeExperimental: false,
        lists: {
          easylist: true,
          easyprivacy: true,
        },
        allowlist: [],
        customLists: [],
        userRules: '',
        updateIntervalHours: 24,
        lastUpdateAt: null,
        listStatus: {},
        listMeta: {},
        statusMessage: '',
      },
    },
    appearance: {},
  };
  fs.writeFileSync(path.join(userdata, STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
  console.log('Seeded userdata:', userdata);
}

function runPhase(phase) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'adblock-startup',
      MULTIHEIZ_SELFTEST_PHASE: String(phase),
      MULTIHEIZ_ADBLOCK_TEST: '1',
      MULTIHEIZ_UI_WIDTH: '1200',
      MULTIHEIZ_UI_HEIGHT: '800',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log(`\n=== selftest:adblock-startup phase=${phase} ===`);
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
      reject(new Error(`adblock-startup phase=${phase} timed out`));
    }, 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`adblock-startup phase=${phase} exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:adblock-startup');
  try {
    seedUserData();
    await runPhase('1');
    await runPhase('2');
    console.log('PASS: selftest:adblock-startup complete');
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
