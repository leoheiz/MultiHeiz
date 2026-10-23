'use strict';

/**
 * Selftest: atualizações diferenciais (blockmap / latest.yml / release.js / feed de teste).
 * Uso: npm run selftest:diff-update
 *
 * Por padrão: asserts de config + artefatos (blockmap referenciado) + feed override.
 * E2E completo (instalar A → baixar B diferencial): MULTIHEIZ_DIFF_UPDATE_E2E=1
 * (usa tools/test-diff-update.ps1; variante InstallerTest apenas; nunca toca o MultiHeiz real).
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');

const root = path.join(__dirname, '..');

function assert(cond, msg) {
  if (!cond) {
    console.log('FAIL:', msg);
    process.exit(1);
  }
}

function installElectronStub(opts = {}) {
  const electronPath = require.resolve('electron');
  const tempDir = opts.tempDir || os.tmpdir();
  const stub = {
    app: {
      isPackaged: !!opts.isPackaged,
      getVersion: () => opts.version || '1.3.0',
      getAppPath: () => opts.appPath || tempDir,
      getPath: () => tempDir,
      quit() {},
      on() {},
      removeListener() {},
    },
    ipcMain: { removeHandler() {}, handle() {} },
    shell: { openExternal() {}, showItemInFolder() {}, openPath() {} },
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

function parseLatestYml(text) {
  const version = (text.match(/^version:\s*(.+)$/m) || [])[1];
  const setupPath = (text.match(/^path:\s*(.+)$/m) || [])[1];
  const fileUrl = (text.match(/^\s*-\s*url:\s*(.+)$/m) || [])[1];
  const size = (text.match(/^\s*size:\s*(\d+)/m) || [])[1];
  return {
    version: version && version.trim(),
    path: setupPath && setupPath.trim(),
    url: fileUrl && fileUrl.trim(),
    size: size ? Number(size) : null,
  };
}

function findInstallerTestArtifacts(dir) {
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir);
  const setup = names.find((n) => /^MultiHeizInstallerTest-.*-setup\.exe$/i.test(n));
  if (!setup) return null;
  const blockmap = setup + '.blockmap';
  const latest = names.includes('latest.yml') ? 'latest.yml' : null;
  return {
    dir,
    setup,
    setupPath: path.join(dir, setup),
    blockmap,
    blockmapPath: path.join(dir, blockmap),
    latest,
    latestPath: latest ? path.join(dir, latest) : null,
    hasBlockmap: names.includes(blockmap),
  };
}

async function main() {
  console.log('MultiHeiz selftest:diff-update');
  process.env.MULTIHEIZ_SELFTEST = 'diff-update';
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-diff-upd-'));

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert(pkg.version === '1.3.1', 'package version must be 1.3.1 (got ' + pkg.version + ')');
  assert(
    pkg.build && pkg.build.nsis && pkg.build.nsis.differentialPackage === true,
    'nsis.differentialPackage must be true'
  );
  assert(
    pkg.build.nsis.artifactName === 'MultiHeiz-${version}-setup.${ext}',
    'setup artifactName pattern'
  );
  console.log('PASS: nsis.differentialPackage true + artifactName setup');

  const ymlPath = path.join(root, 'electron-builder.installertest.yml');
  const yml = fs.readFileSync(ymlPath, 'utf8');
  assert(/differentialPackage:\s*true/.test(yml), 'installertest.yml differentialPackage');
  console.log('PASS: installertest.yml differentialPackage');

  const release = require('./release.js');
  const mockDist = path.join(tempRoot, 'dist');
  fs.mkdirSync(mockDist, { recursive: true });
  const ver = pkg.version;
  const mockNames = [
    'MultiHeiz-' + ver + '-setup.exe',
    'MultiHeiz-' + ver + '-setup.exe.blockmap',
    'MultiHeiz-' + ver + '-portable.exe',
    'MultiHeiz-' + ver + '.AppImage',
    'MultiHeiz-' + ver + '.AppImage.blockmap',
    'latest.yml',
    'latest-linux.yml',
    'SHA256SUMS.txt',
    'multiheiz_' + ver + '_amd64.deb',
  ];
  for (const n of mockNames) {
    fs.writeFileSync(path.join(mockDist, n), 'x');
  }
  const artsCollected = release.collectArtifacts(ver, mockDist);
  for (const need of [
    'MultiHeiz-' + ver + '-setup.exe',
    'MultiHeiz-' + ver + '-setup.exe.blockmap',
    'MultiHeiz-' + ver + '.AppImage.blockmap',
    'latest.yml',
    'latest-linux.yml',
    'SHA256SUMS.txt',
  ]) {
    assert(artsCollected.includes(need), 'collectArtifacts missing ' + need);
  }
  console.log('PASS: release.collectArtifacts includes yml + blockmaps');

  // sha256sums wants blockmaps
  const shaSrc = fs.readFileSync(path.join(root, 'tools', 'sha256sums.js'), 'utf8');
  assert(/blockmap/i.test(shaSrc), 'sha256sums includes blockmap');
  assert(/latest\\.yml/.test(shaSrc) || /latest\.yml/.test(shaSrc), 'sha256sums includes latest.yml');
  console.log('PASS: sha256sums covers blockmap + latest.yml');

  // Updater feed override + portable hint
  installElectronStub({ isPackaged: true, version: '1.3.0', tempDir: tempRoot });
  const updater = require('../src/main/updater');
  assert(updater.PORTABLE_UPDATE_HINT && /instalador|setup/i.test(updater.PORTABLE_UPDATE_HINT), 'portable hint');
  assert(typeof updater.configureUpdateFeedForSelftest === 'function', 'configureUpdateFeedForSelftest');
  assert(typeof updater.prepareAutoUpdater === 'function', 'prepareAutoUpdater');

  process.env.MULTIHEIZ_UPDATE_URL = 'http://127.0.0.1:9/';
  const fakeAu = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    setFeedURL(cfg) {
      fakeAu._feed = cfg;
    },
  };
  const feed = updater.configureUpdateFeedForSelftest(fakeAu);
  assert(feed.ok && feed.url === 'http://127.0.0.1:9/', 'selftest feed url: ' + JSON.stringify(feed));
  assert(fakeAu._feed && fakeAu._feed.provider === 'generic', 'generic provider');

  delete process.env.MULTIHEIZ_SELFTEST;
  const blocked = updater.configureUpdateFeedForSelftest(fakeAu);
  assert(blocked.skipped === true, 'UPDATE_URL ignored without SELFTEST');
  process.env.MULTIHEIZ_SELFTEST = 'diff-update';

  process.env.MULTIHEIZ_UPDATE_NO_INSTALL = '1';
  updater.prepareAutoUpdater(fakeAu);
  assert(fakeAu.autoInstallOnAppQuit === false, 'no install on quit in selftest');
  assert(fakeAu.autoDownload === true, 'autoDownload for silent background');
  assert(updater.AUTO_CHECK_DELAY_MS === 30_000, 'bg check delay 30s');
  assert(updater.AUTO_CHECK_INTERVAL_MS === 6 * 60 * 60 * 1000, 'bg check every 6h');
  assert(typeof updater.runSilentAutoUpdate === 'function', 'runSilentAutoUpdate');
  assert(typeof updater.deferUpdateInstall === 'function', 'deferUpdateInstall');

  updater.resetStatusForTest();
  const promptEvents = [];
  updater.simulateReadyForTest({
    version: '1.3.1',
    emitToRenderer: (p) => promptEvents.push(p),
  });
  assert(
    promptEvents.some((e) => e && e.type === 'updates:prompt'),
    'ready emits updates:prompt'
  );
  const def = updater.deferUpdateInstall();
  assert(def.installOnQuit === true, 'Depois → installOnQuit');
  console.log('PASS: MULTIHEIZ_UPDATE_URL generic feed (selftest-only) + no auto-install');
  console.log('PASS: silent flow prompt + defer install-on-quit');

  // Artifact check: installertest NSIS output (Windows-only — needs wine on Linux)
  if (process.platform === 'win32') {
    let arts = findInstallerTestArtifacts(path.join(root, 'dist-installertest'));
    if (!arts || !arts.hasBlockmap || !arts.latestPath) {
      console.log('INFO: dist-installertest incomplete — building TEST-ONLY NSIS (may take several minutes)…');
      const r = spawnSync(
        'npx',
        ['--yes', 'electron-builder', '--win', 'nsis', '--config', 'electron-builder.installertest.yml'],
        { cwd: root, stdio: 'inherit', shell: true, env: process.env }
      );
      assert(r.status === 0, 'electron-builder installertest failed: ' + r.status);
      arts = findInstallerTestArtifacts(path.join(root, 'dist-installertest'));
    }
    assert(arts && arts.setup, 'InstallerTest setup.exe missing');
    assert(arts.hasBlockmap, 'missing ' + arts.blockmap);
    assert(fs.statSync(arts.blockmapPath).size > 100, 'blockmap too small');
    assert(arts.latestPath && fs.existsSync(arts.latestPath), 'latest.yml missing');
    const latestText = fs.readFileSync(arts.latestPath, 'utf8');
    const parsed = parseLatestYml(latestText);
    assert(parsed.version, 'latest.yml version');
    assert(parsed.path || parsed.url, 'latest.yml path/url');
    const named = parsed.path || parsed.url;
    assert(
      named === arts.setup || named.endsWith(arts.setup),
      'latest.yml must reference setup: ' + named + ' vs ' + arts.setup
    );
    // electron-updater appends .blockmap to the file URL — sibling file must exist
    assert(
      fs.existsSync(path.join(arts.dir, named + '.blockmap')) || arts.hasBlockmap,
      'blockmap sibling for ' + named
    );
    console.log(
      'PASS: latest.yml references',
      named,
      '+ blockmap present (',
      fs.statSync(arts.blockmapPath).size,
      'bytes)'
    );

    // Local generic server smoke: serve latest.yml + blockmap head
    await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const u = req.url || '/';
        if (u === '/' || u === '/latest.yml') {
          res.writeHead(200, { 'Content-Type': 'text/yaml' });
          res.end(latestText);
          return;
        }
        if (u.endsWith('.blockmap')) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(fs.readFileSync(arts.blockmapPath));
          return;
        }
        if (u.includes('setup.exe') && !u.endsWith('.blockmap')) {
          // only headers / tiny body for smoke — full e2e uses real file
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(parsed.size || 1),
          });
          res.end(Buffer.alloc(1));
          return;
        }
        res.writeHead(404);
        res.end('no');
      });
      server.listen(0, '127.0.0.1', async () => {
        try {
          const port = server.address().port;
          const base = 'http://127.0.0.1:' + port + '/';
          const r = await new Promise((res, rej) => {
            http
              .get(base + 'latest.yml', (resp) => {
                let d = '';
                resp.on('data', (c) => (d += c));
                resp.on('end', () => res({ status: resp.statusCode, body: d }));
              })
              .on('error', rej);
          });
          assert(r.status === 200 && /version:/.test(r.body), 'local latest.yml served');
          console.log('PASS: local generic update server serves latest.yml');
          server.close();
          resolve();
        } catch (err) {
          server.close();
          reject(err);
        }
      });
    });
  } else {
    console.log('SKIP: NSIS installertest build (Windows-only)');
    // Cheap Linux-side static checks (no AppImage build): publish config → latest-linux.yml
    const linuxTargets = (pkg.build && pkg.build.linux && pkg.build.linux.target) || [];
    assert(
      linuxTargets.includes('AppImage'),
      'linux.target must include AppImage (emits latest-linux.yml with publish)'
    );
    assert(
      Array.isArray(pkg.build.publish) && pkg.build.publish.length > 0,
      'build.publish required so electron-builder emits latest-linux.yml for AppImage'
    );
    assert(artsCollected.includes('latest-linux.yml'), 'collectArtifacts must pick up latest-linux.yml');
    assert(
      /latest-linux\\.yml/.test(shaSrc) || /latest-linux\.yml/.test(shaSrc),
      'sha256sums includes latest-linux.yml'
    );
    console.log('PASS: Linux AppImage + publish → latest-linux.yml (static; collectArtifacts + sha256sums)');
  }

  // Full A→B e2e (expensive): optional
  const wantE2e =
    process.env.MULTIHEIZ_DIFF_UPDATE_E2E === '1' ||
    process.env.MULTIHEIZ_DIFF_UPDATE_E2E === 'true';
  if (wantE2e && process.platform === 'win32') {
    console.log('INFO: running full differential e2e via test-diff-update.ps1…');
    const ps1 = path.join(root, 'tools', 'test-diff-update.ps1');
    assert(fs.existsSync(ps1), 'test-diff-update.ps1 missing');
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { cwd: root, stdio: 'inherit', env: process.env }
    );
    assert(r.status === 0, 'test-diff-update.ps1 failed: ' + r.status);
    console.log('PASS: full differential e2e');
  } else {
    console.log(
      'SKIP: full A→B differential e2e (set MULTIHEIZ_DIFF_UPDATE_E2E=1). ' +
        'Reason: needs a second NSIS build (1.3.1-test) + per-user install of InstallerTest; ' +
        'default asserts blockmap + latest.yml + selftest feed wiring instead.'
    );
  }

  // Settings: Updates tab removed; Sobre has auto-update controls
  const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  assert(!/data-section=["']atualizacoes["']/.test(html), 'Updates tab absent');
  assert(!/data-pane=["']atualizacoes["']/.test(html), 'Updates pane absent');
  assert(/Atualizar automaticamente/.test(html), 'Sobre: Atualizar automaticamente');
  assert(/Verificar agora/.test(html), 'Sobre: Verificar agora');
  assert(/update-ready-banner/.test(html), 'in-app update ready banner');
  const updSrc = fs.readFileSync(path.join(root, 'src', 'main', 'updater.js'), 'utf8');
  assert(/differentialPackage|blockmap|MULTIHEIZ_UPDATE_URL/.test(updSrc), 'updater wiring');
  assert(/AUTO_CHECK_INTERVAL_MS|runSilentAutoUpdate/.test(updSrc), 'silent bg update wiring');
  assert(fs.existsSync(path.join(root, 'src', 'main', 'diff-update-check.js')), 'diff-update-check.js');

  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.MULTIHEIZ_UPDATE_URL;
  delete process.env.MULTIHEIZ_UPDATE_NO_INSTALL;
  delete process.env.MULTIHEIZ_SELFTEST;

  console.log('PASS: selftest:diff-update complete');
  process.exit(0);
}

main().catch((err) => {
  console.log('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
