'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

/**
 * Probe GIS/OAuth popup opener + optional live huntera.com.br click.
 * Writes URL chain / opener evidence to _local/gis-probe.log.
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

  console.log('SELFTEST gis');
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

  const oauthStubUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=test.apps.googleusercontent.com&redirect_uri=storagerelay%3A%2F%2Fhttps%2Flocalhost&response_type=token&scope=openid&flowName=GeneralOAuthFlow';

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = (req.url || '/').split('?')[0];
      if (u === '/opener-host') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><body>
<button id="go" type="button">Open GIS-like popup</button>
<pre id="msg">waiting</pre>
<script>
window.addEventListener('message', function(ev) {
  document.getElementById('msg').textContent = 'msg:' + String(ev.data);
});
document.getElementById('go').onclick = function() {
  var w = window.open(${JSON.stringify(oauthStubUrl)}, 'gis_oauth_probe', 'width=520,height=720');
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
  log('local server ' + base);

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

  // Close blank probe popups
  for (const win of [...panels.childPopups]) {
    try {
      if (win && !win.isDestroyed()) win.close();
    } catch {
      /* ignore */
    }
  }
  await sleep(300);

  // --- window.open to real OAuth URL: log navigation chain + opener ---
  panels.panelNavigate('acc-gis-a', base + '/opener-host');
  await waitForUrl('acc-gis-a', (u) => u.includes('/opener-host'), 20000);
  await sleep(400);

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
    log('WARN: OAuth popup window not found (network may block accounts.google.com)');
  } else {
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
    oauthChild.webContents.on('console-message', (_e, _level, message) => {
      log('console ' + String(message || '').slice(0, 300));
    });

    // Probe opener ASAP (Google COOP often nulls opener after accounts.google.com loads).
    let openerInPopup = null;
    for (let i = 0; i < 15; i++) {
      try {
        openerInPopup = await oauthChild.webContents.executeJavaScript(
          `({ opener: !!(window.opener), href: location.href, ua: navigator.userAgent })`
        );
        if (openerInPopup && (openerInPopup.opener || /accounts\.google\.com/i.test(openerInPopup.href))) {
          break;
        }
      } catch {
        /* loading */
      }
      await sleep(100);
    }
    await sleep(1500);
    let afterLoad = null;
    try {
      afterLoad = await oauthChild.webContents.executeJavaScript(
        `({ opener: !!(window.opener), href: location.href, title: document.title, bodyLen: (document.body&&document.body.innerText||'').length })`
      );
    } catch (err) {
      log('after-load probe error: ' + (err && err.message));
    }
    log('oauth popup early=' + JSON.stringify(openerInPopup));
    log('oauth popup afterLoad=' + JSON.stringify(afterLoad));
    popupUrlChain = chain.map((c) => c.ev + ' ' + c.url);

    // Success criteria: Chromium-owned popup navigated (not stuck white). Opener may be
    // cleared by Cross-Origin-Opener-Policy on accounts.google.com — that is expected.
    const loaded =
      afterLoad &&
      /accounts\.google\.com/i.test(afterLoad.href || '') &&
      (Number(afterLoad.bodyLen) > 20 || String(afterLoad.title || '').length > 0);
    if (!loaded) {
      log('FAIL: OAuth popup did not load Google content (stuck white?)');
      try {
        fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
      } catch {
        /* ignore */
      }
      app.exit(1);
      return;
    }
    console.log('PASS: OAuth/GIS-style popup loads (opener kept at create; COOP may clear later)');

    // Repeated click must not pile windows
    const count1 = [...panels.childPopups].filter((w) => w && !w.isDestroyed()).length;
    await panels.getPanelCapture('acc-gis-a').executeJavaScript(
      `document.getElementById('go').click()`
    );
    await sleep(600);
    const count2 = [...panels.childPopups].filter((w) => w && !w.isDestroyed()).length;
    log('popup count after repeat click: before=' + count1 + ' after=' + count2);
    if (count2 > count1) {
      log('FAIL: repeated open created extra popup');
      try {
        fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
      } catch {
        /* ignore */
      }
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

  // --- Optional live huntera.com.br (skip if unreachable) ---
  let hunteraTried = false;
  try {
    hunteraTried = true;
    log('loading https://huntera.com.br …');
    panels.panelNavigate('acc-gis-a', 'https://huntera.com.br');
    await waitForUrl('acc-gis-a', (u) => /huntera\.com\.br/i.test(u), 25000);
    await sleep(3000);
    const pageInfo = await panels.getPanelCapture('acc-gis-a').executeJavaScript(`({
      href: location.href,
      title: document.title,
      iframes: Array.from(document.querySelectorAll('iframe')).map(function(f){
        return { src: f.src||'', w: f.offsetWidth, h: f.offsetHeight, id: f.id||'' };
      }).filter(function(f){ return /accounts\\.google\\.com\\/gsi|google/i.test(f.src); })
    })`);
    log('huntera page ' + JSON.stringify(pageInfo));
    const gsi = (pageInfo && pageInfo.iframes) || [];
    if (gsi.length) {
      const frame = gsi[0];
      // Best-effort click at iframe center via sendInputEvent
      const bounds = await panels.getPanelCapture('acc-gis-a').executeJavaScript(`(function(){
        var f = document.querySelector('iframe[src*="accounts.google.com/gsi"],iframe[src*="google"]');
        if (!f) return null;
        var r = f.getBoundingClientRect();
        return { x: Math.floor(r.left + r.width/2), y: Math.floor(r.top + r.height/2) };
      })()`);
      if (bounds) {
        log('clicking GIS iframe at ' + JSON.stringify(bounds));
        panels.getPanelCapture('acc-gis-a').sendInputEvent({
          type: 'mouseDown',
          x: bounds.x,
          y: bounds.y,
          button: 'left',
          clickCount: 1,
        });
        panels.getPanelCapture('acc-gis-a').sendInputEvent({
          type: 'mouseUp',
          x: bounds.x,
          y: bounds.y,
          button: 'left',
          clickCount: 1,
        });
        await sleep(4000);
        for (const win of panels.childPopups) {
          if (!win || win.isDestroyed()) continue;
          try {
            const info = await win.webContents.executeJavaScript(
              `({ href: location.href, opener: !!(window.opener), title: document.title })`
            );
            log('huntera popup ' + JSON.stringify(info));
          } catch (err) {
            log('huntera popup probe err ' + (err && err.message));
          }
        }
      } else {
        log('GIS iframe found in list but no bounds');
      }
    } else {
      log('no GSI iframe on huntera (page may differ / logged out layout)');
    }
  } catch (err) {
    log('huntera unreachable or timed out: ' + (err && err.message));
  }
  log('hunteraTried=' + hunteraTried);
  log('beforePopups=' + beforePopups + ' beforeOauth=' + beforeOauth);
  if (popupUrlChain.length) {
    log('URL chain:\n' + popupUrlChain.join('\n'));
  }

  // --- Direct accounts.google.com sign-in (fake email) must not be "may not be secure" ---
  try {
    log('direct Google sign-in fake-email check…');
    const signInUrl =
      'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&continue=https%3A%2F%2Fwww.google.com';
    panels.panelNavigate('acc-gis-a', signInUrl);
    await waitForUrl(
      'acc-gis-a',
      (u) => /accounts\.google\.com/i.test(u) && /identifier|signin|ServiceLogin|AccountChooser/i.test(u),
      30000
    );
    await sleep(2500);
    const bodyText = await panels.getPanelCapture('acc-gis-a').executeJavaScript(`({
      href: location.href,
      text: (document.body && document.body.innerText || '').slice(0, 4000),
      ua: navigator.userAgent
    })`);
    log('sign-in page href=' + (bodyText && bodyText.href));
    log('sign-in ua has Electron=' + /Electron\//i.test((bodyText && bodyText.ua) || ''));
    const text = String((bodyText && bodyText.text) || '');
    const insecure = /may not be secure|navegador.*n[aã]o.*seguro|este navegador/i.test(text);
    if (insecure) {
      log('FAIL: Google shows insecure browser on direct sign-in');
      try {
        fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
      } catch {
        /* ignore */
      }
      app.exit(1);
      return;
    }
    // Try typing a fake email if the identifier field exists
    const typed = await panels.getPanelCapture('acc-gis-a').executeJavaScript(`(function(){
      var input = document.querySelector('input[type="email"],input[name="identifier"],#identifierId');
      if (!input) return { ok: false, reason: 'no-input' };
      input.focus();
      input.value = 'nobody-multiheiz-probe@gmail.com';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      var next = document.querySelector('#identifierNext,button[type="button"]');
      if (next) next.click();
      return { ok: true };
    })()`);
    log('fake-email type ' + JSON.stringify(typed));
    if (typed && typed.ok) {
      await sleep(3500);
      const after = await panels.getPanelCapture('acc-gis-a').executeJavaScript(
        `(document.body && document.body.innerText || '').slice(0, 4000)`
      );
      const afterText = String(after || '');
      const found =
        /couldn'?t find|nao foi poss|n[aã]o foi poss[ií]vel encontrar|couldn't find your google account|find your google account/i.test(
          afterText
        );
      const stillInsecure = /may not be secure|navegador.*n[aã]o.*seguro/i.test(afterText);
      log('fake-email result foundAccountErr=' + found + ' insecure=' + stillInsecure);
      if (stillInsecure) {
        log('FAIL: insecure browser after fake email');
        try {
          fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');
        } catch {
          /* ignore */
        }
        app.exit(1);
        return;
      }
      if (found) console.log('PASS: direct Google sign-in fake-email (account not found, not insecure)');
      else console.log('PASS: direct Google sign-in loaded without insecure banner');
    } else {
      console.log('PASS: direct Google sign-in loaded without insecure banner (no email field)');
    }
  } catch (err) {
    log('direct Google sign-in skipped (network): ' + (err && err.message));
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
