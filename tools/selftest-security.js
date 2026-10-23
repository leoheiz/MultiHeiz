'use strict';

/**
 * Security selftest (phase 1.2.0-c).
 * Node unit checks + Electron spawn (MULTIHEIZ_SELFTEST=security).
 * Uso: npm run selftest:security
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
  const handled = [];
  const stub = {
    app: {
      isPackaged: !!opts.isPackaged,
      getVersion: () => opts.version || '1.2.0',
      getPath: (name) => {
        if (name === 'userData') return opts.userData || opts.tempDir || os.tmpdir();
        if (name === 'temp') return opts.tempDir || os.tmpdir();
        if (name === 'downloads') return path.join(opts.tempDir || os.tmpdir(), 'Downloads');
        return opts.tempDir || os.tmpdir();
      },
      on() {},
      quit() {},
    },
    ipcMain: {
      handle(ch) {
        handled.push(ch);
      },
      on() {},
      removeHandler() {},
    },
    shell: {
      openExternal() {},
      showItemInFolder() {},
      openPath: async () => '',
    },
    dialog: {
      showMessageBox: async () => ({ response: 1 }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      },
      fromPartition() {
        return {
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
        };
      },
    },
    BrowserWindow: function BrowserWindow() {},
    WebContentsView: function WebContentsView() {},
    _handled: handled,
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

function clearModuleMatch(re) {
  for (const key of Object.keys(require.cache)) {
    if (re.test(key.replace(/\\/g, '/'))) delete require.cache[key];
  }
}

async function runNodeChecks() {
  console.log('MultiHeiz selftest:security (node)');
  process.env.MULTIHEIZ_SELFTEST = 'security';

  const urlPolicy = require('../src/main/url-policy');
  for (const bad of [
    'file:///C:/Windows',
    'javascript:alert(1)',
    'data:text/html,x',
    'chrome://settings',
    'view-source:https://example.com',
    'myapp:foo',
  ]) {
    assert(urlPolicy.classifyScheme(bad) === 'blocked', 'blocked: ' + bad);
    assert(!urlPolicy.isNavigableUrl(bad), 'not navigable: ' + bad);
  }
  assert(urlPolicy.classifyScheme('mailto:a@b.com') === 'external', 'mailto external');
  assert(urlPolicy.classifyScheme('https://example.com') === 'web', 'https web');
  assert(urlPolicy.classifyScheme('http://example.com') === 'web', 'http web');
  console.log('PASS: url-policy schemes');

  const searchUrl = require('../src/main/search-url');
  const settings = { searchEngine: 'google' };
  const fileNav = searchUrl.resolveNavigateUrl('file:///C:/Windows', settings);
  assert(fileNav && !fileNav.startsWith('file:'), 'file becomes search not navigate');
  assert(/google|search|q=/i.test(fileNav) || fileNav.includes('%'), 'file search url: ' + fileNav);
  const jsNav = searchUrl.resolveNavigateUrl('javascript:alert(1)', settings);
  assert(jsNav && !jsNav.startsWith('javascript:'), 'javascript becomes search');
  console.log('PASS: address bar file/javascript -> search');

  assert(!urlPolicy.isKnownIdentityProviderUrl('https://evil.example/oauth'), 'evil oauth');
  assert(!urlPolicy.isKnownIdentityProviderUrl('https://accounts.evil.example/'), 'evil accounts');
  assert(
    urlPolicy.isKnownIdentityProviderUrl('https://accounts.google.com/o/oauth2/v2/auth'),
    'google oauth'
  );
  console.log('PASS: OAuth IdP allowlist');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-sec-'));
  const userData = path.join(tempRoot, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  installElectronStub({ tempDir: tempRoot, userData });
  clearModuleMatch(/\/src\/main\/safe-open-path/);
  const safeOpen = require('../src/main/safe-open-path');
  assert(!safeOpen.assertAllowedPath('C:\\Windows\\System32').ok, 'System32 rejected');
  assert(
    !safeOpen.assertAllowedPath(path.join(userData, '..', '..', 'Windows')).ok,
    '.. rejected'
  );
  assert(safeOpen.assertAllowedPath(userData).ok, 'userData allowed');
  console.log('PASS: app:open-path rejects System32 and ..');

  delete process.env.MULTIHEIZ_SELFTEST;
  clearModuleMatch(/\/src\/main\/extensions/);
  const stub2 = installElectronStub({ tempDir: tempRoot, userData });
  try {
    const extensions = require('../src/main/extensions');
    extensions.init({
      emit() {},
      getAccountIds: () => [],
      getMainWindow: () => null,
    });
    const handled = stub2._handled || [];
    assert(!handled.includes('extensions:selftest-install-unpacked'), 'no unpacked selftest ipc');
    assert(!handled.includes('extensions:selftest-install-crx'), 'no crx selftest ipc');
    console.log('PASS: extensions selftest-install-* absent without SELFTEST');
  } catch (err) {
    const extSrc = fs.readFileSync(path.join(root, 'src', 'main', 'extensions', 'index.js'), 'utf8');
    assert(
      /if\s*\(\s*process\.env\.MULTIHEIZ_SELFTEST\s*\)[\s\S]*?selftest-install-unpacked/.test(extSrc),
      'source gate extensions: ' + (err && err.message)
    );
    console.log('PASS: extensions selftest-install gated (source)');
  }
  const mainSrc = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');
  assert(
    /if\s*\(\s*process\.env\.MULTIHEIZ_SELFTEST\s*\)\s*\{[\s\S]{0,240}?selftest:renderer/.test(mainSrc),
    'selftest:renderer gated'
  );
  console.log('PASS: selftest:renderer gated on MULTIHEIZ_SELFTEST');
  process.env.MULTIHEIZ_SELFTEST = 'security';

  clearModuleMatch(/\/src\/main\/ipc-guard/);
  installElectronStub({ tempDir: tempRoot, userData });
  clearModuleMatch(/\/src\/main\/ipc-guard/);
  const ipcGuard = require('../src/main/ipc-guard');
  const indexUrl = ipcGuard.getAppRendererFileUrl();
  const uiWc = { id: 1 };
  const panelWc = { id: 99 };
  ipcGuard.configure({
    getMainWindow: () => ({ isDestroyed: () => false, webContents: uiWc }),
    isPanelWebContents: (wc) => wc === panelWc,
  });
  assert(
    ipcGuard.isAllowedIpc({ sender: uiWc, senderFrame: { url: indexUrl } }, 'state:get'),
    'UI allowed'
  );
  assert(
    !ipcGuard.isAllowedIpc(
      { sender: panelWc, senderFrame: { url: 'https://x.com/' } },
      'state:get'
    ),
    'panel UI rejected'
  );
  assert(
    !ipcGuard.isAllowedIpc({ sender: panelWc, senderFrame: null }, 'state:get'),
    'null frame rejected'
  );
  const mainFr = { url: 'http://127.0.0.1:8/', parent: null };
  const panelMain = {
    sender: Object.assign(panelWc, { mainFrame: mainFr }),
    senderFrame: mainFr,
  };
  assert(ipcGuard.isAllowedIpc(panelMain, 'panel:ai-open'), 'main frame ai-open');
  assert(ipcGuard.isAllowedIpc(panelMain, 'panel:media-use'), 'main frame media-use');
  assert(ipcGuard.isAllowedIpc(panelMain, 'panel:ctrl-wheel'), 'main frame ctrl-wheel');
  const panelSub = {
    sender: panelMain.sender,
    senderFrame: { url: 'http://127.0.0.1:9/', parent: mainFr },
  };
  assert(!ipcGuard.isAllowedIpc(panelSub, 'panel:ai-open'), 'subframe ai-open rejected');
  assert(!ipcGuard.isAllowedIpc(panelSub, 'panel:media-use'), 'subframe media-use rejected');
  assert(!ipcGuard.isAllowedIpc(panelSub, 'panel:ctrl-wheel'), 'subframe ctrl-wheel rejected');
  assert(
    !ipcGuard.isAllowedIpc(panelSub, 'panel:languagetool-check'),
    'cross-origin subframe LT rejected'
  );
  const panelSubSame = {
    sender: panelMain.sender,
    senderFrame: { url: 'http://127.0.0.1:8/embed', parent: mainFr },
  };
  assert(
    ipcGuard.isAllowedIpc(panelSubSame, 'panel:languagetool-check'),
    'same-origin subframe LT allowed'
  );
  console.log('PASS: IPC guard rejects unknown frames');
  console.log('PASS: IPC main-frame / LT same-origin policy');

  clearModuleMatch(/\/src\/main\/permissions/);
  installElectronStub({ tempDir: tempRoot, userData });
  clearModuleMatch(/\/src\/main\/permissions/);
  const permissions = require('../src/main/permissions');
  permissions.clearDecisionsForTest();
  assert(permissions.checkPermission('a', 'geolocation', 'https://a.com') === false, 'geo');
  assert(permissions.checkPermission('a', 'media', 'https://a.com') === false, 'media');
  assert(permissions.checkPermission('a', 'usb', 'https://a.com') === false, 'usb');
  assert(permissions.checkPermission('a', 'hid', 'https://a.com') === false, 'hid');
  assert(permissions.checkPermission('a', 'serial', 'https://a.com') === false, 'serial');
  assert(
    permissions.checkPermission('a', 'publickey-credentials-get', 'https://a.com') === true,
    'webauthn get'
  );
  assert(
    permissions.checkPermission('a', 'identity-credentials-get', 'https://a.com') === false,
    'FedCM identity-credentials-get denied (no Electron UI)'
  );
  console.log('PASS: permissions geo/media not auto, usb/hid/serial deny, FedCM deny');

  clearModuleMatch(/\/src\/main\/portable-update/);
  installElectronStub({ tempDir: tempRoot, userData, isPackaged: true });
  clearModuleMatch(/\/src\/main\/portable-update/);
  const portable = require('../src/main/portable-update');
  assert(!portable.verifyAssetHash(Buffer.from('x'), { size: 1 }).ok, 'manifest without hash');
  const payload = Buffer.from('portable-bytes');
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  assert(
    !portable.verifyAssetHash(payload, { digest: 'sha256:' + '00'.repeat(32) }).ok,
    'wrong hash'
  );
  assert(portable.verifyAssetHash(payload, { digest: 'sha256:' + sha256 }).ok, 'correct hash');
  let hostFail = false;
  try {
    portable.assertAllowedUpdateUrl('https://evil.example/x');
  } catch {
    hostFail = true;
  }
  assert(hostFail, 'host outside allowlist');
  let httpFail = false;
  try {
    portable.assertAllowedUpdateUrl('http://objects.githubusercontent.com/x');
  } catch {
    httpFail = true;
  }
  assert(httpFail, 'https->http (http download host) refused');

  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/start')) {
      res.writeHead(302, { Location: 'http://evil.example/payload' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let redirectFail = false;
  try {
    await portable.httpGetBuffer(`http://127.0.0.1:${port}/start`);
  } catch {
    redirectFail = true;
  }
  assert(redirectFail, 'redirect to non-allowlisted host refused');
  await new Promise((r) => server.close(r));
  console.log('PASS: portable-update hash/redirect/host');

  const crx = require('../src/main/extensions/crx');
  const fixtures = crx.buildCrx3TestFixtures();
  assert(
    !!crx.verifyAndStripCrx3(fixtures.valid.buffer, { expectedId: fixtures.valid.extensionId }).zip,
    'valid CRX3'
  );
  let t = false;
  try {
    crx.verifyAndStripCrx3(fixtures.tampered.buffer, { expectedId: fixtures.tampered.extensionId });
  } catch {
    t = true;
  }
  assert(t, 'tampered CRX3');
  let w = false;
  try {
    crx.verifyAndStripCrx3(fixtures.wrongId.buffer, { expectedId: fixtures.wrongId.expectedId });
  } catch {
    w = true;
  }
  assert(w, 'wrong id CRX3');
  let c2 = false;
  try {
    crx.verifyAndStripCrx3(fixtures.crx2.buffer);
  } catch {
    c2 = true;
  }
  assert(c2, 'CRX2 refused');
  console.log('PASS: CRX3 fixtures');

  clearModuleMatch(/\/src\/main\/extensions\/webstore/);
  clearModuleMatch(/\/src\/main\/extensions\/download/);
  const webstore = require('../src/main/extensions/webstore');
  const dl = require('../src/main/extensions/download');
  const sampleId = 'abcdefghijklmnopabcdefghijklmnop';
  assert(
    webstore.parseStoreUrl(
      'https://chromewebstore.google.com/detail/foo/' + sampleId
    )?.id === sampleId,
    'parse CWS detail slug/id'
  );
  assert(
    webstore.parseStoreUrl('https://chromewebstore.google.com/detail/' + sampleId)?.store ===
      'chrome',
    'parse CWS detail id-only'
  );
  assert(
    webstore.parseStoreUrl(
      'https://chrome.google.com/webstore/detail/foo/' + sampleId
    )?.id === sampleId,
    'parse legacy CWS'
  );
  assert(
    webstore.parseStoreUrl(
      'https://microsoftedge.microsoft.com/addons/detail/bar/' + sampleId
    )?.store === 'edge',
    'parse Edge addons detail'
  );
  assert(webstore.parseStoreUrl('https://evil.example/detail/' + sampleId) === null, 'reject foreign host');
  assert(webstore.isAllowedCrxDownloadHost('clients2.google.com'), 'allow clients2');
  assert(webstore.isAllowedCrxDownloadHost('r2---sn-xx.gvt1.com'), 'allow gvt1');
  assert(webstore.isAllowedCrxDownloadHost('edge.microsoft.com'), 'allow edge.microsoft');
  assert(
    webstore.isAllowedCrxDownloadHost('msedgeextensions.sf.tlu.dl.delivery.mp.microsoft.com'),
    'allow edge CDN'
  );
  assert(!webstore.isAllowedCrxDownloadHost('evil.example'), 'deny evil host');
  // Edge CDN regional HTTP → HTTPS sf.tlu rewrite
  {
    const edgeHttp = new URL(
      'http://msedgeextensions.f.tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/guid?P1=a&P2=b'
    );
    dl.assertAllowedCrxUrl(edgeHttp);
    assert(edgeHttp.protocol === 'https:', 'Edge f.tlu rewrite → https');
    assert(
      edgeHttp.hostname === 'msedgeextensions.sf.tlu.dl.delivery.mp.microsoft.com',
      'Edge f.tlu rewrite → sf.tlu host'
    );
    assert(
      edgeHttp.pathname === '/filestreamingservice/files/guid' &&
        edgeHttp.search === '?P1=a&P2=b',
      'Edge rewrite keeps path+query'
    );
  }
  let crxHttpFail = false;
  try {
    dl.assertAllowedCrxUrl(new URL('http://clients2.google.com/x'));
  } catch {
    crxHttpFail = true;
  }
  assert(crxHttpFail, 'CRX download rejects http');
  let crxHostFail = false;
  try {
    dl.assertAllowedCrxUrl(new URL('https://evil.example/x.crx'));
  } catch {
    crxHostFail = true;
  }
  assert(crxHostFail, 'CRX download rejects non-allowlisted host');
  // MULTIHEIZ_WEBSTORE_TEST_BASE only when SELFTEST (already set)
  process.env.MULTIHEIZ_WEBSTORE_TEST_BASE = 'http://127.0.0.1:9';
  clearModuleMatch(/\/src\/main\/extensions\/webstore/);
  clearModuleMatch(/\/src\/main\/extensions\/download/);
  const webstore2 = require('../src/main/extensions/webstore');
  assert(
    webstore2.parseStoreUrl('http://127.0.0.1:9/detail/x/' + sampleId + '?store=chrome')?.id ===
      sampleId,
    'test-base detail parse'
  );
  assert(
    webstore2.crxUrlFor('chrome', sampleId).startsWith('http://127.0.0.1:9/crx?'),
    'test-base crx url'
  );
  delete process.env.MULTIHEIZ_WEBSTORE_TEST_BASE;
  // Without SELFTEST, test base must be ignored
  const savedSt = process.env.MULTIHEIZ_SELFTEST;
  delete process.env.MULTIHEIZ_SELFTEST;
  process.env.MULTIHEIZ_WEBSTORE_TEST_BASE = 'http://127.0.0.1:9';
  clearModuleMatch(/\/src\/main\/extensions\/webstore/);
  const webstoreProd = require('../src/main/extensions/webstore');
  assert(webstoreProd.webstoreTestBase() === null, 'test base inert without SELFTEST');
  assert(
    !webstoreProd.crxUrlFor('chrome', sampleId).includes('127.0.0.1'),
    'production crx URL unchanged'
  );
  delete process.env.MULTIHEIZ_WEBSTORE_TEST_BASE;
  if (savedSt) process.env.MULTIHEIZ_SELFTEST = savedSt;
  console.log('PASS: webstore parse + CRX host allowlist');

  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Dois servidores locais (portas distintas = origens distintas) para
 * selftest de iframe cross-origin vs frame principal.
 * @returns {Promise<{ close: () => Promise<void>, topUrl: string, frameUrl: string }>}
 */
function startIpcFrameServers() {
  let frameUrl = '';
  const frameServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><body>
<script>
window.__mhFrameProbe = {
  hasAi: typeof window.__mhAi === 'function' || !!(window.__mhAi && window.__mhAi.open),
  hasMedia: typeof window.__mhMediaUseReport === 'function',
  hasLtForce: !!(window.__mhLt && typeof window.__mhLt.forceCheck === 'function'),
};
try {
  if (window.__mhMediaUseReport) window.__mhMediaUseReport({ microphone: true, camera: false });
} catch (e) {}
try {
  if (window.__mhAi && window.__mhAi.open) window.__mhAi.open();
} catch (e2) {}
try {
  if (window.parent) window.parent.postMessage({ type: 'mh-frame-ready', probe: window.__mhFrameProbe }, '*');
} catch (e3) {}
</script>
frame</body></html>`);
  });
  const topServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><body>
<iframe id="xo" src="${frameUrl}"></iframe>
<script>
window.__mhTopReady = false;
window.__mhFrameProbe = null;
window.addEventListener('message', function (ev) {
  if (ev && ev.data && ev.data.type === 'mh-frame-ready') {
    window.__mhFrameProbe = ev.data.probe || null;
    window.__mhTopReady = true;
  }
});
window.__mhPage = {
  ready: true,
  hasAi: !!(window.__mhAi && window.__mhAi.open),
  hasMedia: typeof window.__mhMediaUseReport === 'function',
};
</script>
top</body></html>`);
  });
  return new Promise((resolve, reject) => {
    frameServer.listen(0, '127.0.0.1', () => {
      const fp = frameServer.address().port;
      frameUrl = `http://127.0.0.1:${fp}/`;
      topServer.listen(0, '127.0.0.1', () => {
        const tp = topServer.address().port;
        resolve({
          topUrl: `http://127.0.0.1:${tp}/`,
          frameUrl,
          close: () =>
            Promise.all([
              new Promise((r) => frameServer.close(() => r())),
              new Promise((r) => topServer.close(() => r())),
            ]),
        });
      });
    });
    frameServer.on('error', reject);
    topServer.on('error', reject);
  });
}

function runElectronPhase(extraEnv) {
  return new Promise((resolve, reject) => {
    const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-sec-'));
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'security',
      ELECTRON_ENABLE_LOGGING: '1',
      ...(extraEnv || {}),
    };
    console.log('\n=== selftest:security electron ===');
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
      reject(new Error('security electron selftest timed out'));
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
      else reject(new Error('security electron exited with code ' + code));
    });
  });
}

async function main() {
  await runNodeChecks();
  const frames = await startIpcFrameServers();
  try {
    await runElectronPhase({
      MULTIHEIZ_SEC_TOP_URL: frames.topUrl,
      MULTIHEIZ_SEC_FRAME_URL: frames.frameUrl,
    });
  } finally {
    await frames.close();
  }
  console.log('PASS: selftest:security complete');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err && err.message ? err.message : err);
  process.exit(1);
});
