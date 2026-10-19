'use strict';

/**
 * Minimal packaged-only adblock check (MULTIHEIZ_SELFTEST=adblock-packaged).
 * Kept outside selftest-*.js so electron-builder includes it in the asar.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, session } = require('electron');

/**
 * Close an HTTP server without hanging on keep-alive sockets.
 * @param {http.Server|null} server
 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
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

/**
 * @param {{
 *   mainWindow: import('electron').BrowserWindow,
 *   panels: typeof import('../panels'),
 *   getState: () => any,
 *   updateState: Function,
 *   flushSave: Function,
 *   sleep: (ms: number) => Promise<void>,
 *   waitForUrl: Function,
 *   adblock: typeof import('./index'),
 * }} ctx
 */
async function runPackagedAdblockCheck(ctx) {
  const { panels, updateState, flushSave, sleep, waitForUrl, adblock } = ctx;

  if (!app.isPackaged) {
    throw new Error('FAIL: adblock-packaged selftest requires a packaged build');
  }

  console.log('SELFTEST adblock-packaged');
  console.log('appPath', app.getAppPath());
  console.log('isPackaged', app.isPackaged);

  const diag0 = adblock.getDiagnostics();
  console.log(
    'preloadPath',
    diag0.preloadPath,
    'exists',
    diag0.preloadExists,
    'unpacked',
    diag0.preloadUnpacked,
    'inAsar',
    diag0.preloadInAsar
  );
  if (!diag0.preloadExists) {
    throw new Error('FAIL: cosmetic preload path missing: ' + diag0.preloadPath);
  }

  /** @type {http.Server|null} */
  let server = null;
  const hitCounts = new Map();

  const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>packaged-adblock</title></head>
<body>
  <h1 id="ok">page-ok</h1>
  <div class="ad-banner" id="ad-banner">AD</div>
  <img id="ad-img" src="/adserver/banner.gif" width="1" height="1" />
  <img id="ok-img" src="/normal.png" width="1" height="1" />
  <script>
    window.__adResults = { adImg: 'pending', okImg: 'pending', scriptlet: 'pending' };
    document.getElementById('ad-img').onerror = () => { window.__adResults.adImg = 'error'; };
    document.getElementById('ad-img').onload = () => { window.__adResults.adImg = 'load'; };
    document.getElementById('ok-img').onerror = () => { window.__adResults.okImg = 'error'; };
    document.getElementById('ok-img').onload = () => { window.__adResults.okImg = 'load'; };
    setTimeout(() => {
      window.__adResults.scriptlet = window.__mhScriptletOk === true ? 'ok' : 'missing';
      window.__adResults.earlyCss =
        !!(document.getElementById('mh-adblock-css-early') || document.getElementById('mh-adblock-css'));
    }, 700);
  </script>
</body></html>`;

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = (req.url || '/').split('?')[0];
      hitCounts.set(u, (hitCounts.get(u) || 0) + 1);
      if (u.startsWith('/adserver/')) {
        res.writeHead(200, { 'Content-Type': 'image/gif' });
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        return;
      }
      if (u === '/normal.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
          )
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const base = `http://127.0.0.1:${port}`;
  console.log('PASS: local server', base);

  const filters = [
    '! packaged selftest',
    '/adserver/*',
    '##.ad-banner',
    '127.0.0.1##+js(set-constant, __mhScriptletOk, true)',
  ].join('\n');

  adblock.setFetchBlocked(true);
  await adblock.injectTestFilters(filters);
  await adblock.whenReady();
  await adblock.applySettings({ enabled: true, cosmetic: true });

  updateState((s) => {
    s.accounts = [
      {
        id: 'acc-pack-a',
        name: 'Pack A',
        color: '#2bb8a6',
        startUrl: `${base}/page`,
        workspaceId: s.activeWorkspaceId,
        muted: true,
        pauseInBackground: false,
        privateHistory: false,
        adblockEnabled: true,
        lastUrl: null,
      },
    ];
    s.layout = '1';
    s.page = 0;
    s.settings.adblock = {
      ...(s.settings.adblock || adblock.defaultAdblockSettings()),
      enabled: true,
      cosmetic: true,
    };
  });
  flushSave();

  adblock.attachAllAccountSessions();
  panels.createPanel('acc-pack-a');
  const ses = session.fromPartition(panels.partitionFor('acc-pack-a'));
  const scripts = typeof ses.getPreloadScripts === 'function' ? ses.getPreloadScripts() : [];
  console.log('sessionPreloads', JSON.stringify(scripts));
  if (!scripts.length) {
    throw new Error('FAIL: no session preload registered on persist partition');
  }

  hitCounts.clear();
  panels.panelNavigate('acc-pack-a', `${base}/page`);
  await waitForUrl('acc-pack-a', (u) => u.includes('/page'), 20000);
  await sleep(1400);

  const wc = panels.getPanelCapture('acc-pack-a');
  if (!wc) throw new Error('FAIL: no panel webContents');
  const info = await wc.executeJavaScript(`(function(){
    const r = window.__adResults || {};
    const banner = document.getElementById('ad-banner');
    const style = banner ? getComputedStyle(banner) : null;
    return {
      results: r,
      bannerDisplay: style ? style.display : null,
      earlyTiming: true
    };
  })()`);

  const stats = adblock.getPageStats('acc-pack-a');
  const early = adblock.getEarlyTimingLog();
  const focusDiag = adblock.getFocusedPanelDiagnostics('acc-pack-a');
  console.log('page', JSON.stringify(info));
  console.log('stats', stats.pageBlocked, 'earlyLog', JSON.stringify(early.slice(0, 3)));
  console.log('focusDiag', JSON.stringify(focusDiag));

  if (info.results.adImg !== 'error' || info.results.okImg !== 'load') {
    throw new Error('FAIL: network block in packaged app: ' + JSON.stringify(info));
  }
  if (info.results.scriptlet !== 'ok') {
    throw new Error('FAIL: early main-world scriptlet missing: ' + JSON.stringify(info));
  }
  if (info.bannerDisplay !== 'none') {
    await sleep(800);
    const info2 = await wc.executeJavaScript(`(function(){
      const banner = document.getElementById('ad-banner');
      return banner ? getComputedStyle(banner).display : null;
    })()`);
    if (info2 !== 'none') {
      throw new Error('FAIL: cosmetic hide missing in packaged app: ' + info2);
    }
  }
  if (!(stats.pageBlocked >= 1)) {
    throw new Error('FAIL: shield counter too low: ' + stats.pageBlocked);
  }
  if (!early.length || !(early[0].scripts >= 1)) {
    throw new Error('FAIL: early-timing IPC never reported scriptlets: ' + JSON.stringify(early));
  }
  if (!focusDiag || !focusDiag.scriptletsInjected) {
    throw new Error('FAIL: focused panel diagnostics missing scriptletsInjected');
  }

  console.log('PASS: packaged early scriptlet + cosmetic + network block');
  await closeServer(server);
  server = null;
  console.log('PASS: selftest adblock-packaged complete');
  app.exit(0);
}

module.exports = { runPackagedAdblockCheck, closeServer };
