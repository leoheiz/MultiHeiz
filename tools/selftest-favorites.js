'use strict';

/**
 * Self-test favoritos (migração, popover, página).
 * Uso: npm run selftest:favorites
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

function assert(cond, msg) {
  if (!cond) {
    console.log('FAIL:', msg);
    process.exit(1);
  }
}

function installElectronStub(opts = {}) {
  const electronPath = require.resolve('electron');
  const stub = {
    app: {
      isPackaged: false,
      getVersion: () => '1.3.0',
      getPath: (name) => {
        if (name === 'userData') return opts.userData || opts.tempDir || os.tmpdir();
        return opts.tempDir || os.tmpdir();
      },
      on() {},
      quit() {},
    },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
  };
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: stub,
  };
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'electron') return electronPath;
    return orig.call(this, request, parent, isMain, options);
  };
}

function clearModuleMatch(re) {
  for (const key of Object.keys(require.cache)) {
    if (re.test(key.replace(/\\/g, '/'))) delete require.cache[key];
  }
}

function runNodeChecks() {
  console.log('MultiHeiz selftest:favorites (node)');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-fav-node-'));
  const userData = path.join(tempDir, 'ud');
  fs.mkdirSync(userData, { recursive: true });
  installElectronStub({ tempDir, userData });
  clearModuleMatch(/\/src\/main\/bookmarks\.js$/);
  clearModuleMatch(/\/src\/main\/json-store\.js$/);
  const bookmarks = require('../src/main/bookmarks');

  const flat = [
    { url: 'https://a.example/', title: 'A', name: 'A' },
    { url: 'https://b.example/', title: 'B', name: 'B' },
  ];
  const { data, migrated } = bookmarks.migrateBookmarksData(flat);
  assert(migrated, 'flat migrated');
  assert(data.version === 2, 'v2');
  assert(data.folders.some((f) => f.builtIn === 'bar'), 'bar folder');
  assert(data.folders.some((f) => f.builtIn === 'other'), 'other folder');
  assert(data.items.length === 2, '2 items');
  assert(data.items.every((it) => it.folderId === 'folder-other'), 'items in other');

  const v1 = {
    version: 1,
    folders: [{ id: 'folder-default', name: 'Favoritos', order: 0 }],
    items: [{ id: 'bm-1', url: 'https://x.example/', name: 'X', folderId: 'folder-default' }],
  };
  const m2 = bookmarks.migrateBookmarksData(v1);
  assert(m2.data.items[0].folderId === 'folder-other', 'legacy folder-default mapped');
  assert(m2.data.folders.every((f) => f.id !== 'folder-default'), 'no legacy id');

  console.log('PASS: node bookmarks migration');
}

async function main() {
  runNodeChecks();

  const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-fav-'));
  console.log('userData:', userdata);

  await new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'favorites',
      MULTIHEIZ_UI_WIDTH: '1100',
      MULTIHEIZ_UI_HEIGHT: '800',
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
      reject(new Error('favorites selftest timed out'));
    }, 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error('favorites selftest exited ' + code));
    });
  });

  console.log('PASS: selftest:favorites complete');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
