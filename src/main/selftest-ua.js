'use strict';

const http = require('node:http');
const { app, session } = require('electron');

/**
 * Offline selftest: Chrome UA / Client Hints on panel + login popup (real openLoginPopup path).
 */
async function runUaSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    userAgent,
    sessionPersist,
  } = ctx;

  console.log('SELFTEST ua');
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  let server = null;
  let port = 0;

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = (req.url || '/').split('?')[0];
      if (u === '/echo-headers' || u === '/echo-popup') {
        const payload = JSON.stringify({
          ua: req.headers['user-agent'] || '',
          secChUa: req.headers['sec-ch-ua'] || '',
          secChUaFull: req.headers['sec-ch-ua-full-version-list'] || '',
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!DOCTYPE html><html><body><pre id="echo">' +
            payload +
            '</pre><script>window.__nav={ua:navigator.userAgent,brands:navigator.userAgentData&&navigator.userAgentData.brands};</script></body></html>'
        );
        return;
      }
      if (u === '/home') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body id="home">home-ok</body></html>');
        return;
      }
      res.writeHead(404);
      res.end('no');
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });

  const base = 'http://127.0.0.1:' + port;
  console.log('local server', base);

  updateState((s) => {
    s.settings.openLastPage = false;
    s.settings.homepage = base + '/home';
    s.settings.uaIdentity = 'chrome';
    s.accounts = [
      {
        id: 'acc-ua-a',
        name: 'UA',
        color: '#2bb8a6',
        workspaceId: s.activeWorkspaceId,
        startUrl: base + '/echo-headers',
        lastUrl: null,
        muted: false,
        adblockEnabled: true,
        lastBounds: { x: 10, y: 80, width: 500, height: 400 },
      },
    ];
  });
  flushSave();

  const built = userAgent.buildChromeUserAgent();
  if (/Electron/i.test(built) || /MultiHeiz/i.test(built) || !/Chrome\//i.test(built)) {
    console.log('FAIL: buildChromeUserAgent', built);
    app.exit(1);
    return;
  }
  console.log('PASS: buildChromeUserAgent clean Chrome UA');

  const sec = userAgent.buildSecChUa('chrome');
  if (!/Google Chrome/i.test(sec) || !/Chromium/i.test(sec) || /Electron/i.test(sec)) {
    console.log('FAIL: sec-ch-ua', sec);
    app.exit(1);
    return;
  }
  if (!/Not\?A_Brand/i.test(sec)) {
    console.log('FAIL: sec-ch-ua missing Not?A_Brand GREASE', sec);
    app.exit(1);
    return;
  }
  console.log('PASS: sec-ch-ua Chrome brands + GREASE');

  panels.createPanel('acc-ua-a');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: 'acc-ua-a', x: 0, y: 80, width: bw0, height: Math.max(240, bh0 - 80) },
    ]);
  }
  await waitForUrl('acc-ua-a', (u) => u.includes('/echo-headers'), 20000);
  await sleep(500);

  const panelNav = await panels.getPanelCapture('acc-ua-a').executeJavaScript(`({
    ua: navigator.userAgent,
    brands: navigator.userAgentData && navigator.userAgentData.brands,
    echo: (document.getElementById('echo') && document.getElementById('echo').textContent) || ''
  })`);
  let echoPanel = {};
  try {
    echoPanel = JSON.parse(panelNav.echo || '{}');
  } catch {
    echoPanel = {};
  }

  const badUa = (ua) => /Electron/i.test(ua || '') || /MultiHeiz/i.test(ua || '') || !/Chrome\//i.test(ua || '');
  const brandsHaveElectron = (brands) =>
    Array.isArray(brands) && brands.some((b) => /Electron/i.test((b && b.brand) || ''));
  const brandsHaveChromeFamily = (brands) =>
    Array.isArray(brands) &&
    brands.some((b) => /Chromium|Google Chrome/i.test((b && b.brand) || ''));

  if (badUa(panelNav.ua) || badUa(echoPanel.ua)) {
    console.log('FAIL: panel UA', { nav: panelNav.ua, hdr: echoPanel.ua });
    app.exit(1);
    return;
  }
  if (brandsHaveElectron(panelNav.brands) || !brandsHaveChromeFamily(panelNav.brands)) {
    console.log('FAIL: panel userAgentData.brands', panelNav.brands);
    app.exit(1);
    return;
  }
  if (!echoPanel.secChUa || /Electron/i.test(echoPanel.secChUa) || !/Chromium/i.test(echoPanel.secChUa)) {
    console.log('FAIL: panel sec-ch-ua header', echoPanel);
    app.exit(1);
    return;
  }
  console.log('PASS: panel navigator + headers UA/CH');

  const sesA = session.fromPartition(panels.partitionFor('acc-ua-a'));
  userAgent.applySessionUserAgent(sesA);
  sessionPersist.hookSessionCookies(sesA);

  const child = panels.openLoginPopup('acc-ua-a', base + '/echo-popup', sesA);
  if (!child || child.isDestroyed()) {
    console.log('FAIL: login popup not created');
    app.exit(1);
    return;
  }
  if (child.webContents.session !== sesA) {
    console.log('FAIL: popup session !== panel partition');
    app.exit(1);
    return;
  }
  console.log('PASS: OAuth popup uses same partition');

  await sleep(800);
  let popupNav = null;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    try {
      if (child.isDestroyed()) break;
      popupNav = await child.webContents.executeJavaScript(`({
        ua: navigator.userAgent,
        brands: navigator.userAgentData && navigator.userAgentData.brands,
        echo: (document.getElementById('echo') && document.getElementById('echo').textContent) || '',
        url: location.href
      })`);
      if (popupNav && popupNav.echo) break;
    } catch {
      /* loading */
    }
  }
  if (!popupNav || !popupNav.echo) {
    console.log('FAIL: popup echo not ready', popupNav);
    try {
      child.close();
    } catch {
      /* ignore */
    }
    app.exit(1);
    return;
  }
  let echoPopup = {};
  try {
    echoPopup = JSON.parse(popupNav.echo || '{}');
  } catch {
    echoPopup = {};
  }
  if (badUa(popupNav.ua) || badUa(echoPopup.ua)) {
    console.log('FAIL: popup UA', { nav: popupNav.ua, hdr: echoPopup.ua });
    try {
      child.close();
    } catch {
      /* ignore */
    }
    app.exit(1);
    return;
  }
  if (brandsHaveElectron(popupNav.brands) || !brandsHaveChromeFamily(popupNav.brands)) {
    console.log('FAIL: popup userAgentData.brands', popupNav.brands);
    try {
      child.close();
    } catch {
      /* ignore */
    }
    app.exit(1);
    return;
  }
  if (!echoPopup.secChUa || /Electron/i.test(echoPopup.secChUa) || !/Chromium/i.test(echoPopup.secChUa)) {
    console.log('FAIL: popup sec-ch-ua header', echoPopup);
    try {
      child.close();
    } catch {
      /* ignore */
    }
    app.exit(1);
    return;
  }
  console.log('PASS: popup navigator + headers UA/CH');

  try {
    child.close();
  } catch {
    /* ignore */
  }

  if (typeof userAgent.isGoogleAuthUrl === 'function') {
    if (!userAgent.isGoogleAuthUrl('https://accounts.google.com/signin')) {
      console.log('FAIL: isGoogleAuthUrl accounts.google.com');
      app.exit(1);
      return;
    }
    const gUa = userAgent.buildGoogleAuthUserAgent();
    if (!/Electron\//i.test(gUa) || /MultiHeiz/i.test(gUa)) {
      console.log('FAIL: google auth UA should keep Electron, strip MultiHeiz', gUa);
      app.exit(1);
      return;
    }
    console.log('PASS: google auth UA exception');
  }

  // --- Passkey preference (windowsPasskeys) ---
  // Default ON: patch must NOT be injected (do not call real WebAuthn API).
  {
    const onFlag = await panels.getPanelCapture('acc-ua-a').executeJavaScript(
      'typeof window.__MH_PASSKEYS_DISABLED__ !== "undefined" && !!window.__MH_PASSKEYS_DISABLED__'
    );
    if (onFlag) {
      console.log('FAIL: passkey disable patch present while windowsPasskeys default ON');
      app.exit(1);
      return;
    }
    console.log('PASS: passkeys ON — disable patch absent');
  }

  updateState((s) => {
    s.settings.windowsPasskeys = false;
  });
  flushSave();

  // New navigation so early-scriptlets re-runs with passkeyDisable
  panels.panelNavigate('acc-ua-a', base + '/home');
  await waitForUrl('acc-ua-a', (u) => u.includes('/home'), 20000);
  await sleep(400);

  const offProbe = await panels.getPanelCapture('acc-ua-a').executeJavaScript(`(async () => {
    const flag = !!window.__MH_PASSKEYS_DISABLED__;
    let cond = null;
    try {
      if (window.PublicKeyCredential && PublicKeyCredential.isConditionalMediationAvailable) {
        cond = await PublicKeyCredential.isConditionalMediationAvailable();
      }
    } catch (e) {
      cond = 'err:' + (e && e.name);
    }
    let uvpa = null;
    try {
      if (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
        uvpa = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      }
    } catch (e) {
      uvpa = 'err:' + (e && e.name);
    }
    const t0 = Date.now();
    let getName = null;
    try {
      await navigator.credentials.get({
        publicKey: {
          challenge: new Uint8Array(32),
          timeout: 60000,
          rpId: location.hostname,
          userVerification: 'preferred',
          allowCredentials: []
        }
      });
      getName = 'resolved';
    } catch (e) {
      getName = (e && e.name) || String(e);
    }
    const ms = Date.now() - t0;
    return { flag, cond, uvpa, getName, ms };
  })()`);

  if (!offProbe || !offProbe.flag) {
    console.log('FAIL: passkey disable patch missing when windowsPasskeys OFF', offProbe);
    app.exit(1);
    return;
  }
  if (offProbe.cond !== false) {
    console.log('FAIL: isConditionalMediationAvailable should be false', offProbe);
    app.exit(1);
    return;
  }
  if (offProbe.uvpa !== false) {
    console.log('FAIL: isUserVerifyingPlatformAuthenticatorAvailable should be false', offProbe);
    app.exit(1);
    return;
  }
  if (offProbe.getName !== 'NotAllowedError') {
    console.log('FAIL: credentials.get(publicKey) should reject NotAllowedError', offProbe);
    app.exit(1);
    return;
  }
  if (offProbe.ms > 3000) {
    console.log('FAIL: passkey reject too slow (dialog?)', offProbe.ms);
    app.exit(1);
    return;
  }
  console.log('PASS: passkeys OFF — NotAllowedError fast + platform auth hidden');

  // Restore default for any later suites sharing userdata
  updateState((s) => {
    s.settings.windowsPasskeys = true;
  });
  flushSave();

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest ua complete');
  app.exit(0);
}

module.exports = { runUaSelftest };
