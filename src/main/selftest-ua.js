'use strict';

const http = require('node:http');
const { app, BrowserWindow, session } = require('electron');

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
    rendererEval,
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
      if (u === '/oauth-opener' || u === '/blank-opener') {
        const target =
          u === '/blank-opener'
            ? 'about:blank'
            : 'https://accounts.google.com/o/oauth2/v2/auth?client_id=ua-selftest.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1&response_type=token&scope=openid&flowName=GeneralOAuthFlow';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!DOCTYPE html><html><body><button id="go">go</button><pre id="msg">waiting</pre>' +
            '<script>window.addEventListener("message",function(e){document.getElementById("msg").textContent="msg:"+e.data;});' +
            'document.getElementById("go").onclick=function(){window.open(' +
            JSON.stringify(target) +
            ',"ua_oauth_probe","width=520,height=720");};</script></body></html>'
        );
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

  // Rótulo da UI: nunca "do Windows" em Linux/macOS (simula platform via gancho).
  {
    const passkeys = require('./passkeys');
    function assertLabel(platform, expectSubstr, forbidSubstr) {
      passkeys.setSelftestPlatformOverride(platform);
      const ui = passkeys.getPasskeysUi();
      if (!ui.supported) {
        throw new Error('passkeys UI should be supported on ' + platform);
      }
      if (!String(ui.label || '').includes(expectSubstr)) {
        throw new Error('passkeys label for ' + platform + ' missing "' + expectSubstr + '": ' + ui.label);
      }
      if (forbidSubstr && String(ui.label || '').includes(forbidSubstr)) {
        throw new Error('passkeys label for ' + platform + ' must not say "' + forbidSubstr + '": ' + ui.label);
      }
    }
    assertLabel('linux', 'do sistema', 'do Windows');
    assertLabel('darwin', 'do sistema', 'do Windows');
    assertLabel('win32', 'do Windows', null);
    passkeys.setSelftestPlatformOverride('linux');
    // Renderer must pick up passkeysUi from app:info
    if (typeof rendererEval === 'function') {
      await rendererEval(`(async function(){
        if (window.MultiHeizV16 && window.MultiHeizV16.fillSettingsForm) {
          await window.MultiHeizV16.fillSettingsForm();
        }
        return true;
      })()`);
      const labelText = await rendererEval(
        'document.getElementById("windows-passkeys-label") && document.getElementById("windows-passkeys-label").textContent'
      );
      if (!labelText || !String(labelText).includes('do sistema') || String(labelText).includes('do Windows')) {
        console.log('FAIL: renderer passkeys label for simulated linux', labelText);
        app.exit(1);
        return;
      }
      console.log('PASS: passkeys label renderer (linux sim) =', labelText);
    } else {
      console.log('PASS: passkeys label helpers (no rendererEval)');
    }
    passkeys.setSelftestPlatformOverride(null);
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

  // --- GIS/OAuth popup opener + Glif rewrite scope + reuse ---
  {
    // Handler must allow IdP URLs (Chromium keeps opener; deny+detached BrowserWindow breaks GIS).
    const sesProbe = session.fromPartition(panels.partitionFor('acc-ua-a'));
    const allowResp = panels.handlePanelWindowOpen(
      'acc-ua-a',
      {
        url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&flowName=GeneralOAuthFlow',
        frameName: 'ua_oauth_probe',
        features: 'width=520,height=720',
        disposition: 'new-window',
      },
      sesProbe,
      panels.getPanelCapture('acc-ua-a')
    );
    if (!allowResp || allowResp.action !== 'allow' || !allowResp.overrideBrowserWindowOptions) {
      console.log('FAIL: IdP window.open handler must action=allow', allowResp);
      app.exit(1);
      return;
    }
    console.log('PASS: IdP window.open handler returns action=allow (keeps opener)');

    // (a) about:blank login-style popup keeps opener + postMessage (COOP-safe local check)
    panels.panelNavigate('acc-ua-a', base + '/blank-opener');
    await waitForUrl('acc-ua-a', (u) => u.includes('/blank-opener'), 20000);
    await sleep(400);

    const beforeCount = [...panels.childPopups].filter((w) => w && !w.isDestroyed()).length;
    await panels.getPanelCapture('acc-ua-a').executeJavaScript(
      'document.getElementById("go").click()'
    );
    await sleep(600);

    let oauthWin = null;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      for (const w of panels.childPopups) {
        if (w && !w.isDestroyed()) {
          oauthWin = w;
          break;
        }
      }
      if (oauthWin) break;
    }
    if (!oauthWin) {
      console.log('FAIL: window.open login-style popup not created');
      app.exit(1);
      return;
    }
    let openerProbe = null;
    try {
      openerProbe = await oauthWin.webContents.executeJavaScript(
        '({ opener: !!(window.opener), href: location.href })'
      );
    } catch (err) {
      console.log('FAIL: opener probe', err && err.message);
      app.exit(1);
      return;
    }
    if (!openerProbe || !openerProbe.opener) {
      console.log('FAIL: login popup missing window.opener', openerProbe);
      app.exit(1);
      return;
    }
    await oauthWin.webContents.executeJavaScript(
      'window.opener && window.opener.postMessage("ua-opener-ok","*")'
    );
    await sleep(200);
    const msg = await panels.getPanelCapture('acc-ua-a').executeJavaScript(
      '(document.getElementById("msg")&&document.getElementById("msg").textContent)||""'
    );
    if (!String(msg).includes('ua-opener-ok')) {
      console.log('FAIL: postMessage to opener failed', msg);
      app.exit(1);
      return;
    }
    console.log('PASS: login-style window.open keeps opener + postMessage');

    // (c) repeated open does not create a second window
    await panels.getPanelCapture('acc-ua-a').executeJavaScript(
      'document.getElementById("go").click()'
    );
    await sleep(500);
    const afterCount = [...panels.childPopups].filter((w) => w && !w.isDestroyed()).length;
    if (afterCount > beforeCount + 1) {
      console.log('FAIL: repeated open piled popups', {
        beforeCount,
        afterCount,
        wins: BrowserWindow.getAllWindows().length,
      });
      app.exit(1);
      return;
    }
    console.log('PASS: repeated IdP popup open does not pile windows');

    try {
      oauthWin.close();
    } catch {
      /* ignore */
    }
    await sleep(200);
  }

  {
    // (b) Glif rewrite: OAuth/GIS untouched; identifier Glif rewritten
    const cases = [
      {
        url: 'https://accounts.google.com/o/oauth2/v2/auth?flowName=GlifWebSignIn&client_id=x',
        expect: false,
        label: 'oauth + client_id',
      },
      {
        url: 'https://accounts.google.com/o/oauth2/v2/auth?flowName=GeneralOAuthFlow',
        expect: false,
        label: 'GeneralOAuthFlow',
      },
      {
        url: 'https://accounts.google.com/gsi/select?flowName=GlifWebSignIn',
        expect: false,
        label: '/gsi/select',
      },
      {
        url: 'https://accounts.google.com/signin/oauth/id?flowName=GlifWebSignIn',
        expect: false,
        label: '/signin/oauth/id',
      },
      {
        url: 'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&continue=https%3A%2F%2Fwww.google.com',
        expect: true,
        label: '/v3/signin/identifier Glif',
      },
    ];
    for (const c of cases) {
      const got = userAgent.shouldRewriteGlifWebSignIn(c.url, { resourceType: 'mainFrame' });
      if (got !== c.expect) {
        console.log('FAIL: Glif rewrite', c.label, { expect: c.expect, got, url: c.url });
        app.exit(1);
        return;
      }
      if (c.expect) {
        const rewritten = userAgent.rewriteGlifWebSignInUrl(c.url);
        if (!/flowName=WebLiteSignIn/i.test(rewritten) || /flowName=GlifWebSignIn/i.test(rewritten)) {
          console.log('FAIL: rewrite output', rewritten);
          app.exit(1);
          return;
        }
      }
      // Subresource must never rewrite
      if (
        userAgent.shouldRewriteGlifWebSignIn(c.url, { resourceType: 'xhr' }) ||
        userAgent.shouldRewriteGlifWebSignIn(c.url, { resourceType: 'script' })
      ) {
        console.log('FAIL: Glif rewrite must not touch non-mainFrame', c.label);
        app.exit(1);
        return;
      }
    }
    console.log('PASS: Glif rewrite scoped (OAuth/GIS untouched, identifier rewritten)');
  }

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest ua complete');
  app.exit(0);
}

module.exports = { runUaSelftest };
