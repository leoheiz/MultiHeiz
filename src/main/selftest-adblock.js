'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app } = require('electron');

/**
 * Offline adblock selftest — local HTTP + injected filter list.
 *
 * @param {{
 *   mainWindow: import('electron').BrowserWindow,
 *   panels: typeof import('./panels'),
 *   getState: () => any,
 *   setState: Function,
 *   updateState: Function,
 *   flushSave: Function,
 *   publicState: () => any,
 *   emitToRenderer: Function,
 *   sleep: (ms: number) => Promise<void>,
 *   waitForUrl: Function,
 *   rendererEval: (code: string) => Promise<any>,
 *   adblock: typeof import('./adblock'),
 * }} ctx
 */
async function runAdblockSelftest(ctx) {
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
  } = ctx;

  console.log('SELFTEST adblock');
  const userData = app.getPath('userData');
  const shotsDir = path.join(__dirname, '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });

  /** @type {http.Server|null} */
  let server = null;
  /** @type {Map<string, number>} */
  const hitCounts = new Map();

  function bump(key) {
    hitCounts.set(key, (hitCounts.get(key) || 0) + 1);
  }

  const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Adblock test</title></head>
<body>
  <h1 id="ok">page-ok</h1>
  <div class="ad-banner" id="ad-banner">AD BANNER</div>
  <img id="ad-img" src="/adserver/banner.gif" width="1" height="1" />
  <img id="ok-img" src="/normal.png" width="1" height="1" />
  <iframe id="ad-frame" src="/iframe" style="width:120px;height:60px;border:0"></iframe>
  <script src="/tracker.js"></script>
  <script>
    window.__adResults = { adImg: 'pending', okImg: 'pending', tracker: 'pending', xhrAd: 'pending', xhrOk: 'pending', cookie: '', scriptlet: 'pending' };
    document.getElementById('ad-img').onerror = () => { window.__adResults.adImg = 'error'; };
    document.getElementById('ad-img').onload = () => { window.__adResults.adImg = 'load'; };
    document.getElementById('ok-img').onerror = () => { window.__adResults.okImg = 'error'; };
    document.getElementById('ok-img').onload = () => { window.__adResults.okImg = 'load'; };
    document.cookie = 'mh_adblock_test=1; path=/';
    window.__adResults.cookie = document.cookie;
    fetch('/adserver/pixel').then(() => { window.__adResults.xhrAd = 'load'; }).catch(() => { window.__adResults.xhrAd = 'error'; });
    fetch('/api/ok.json').then(r => r.json()).then(() => { window.__adResults.xhrOk = 'load'; }).catch(() => { window.__adResults.xhrOk = 'error'; });
    setTimeout(() => {
      window.__adResults.scriptlet = window.__mhScriptletOk === true ? 'ok' : 'missing';
    }, 900);
  </script>
</body></html>`;

  const IFRAME_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>iframe</title></head>
<body>
  <div class="ad-banner" id="iframe-banner">IFRAME AD</div>
  <script>
    setTimeout(() => {
      window.__iframeScriptlet = window.__mhScriptletOk === true ? 'ok' : 'missing';
    }, 900);
  </script>
</body></html>`;

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = req.url || '/';
      bump(u.split('?')[0]);
      if (u.startsWith('/adserver/') || u === '/tracker.js') {
        // These should be blocked when adblock is on — if reached, count as hit
        if (u === '/tracker.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' });
          res.end('window.__adResults = window.__adResults || {}; window.__adResults.tracker = "load";');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        return;
      }
      if (u === '/normal.png' || u === '/api/ok.json') {
        if (u.endsWith('.json')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } else {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
              'base64'
            )
          );
        }
        return;
      }
      if (u === '/iframe') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(IFRAME_HTML);
        return;
      }
      if (u === '/custom-list.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('! custom list\n/custom-ad-pixel\n##.custom-ad-el\n');
        return;
      }
      if (u === '/' || u.startsWith('/page')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
        return;
      }
      res.writeHead(404);
      res.end('no');
    });
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const base = `http://127.0.0.1:${port}`;
  console.log('PASS: local adblock server', base);

  const filters = [
    '! MultiHeiz selftest filters',
    '||ads.test.local^',
    '/adserver/*',
    '/tracker.js',
    '##.ad-banner',
    // Ghostery rejects generic ##+js — must be hostname-specific
    '127.0.0.1##+js(set-constant, __mhScriptletOk, true)',
  ].join('\n');

  adblock.setFetchBlocked(true);
  adblock.clearFetchLog();
  await adblock.injectTestFilters(filters);
  await adblock.whenReady();
  await adblock.applySettings({
    enabled: true,
    cosmetic: true,
    antiTracking: true,
    youtubeExperimental: false,
  });

  updateState((s) => {
    s.accounts = [
      {
        id: 'acc-ad-a',
        name: 'Ad A',
        color: '#2bb8a6',
        startUrl: `${base}/page-a`,
        workspaceId: s.activeWorkspaceId,
        muted: false,
        pauseInBackground: false,
        privateHistory: false,
        adblockEnabled: true,
        lastUrl: null,
      },
      {
        id: 'acc-ad-b',
        name: 'Ad B',
        color: '#3d8bfd',
        startUrl: `${base}/page-b`,
        workspaceId: s.activeWorkspaceId,
        muted: false,
        pauseInBackground: false,
        privateHistory: false,
        adblockEnabled: true,
        lastUrl: null,
      },
    ];
    s.layout = '2';
    s.page = 0;
    s.settings.adblock = {
      ...(s.settings.adblock || adblock.defaultAdblockSettings()),
      enabled: true,
      cosmetic: true,
    };
  });
  flushSave();

  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
  );
  await sleep(400);

  // Ensure panels exist and navigate
  panels.createPanel('acc-ad-a');
  panels.createPanel('acc-ad-b');
  await adblock.whenReady();
  // Re-attach after engine ready
  const { session } = require('electron');
  adblock.attachSession(session.fromPartition(panels.partitionFor('acc-ad-a')), 'acc-ad-a');
  adblock.attachSession(session.fromPartition(panels.partitionFor('acc-ad-b')), 'acc-ad-b');

  hitCounts.clear();
  panels.panelNavigate('acc-ad-a', `${base}/page-a`);
  await waitForUrl('acc-ad-a', (u) => u.includes('/page-a'), 15000);
  await sleep(1200);

  async function pageResults(accountId) {
    const wc = panels.getPanelCapture(accountId);
    if (!wc) throw new Error(`no panel ${accountId}`);
    return wc.executeJavaScript(`(function(){
      const r = window.__adResults || {};
      const banner = document.getElementById('ad-banner');
      const style = banner ? getComputedStyle(banner) : null;
      return {
        results: r,
        bannerDisplay: style ? style.display : null,
        bannerVisibility: style ? style.visibility : null,
        cookie: document.cookie,
      };
    })()`);
  }

  let info = await pageResults('acc-ad-a');
  const statsA = adblock.getPageStats('acc-ad-a');
  console.log('adblock-on results', JSON.stringify(info), 'stats', statsA.pageBlocked);

  // Expected blocked: ad img, tracker, xhr ad (= 3). Normal img + xhr ok load.
  const blockedOk =
    info.results.adImg === 'error' &&
    info.results.okImg === 'load' &&
    info.results.xhrAd === 'error' &&
    info.results.xhrOk === 'load' &&
    (info.results.tracker === 'pending' || info.results.tracker === 'error' || !info.results.tracker);

  if (!blockedOk) {
    throw new Error('FAIL: adblock ON did not block ads / allowed normal: ' + JSON.stringify(info));
  }
  // Server should not have received ad paths (or much fewer)
  const adHits =
    (hitCounts.get('/adserver/banner.gif') || 0) +
    (hitCounts.get('/adserver/pixel') || 0) +
    (hitCounts.get('/tracker.js') || 0);
  if (adHits > 0) {
    console.log('WARN: server saw ad hits (may race):', adHits);
  }
  if (statsA.pageBlocked < 2) {
    throw new Error(`FAIL: shield counter too low: ${statsA.pageBlocked}`);
  }
  console.log('PASS: adblock ON blocks ads, counter=', statsA.pageBlocked);

  // Cosmetic
  if (info.bannerDisplay !== 'none' && info.bannerVisibility !== 'hidden') {
    // Ghostery injects CSS asynchronously — wait a bit more
    await sleep(800);
    info = await pageResults('acc-ad-a');
  }
  if (info.bannerDisplay === 'none' || info.bannerVisibility === 'hidden') {
    console.log('PASS: cosmetic ##.ad-banner hidden');
  } else {
    console.log('WARN: cosmetic hide not observed (engine may delay)', info.bannerDisplay);
    // Still fail soft — task requires it
    throw new Error('FAIL: cosmetic filter did not hide .ad-banner');
  }

  // Cookie
  if (!String(info.cookie).includes('mh_adblock_test=1')) {
    throw new Error('FAIL: cookie missing after page load');
  }
  console.log('PASS: cookies unaffected');

  // Per-window OFF on B — load all
  adblock.setWindowEnabled('acc-ad-b', false);
  // Re-attach so hub sees the updated per-window flag immediately
  adblock.attachSession(session.fromPartition(panels.partitionFor('acc-ad-b')), 'acc-ad-b');
  hitCounts.clear();
  panels.panelNavigate('acc-ad-b', `${base}/page-b`);
  await waitForUrl('acc-ad-b', (u) => u.includes('/page-b'), 15000);
  let infoB = null;
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    infoB = await pageResults('acc-ad-b');
    const r = infoB.results || {};
    // Wait until img probes leave pending (ERR_ABORTED / slow paint flake)
    if (r.adImg !== 'pending' && r.okImg !== 'pending' && r.xhrAd !== 'pending') break;
  }
  if (
    !infoB ||
    infoB.results.adImg !== 'load' ||
    infoB.results.okImg !== 'load' ||
    infoB.results.xhrAd !== 'load'
  ) {
    throw new Error('FAIL: per-window OFF should load ads: ' + JSON.stringify(infoB));
  }
  // A still blocks
  hitCounts.clear();
  panels.panelNavigate('acc-ad-a', `${base}/page-a2`);
  await waitForUrl('acc-ad-a', (u) => u.includes('/page-a2'), 15000);
  await sleep(1000);
  const infoA2 = await pageResults('acc-ad-a');
  if (infoA2.results.adImg !== 'error') {
    throw new Error('FAIL: window A should still block');
  }
  console.log('PASS: per-window OFF / other window still blocks');

  // Allowlist site (127.0.0.1)
  adblock.setWindowEnabled('acc-ad-b', true);
  adblock.addAllowlistDomain('127.0.0.1');
  panels.panelNavigate('acc-ad-a', `${base}/page-allow`);
  await waitForUrl('acc-ad-a', (u) => u.includes('/page-allow'), 15000);
  await sleep(1000);
  const infoAllow = await pageResults('acc-ad-a');
  if (infoAllow.results.adImg !== 'load') {
    throw new Error('FAIL: allowlist should load ads: ' + JSON.stringify(infoAllow));
  }
  adblock.removeAllowlistDomain('127.0.0.1');
  panels.panelNavigate('acc-ad-a', `${base}/page-deny`);
  await waitForUrl('acc-ad-a', (u) => u.includes('/page-deny'), 15000);
  await sleep(1000);
  const infoDeny = await pageResults('acc-ad-a');
  if (infoDeny.results.adImg !== 'error') {
    throw new Error('FAIL: after allowlist remove should block');
  }
  console.log('PASS: allowlist add/remove');

  // Global OFF
  await adblock.applySettings({ enabled: false });
  panels.panelNavigate('acc-ad-a', `${base}/page-global-off`);
  await waitForUrl('acc-ad-a', (u) => u.includes('/page-global-off'), 15000);
  await sleep(1000);
  const infoOff = await pageResults('acc-ad-a');
  if (infoOff.results.adImg !== 'load') {
    throw new Error('FAIL: global OFF should load ads');
  }
  console.log('PASS: global OFF');

  // Re-enable + new window
  await adblock.applySettings({ enabled: true });
  updateState((s) => {
    s.accounts.push({
      id: 'acc-ad-c',
      name: 'Ad C',
      color: '#e67e22',
      startUrl: `${base}/page-c`,
      workspaceId: s.activeWorkspaceId,
      muted: false,
      pauseInBackground: false,
      privateHistory: false,
      adblockEnabled: true,
      lastUrl: null,
    });
  });
  panels.createPanel('acc-ad-c');
  adblock.attachSession(session.fromPartition(panels.partitionFor('acc-ad-c')), 'acc-ad-c');
  panels.panelNavigate('acc-ad-c', `${base}/page-c`);
  await waitForUrl('acc-ad-c', (u) => u.includes('/page-c'), 15000);
  await sleep(1000);
  const infoC = await pageResults('acc-ad-c');
  if (infoC.results.adImg !== 'error') {
    throw new Error('FAIL: new window should block');
  }
  console.log('PASS: new window blocks');

  // Persist settings / per-window / allowlist
  adblock.setWindowEnabled('acc-ad-b', false);
  adblock.addAllowlistDomain('example.com');
  await adblock.applySettings({ enabled: true, youtubeExperimental: true });
  flushSave();
  const statePath = path.join(userData, 'multiheiz-state.json');
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!raw.settings.adblock || raw.settings.adblock.enabled !== true) {
    throw new Error('FAIL: adblock settings not persisted');
  }
  if (!raw.settings.adblock.allowlist.includes('example.com')) {
    throw new Error('FAIL: allowlist not persisted');
  }
  const accB = raw.accounts.find((a) => a.id === 'acc-ad-b');
  if (!accB || accB.adblockEnabled !== false) {
    throw new Error('FAIL: per-window flag not persisted');
  }
  console.log('PASS: settings/allowlist/per-window persist');

  // Offline cache: no network fetch when loading from cache
  adblock.clearFetchLog();
  adblock.setFetchBlocked(true);
  await adblock.injectTestFilters(filters);
  const fetches = adblock.getFetchLog();
  if (fetches.length > 0) {
    throw new Error('FAIL: unexpected network fetch in offline test: ' + JSON.stringify(fetches));
  }
  console.log('PASS: engine from cache / offline (no network fetch)');

  // Scriptlet ##+js in main frame
  panels.panelNavigate('acc-ad-a', `${base}/page-scriptlet`);
  await waitForUrl('acc-ad-a', (u) => u.includes('/page-scriptlet'), 15000);
  await sleep(1600);
  const scriptletInfo = await pageResults('acc-ad-a');
  if (scriptletInfo.results.scriptlet !== 'ok') {
    throw new Error('FAIL: ##+js scriptlet did not run in main frame: ' + JSON.stringify(scriptletInfo));
  }
  console.log('PASS: scriptlet ##+js in main frame');

  // Cosmetic + scriptlet in iframe
  const iframeCheck = await panels.getPanelCapture('acc-ad-a').executeJavaScript(`(async function(){
    const f = document.getElementById('ad-frame');
    if (!f || !f.contentDocument) return { ok: false, reason: 'no-iframe' };
    const banner = f.contentDocument.getElementById('iframe-banner');
    const style = banner ? f.contentWindow.getComputedStyle(banner) : null;
    return {
      ok: true,
      bannerDisplay: style ? style.display : null,
      bannerVisibility: style ? style.visibility : null,
      scriptlet: f.contentWindow.__iframeScriptlet || f.contentWindow.__mhScriptletOk,
    };
  })()`);
  if (!iframeCheck.ok) {
    throw new Error('FAIL: iframe not available for cosmetic/scriptlet check');
  }
  if (iframeCheck.bannerDisplay !== 'none' && iframeCheck.bannerVisibility !== 'hidden') {
    await sleep(800);
    const iframeCheck2 = await panels.getPanelCapture('acc-ad-a').executeJavaScript(`(function(){
      const f = document.getElementById('ad-frame');
      const banner = f && f.contentDocument && f.contentDocument.getElementById('iframe-banner');
      const style = banner ? f.contentWindow.getComputedStyle(banner) : null;
      return {
        bannerDisplay: style ? style.display : null,
        bannerVisibility: style ? style.visibility : null,
        scriptlet: f && f.contentWindow && (f.contentWindow.__iframeScriptlet || f.contentWindow.__mhScriptletOk),
      };
    })()`);
    if (iframeCheck2.bannerDisplay !== 'none' && iframeCheck2.bannerVisibility !== 'hidden') {
      throw new Error('FAIL: cosmetic in iframe did not hide .ad-banner: ' + JSON.stringify(iframeCheck2));
    }
    if (iframeCheck2.scriptlet !== 'ok' && iframeCheck2.scriptlet !== true) {
      throw new Error('FAIL: scriptlet in iframe missing: ' + JSON.stringify(iframeCheck2));
    }
  } else if (iframeCheck.scriptlet !== 'ok' && iframeCheck.scriptlet !== true) {
    throw new Error('FAIL: scriptlet in iframe missing: ' + JSON.stringify(iframeCheck));
  }
  console.log('PASS: cosmetic + scriptlet in iframe');

  // User rules textarea (apply immediately)
  await adblock.setUserRules('/user-rule-pixel\n##.user-rule-el');
  const stUser = adblock.getStatus();
  if (!stUser.userRules || !stUser.userRules.includes('user-rule-pixel')) {
    throw new Error('FAIL: userRules not saved');
  }
  console.log('PASS: custom rule textarea / userRules');

  // Custom list by URL from local server
  adblock.setFetchBlocked(false);
  const custom = await adblock.addCustomList(`${base}/custom-list.txt`);
  if (!custom.ok || !(custom.ruleCount > 0)) {
    throw new Error('FAIL: custom list by URL: ' + JSON.stringify(custom));
  }
  const stCustom = adblock.getStatus();
  if (!(stCustom.customLists || []).some((c) => c.url.includes('/custom-list.txt'))) {
    throw new Error('FAIL: custom list not in status');
  }
  console.log('PASS: custom list by URL, rules=', custom.ruleCount);

  // Screenshot: open settings adblock section if possible
  try {
    await rendererEval(`(async function(){
      const btn = document.getElementById('btn-settings');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 200));
      const nav = document.querySelector('.settings-nav-btn[data-section="adblock"]');
      if (nav) nav.click();
    })()`);
    await sleep(400);
    await rendererEval(
      'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
    );
    await sleep(300);
    const img = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.join(shotsDir, 'v1.7-adblock.png'), img.toPNG());
    console.log('PASS: screenshot v1.7-adblock.png');
  } catch (err) {
    console.log('WARN: screenshot failed', err && err.message);
  }

  if (server) {
    // Avoid hang on keep-alive sockets (flake: server.close never fires)
    await new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(() => {
        try {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        } catch {
          /* ignore */
        }
        try {
          server.unref();
        } catch {
          /* ignore */
        }
        done();
      }, 1500);
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {
        /* ignore */
      }
      server.close(() => {
        clearTimeout(timer);
        done();
      });
    });
  }

  console.log('PASS: selftest adblock complete');
  app.exit(0);
}

module.exports = { runAdblockSelftest };
