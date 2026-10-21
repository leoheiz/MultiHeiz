'use strict';

/**
 * Selftest: ad-block ativo desde a inicialização (MULTIHEIZ_SELFTEST=adblock-startup).
 *
 * Phase 1 (cold): USERDATA pré-semeado com adblock.enabled=true + test-filters.txt,
 * sem engine.bin. Sem toggling. Em ≤10s o motor anexa e bloqueia um URL de anúncio
 * local; o escudo do painel aparece ligado.
 *
 * Phase 2 (cache): mesma USERDATA — motor do cache (engineSource=cache), bloqueio ok.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { envGet } = require('./config');

const ENGINE_DEADLINE_MS = 10000;

/**
 * @param {object} ctx
 */
async function runAdblockStartupSelftest(ctx) {
  const {
    mainWindow,
    panels,
    getState,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    rendererEval,
    adblock,
  } = ctx;

  const phase = String(envGet('MULTIHEIZ_SELFTEST_PHASE') || '1');
  console.log('SELFTEST adblock-startup phase=' + phase);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  function assert(cond, msg, detail) {
    if (!cond) {
      console.log('FAIL:', msg, detail != null ? detail : '');
      throw new Error(msg + (detail != null ? ': ' + JSON.stringify(detail) : ''));
    }
  }

  // Saved setting must already be enabled — never toggle in this selftest.
  const abSettings = getState().settings && getState().settings.adblock;
  assert(abSettings && abSettings.enabled !== false, 'pre-seeded adblock.enabled', abSettings);

  adblock.setFetchBlocked(true);

  /** @type {http.Server|null} */
  let server = null;
  /** @type {Map<string, number>} */
  const hitCounts = new Map();

  const PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>startup-ad</title></head>
<body>
  <h1 id="ok">startup-ok</h1>
  <img id="ad-img" src="/adserver/banner.gif" width="1" height="1" />
  <img id="ok-img" src="/normal.png" width="1" height="1" />
  <script>
    window.__adResults = { adImg: 'pending', okImg: 'pending' };
    function wire(id, key) {
      const el = document.getElementById(id);
      if (!el) return;
      const done = (s) => { window.__adResults[key] = s; };
      el.onerror = () => done('error');
      el.onload = () => done('load');
      if (el.complete) done(el.naturalWidth > 0 ? 'load' : 'error');
    }
    wire('ad-img', 'adImg');
    wire('ok-img', 'okImg');
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
      res.end(PAGE_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const base = `http://127.0.0.1:${port}`;
  console.log('local mock', base);

  // Wait for engine from init (no applySettings / injectTestFilters / toggle).
  const t0 = Date.now();
  let status = adblock.getStatus();
  while (!status.ready && Date.now() - t0 < ENGINE_DEADLINE_MS) {
    await adblock.whenReady();
    status = adblock.getStatus();
    if (!status.ready) await sleep(100);
  }
  assert(status.ready, 'engine ready within deadline', {
    ms: Date.now() - t0,
    status,
  });
  assert(status.enabled !== false, 'status.enabled', status);
  assert(Date.now() - t0 < ENGINE_DEADLINE_MS, 'engine attach deadline', Date.now() - t0);

  if (phase === '2') {
    assert(status.engineSource === 'cache', 'phase2 engineSource=cache', status.engineSource);
    console.log('PASS: phase2 used cached engine');
  } else {
    console.log('PASS: phase1 engine ready source=' + status.engineSource + ' ms=' + (Date.now() - t0));
  }

  // Ensure account + session attached (saved account from seed).
  const st0 = getState();
  let accId = (st0.accounts && st0.accounts[0] && st0.accounts[0].id) || 'acc-startup-ad';
  if (!(st0.accounts || []).some((a) => a.id === accId)) {
    updateState((s) => {
      s.accounts = [
        {
          id: accId,
          name: 'Startup Ad',
          color: '#2bb8a6',
          startUrl: base + '/page',
          workspaceId: s.activeWorkspaceId,
          muted: false,
          adblockEnabled: true,
          lastUrl: null,
        },
      ];
      s.layout = '1';
    });
    flushSave();
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }

  adblock.attachBlockingEverywhere();
  panels.createPanel(accId);
  const { session } = require('electron');
  adblock.attachSession(session.fromPartition(panels.partitionFor(accId)), accId);

  // Shield must reflect saved setting from first paint (no toggle).
  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
  );
  await sleep(300);
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(200);

  const shield = await rendererEval(`(function(){
    const btn = document.querySelector('[data-role="panel-adblock"]');
    if (!btn) return { ok: false, reason: 'no-shield' };
    return {
      ok: true,
      off: btn.classList.contains('off'),
      title: btn.title || '',
    };
  })()`);
  assert(shield && shield.ok, 'shield present', shield);
  assert(!shield.off, 'shield shows enabled (no .off)', shield);
  console.log('PASS: shield enabled without toggling');

  hitCounts.clear();
  panels.panelNavigate(accId, base + '/page');
  await waitForUrl(accId, (u) => u.includes('/page'), 15000);
  await sleep(1200);

  const wc = panels.getPanelCapture(accId);
  assert(wc, 'panel webContents');
  const pageInfo = await wc.executeJavaScript(
    `(function(){ return window.__adResults || null; })()`
  );
  const stats = adblock.getPageStats(accId);
  console.log('page results', pageInfo, 'blocked', stats.pageBlocked, 'hits', Object.fromEntries(hitCounts));

  assert(
    pageInfo && pageInfo.adImg === 'error',
    'ad URL blocked by startup engine',
    pageInfo
  );
  assert(pageInfo && pageInfo.okImg === 'load', 'normal URL allowed', pageInfo);
  assert(stats.pageBlocked >= 1, 'pageBlocked >= 1', stats);

  // Persist engine.bin for phase 2
  flushSave();
  const engPath = path.join(app.getPath('userData'), 'adblock', 'engine.bin');
  assert(fs.existsSync(engPath), 'engine.bin written for cache', engPath);
  console.log('PASS: ad blocked with startup engine; engine.bin present');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest adblock-startup phase=' + phase);
  app.exit(0);
}

module.exports = { runAdblockStartupSelftest };
