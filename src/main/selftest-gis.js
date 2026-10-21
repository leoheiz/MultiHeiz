'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { envGet } = require('./config');

/**
 * Probe GIS/OAuth popup opener + Glif rewrite.
 * Default: mock HTTP local (nunca accounts.google.com / huntera).
 * Site real só com MULTIHEIZ_SELFTEST_REAL_SITES=1.
 * Log: _local/gis-probe.log
 */
async function runGisSelftest(ctx) {
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

  const useRealSites = envGet('MULTIHEIZ_SELFTEST_REAL_SITES') === '1';
  console.log('SELFTEST gis realSites=' + (useRealSites ? '1' : '0'));
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  const logPath = path.join(__dirname, '..', '..', '_local', 'gis-probe.log');
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    /* ignore */
  }
  const lines = [];
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    lines.push(line);
    console.log(line);
  };

  let server = null;
  let port = 0;

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const rawUrl = req.url || '/';
      const u = rawUrl.split('?')[0];
      const qs = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';

      if (u === '/opener-host') {
        // oauthStubUrl filled after listen via rewrite — use placeholder replaced client-side
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body>
<button id="go" type="button">Open GIS-like popup</button>
<pre id="msg">waiting</pre>
<script>
window.__oauthStub = window.__oauthStub || '';
window.addEventListener('message', function(ev) {
  document.getElementById('msg').textContent = 'msg:' + String(ev.data);
});
document.getElementById('go').onclick = function() {
  var w = window.open(window.__oauthStub, 'gis_oauth_probe', 'width=520,height=720');
  document.getElementById('msg').textContent = w ? 'opened' : 'null';
};
</script></body></html>`);
        return;
      }
      if (u === '/blank-host') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body>
<button id="go" type="button">Open blank</button>
<pre id="msg">waiting</pre>
<script>
window.addEventListener('message', function(ev) {
  document.getElementById('msg').textContent = 'msg:' + String(ev.data);
});
document.getElementById('go').onclick = function() {
  var w = window.open('about:blank', 'gis_blank_probe', 'width=520,height=720');
  document.getElementById('msg').textContent = w ? 'opened' : 'null';
};
</script></body></html>`);
        return;
      }
      if (u === '/home') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body id="home">home-ok</body></html>');
        return;
      }

      // --- Mock accounts.google.com GIS/OAuth ---
      if (u === '/mock-accounts/o/oauth2/v2/auth') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>Mock Google OAuth</title></head><body>
<h1>Mock OAuth</h1>
<p id="status">auth-start</p>
<script>
(function(){
  var hasOpener = !!(window.opener);
  document.getElementById('status').textContent = 'auth-start opener=' + hasOpener;
  // Redirect like IdP → relay (opener should survive on same-origin mock)
  setTimeout(function(){
    location.replace('/mock-accounts/oauth-relay?from=auth&opener=' + (hasOpener ? '1' : '0'));
  }, 120);
})();
</script></body></html>`);
        return;
      }
      if (u === '/mock-accounts/oauth-relay') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>Mock OAuth Relay</title></head><body>
<h1>Mock OAuth Done</h1>
<p id="status">relay</p>
<script>
(function(){
  var openerOk = !!(window.opener);
  document.getElementById('status').textContent = 'relay opener=' + openerOk;
  if (window.opener) {
    try { window.opener.postMessage('gis-oauth-done', '*'); } catch (e) {}
  }
})();
</script></body></html>`);
        return;
      }
      if (u === '/mock-accounts/v3/signin/identifier' || u.indexOf('/mock-accounts/v3/signin/') === 0) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>Mock Google Sign-In</title></head><body>
<h1>Fazer login</h1>
<form id="f">
  <input type="email" name="identifier" id="identifierId" />
  <button type="button" id="identifierNext">Avançar</button>
</form>
<pre id="out"></pre>
<script>
document.getElementById('identifierNext').onclick = function(){
  var v = (document.getElementById('identifierId').value || '');
  document.getElementById('out').textContent =
    "Couldn't find your Google Account for " + v;
};
</script></body></html>`);
        return;
      }
      if (u === '/mock-gsi-host') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body>
<iframe id="gsi" src="/mock-accounts/gsi/button" width="300" height="44"></iframe>
<p>mock gsi host</p>
</body></html>`);
        return;
      }
      if (u === '/mock-accounts/gsi/button') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body style="margin:0">
<button id="gsi-btn" type="button" style="width:100%;height:40px">Sign in with Google (mock)</button>
<script>
document.getElementById('gsi-btn').onclick = function(){
  window.open('/mock-accounts/o/oauth2/v2/auth?flowName=GeneralOAuthFlow','gis_btn','width=520,height=720');
};
</script></body></html>`);
        return;
      }

      res.writeHead(404);
      res.end('no ' + u);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });

  const base = 'http://127.0.0.1:' + port;
  const mockOauthUrl =
    base +
    '/mock-accounts/o/oauth2/v2/auth?client_id=test.apps.googleusercontent.com&redirect_uri=storagerelay%3A%2F%2Fhttps%2Flocalhost&response_type=token&scope=openid&flowName=GeneralOAuthFlow';
  const realOauthUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=test.apps.googleusercontent.com&redirect_uri=storagerelay%3A%2F%2Fhttps%2Flocalhost&response_type=token&scope=openid&flowName=GeneralOAuthFlow';
  const oauthStubUrl = useRealSites ? realOauthUrl : mockOauthUrl;
  log('local server ' + base + ' oauthStub=' + oauthStubUrl);

  updateState((s) => {
    s.settings.openLastPage = false;
    s.settings.homepage = base + '/home';
    s.settings.uaIdentity = 'chrome';
    s.accounts = [
      {
        id: 'acc-gis-a',
        name: 'GIS',
        color: '#2bb8a6',
        workspaceId: s.activeWorkspaceId,
        startUrl: base + '/blank-host',
        lastUrl: null,
        muted: false,
        adblockEnabled: true,
        lastBounds: { x: 10, y: 80, width: 500, height: 400 },
      },
    ];
  });
  flushSave();

  panels.createPanel('acc-gis-a');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: 'acc-gis-a', x: 0, y: 80, width: bw0, height: Math.max(240, bh0 - 80) },
    ]);
  }
  await waitForUrl('acc-gis-a', (u) => u.includes('/blank-host'), 20000);
  await sleep(400);

  const sesA = session.fromPartition(panels.partitionFor('acc-gis-a'));
  userAgent.applySessionUserAgent(sesA);
  sessionPersist.hookSessionCookies(sesA);

  // --- Local about:blank popup must keep window.opener + postMessage ---
  const beforePopups = BrowserWindow.getAllWindows().length;
  const wc = panels.getPanelCapture('acc-gis-a');
  await wc.executeJavaScript(`document.getElementById('go').click()`);
  await sleep(600);

  let blankChild = null;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    for (const win of panels.childPopups) {
      if (win && !win.isDestroyed()) {
        blankChild = win;
        break;
      }
    }
    if (blankChild) break;
  }
  let openerOk = false;
  let popupUrlChain = [];
  if (!blankChild) {
    log('FAIL: about:blank popup was not created');
  } else {
    try {
      const probe = await blankChild.webContents.executeJavaScript(`({
        opener: !!(window.opener),
        href: location.href
      })`);
      log('blank popup probe ' + JSON.stringify(probe));
      openerOk = !!(probe && probe.opener);
      if (openerOk) {
        await blankChild.webContents.executeJavaScript(
          `window.opener && window.opener.postMessage('opener-ok', '*')`
        );
        await sleep(200);
        const msg = await wc.executeJavaScript(
          `(document.getElementById('msg') && document.getElementById('msg').textContent) || ''`
        );
        log('postMessage to opener result: ' + msg);
        if (!String(msg).includes('opener-ok')) openerOk = false;
      }
    } catch (err) {
      log('blank probe error: ' + (err && err.message));
    }
  }
  log('local about:blank opener non-null / postMessage: ' + openerOk);
  if (!openerOk) {
    log('FAIL: about:blank popup missing window.opener');
    try {
      fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
    } catch {
      /* ignore */
    }
    app.exit(1);
    return;
  }
  console.log('PASS: local about:blank popup keeps opener + postMessage');

  for (const win of [...panels.childPopups]) {
    try {
      if (win && !win.isDestroyed()) win.close();
    } catch {
      /* ignore */
    }
  }
  await sleep(300);

  // --- Glif rewrite escopada (sem rede) ---
  {
    const cases = [
      {
        url: 'https://accounts.google.com/o/oauth2/v2/auth?flowName=GlifWebSignIn&client_id=x',
        expect: false,
        label: 'OAuth Glif (não reescrever)',
      },
      {
        url: 'https://accounts.google.com/o/oauth2/v2/auth?flowName=GeneralOAuthFlow',
        expect: false,
        label: 'OAuth General',
      },
      {
        url: 'https://accounts.google.com/gsi/select?flowName=GlifWebSignIn',
        expect: false,
        label: 'GSI select',
      },
      {
        url:
          'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&continue=https%3A%2F%2Fwww.google.com',
        expect: true,
        label: 'identifier Glif',
      },
    ];
    for (const c of cases) {
      const got = userAgent.shouldRewriteGlifWebSignIn(c.url, { resourceType: 'mainFrame' });
      if (got !== c.expect) {
        log('FAIL: Glif rewrite ' + c.label + ' expect=' + c.expect + ' got=' + got);
        app.exit(1);
        return;
      }
      if (c.expect) {
        const rewritten = userAgent.rewriteGlifWebSignInUrl(c.url);
        if (!/flowName=WebLiteSignIn/i.test(rewritten) || /flowName=GlifWebSignIn/i.test(rewritten)) {
          log('FAIL: rewrite output ' + rewritten);
          app.exit(1);
          return;
        }
      }
    }
    console.log('PASS: Glif rewrite scoped (OAuth/GIS untouched, identifier rewritten)');
  }

  // --- window.open OAuth (mock local ou Google real) ---
  panels.panelNavigate('acc-gis-a', base + '/opener-host');
  await waitForUrl('acc-gis-a', (u) => u.includes('/opener-host'), 20000);
  await sleep(400);
  await panels.getPanelCapture('acc-gis-a').executeJavaScript(
    `window.__oauthStub = ${JSON.stringify(oauthStubUrl)}; true`
  );

  const beforeOauth = BrowserWindow.getAllWindows().length;
  await panels.getPanelCapture('acc-gis-a').executeJavaScript(
    `document.getElementById('go').click()`
  );

  let oauthChild = null;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    for (const win of panels.childPopups) {
      if (win && !win.isDestroyed()) {
        oauthChild = win;
        break;
      }
    }
    if (oauthChild) break;
  }

  if (!oauthChild) {
    log('FAIL: OAuth popup window not found');
    try {
      fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
    } catch {
      /* ignore */
    }
    app.exit(1);
    return;
  }

  {
    const chain = [];
    const pushNav = (ev, url, extra) => {
      const entry = { ev, url: String(url || ''), extra: extra || '' };
      chain.push(entry);
      log('nav ' + ev + ' ' + entry.url + (extra ? ' ' + extra : ''));
    };
    oauthChild.webContents.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) pushNav('did-start-navigation', url);
    });
    oauthChild.webContents.on('did-redirect-navigation', (_e, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) pushNav('did-redirect-navigation', url);
    });
    oauthChild.webContents.on('did-navigate', (_e, url) => pushNav('did-navigate', url));
    oauthChild.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame) pushNav('did-fail-load', url, 'code=' + code + ' ' + desc);
    });

    let openerInPopup = null;
    for (let i = 0; i < 20; i++) {
      try {
        openerInPopup = await oauthChild.webContents.executeJavaScript(
          `({ opener: !!(window.opener), href: location.href, ua: navigator.userAgent })`
        );
        if (
          openerInPopup &&
          (openerInPopup.opener ||
            /mock-accounts|accounts\.google\.com/i.test(openerInPopup.href || ''))
        ) {
          break;
        }
      } catch {
        /* loading */
      }
      await sleep(100);
    }
    await sleep(useRealSites ? 1500 : 500);
    let afterLoad = null;
    try {
      afterLoad = await oauthChild.webContents.executeJavaScript(
        `({ opener: !!(window.opener), href: location.href, title: document.title, bodyLen: (document.body&&document.body.innerText||'').length, status: (document.getElementById('status')&&document.getElementById('status').textContent)||'' })`
      );
    } catch (err) {
      log('after-load probe error: ' + (err && err.message));
    }
    log('oauth popup early=' + JSON.stringify(openerInPopup));
    log('oauth popup afterLoad=' + JSON.stringify(afterLoad));
    popupUrlChain = chain.map((c) => c.ev + ' ' + c.url);

    if (useRealSites) {
      const loaded =
        afterLoad &&
        /accounts\.google\.com/i.test(afterLoad.href || '') &&
        (Number(afterLoad.bodyLen) > 20 || String(afterLoad.title || '').length > 0);
      if (!loaded) {
        log('FAIL: OAuth popup did not load Google content');
        try {
          fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
        } catch {
          /* ignore */
        }
        app.exit(1);
        return;
      }
    } else {
      const href = String((afterLoad && afterLoad.href) || (openerInPopup && openerInPopup.href) || '');
      const sawAuth =
        /mock-accounts\/o\/oauth2|mock-accounts\/oauth-relay/i.test(href) ||
        popupUrlChain.some((l) => /mock-accounts/.test(l));
      const sawRelay =
        /oauth-relay/i.test(href) || popupUrlChain.some((l) => /oauth-relay/.test(l));
      const openerKept =
        !!(openerInPopup && openerInPopup.opener) || !!(afterLoad && afterLoad.opener);
      if (!sawAuth) {
        log('FAIL: mock OAuth popup did not navigate to mock-accounts');
        app.exit(1);
        return;
      }
      if (!sawRelay) {
        log('FAIL: mock OAuth missing redirect to oauth-relay');
        app.exit(1);
        return;
      }
      if (!openerKept) {
        log('FAIL: mock OAuth lost window.opener (same-origin mock should keep it)');
        app.exit(1);
        return;
      }
      // postMessage from relay
      await sleep(200);
      const hostMsg = await panels.getPanelCapture('acc-gis-a').executeJavaScript(
        `(document.getElementById('msg') && document.getElementById('msg').textContent) || ''`
      );
      log('host msg after oauth: ' + hostMsg);
      if (!/gis-oauth-done/.test(String(hostMsg))) {
        log('FAIL: opener did not receive gis-oauth-done');
        app.exit(1);
        return;
      }
    }
    console.log(
      useRealSites
        ? 'PASS: OAuth/GIS-style popup loads (real Google)'
        : 'PASS: OAuth/GIS mock popup (opener + redirect + postMessage)'
    );

    const count1 = [...panels.childPopups].filter((w) => w && !w.isDestroyed()).length;
    await panels.getPanelCapture('acc-gis-a').executeJavaScript(
      `document.getElementById('go').click()`
    );
    await sleep(600);
    const count2 = [...panels.childPopups].filter((w) => w && !w.isDestroyed()).length;
    log('popup count after repeat click: before=' + count1 + ' after=' + count2);
    if (count2 > count1) {
      log('FAIL: repeated open created extra popup');
      app.exit(1);
      return;
    }
    console.log('PASS: repeated GIS open reuses/focuses popup');

    try {
      oauthChild.close();
    } catch {
      /* ignore */
    }
  }

  // --- Mock sign-in identifier (default) / real Google (flag) ---
  if (!useRealSites) {
    log('mock Google sign-in identifier…');
    panels.panelNavigate('acc-gis-a', base + '/mock-accounts/v3/signin/identifier?flowName=GlifWebSignIn');
    await waitForUrl('acc-gis-a', (u) => /mock-accounts\/v3\/signin/i.test(u), 15000);
    await sleep(300);
    const typed = await panels.getPanelCapture('acc-gis-a').executeJavaScript(`(function(){
      var input = document.querySelector('input[type="email"],#identifierId');
      if (!input) return { ok: false, reason: 'no-input' };
      input.focus();
      input.value = 'nobody-multiheiz-probe@gmail.com';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      var next = document.querySelector('#identifierNext');
      if (next) next.click();
      return { ok: true, out: (document.getElementById('out')&&document.getElementById('out').textContent)||'' };
    })()`);
    log('fake-email mock ' + JSON.stringify(typed));
    if (!typed || !typed.ok || !/couldn'?t find your google account/i.test(String(typed.out || ''))) {
      log('FAIL: mock sign-in fake-email');
      app.exit(1);
      return;
    }
    console.log('PASS: mock Google sign-in fake-email (account not found)');
  }

  // --- Real sites only under flag ---
  if (useRealSites) {
    let hunteraTried = false;
    try {
      hunteraTried = true;
      log('loading https://huntera.com.br …');
      panels.panelNavigate('acc-gis-a', 'https://huntera.com.br');
      await waitForUrl('acc-gis-a', (u) => /huntera\\.com\\.br/i.test(u), 25000);
      await sleep(3000);
      const pageInfo = await panels.getPanelCapture('acc-gis-a').executeJavaScript(`({
        href: location.href,
        title: document.title,
        iframes: Array.from(document.querySelectorAll('iframe')).map(function(f){
          return { src: f.src||'', w: f.offsetWidth, h: f.offsetHeight, id: f.id||'' };
        }).filter(function(f){ return /accounts\\.google\\.com\\/gsi|google/i.test(f.src); })
      })`);
      log('huntera page ' + JSON.stringify(pageInfo));
    } catch (err) {
      log('huntera unreachable or timed out: ' + (err && err.message));
    }
    log('hunteraTried=' + hunteraTried);

    try {
      log('direct Google sign-in fake-email check…');
      const signInUrl =
        'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&continue=https%3A%2F%2Fwww.google.com';
      panels.panelNavigate('acc-gis-a', signInUrl);
      await waitForUrl(
        'acc-gis-a',
        (u) =>
          /accounts\\.google\\.com/i.test(u) &&
          /identifier|signin|ServiceLogin|AccountChooser/i.test(u),
        30000
      );
      await sleep(2500);
      const bodyText = await panels.getPanelCapture('acc-gis-a').executeJavaScript(`({
        href: location.href,
        text: (document.body && document.body.innerText || '').slice(0, 4000),
        ua: navigator.userAgent
      })`);
      const text = String((bodyText && bodyText.text) || '');
      const insecure = /may not be secure|navegador.*n[aã]o.*seguro|este navegador/i.test(text);
      if (insecure) {
        log('FAIL: Google shows insecure browser on direct sign-in');
        app.exit(1);
        return;
      }
      console.log('PASS: direct Google sign-in loaded without insecure banner');
    } catch (err) {
      log('direct Google sign-in skipped (network): ' + (err && err.message));
    }
  } else {
    log('SKIP: sites reais (huntera / accounts.google.com) — use MULTIHEIZ_SELFTEST_REAL_SITES=1');
    // Mock GSI host click still exercises popup path locally
    panels.panelNavigate('acc-gis-a', base + '/mock-gsi-host');
    await waitForUrl('acc-gis-a', (u) => /mock-gsi-host/.test(u), 15000);
    await sleep(300);
    console.log('PASS: mock GSI host served (no real Google)');
  }

  log('beforePopups=' + beforePopups + ' beforeOauth=' + beforeOauth);
  if (popupUrlChain.length) {
    log('URL chain:\n' + popupUrlChain.join('\n'));
  }

  try {
    fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
    console.log('Wrote ' + logPath);
  } catch (err) {
    console.log('WARN: could not write gis-probe.log', err && err.message);
  }

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest gis complete');
  app.exit(0);
}

module.exports = { runGisSelftest };
