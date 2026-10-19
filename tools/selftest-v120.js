'use strict';

/**
 * Self-test MultiHeiz 1.2.0 Partes A+B
 * Uso: npm run selftest:v120
 *
 * Node: downloads sync, DNR fail-closed, extension coalesce, keepAlive default OFF,
 *       adblock rebuild single-flight, snapshot size constants.
 * Electron: loadQueue + keepAlive default + snapshot LRU/compress.
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
      getVersion: () => '1.2.0',
      getPath: (name) => {
        if (name === 'userData') return opts.userData || opts.tempDir || os.tmpdir();
        if (name === 'temp') return opts.tempDir || os.tmpdir();
        if (name === 'downloads') return path.join(opts.tempDir || os.tmpdir(), 'Downloads');
        return opts.tempDir || os.tmpdir();
      },
      on() {},
      quit() {},
    },
    dialog: {
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    },
    BrowserWindow: {
      fromWebContents: () => null,
      getFocusedWindow: () => null,
    },
    session: {
      fromPartition() {
        return {
          extensions: {
            loadExtension: async () => ({ id: 'eid-stub' }),
          },
        };
      },
    },
    webContents: { fromId: () => null },
  };
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: stub,
    parent: null,
    children: [],
    paths: [],
  };
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'electron') return electronPath;
    return orig.call(this, request, parent, isMain, options);
  };
  return stub;
}

function clearModuleMatch(re) {
  for (const key of Object.keys(require.cache)) {
    if (re.test(key.replace(/\\/g, '/'))) delete require.cache[key];
  }
}

async function runNodeChecks() {
  console.log('MultiHeiz selftest:v120 (node)');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-v120-'));
  const userData = path.join(tempRoot, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(tempRoot, 'Downloads'), { recursive: true });
  process.env.MULTIHEIZ_USERDATA = userData;

  // --- downloads: setSavePath / setSaveDialogOptions before any await ---
  clearModuleMatch(/\/src\/main\/(downloads|json-store)/);
  installElectronStub({ tempDir: tempRoot, userData });
  clearModuleMatch(/\/src\/main\/(downloads|json-store)/);
  const downloads = require('../src/main/downloads');
  downloads.load();
  downloads.init(() => {});

  let handler = null;
  const ses = {
    storagePath: 'v120-dl',
    on(ev, fn) {
      if (ev === 'will-download') handler = fn;
    },
  };
  downloads.hookSession(ses, () => ({ windowId: null, windowName: '' }));
  assert(typeof handler === 'function', 'will-download handler registered');

  downloads.updateSettings({
    askWhereToSave: false,
    defaultFolder: path.join(tempRoot, 'Downloads'),
  });

  const order = [];
  const item = {
    getFilename: () => 'file.txt',
    getURL: () => 'https://example.com/file.txt',
    getMimeType: () => 'text/plain',
    getTotalBytes: () => 10,
    getReceivedBytes: () => 0,
    getSavePath: () => order.find((x) => x[0] === 'setSavePath')?.[1] || '',
    setSavePath(p) {
      order.push(['setSavePath', p]);
    },
    setSaveDialogOptions(opts) {
      order.push(['setSaveDialogOptions', opts]);
    },
    pause() {
      order.push(['pause']);
    },
    resume() {
      order.push(['resume']);
    },
    cancel() {
      order.push(['cancel']);
    },
    isPaused: () => false,
    on() {},
    once() {},
  };
  handler({}, item, {});
  assert(order.length >= 1 && order[0][0] === 'setSavePath', 'setSavePath first (sync): ' + JSON.stringify(order));
  assert(order.every((x) => x[0] !== 'pause'), 'no pause when askWhereToSave=false');
  console.log('PASS: will-download setSavePath synchronous');

  // askWhereToSave → setSaveDialogOptions sync (no await before control)
  clearModuleMatch(/\/src\/main\/downloads/);
  installElectronStub({ tempDir: tempRoot, userData });
  clearModuleMatch(/\/src\/main\/downloads/);
  const downloads2 = require('../src/main/downloads');
  downloads2.load();
  downloads2.init(() => {});
  downloads2.updateSettings({
    askWhereToSave: true,
    defaultFolder: path.join(tempRoot, 'Downloads'),
  });
  let handler2 = null;
  const ses2 = {
    storagePath: 'v120-dl-ask',
    on(ev, fn) {
      if (ev === 'will-download') handler2 = fn;
    },
  };
  downloads2.hookSession(ses2, () => ({}));
  const order2 = [];
  const item2 = {
    getFilename: () => 'file2.txt',
    getURL: () => 'https://example.com/file2.txt',
    getMimeType: () => 'text/plain',
    getTotalBytes: () => 10,
    getReceivedBytes: () => 0,
    getSavePath: () => '',
    setSavePath(p) {
      order2.push(['setSavePath', p]);
    },
    setSaveDialogOptions(opts) {
      order2.push(['setSaveDialogOptions', opts]);
    },
    pause() {
      order2.push(['pause']);
    },
    on() {},
    once() {},
    isPaused: () => false,
  };
  handler2({}, item2, {});
  assert(
    order2.length >= 1 && order2[0][0] === 'setSaveDialogOptions',
    'setSaveDialogOptions first when ask: ' + JSON.stringify(order2)
  );
  console.log('PASS: will-download setSaveDialogOptions synchronous when askWhereToSave');

  // --- DNR fail-closed when applyMap missing ---
  clearModuleMatch(/\/src\/main\/extensions\/dnr-shim/);
  clearModuleMatch(/\/src\/main\/adblock\/web-request-hub/);
  installElectronStub({ tempDir: tempRoot, userData });
  clearModuleMatch(/\/src\/main\/extensions\/dnr-shim/);
  const dnr = require('../src/main/extensions/dnr-shim');
  const fixture = path.join(root, 'tools', 'fixtures', 'mh-ext-test');
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json'), 'utf8'));
  dnr.loadExtensionRules('ext-v120', fixture, manifest);
  const eng = dnr.getEngine('ext-v120');
  assert(eng && eng.ruleCount > 0, 'fixture engine loaded');

  const probe = {
    url: 'http://127.0.0.1/dnr-probe-block.png',
    resourceType: 'image',
    referrer: 'http://127.0.0.1/',
  };
  const noMap = dnr.evaluate('acc-missing', probe);
  assert(!noMap.cancel, 'missing applyMap must not cancel (fail-closed): ' + JSON.stringify(noMap));
  console.log('PASS: DNR missing applyMap applies no rules');

  dnr.setApplies('acc-ok', ['ext-v120']);
  const withMap = dnr.evaluate('acc-ok', probe);
  assert(withMap.cancel === true, 'mapped account should block: ' + JSON.stringify(withMap));
  console.log('PASS: DNR mapped account applies rules');

  const otherAcc = dnr.evaluate('acc-other', probe);
  assert(!otherAcc.cancel, 'unmapped other account fail-closed: ' + JSON.stringify(otherAcc));
  console.log('PASS: DNR unmapped account does not leak rules');

  dnr.unloadExtensionRules('ext-v120');

  // --- extension loadOne coalesces concurrent loads ---
  clearModuleMatch(/\/src\/main\/extensions\/loader/);
  clearModuleMatch(/\/src\/main\/extensions\/store/);
  clearModuleMatch(/\/src\/main\/extensions\/dnr/);
  installElectronStub({ tempDir: tempRoot, userData });

  let loadCalls = 0;
  const electronPath = require.resolve('electron');
  const stub = require.cache[electronPath].exports;
  stub.session.fromPartition = () => ({
    extensions: {
      loadExtension: async () => {
        loadCalls += 1;
        await new Promise((r) => setTimeout(r, 80));
        return { id: 'eid-coalesce' };
      },
    },
  });

  clearModuleMatch(/\/src\/main\/extensions\/loader/);
  const loader = require('../src/main/extensions/loader');
  loader.resetLoadedState();
  const rec = {
    id: 'inst-v120',
    name: 'V120',
    path: fixture,
    enabled: true,
    applyTo: 'all',
    warnings: [],
  };
  const p1 = loader.loadOne('acc-coalesce', rec);
  const p2 = loader.loadOne('acc-coalesce', rec);
  assert(loader.inflightLoadCount() === 1, 'one inflight promise while loading');
  const [a, b] = await Promise.all([p1, p2]);
  assert(a === 'eid-coalesce' && b === 'eid-coalesce', 'both resolve same id');
  assert(loadCalls === 1, 'loadExtension called once, got ' + loadCalls);
  assert(loader.inflightLoadCount() === 0, 'inflight cleared in finally');
  console.log('PASS: concurrent loadOne coalesces (no double load)');

  // --- keepAliveInBackground default OFF + migration ---
  clearModuleMatch(/\/src\/main\/(state|json-store)/);
  installElectronStub({ tempDir: tempRoot, userData });
  clearModuleMatch(/\/src\/main\/(state|json-store)/);
  const statePath = path.join(userData, 'multiheiz-state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      accounts: [
        {
          id: 'acc-legacy',
          name: 'Legacy',
          color: '#2bb8a6',
          startUrl: 'https://example.com',
          workspaceId: 'ws',
          muted: false,
        },
      ],
      workspaces: [{ id: 'ws', name: 'W' }],
      activeWorkspaceId: 'ws',
      settings: {},
      ui: {},
      appearance: {},
    }),
    'utf8'
  );
  const stateMod = require('../src/main/state');
  stateMod.loadState();
  const st = stateMod.getState();
  assert(
    st.accounts[0] && st.accounts[0].keepAliveInBackground === false,
    'legacy account keepAliveInBackground defaults false'
  );
  assert(
    st.settings.keepBackgroundRunning === false,
    'keepBackgroundRunning defaults false when missing'
  );
  console.log('PASS: keepAliveInBackground / keepBackgroundRunning default OFF');

  // --- adblock rebuild single-flight (parallel peak ≤ 1) ---
  clearModuleMatch(/\/src\/main\/adblock/);
  installElectronStub({ tempDir: tempRoot, userData });
  // Minimal ipcMain for adblock module load
  const ePath = require.resolve('electron');
  const estub = require.cache[ePath].exports;
  estub.ipcMain = {
    handle() {},
    on() {},
    removeHandler() {},
  };
  estub.net = { fetch: async () => ({ ok: false }) };
  clearModuleMatch(/\/src\/main\/adblock/);
  process.env.MULTIHEIZ_SELFTEST = 'v120';
  const adblock = require('../src/main/adblock');
  adblock.resetRebuildDebug();
  adblock.setFetchBlocked(true);
  const b1 = adblock.buildEngine({ forceDownload: false, skipSerialize: true }, { immediate: true });
  const b2 = adblock.buildEngine({ forceDownload: false, skipSerialize: true }, { immediate: true });
  await Promise.all([b1, b2]);
  const rd = adblock.getRebuildDebug();
  assert(rd.parallelPeak <= 1, 'rebuild parallelPeak ≤ 1, got ' + rd.parallelPeak);
  assert(rd.parallelNow === 0, 'no rebuild left active');
  console.log('PASS: adblock rebuild serialized (parallelPeak≤1)');
  assert(adblock.REBUILD_DEBOUNCE_MS >= 300 && adblock.REBUILD_DEBOUNCE_MS <= 500, 'debounce 300-500ms');

  // --- Parte C UX (static) ---
  const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  assert(indexHtml.includes('id="dlg-history-clear"'), 'dlg-history-clear present');
  assert(indexHtml.includes('Limpar histórico'), 'history clear title pt-BR');
  assert(indexHtml.includes('id="btn-tabs-more"'), 'tabs overflow » button');
  assert(/id="btn-favorites"[^>]*aria-label="Favoritos"/.test(indexHtml), 'favorites aria-label');
  assert(/id="btn-history"[^>]*aria-label="Histórico"/.test(indexHtml), 'history aria-label');
  assert(/id="btn-downloads"[^>]*aria-label="Downloads"/.test(indexHtml), 'downloads aria-label');
  const v16 = fs.readFileSync(path.join(root, 'src/renderer/v16-ui.js'), 'utf8');
  assert(!/prompt\('Limpar: hour/.test(v16), 'history clear no longer uses English prompt()');
  assert(v16.includes('showSaveError'), 'autosave shows Erro ao salvar');
  assert(v16.includes('openHistoryClearDialog'), 'history clear uses in-app dialog');
  const appJs = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  assert(appJs.includes("setAttribute('aria-label', title)"), 'iconBtn sets aria-label');
  assert(appJs.includes('updateTabsOverflow'), 'tabs overflow helper');
  assert(appJs.includes("createElement('button')") && appJs.includes('sidebar-item'), 'sidebar items are buttons');
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  assert(css.includes(':focus-visible'), 'focus-visible styles');
  assert(css.includes('scrollbar-width: none') || css.includes('.tabs::-webkit-scrollbar'), 'tabs scrollbar hidden');
  console.log('PASS: Parte C UX static checks');

  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function runElectron() {
  return new Promise((resolve, reject) => {
    const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-v120-'));
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'v120',
      MULTIHEIZ_UI_WIDTH: '1400',
      MULTIHEIZ_UI_HEIGHT: '900',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    console.log('MultiHeiz selftest:v120 (electron)');
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
      reject(new Error('v120 selftest timed out'));
    }, 180000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.rmSync(userdata, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (code === 0) resolve(out);
      else reject(new Error('v120 electron selftest exited with code ' + code));
    });
  });
}

runNodeChecks()
  .then(() => runElectron())
  .then(() => {
    console.log('PASS: selftest:v120 complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL:', err && err.message ? err.message : err);
    process.exit(1);
  });
