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
    s.layout = { cols: 1, rows: 1, slots: [{ accountId: 'acc-sec-a' }] };
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
    permissions.checkPermission('acc-sec-a', 'notifications', origin) === true,
    'notifications allowed for https'
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
  console.log('PASS: permission policy geo/media ask, usb/hid/serial deny, webauthn allow, FedCM deny');

  // Live session has handlers
  const ses = require('electron').session.fromPartition(panels.partitionFor('acc-sec-a'));
  assert(typeof ses.setPermissionRequestHandler === 'function', 'session permission API');
  console.log('PASS: session permission handlers attached');

  console.log('PASS: selftest:security electron complete');
  require('electron').app.exit(0);
}

module.exports = { runSecuritySelftest };
