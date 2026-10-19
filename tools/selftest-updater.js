'use strict';

/**
 * Offline selftest for updater module (no Electron window).
 * Uso: npm run selftest:updater
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');

/** Minimal electron stub so updater.js can load without Electron. */
function installElectronStub() {
  const electronPath = require.resolve('electron');
  const stub = {
    app: {
      isPackaged: false,
      getVersion: () => '1.0.0',
    },
    ipcMain: {
      removeHandler() {},
      handle() {},
    },
    shell: {
      openExternal() {},
    },
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
  return stub;
}

function assert(cond, msg) {
  if (!cond) {
    console.log('FAIL:', msg);
    process.exit(1);
  }
}

function main() {
  console.log('MultiHeiz selftest:updater');
  installElectronStub();

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const publish = pkg.build && pkg.build.publish;
  assert(Array.isArray(publish) && publish.length > 0, 'build.publish missing');
  const gh = publish[0];
  assert(gh.provider === 'github', 'publish provider');
  assert(gh.owner === 'leoheiz', 'publish owner leoheiz');
  assert(gh.repo === 'MultiHeiz', 'publish repo MultiHeiz');
  assert(gh.releaseType === 'release', 'releaseType release');
  console.log('PASS: publish config github leoheiz/MultiHeiz');

  assert(pkg.dependencies && pkg.dependencies['electron-updater'], 'electron-updater dep');
  console.log('PASS: electron-updater in dependencies');

  const updater = require('../src/main/updater');
  assert(updater.GITHUB_OWNER === 'leoheiz', 'GITHUB_OWNER');
  assert(updater.GITHUB_REPO === 'MultiHeiz', 'GITHUB_REPO');

  const prevDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const prevFile = process.env.PORTABLE_EXECUTABLE_FILE;
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  process.env.PORTABLE_EXECUTABLE_DIR = 'C:\\portable';
  assert(updater.detectUpdateChannel() === 'portable', 'portable via DIR');
  assert(updater.isManualOnlyChannel('portable'), 'portable is manual');
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\MultiHeiz-portable.exe';
  assert(updater.detectUpdateChannel() === 'portable', 'portable via FILE');
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  if (prevDir !== undefined) process.env.PORTABLE_EXECUTABLE_DIR = prevDir;
  if (prevFile !== undefined) process.env.PORTABLE_EXECUTABLE_FILE = prevFile;
  console.log('PASS: portable detection');

  assert(updater.isManualOnlyChannel('deb'), 'deb is manual');
  assert(!updater.isManualOnlyChannel('nsis'), 'nsis not manual');
  assert(!updater.isManualOnlyChannel('appimage'), 'appimage not manual');
  console.log('PASS: portable/deb manual-only logic');

  const enabledDefault = updater.getAutoCheckEnabled(() => ({ settings: {} }));
  assert(enabledDefault === true, 'autoCheck default ON when unset');
  const enabledOff = updater.getAutoCheckEnabled(() => ({
    settings: { autoCheckUpdates: false },
  }));
  assert(enabledOff === false, 'autoCheck respects false');
  const enabledOn = updater.getAutoCheckEnabled(() => ({
    settings: { autoCheckUpdates: true },
  }));
  assert(enabledOn === true, 'autoCheck respects true');
  console.log('PASS: autoCheckUpdates default ON');

  const srcFiles = [
    path.join(root, 'src', 'main', 'updater.js'),
    path.join(root, 'package.json'),
    path.join(root, '.github', 'workflows', 'release.yml'),
  ];
  const tokenRe = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/;
  for (const f of srcFiles) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    assert(!tokenRe.test(text), 'token-like string in ' + path.relative(root, f));
    if (/GH_TOKEN\s*[:=]\s*['"][A-Za-z0-9_]+['"]/.test(text)) {
      assert(false, 'hardcoded GH_TOKEN in ' + path.relative(root, f));
    }
  }
  const updaterSrc = fs.readFileSync(path.join(root, 'src', 'main', 'updater.js'), 'utf8');
  assert(!/token\s*[:=]\s*['"][a-zA-Z0-9_]{8,}['"]/i.test(updaterSrc), 'no hardcoded token');
  console.log('PASS: no token strings in updater source');

  updater.resetStatusForTest();
  const { app } = require('electron');
  app.isPackaged = false;
  return updater
    .checkForUpdates({ silent: false })
    .then((st) => {
      assert(st.status === 'dev', 'dev status');
      assert(/versão instalada/i.test(st.message), 'dev message');
      console.log('PASS: unpackaged check shows installed-only message');
      console.log('PASS: selftest:updater complete');
      process.exit(0);
    })
    .catch((err) => {
      console.log('FAIL:', err && err.message ? err.message : err);
      process.exit(1);
    });
}

main();
