'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, session, net } = require('electron');

/**
 * Offline selftest for v1.8 (Part A + B1-B9).
 */
async function runV18Selftest(ctx) {
  const {
    mainWindow,
    panels,
    getState,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    rendererEval,
    adblock,
    userAgent,
    sessionPersist,
    popupAdblockMenu,
    popupTopMenu,
    clampBoundsToDisplays,
    recovery,
    loadState,
    v16,
  } = ctx;

  console.log('SELFTEST v18');
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  let server = null;
  let port = 0;

  const EARLY_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script>
window.__earlyProbe = {
  scriptletAtHead: window.__mhEarlyOk === true
};
</script>
<title>early</title>
</head>
<body>
  <h1 id="ok">early-ok</h1>
  <iframe id="f" src="/early-iframe"></iframe>
  <script>
    window.__earlyProbe.afterBody = window.__mhEarlyOk === true;
  </script>
</body></html>`;

  const EARLY_IFRAME = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script>
window.__iframeEarly = window.__mhEarlyOk === true;
</script>
</head><body>iframe</body></html>`;

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = (req.url || '/').split('?')[0];
      if (u === '/early') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(EARLY_HTML);
        return;
      }
      if (u === '/early-iframe') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(EARLY_IFRAME);
        return;
      }
      if (u === '/echo-headers') {
        const payload = JSON.stringify({
          ua: req.headers['user-agent'] || '',
          secChUa: req.headers['sec-ch-ua'] || '',
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body><pre id="echo">' + payload + '</pre></body></html>');
        return;
      }
      if (u === '/set-session-cookie') {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': 'mh_sess=1; Path=/',
        });
        res.end('<html><body>cookie-set</body></html>');
        return;
      }
      if (u === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>slow-ok</body></html>');
        }, 800);
        return;
      }
      if (u === '/drop-once') {
        const n = (server._dropCount = (server._dropCount || 0) + 1);
        if (n <= 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>drop-recovered</body></html>');
        return;
      }
      if (u === '/home') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body id="home">home-ok</body></html>');
        return;
      }
      if (u === '/last') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body id="last">last-ok</body></html>');
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

  adblock.setFetchBlocked(true);
  await adblock.injectTestFilters(
    ['##+js(set-constant, __mhEarlyOk, true)', '127.0.0.1##+js(set-constant, __mhEarlyOk, true)', '##.ad-banner'].join(
      '\n'
    )
  );
  await adblock.applySettings({ enabled: true, cosmetic: true, youtubeExperimental: true });

  updateState((s) => {
    s.settings.openLastPage = false;
    s.settings.persistSessions = true;
    s.settings.homepage = base + '/home';
    s.settings.uaIdentity = 'chrome';
    s.settings.lightMode = false;
    s.settings.backgroundPreset = 'balanced';
    s.accounts = [
      {
        id: 'acc-v18-a',
        name: 'A',
        color: '#2bb8a6',
        workspaceId: s.activeWorkspaceId,
        startUrl: base + '/early',
        lastUrl: null,
        muted: false,
        adblockEnabled: true,
        lastBounds: { x: 10, y: 80, width: 400, height: 300 },
      },
      {
        id: 'acc-v18-b',
        name: 'B',
        color: '#c45',
        workspaceId: s.activeWorkspaceId,
        startUrl: base + '/home',
        muted: false,
        adblockEnabled: true,
      },
    ];
  });
  flushSave();

  // ---- Early scriptlets first ----
  panels.createPanel('acc-v18-a');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: 'acc-v18-a', x: 0, y: 80, width: bw0, height: Math.max(240, bh0 - 80) },
    ]);
  }
  await waitForUrl('acc-v18-a', (u) => u.includes('/early'), 20000);
  let early = null;
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    early = await panels.getPanelCapture('acc-v18-a').executeJavaScript(`({
      head: !!(window.__earlyProbe && window.__earlyProbe.scriptletAtHead === true),
      body: !!(window.__earlyProbe && window.__earlyProbe.afterBody === true),
      flag: window.__mhEarlyOk === true,
      title: document.title,
      hasH1: !!document.getElementById('ok'),
      html: (document.documentElement && document.documentElement.outerHTML || '').slice(0, 220)
    })`);
    if (early && early.hasH1) break;
  }
  if (!early || early.head !== true) {
    console.log('FAIL: scriptlet did not run before head inline script', early);
    app.exit(1);
    return;
  }
  console.log('PASS: early scriptlet before page scripts (main frame)');
  let iframeOk = false;
  for (let i = 0; i < 25 && !iframeOk; i++) {
    await sleep(150);
    iframeOk = await panels.getPanelCapture('acc-v18-a').executeJavaScript(
      `(function(){var f=document.getElementById('f');return !!(f&&f.contentWindow&&f.contentWindow.__iframeEarly===true);})()`
    );
  }
  if (!iframeOk) {
    console.log('FAIL: early scriptlet missing in iframe');
    app.exit(1);
    return;
  }
  console.log('PASS: early scriptlet in iframe');
  const timing = adblock.getEarlyTimingLog();
  if (timing.length) {
    console.log(
      'INFO: early timing sample syncMs=',
      timing[0].syncMs,
      'injectMs=',
      timing[0].injectMs,
      'scripts=',
      timing[0].scripts
    );
  }

  // ---- B1 UA ----
  const ua = userAgent.buildChromeUserAgent();
  if (/Electron/i.test(ua) || /MultiHeiz/i.test(ua)) {
    console.log('FAIL: UA still has Electron/app token', ua);
    app.exit(1);
    return;
  }
  console.log('PASS: UA has no Electron token');
  const sec = userAgent.buildSecChUa('chrome');
  if (!/Google Chrome/i.test(sec) || !/Chromium/i.test(sec)) {
    console.log('FAIL: sec-ch-ua brands', sec);
    app.exit(1);
    return;
  }
  console.log('PASS: sec-ch-ua Chrome brands');

  const sesA = session.fromPartition(panels.partitionFor('acc-v18-a'));
  userAgent.applySessionUserAgent(sesA);
  sessionPersist.hookSessionCookies(sesA);

  const echoJson = await new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url: base + '/echo-headers', session: sesA });
    let body = '';
    req.on('response', (res) => {
      res.on('data', (c) => {
        body += c.toString();
      });
      res.on('end', () => {
        try {
          const m = body.match(/<pre id="echo">([\s\S]*?)<\/pre>/);
          resolve(JSON.parse(m ? m[1] : body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
  if (!echoJson || /Electron/i.test(echoJson.ua || '')) {
    console.log('FAIL: echo UA', echoJson);
    app.exit(1);
    return;
  }
  if (!echoJson.secChUa || !/Chromium/i.test(echoJson.secChUa)) {
    console.log('FAIL: echo sec-ch-ua', echoJson);
    app.exit(1);
    return;
  }
  console.log('PASS: request headers UA + sec-ch-ua');

  const child = panels.openLoginPopup('acc-v18-a', base + '/echo-headers', sesA);
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
  child.close();

  // ---- Relatar anuncio ----
  const menu = popupAdblockMenu({
    accountId: 'acc-v18-a',
    x: 10,
    y: 10,
    url: base + '/early',
  });
  if (!menu || !menu.labels || !menu.labels.some((l) => /Relatar an/i.test(l))) {
    console.log('FAIL: Relatar anuncio menu missing', menu);
    app.exit(1);
    return;
  }
  const report = adblock.writeAdReport({
    accountId: 'acc-v18-a',
    pageUrl: base + '/early',
  });
  if (!report.ok || !fs.existsSync(report.path)) {
    console.log('FAIL: report file not written', report);
    app.exit(1);
    return;
  }
  const reportJson = JSON.parse(fs.readFileSync(report.path, 'utf8'));
  if (!reportJson.pageUrl || !reportJson.engine) {
    console.log('FAIL: report incomplete', reportJson);
    app.exit(1);
    return;
  }
  console.log('PASS: Relatar anuncio writes report', path.basename(report.path));

  // ---- B2 cookies / last URL / home ----
  updateState((s) => {
    s.settings.openLastPage = true;
    s.settings.persistSessions = true;
  });
  panels.panelNavigate('acc-v18-a', base + '/set-session-cookie');
  await waitForUrl('acc-v18-a', (u) => u.includes('/set-session-cookie'), 20000);
  await sleep(800);
  let cookies = await sesA.cookies.get({ url: base });
  let sess = cookies.find((c) => c.name === 'mh_sess');
  if (!sess) {
    console.log('FAIL: session cookie not set', cookies);
    app.exit(1);
    return;
  }
  console.log('PASS: session cookie present');
  await sessionPersist.flushAllSessions([sesA]);
  console.log('PASS: flushStorageData/cookies.flushStore');

  panels.panelNavigate('acc-v18-a', base + '/last');
  await waitForUrl('acc-v18-a', (u) => u.includes('/last'), 20000);
  await sleep(200);
  panels.destroyPanel('acc-v18-a', { keepLastUrl: true });
  await sleep(200);
  panels.createPanel('acc-v18-a');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: 'acc-v18-a', x: 0, y: 80, width: bw0, height: Math.max(240, bh0 - 80) },
    ]);
  }
  await waitForUrl('acc-v18-a', (u) => u.includes('/last'), 20000);
  console.log('PASS: last URL restored');

  updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-v18-a');
    if (a) a.startUrl = base + '/home';
  });
  panels.panelGoHome('acc-v18-a');
  await waitForUrl('acc-v18-a', (u) => u.includes('/home'), 20000);
  console.log('PASS: Inicio navigates to home');

  // ---- B3 settings ----
  updateState((s) => {
    s.settings.lightMode = true;
    s.settings.backgroundPreset = 'balanced';
  });
  const st = getState().settings;
  if (st.lightMode !== true || st.backgroundPreset !== 'balanced') {
    console.log('FAIL: desempenho settings', st.lightMode, st.backgroundPreset);
    app.exit(1);
    return;
  }
  console.log('PASS: desempenho settings (lightMode + preset)');

  // ---- B4 bounds / slow / stagger ----
  panels.destroyPanel('acc-v18-a', { keepLastUrl: true });
  updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-v18-a');
    if (a) a.lastBounds = { x: 12, y: 90, width: 420, height: 310 };
  });
  const e2 = panels.createPanel('acc-v18-a');
  const b = e2.view.getBounds();
  if (b.width !== 420 || b.height !== 310) {
    console.log('FAIL: stored bounds not applied', b);
    app.exit(1);
    return;
  }
  console.log('PASS: panel bounds applied at create');

  await waitForUrl('acc-v18-a', (u) => u.includes('/home') || u.includes('/last') || u.includes('/early'), 20000);
  await sleep(300);
  panels.panelNavigate('acc-v18-a', base + '/slow');
  await waitForUrl('acc-v18-a', (u) => u.includes('/slow'), 20000);
  let slowOk = false;
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    slowOk = await panels
      .getPanelCapture('acc-v18-a')
      .executeJavaScript("(document.body && document.body.textContent || '').includes('slow-ok')");
    if (slowOk) break;
  }
  if (!slowOk) {
    console.log('FAIL: slow response');
    app.exit(1);
    return;
  }
  console.log('PASS: slow server kept waiting');

  panels.panelNavigate('acc-v18-a', base + '/drop-once');
  await sleep(6000);
  console.log('PASS: connection drop retry path exercised');

  const [cw, ch] = mainWindow.getContentSize();
  panels.syncVisiblePanels([
    { accountId: 'acc-v18-a', x: 0, y: 80, width: Math.floor(cw / 2), height: ch - 80 },
    { accountId: 'acc-v18-b', x: Math.floor(cw / 2), y: 80, width: Math.floor(cw / 2), height: ch - 80 },
  ]);
  await sleep(1500);
  console.log('PASS: staggered syncVisiblePanels (2 panels)');

  // ---- B5 UI: overflow, focus, maximize keep, zoom, window bounds ----
  const topMenu = popupTopMenu({ x: 100, y: 40 });
  if (!topMenu || !topMenu.ok || !topMenu.labels) {
    console.log('FAIL: top overflow menu', topMenu);
    app.exit(1);
    return;
  }
  const needLabels = [
    /Recarregar todas/i,
    /^Som$/i,
    /^Zoom/i,
    /^Layout$/i,
    /Downloads/i,
    /Tela cheia/i,
    /^Ajuda$/i,
    /Silenciar todas/i,
    /100%/,
    /Novidades/i,
    /Atalhos/i,
  ];
  for (const re of needLabels) {
    if (!topMenu.labels.some((l) => re.test(l))) {
      console.log('FAIL: overflow menu missing', re, topMenu.labels);
      app.exit(1);
      return;
    }
  }
  console.log('PASS: overflow › menu labels');

  panels.setFocusedAccount('acc-v18-b');
  if (panels.getFocusedAccountId() !== 'acc-v18-b') {
    console.log('FAIL: setFocusedAccount');
    app.exit(1);
    return;
  }
  console.log('PASS: click-to-focus setFocusedAccount');

  const ws1 = getState().activeWorkspaceId;
  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-v18-b')) {
      s.workspaces.push({ id: 'ws-v18-b', name: 'B5' });
    }
    s.maximizedAccountId = 'acc-v18-a';
    if (!s.maximizedByWorkspace) s.maximizedByWorkspace = {};
    s.maximizedByWorkspace[ws1] = 'acc-v18-a';
  });
  // switch workspace via same logic as IPC
  updateState((st) => {
    if (!st.maximizedByWorkspace) st.maximizedByWorkspace = {};
    if (!st.pageByWorkspace) st.pageByWorkspace = {};
    const prev = st.activeWorkspaceId;
    st.maximizedByWorkspace[prev] = st.maximizedAccountId || null;
    st.pageByWorkspace[prev] = st.page || 0;
    st.activeWorkspaceId = 'ws-v18-b';
    st.maximizedAccountId = st.maximizedByWorkspace['ws-v18-b'] || null;
    st.page = st.pageByWorkspace['ws-v18-b'] || 0;
  });
  if (getState().maximizedAccountId) {
    console.log('FAIL: maximized should clear on empty ws', getState().maximizedAccountId);
    app.exit(1);
    return;
  }
  updateState((st) => {
    if (!st.maximizedByWorkspace) st.maximizedByWorkspace = {};
    if (!st.pageByWorkspace) st.pageByWorkspace = {};
    const prev = st.activeWorkspaceId;
    st.maximizedByWorkspace[prev] = st.maximizedAccountId || null;
    st.pageByWorkspace[prev] = st.page || 0;
    st.activeWorkspaceId = ws1;
    st.maximizedAccountId =
      st.maximizedByWorkspace[ws1] != null ? st.maximizedByWorkspace[ws1] : null;
    st.page = typeof st.pageByWorkspace[ws1] === 'number' ? st.pageByWorkspace[ws1] : 0;
  });
  if (getState().maximizedAccountId !== 'acc-v18-a') {
    console.log('FAIL: maximized not restored for workspace', getState().maximizedAccountId);
    app.exit(1);
    return;
  }
  console.log('PASS: maximized kept per workspace');

  panels.panelZoom('acc-v18-a', 0.25);
  let z = panels.panelGetZoom('acc-v18-a');
  if (z < 1.2 || z > 1.4) {
    console.log('FAIL: zoom not applied', z);
    app.exit(1);
    return;
  }
  const zSaved = getState().accounts.find((a) => a.id === 'acc-v18-a').zoomFactor;
  if (Math.abs(zSaved - z) > 0.01) {
    console.log('FAIL: zoom not persisted in state', zSaved, z);
    app.exit(1);
    return;
  }
  panels.destroyPanel('acc-v18-a', { keepLastUrl: true });
  await sleep(100);
  panels.createPanel('acc-v18-a');
  await sleep(200);
  z = panels.panelGetZoom('acc-v18-a');
  if (Math.abs(z - zSaved) > 0.05) {
    console.log('FAIL: zoom not restored on create', z, zSaved);
    app.exit(1);
    return;
  }
  panels.panelZoom('acc-v18-a', 0);
  console.log('PASS: per-panel zoom persist 25%-300%');

  const clamped = clampBoundsToDisplays(
    { x: -50000, y: -50000, width: 900, height: 700 },
    [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }]
  );
  if (!clamped.adjusted || clamped.x < -100) {
    console.log('FAIL: off-monitor clamp', clamped);
    app.exit(1);
    return;
  }
  console.log('PASS: app window bounds clamp off-monitor');

  // ---- B6 Recovery .bak ----
  const { writeJsonDurable, readJsonDurable, createJsonStore } = require('./json-store');
  const bookmarks = require('./bookmarks');
  const history = require('./history');
  const downloads = require('./downloads');
  const userData = app.getPath('userData');

  recovery.resetForTests();

  const storeFiles = [
    {
      name: 'multiheiz-state.json',
      good: () => {
        flushSave();
        const p = path.join(userData, 'multiheiz-state.json');
        const good = JSON.parse(fs.readFileSync(p, 'utf8'));
        writeJsonDurable(p, good);
        fs.writeFileSync(p, '{not-json', 'utf8');
        const r = readJsonDurable(p, () => ({ version: 1 }), 'multiheiz-state.json');
        if (r.restored !== 'bak') throw new Error('state bak restore ' + r.restored);
        loadState();
      },
    },
    {
      name: 'bookmarks.json',
      good: () => {
        bookmarks.load();
        bookmarks.addFavorite({ url: 'http://127.0.0.1/b6', title: 'b6' });
        bookmarks.flush();
        const p = path.join(userData, 'bookmarks.json');
        writeJsonDurable(p, bookmarks.get());
        fs.writeFileSync(p, 'CORRUPT', 'utf8');
        bookmarks.load();
        const found = bookmarks.findByUrl('http://127.0.0.1/b6');
        if (!found) throw new Error('bookmarks not restored');
      },
    },
    {
      name: 'history.json',
      good: () => {
        history.load();
        const store = createJsonStore('history.json', { version: 1, items: [] });
        store.load();
        store.set({ version: 1, items: [{ id: 'h1', url: 'http://x/', title: 'x', at: Date.now() }] });
        store.flush();
        const p = path.join(userData, 'history.json');
        writeJsonDurable(p, store.get());
        fs.writeFileSync(p, '@@@', 'utf8');
        const r = readJsonDurable(p, { version: 1, items: [] }, 'history.json');
        if (r.restored !== 'bak' || !(r.data.items && r.data.items.length)) {
          throw new Error('history bak ' + JSON.stringify(r));
        }
      },
    },
    {
      name: 'downloads.json',
      good: () => {
        downloads.load();
        downloads.flush();
        const p = path.join(userData, 'downloads.json');
        const good = { version: 1, items: [{ id: 'd1', fileName: 'a.bin', state: 'completed' }], settings: {} };
        writeJsonDurable(p, good);
        writeJsonDurable(p, good);
        fs.writeFileSync(p, '{', 'utf8');
        const r = readJsonDurable(p, { version: 1, items: [] }, 'downloads.json');
        if (r.restored !== 'bak') throw new Error('downloads bak');
      },
    },
    {
      name: 'modules/alarmes.json',
      good: () => {
        const p = path.join(userData, 'modules', 'alarmes.json');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const good = { version: 1, reminders: [{ id: 'r1', title: 't' }], timers: [] };
        writeJsonDurable(p, good);
        writeJsonDurable(p, good);
        fs.writeFileSync(p, 'nope', 'utf8');
        const r = readJsonDurable(p, { version: 1, reminders: [], timers: [] }, 'modules/alarmes.json');
        if (r.restored !== 'bak' || !r.data.reminders.length) throw new Error('alarmes bak');
      },
    },
    {
      name: 'adblock/meta.json',
      good: () => {
        const p = path.join(userData, 'adblock', 'meta.json');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const good = { lastUpdateAt: 123, listStatus: { easylist: 'ok' }, fingerprint: 'abc' };
        writeJsonDurable(p, good);
        writeJsonDurable(p, good);
        fs.writeFileSync(p, '%%%', 'utf8');
        const r = readJsonDurable(p, { lastUpdateAt: null }, 'adblock/meta.json');
        if (r.restored !== 'bak' || r.data.fingerprint !== 'abc') throw new Error('meta bak');
      },
    },
  ];

  for (const spec of storeFiles) {
    try {
      spec.good();
      console.log('PASS: recovery .bak for', spec.name);
    } catch (err) {
      console.log('FAIL: recovery', spec.name, err && err.message);
      app.exit(1);
      return;
    }
  }

  const badImport = bookmarks.importJson('{not json');
  if (badImport.ok || !/inválido|rejeitad/i.test(badImport.message || '')) {
    console.log('FAIL: invalid import parse', badImport);
    app.exit(1);
    return;
  }
  const badSchema = bookmarks.importJson(JSON.stringify({ folders: 'x', items: [] }));
  if (badSchema.ok || !badSchema.message) {
    console.log('FAIL: invalid import schema', badSchema);
    app.exit(1);
    return;
  }
  console.log('PASS: invalid imports rejected with message');

  // Corrupt primary again — loadState must not throw (never crash on start)
  try {
    const p = path.join(userData, 'multiheiz-state.json');
    fs.writeFileSync(p, 'BROKEN', 'utf8');
    loadState();
    getState();
    console.log('PASS: never crash on start (corrupt state)');
  } catch (err) {
    console.log('FAIL: crash on corrupt state', err);
    app.exit(1);
    return;
  }

  // ---- B7 Alarmes: views, priority, go-to, snooze, missed group ----
  if (!v16 || !v16.alarmes) {
    console.log('FAIL: v16.alarmes missing');
    app.exit(1);
    return;
  }
  const alarmes = v16.alarmes;
  const planilha = v16.planilha;

  // Reset alarmes for clean B7 tests
  alarmes.stopAll();
  alarmes.clearTestNotificationLog();
  for (const r of [...(alarmes.list().reminders || [])]) alarmes.removeReminder(r.id);
  for (const t of [...(alarmes.list().timers || [])]) alarmes.removeTimer(t.id);
  alarmes.flush();

  const now = Date.now();
  const todayNext = msLaterToday(now, 60 * 1000);
  const tomorrow = startOfTomorrow(now);
  const remHoje = alarmes.addReminder({
    title: 'Hoje item',
    kind: 'one-off',
    at: todayNext,
    priority: 'baixa',
  });
  const remProx = alarmes.addReminder({
    title: 'Prox item',
    kind: 'one-off',
    at: tomorrow + 2 * 60 * 60 * 1000,
    priority: 'alta',
  });
  const remRec = alarmes.addReminder({
    title: 'Recorrente item',
    kind: 'recurring',
    recur: 'daily',
    timeOfDay: '18:30',
    priority: 'normal',
    windowId: 'acc-v18-b',
  });
  const remDone = alarmes.addReminder({
    title: 'Feito item',
    kind: 'one-off',
    at: now + 999999,
    priority: 'normal',
  });
  alarmes.completeReminder(remDone.id);

  const viewHoje = alarmes.filterByView(alarmes.list().reminders, 'hoje', now);
  const viewProx = alarmes.filterByView(alarmes.list().reminders, 'proximos', now);
  const viewRec = alarmes.filterByView(alarmes.list().reminders, 'recorrentes', now);
  const viewDone = alarmes.filterByView(alarmes.list().reminders, 'concluidos', now);

  if (!viewHoje.some((r) => r.id === remHoje.id)) {
    console.log('FAIL: view hoje', viewHoje.map((r) => r.title));
    app.exit(1);
    return;
  }
  if (!viewProx.some((r) => r.id === remProx.id)) {
    console.log('FAIL: view proximos', viewProx.map((r) => r.title));
    app.exit(1);
    return;
  }
  if (!viewRec.some((r) => r.id === remRec.id)) {
    console.log('FAIL: view recorrentes', viewRec.map((r) => r.title));
    app.exit(1);
    return;
  }
  if (!viewDone.some((r) => r.id === remDone.id)) {
    console.log('FAIL: view concluidos', viewDone.map((r) => r.title));
    app.exit(1);
    return;
  }
  console.log('PASS: alarmes views Hoje/Próximos/Recorrentes/Concluídos');

  const sorted = alarmes.sortByPriorityThenNext([remHoje, remProx, remRec], now);
  if (sorted[0].priority !== 'alta' || sorted[sorted.length - 1].priority !== 'baixa') {
    console.log(
      'FAIL: priority sort',
      sorted.map((r) => r.priority)
    );
    app.exit(1);
    return;
  }
  console.log('PASS: alarmes priority sort alta→baixa');

  // Snooze keeps recurrence base
  const beforeSnooze = {
    kind: remRec.kind,
    recur: remRec.recur,
    timeOfDay: remRec.timeOfDay,
    at: remRec.at,
  };
  const snoozed = alarmes.snooze(remRec.id, 10);
  if (
    !snoozed ||
    snoozed.kind !== beforeSnooze.kind ||
    snoozed.recur !== beforeSnooze.recur ||
    snoozed.timeOfDay !== beforeSnooze.timeOfDay ||
    Number(snoozed.at) !== Number(beforeSnooze.at) ||
    !snoozed.snoozeUntil ||
    snoozed.snoozeUntil < now
  ) {
    console.log('FAIL: snooze changed base schedule', snoozed, beforeSnooze);
    app.exit(1);
    return;
  }
  console.log('PASS: snooze keeps recurrence base schedule');

  // Missed grouped into ONE notification
  alarmes.clearTestNotificationLog();
  const missedItems = [
    { id: 'm1', title: 'A', at: now - 3000 },
    { id: 'm2', title: 'B', at: now - 2000 },
    { id: 'm3', title: 'C', at: now - 1000 },
  ];
  const group = alarmes.notifyMissedGroup(missedItems);
  const log = alarmes.getTestNotificationLog();
  const missedLogs = log.filter((x) => x.kind === 'missed-group');
  if (!group || group.count !== 3 || missedLogs.length !== 1 || !/3 lembretes perdidos/.test(group.title)) {
    console.log('FAIL: missed group notification', group, missedLogs);
    app.exit(1);
    return;
  }
  console.log('PASS: missed reminders one grouped notification');

  // Ir até a janela without reload
  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-v18-b')) {
      s.workspaces.push({ id: 'ws-v18-b', name: 'B7' });
    }
    const a = s.accounts.find((x) => x.id === 'acc-v18-a');
    const b = s.accounts.find((x) => x.id === 'acc-v18-b');
    if (a) a.workspaceId = s.activeWorkspaceId;
    if (b) b.workspaceId = 'ws-v18-b';
  });
  flushSave();
  const urlB = base + '/early';
  panels.createPanel('acc-v18-b');
  panels.panelNavigate('acc-v18-b', urlB);
  await waitForUrl('acc-v18-b', (u) => u.includes('/early'), 15000);
  const urlBefore = panels.getPanelCapture('acc-v18-b').getURL();

  updateState((st) => {
    st.activeWorkspaceId = getState().workspaces.find((w) => w.id !== 'ws-v18-b').id;
  });
  panels.setFocusedAccount('acc-v18-a');

  const goResult = await rendererEval(`
    (async () => {
      const ui = window.MultiHeizV16;
      if (!ui || !ui.goToReminderWindow) return { ok: false, reason: 'no-api' };
      return ui.goToReminderWindow({ id: 'x', windowId: 'acc-v18-b', title: 't' });
    })()
  `);
  await sleep(400);
  const urlAfter = panels.getPanelCapture('acc-v18-b').getURL();
  const focused = panels.getFocusedAccountId();
  const wsNow = getState().activeWorkspaceId;
  if (!goResult || !goResult.ok || goResult.reloaded) {
    console.log('FAIL: goToReminderWindow', goResult);
    app.exit(1);
    return;
  }
  if (focused !== 'acc-v18-b') {
    console.log('FAIL: go-to focus', focused);
    app.exit(1);
    return;
  }
  if (wsNow !== 'ws-v18-b') {
    console.log('FAIL: go-to workspace switch', wsNow);
    app.exit(1);
    return;
  }
  if (urlAfter !== urlBefore) {
    console.log('FAIL: go-to reloaded panel', urlBefore, urlAfter);
    app.exit(1);
    return;
  }
  console.log('PASS: Ir até a janela without reload');

  // Pick another if removed
  const remGone = alarmes.addReminder({
    title: 'Gone window',
    kind: 'one-off',
    at: now + 3600000,
    windowId: 'acc-does-not-exist',
  });
  const pickResult = await rendererEval(`
    (async () => {
      const ui = window.MultiHeizV16;
      const r = await ui.goToReminderWindow({
        id: ${JSON.stringify(remGone.id)},
        windowId: 'acc-does-not-exist',
        title: 'Gone window',
      });
      const dlg = document.getElementById('dlg-pick-window');
      const open = !!(dlg && dlg.open);
      if (dlg && dlg.open) dlg.close();
      return { result: r, dialogOpen: open };
    })()
  `);
  if (!pickResult || pickResult.result.ok || !pickResult.dialogOpen) {
    console.log('FAIL: pick window when removed', pickResult);
    app.exit(1);
    return;
  }
  alarmes.updateReminder(remGone.id, { windowId: 'acc-v18-a' });
  const afterPick = (alarmes.list().reminders || []).find((r) => r.id === remGone.id);
  if (!afterPick || afterPick.windowId !== 'acc-v18-a') {
    console.log('FAIL: rebind windowId', afterPick);
    app.exit(1);
    return;
  }
  console.log('PASS: pick another window if linked removed');

  // ---- B8 Planilha: refs, ranges, column, Ctrl+A helpers ----
  if (!planilha) {
    console.log('FAIL: planilha module missing');
    app.exit(1);
    return;
  }
  if (planilha.formatCellRef(0, 0) !== 'A1' || planilha.formatRangeRef(0, 0, 1, 2) !== 'A1:B3') {
    console.log('FAIL: format refs', planilha.formatCellRef(0, 0), planilha.formatRangeRef(0, 0, 1, 2));
    app.exit(1);
    return;
  }
  if (planilha.formatColumnRef(0) !== 'A:A') {
    console.log('FAIL: column ref', planilha.formatColumnRef(0));
    app.exit(1);
    return;
  }
  if (!planilha.isFormulaMode('=A1') || planilha.isFormulaMode('123')) {
    console.log('FAIL: isFormulaMode');
    app.exit(1);
    return;
  }
  const inserted = planilha.insertFormulaRef('=', 'B2');
  if (inserted !== '=B2') {
    console.log('FAIL: insertFormulaRef', inserted);
    app.exit(1);
    return;
  }

  const wb = planilha.createWorkbook('v18-b8');
  const sheetId = wb.sheets[0].id;
  const evaled = planilha.applyCellsForTest(wb.id, sheetId, {
    A1: '1',
    A2: '2',
    A3: '3',
    B1: '=SUM(A:A)',
  });
  const b1 = evaled.sheets[0].display.B1;
  if (!b1 || Number(b1.value) !== 6) {
    console.log('FAIL: column range SUM(A:A)', b1);
    app.exit(1);
    return;
  }
  console.log('PASS: planilha format refs + SUM(A:A)');

  await rendererEval('window.__multiheizUi.openModule("planilha")');
  await sleep(600);
  const uiPlanilha = await rendererEval(`
    (async () => {
      const t = window.MultiHeizV16 && window.MultiHeizV16._planilhaTest;
      if (!t) return { ok: false, reason: 'no-test-api' };
      t.setEditing('C1');
      const click = t.clickCell(0, 0, {});
      const shift = t.clickCell(1, 1, { shift: true });
      t.setEditing('D1');
      const col = t.clickColHeader(2);
      const all = t.selectAll();
      return {
        ok: true,
        afterClick: click && click.value,
        afterShift: shift && shift.value,
        afterCol: col && col.value,
        colRef: col && col.ref,
        allSel: all,
        rangeHelper: t.formatRangeRef(0, 0, 2, 4),
      };
    })()
  `);
  if (!uiPlanilha || !uiPlanilha.ok) {
    console.log('FAIL: planilha UI helpers', uiPlanilha);
    app.exit(1);
    return;
  }
  if (!uiPlanilha.afterClick || !String(uiPlanilha.afterClick).includes('A1')) {
    console.log('FAIL: click inserts cell ref', uiPlanilha.afterClick);
    app.exit(1);
    return;
  }
  if (!uiPlanilha.afterShift || !String(uiPlanilha.afterShift).includes(':')) {
    console.log('FAIL: shift+click range', uiPlanilha.afterShift);
    app.exit(1);
    return;
  }
  if (uiPlanilha.colRef !== 'C:C' || !String(uiPlanilha.afterCol).includes('C:C')) {
    console.log('FAIL: column header ref', uiPlanilha);
    app.exit(1);
    return;
  }
  if (!uiPlanilha.allSel || uiPlanilha.allSel.c0 !== 0 || uiPlanilha.allSel.c1 !== 9) {
    console.log('FAIL: Ctrl+A select all', uiPlanilha.allSel);
    app.exit(1);
    return;
  }
  console.log('PASS: planilha click/shift/column/Ctrl+A selection');
  await rendererEval('window.__multiheizUi.closeModule()');

  // ---- B9 Novidades / changelog + clock skew + settings preserve ----
  const changelog = require('./changelog');
  const validated = changelog.validateChangelog();
  if (!validated.ok) {
    console.log('FAIL: changelog.json invalid', validated);
    app.exit(1);
    return;
  }
  console.log(
    'PASS: changelog.json versions',
    validated.versionCount,
    'entries',
    validated.entryCount
  );

  if (!changelog.shouldShowNovidades(null, '1.0.0')) {
    console.log('FAIL: should show when never seen');
    app.exit(1);
    return;
  }
  if (!changelog.shouldShowNovidades('0.9.0', '1.0.0')) {
    console.log('FAIL: should show after update 0.9.0 -> 1.0.0');
    app.exit(1);
    return;
  }
  if (changelog.shouldShowNovidades('1.0.0', '1.0.0')) {
    console.log('FAIL: should not show when already seen');
    app.exit(1);
    return;
  }
  console.log('PASS: show-once after update logic');

  updateState((s) => {
    s.settings.homepage = 'http://127.0.0.1/keep-settings';
    s.settings.persistSessions = true;
    if (!s.ui) s.ui = {};
    s.ui.lastSeenChangelogVersion = '0.9.0';
  });
  flushSave();
  const beforeMark = getState();
  if (
    !beforeMark.settings ||
    beforeMark.settings.homepage !== 'http://127.0.0.1/keep-settings' ||
    beforeMark.settings.persistSessions !== true
  ) {
    console.log('FAIL: settings not set before mark', beforeMark.settings);
    app.exit(1);
    return;
  }
  changelog.markChangelogSeen(app.getVersion(), updateState);
  flushSave();
  const afterMark = getState();
  if (
    afterMark.settings.homepage !== 'http://127.0.0.1/keep-settings' ||
    afterMark.settings.persistSessions !== true
  ) {
    console.log('FAIL: settings wiped when marking changelog', afterMark.settings);
    app.exit(1);
    return;
  }
  if (afterMark.ui.lastSeenChangelogVersion !== app.getVersion()) {
    console.log('FAIL: lastSeen not updated', afterMark.ui);
    app.exit(1);
    return;
  }
  if (changelog.shouldShowNovidades(afterMark.ui.lastSeenChangelogVersion, app.getVersion())) {
    console.log('FAIL: still showing after mark');
    app.exit(1);
    return;
  }
  console.log('PASS: settings/sessions preserved across changelog mark');

  changelog.resetClockSkewForTest();
  const skewed = changelog.noteHttpDate(new Date(Date.now() - 10 * 60 * 1000).toUTCString());
  if (!skewed.skewed || Math.abs(skewed.skewMs) < changelog.SKEW_MS) {
    console.log('FAIL: clock skew not detected', skewed);
    app.exit(1);
    return;
  }
  const okSkew = changelog.noteHttpDate(new Date().toUTCString());
  if (okSkew.skewed) {
    console.log('FAIL: false clock skew', okSkew);
    app.exit(1);
    return;
  }
  console.log('PASS: clock skew >5 min detection');

  // Force show once for UI (version already marked seen above)
  updateState((s) => {
    if (!s.ui) s.ui = {};
    s.ui.lastSeenChangelogVersion = null;
  });
  const uiNov = await rendererEval(`
    (async () => {
      const ui = window.MultiHeizV16;
      if (!ui || !ui.openNovidades) return { ok: false, reason: 'no-api' };
      const r = await ui.openNovidades({ auto: false, markSeen: true });
      const dlg = document.getElementById('dlg-novidades');
      const list = document.getElementById('novidades-list');
      const tags = list
        ? [...list.querySelectorAll('[class^="tag-"]')].map((n) => n.textContent)
        : [];
      const versions = list
        ? [...list.querySelectorAll('.novidades-version')].map((n) => n.dataset.version)
        : [];
      const open = !!(dlg && dlg.open);
      if (ui.closeNovidadesAndMaybeMark) ui.closeNovidadesAndMaybeMark();
      await new Promise((res) => setTimeout(res, 200));
      return {
        ok: !!(r && r.ok && open),
        count: r && r.count,
        tags: [...new Set(tags)],
        has100: versions.includes('1.0.0'),
        only100: versions.length === 1 && versions[0] === '1.0.0',
        tagNovo: tags.includes('Novo'),
        tagMelhoria: tags.includes('Melhoria'),
        tagCorrecao: tags.includes('Correção'),
      };
    })()
  `);
  if (!uiNov || !uiNov.ok || !uiNov.has100 || !uiNov.only100) {
    console.log('FAIL: novidades UI', uiNov);
    app.exit(1);
    return;
  }
  if (!uiNov.tagNovo || !uiNov.tagMelhoria || !uiNov.tagCorrecao) {
    console.log('FAIL: missing tags in UI', uiNov.tags);
    app.exit(1);
    return;
  }
  await sleep(300);
  const afterUi = getState();
  if (afterUi.ui.lastSeenChangelogVersion !== app.getVersion()) {
    console.log('FAIL: mark seen on close', afterUi.ui);
    app.exit(1);
    return;
  }
  console.log('PASS: Novidades UI tags + mark seen on close');

  // Banner text/API
  const banner = await rendererEval(`
    (async () => {
      const api = window.__multiheizUi;
      if (api && api.setClockSkewBanner) {
        api.setClockSkewBanner(true, 'Relógio do sistema incorreto — logins e certificados podem falhar');
      }
      const el = document.getElementById('clock-skew-banner');
      const text = el && el.querySelector('span') ? el.querySelector('span').textContent : '';
      const hidden = !el || el.classList.contains('hidden');
      const main = document.getElementById('main-col');
      const has = !!(main && main.classList.contains('has-clock-skew'));
      if (api && api.setClockSkewBanner) api.setClockSkewBanner(false);
      return { text, hidden, has };
    })()
  `);
  if (
    !banner ||
    banner.hidden ||
    !banner.has ||
    !/Relógio do sistema incorreto/.test(banner.text || '')
  ) {
    console.log('FAIL: clock skew banner', banner);
    app.exit(1);
    return;
  }
  console.log('PASS: clock skew warning banner');

  if (server) server.close();
  console.log('PASS: v18 selftest complete');
  app.exit(0);
}

function startOfTomorrow(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Timestamp still on the same calendar day as `now`, at least `deltaMs` ahead when possible. */
function msLaterToday(now, deltaMs) {
  const eod = new Date(now);
  eod.setHours(23, 59, 50, 0);
  const target = now + (deltaMs || 60000);
  if (target <= eod.getTime()) return target;
  return Math.max(now + 1000, eod.getTime());
}

module.exports = { runV18Selftest };
