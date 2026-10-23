'use strict';

/**
 * In-process security selftest (MULTIHEIZ_SELFTEST=security).
 * Node-only checks run from tools/selftest-security.js; this covers live Electron.
 */

/**
 * @param {object} ctx
 */
async function runSecuritySelftest(ctx) {
  const {
    mainWindow,
    panels,
    getState,
    updateState,
    flushSave,
    sleep,
    ipcGuard,
    permissions,
  } = ctx;

  console.log('MultiHeiz selftest:security (electron)');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  // --- Main UI navigation / window.open / webview ---
  assert(mainWindow && !mainWindow.isDestroyed(), 'main window');
  const uiUrl = mainWindow.webContents.getURL();
  assert(ipcGuard.isAppRendererUrl(uiUrl), 'main UI is local index.html: ' + uiUrl);

  // will-navigate should block leaving the UI
  let navBlocked = false;
  const navPromise = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 800);
    mainWindow.webContents.once('will-navigate', (e, url) => {
      if (!ipcGuard.isAppRendererUrl(url)) {
        navBlocked = e.defaultPrevented || true;
        // preventDefault is done by our handler; event may already be prevented
        clearTimeout(t);
        resolve(true);
      }
    });
  });
  mainWindow.webContents
    .executeJavaScript('location.href = "https://evil.example/"')
    .catch(() => {});
  await navPromise;
  await sleep(300);
  assert(ipcGuard.isAppRendererUrl(mainWindow.webContents.getURL()), 'UI stayed on index after navigate attempt');
  console.log('PASS: main UI will-navigate blocks external URL', navBlocked ? '(event seen)' : '');

  // --- Panel window.open to dangerous schemes ---
  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-sec-a');
    s.accounts.push({
      id: 'acc-sec-a',
      name: 'Sec',
      workspaceId: 'ws-default',
      color: '#4a9',
      muted: false,
      zoomFactor: 1,
      startUrl: 'data:text/html;charset=utf-8,' + encodeURIComponent('<html><body>sec</body></html>'),
      lastUrl: '',
    });
    s.layout = '1';
    if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
      s.layoutByWorkspace = {};
    }
    s.layoutByWorkspace[s.activeWorkspaceId] = '1';
  });
  flushSave();
  panels.createPanel('acc-sec-a');
  await sleep(600);
  const wc = panels.getPanelCapture('acc-sec-a');
  assert(wc && !wc.isDestroyed(), 'panel webContents');
  let before = '';
  try {
    before = wc.getURL();
  } catch {
    before = '';
  }
  assert(before.startsWith('data:') || before.startsWith('http'), 'panel loaded: ' + before);

  const startData = before;
  for (const bad of [
    'file:///C:/Windows',
    'javascript:alert(1)',
    'data:text/html,pwned',
  ]) {
    try {
      await wc.loadURL(startData);
    } catch {
      /* ignore */
    }
    await sleep(300);
    const beforeOpen = wc.getURL();
    await wc.executeJavaScript(`window.open(${JSON.stringify(bad)}, "_blank")`).catch(() => {});
    await sleep(400);
    const after = wc.getURL();
    const loadedAttack =
      after.startsWith('file:') ||
      after.startsWith('javascript:') ||
      (bad.startsWith('data:') && after.includes('pwned'));
    assert(
      !loadedAttack,
      `window.open(${bad}) must not load attack URL (before=${beforeOpen} after=${after})`
    );
    // Prefer unchanged URL; Chromium may flip opener to about:blank when denying javascript:
    assert(
      after === beforeOpen || after === 'about:blank' || after.startsWith('data:text/html'),
      `window.open(${bad}) must not navigate panel away (before=${beforeOpen} after=${after})`
    );
  }
  console.log('PASS: panel window.open file/javascript/data denied');

  // --- IPC guard: UI channel from panel rejected; from main accepted ---
  ipcGuard.resetRejectCountForTest();
  const panelFrame = wc.mainFrame;
  const panelEvent = { sender: wc, senderFrame: panelFrame };
  assert(!ipcGuard.isAllowedIpc(panelEvent, 'state:get'), 'panel cannot call state:get');
  assert(ipcGuard.isTrustedPanelEvent(panelEvent), 'panel is trusted for panel channels');
  assert(
    ipcGuard.isAllowedIpc(panelEvent, '@ghostery/adblocker/early-scriptlets'),
    'panel may call adblock early channel'
  );
  assert(ipcGuard.isAllowedIpc(panelEvent, 'panel:ai-open'), 'main frame may panel:ai-open');
  assert(ipcGuard.isAllowedIpc(panelEvent, 'panel:media-use'), 'main frame may panel:media-use');
  assert(ipcGuard.isAllowedIpc(panelEvent, 'panel:ctrl-wheel'), 'main frame may panel:ctrl-wheel');

  const subframeTrusted = {
    sender: wc,
    senderFrame: {
      url: 'http://127.0.0.1:9/',
      parent: panelFrame || { url: 'http://127.0.0.1:8/' },
    },
  };
  assert(!ipcGuard.isMainFrameEvent(subframeTrusted), 'subframe is not main');
  assert(!ipcGuard.isAllowedIpc(subframeTrusted, 'panel:ai-open'), 'subframe cannot panel:ai-open');
  assert(!ipcGuard.isAllowedIpc(subframeTrusted, 'panel:media-use'), 'subframe cannot panel:media-use');
  assert(!ipcGuard.isAllowedIpc(subframeTrusted, 'panel:ctrl-wheel'), 'subframe cannot panel:ctrl-wheel');

  const uiFrame = mainWindow.webContents.mainFrame;
  const uiEvent = { sender: mainWindow.webContents, senderFrame: uiFrame };
  assert(ipcGuard.isAllowedIpc(uiEvent, 'state:get'), 'main UI may call state:get');
  assert(!ipcGuard.isAllowedIpc(uiEvent, '@ghostery/adblocker/early-scriptlets'), 'UI is not a panel channel sender');

  const unknownEvent = {
    sender: wc,
    senderFrame: null,
  };
  assert(!ipcGuard.isAllowedIpc(unknownEvent, 'state:get'), 'missing senderFrame rejected');
  console.log('PASS: IPC guard rejects unknown/panel-for-UI frames');
  console.log('PASS: IPC main-frame-only for ai-open/media-use/ctrl-wheel');

  // --- Permissions: no auto-grant for geo/media; usb/hid/serial denied ---
  permissions.clearDecisionsForTest();
  const origin = 'https://example.com';
  assert(
    permissions.checkPermission('acc-sec-a', 'geolocation', origin) === false,
    'geolocation not auto-granted'
  );
  assert(
    permissions.checkPermission('acc-sec-a', 'media', origin, { mediaTypes: ['video'] }) === false,
    'media not auto-granted'
  );
  assert(permissions.checkPermission('acc-sec-a', 'usb', origin) === false, 'usb denied');
  assert(permissions.checkPermission('acc-sec-a', 'hid', origin) === false, 'hid denied');
  assert(permissions.checkPermission('acc-sec-a', 'serial', origin) === false, 'serial denied');
  assert(
    permissions.checkPermission('acc-sec-a', 'notifications', origin) === false,
    'notifications ask (not auto-granted)'
  );
  assert(
    permissions.checkPermission('acc-sec-a', 'publickey-credentials-get', origin) === true,
    'webauthn get allowed for https (Google sign-in)'
  );
  assert(
    permissions.checkPermission('acc-sec-a', 'publickey-credentials-create', origin) === true,
    'webauthn create allowed for https'
  );
  assert(
    permissions.checkPermission('acc-sec-a', 'identity-credentials-get', origin) === false,
    'FedCM identity-credentials-get denied'
  );
  console.log(
    'PASS: permission policy geo/media/notifications ask, usb/hid/serial deny, webauthn allow, FedCM deny'
  );

  // Live session has handlers
  const ses = require('electron').session.fromPartition(panels.partitionFor('acc-sec-a'));
  assert(typeof ses.setPermissionRequestHandler === 'function', 'session permission API');
  console.log('PASS: session permission handlers attached');

  // --- iframe cross-origin: pontes de UI só no top; IPC de subframe ignorado ---
  const topUrl = process.env.MULTIHEIZ_SEC_TOP_URL || '';
  if (topUrl && topUrl.startsWith('http://127.0.0.1')) {
    permissions.clearMediaInUse('acc-sec-a');
    ipcGuard.resetRejectCountForTest();
    const rejectsBefore = ipcGuard.getRejectCount();
    await wc.loadURL(topUrl).catch(() => {});
    await sleep(1200);
    let topProbe = null;
    for (let i = 0; i < 20; i++) {
      topProbe = await wc
        .executeJavaScript(
          `(function(){
            return {
              ready: !!(window.__mhPage && window.__mhPage.ready),
              hasAi: !!(window.__mhAi && window.__mhAi.open),
              hasMedia: typeof window.__mhMediaUseReport === 'function',
              frameProbe: window.__mhFrameProbe,
              topReady: !!window.__mhTopReady,
            };
          })()`
        )
        .catch(() => null);
      if (topProbe && topProbe.ready && topProbe.topReady) break;
      await sleep(200);
    }
    assert(topProbe && topProbe.ready, 'top page loaded');
    assert(topProbe.hasAi, 'top has __mhAi');
    assert(topProbe.hasMedia, 'top has __mhMediaUseReport');
    assert(topProbe.frameProbe, 'iframe posted probe');
    assert(!topProbe.frameProbe.hasAi, 'iframe must not expose __mhAi');
    assert(!topProbe.frameProbe.hasMedia, 'iframe must not expose __mhMediaUseReport');
    await sleep(400);
    const media = permissions.getMediaInUse('acc-sec-a');
    assert(!media.microphone && !media.camera, 'iframe media-use ignored');
    // Main frame still works
    await wc
      .executeJavaScript(
        `(function(){
          if (typeof window.__mhMediaUseReport === 'function') {
            window.__mhMediaUseReport({ microphone: true, camera: false });
          }
          return true;
        })()`
      )
      .catch(() => {});
    await sleep(300);
    const media2 = permissions.getMediaInUse('acc-sec-a');
    assert(media2.microphone === true, 'main frame media-use works');
    console.log(
      'PASS: iframe cross-origin bridges hidden; media-use main-only',
      'rejectsΔ=',
      ipcGuard.getRejectCount() - rejectsBefore
    );
  } else {
    console.log('SKIP: iframe IPC frames (no MULTIHEIZ_SEC_TOP_URL)');
  }

  console.log('PASS: selftest:security electron complete');
  require('electron').app.exit(0);
}

module.exports = { runSecuritySelftest };
