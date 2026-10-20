'use strict';

/**
 * Selftest: medição de desempenho (MULTIHEIZ_SELFTEST=perf).
 * 3 painéis locais (1 com <video>); marca startup até did-finish-load do 1º painel;
 * RAM (app.getAppMetrics) e CPU médio em repouso.
 * Emite linha PERF_JSON={...} para tools/check-perf.js.
 */

const http = require('node:http');
const { app } = require('electron');
const { envGet } = require('./config');

const IDLE_MS = Math.max(5000, Number(envGet('MULTIHEIZ_PERF_IDLE_MS')) || 30000);
const VIDEO_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>perf-v</title></head>
<body style="margin:0;background:#123;color:#fff;font:16px system-ui">
<video id="v" width="320" height="180" autoplay muted loop playsinline></video>
<canvas id="c" width="320" height="180" style="display:none"></canvas>
<script>
(function(){
  var c = document.getElementById('c');
  var ctx = c.getContext('2d');
  var t0 = performance.now();
  function frame(t) {
    var x = ((t - t0) / 16) % 320;
    ctx.fillStyle = '#0a2030';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#2bb8a6';
    ctx.fillRect(x, 60, 40, 60);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  var stream = c.captureStream(30);
  var v = document.getElementById('v');
  v.srcObject = stream;
  v.play().catch(function(){});
})();
</script>
</body></html>`;

const QUIET_PAGE =
  '<!DOCTYPE html><html><body style="margin:0;background:#234;color:#fff;font:18px sans-serif;padding:24px">quiet</body></html>';

/**
 * @param {object} ctx
 */
async function runPerfSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
  } = ctx;

  const tProcStart = Number(envGet('MULTIHEIZ_PERF_T0')) || Date.now();
  console.log('SELFTEST perf idleMs=' + IDLE_MS);

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = String(req.url || '');
      if (u.startsWith('/video')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(VIDEO_PAGE);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(QUIET_PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const videoUrl = base + '/video';
  const quietUrl = base + '/quiet';

  /** @type {number|null} */
  let firstPanelFinishMs = null;
  const finishWaiters = [];

  function onMaybeFirstFinish(accountId) {
    if (firstPanelFinishMs != null) return;
    firstPanelFinishMs = Date.now() - tProcStart;
    console.log('PERF_MARK first-panel-did-finish-load ms=' + firstPanelFinishMs + ' account=' + accountId);
    for (const w of finishWaiters) w();
    finishWaiters.length = 0;
  }

  for (const id of ['acc-perf-v', 'acc-perf-b', 'acc-perf-c']) {
    const wc = panels.getPanelCapture && panels.getPanelCapture(id);
    if (wc && !wc.isDestroyed()) {
      wc.on('did-finish-load', () => onMaybeFirstFinish(id));
    }
  }

  updateState((s) => {
    s.workspaces = [{ id: 'ws-perf', name: 'Perf' }];
    s.activeWorkspaceId = 'ws-perf';
    s.layout = '3';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace['ws-perf'] = '3';
    s.page = 0;
    s.accounts = [
      {
        id: 'acc-perf-v',
        name: 'Video',
        color: '#2bb8a6',
        startUrl: videoUrl,
        workspaceId: 'ws-perf',
        muted: true,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-perf-b',
        name: 'QuietB',
        color: '#4a9',
        startUrl: quietUrl,
        workspaceId: 'ws-perf',
        muted: true,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-perf-c',
        name: 'QuietC',
        color: '#a94',
        startUrl: quietUrl,
        workspaceId: 'ws-perf',
        muted: true,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    s.ui = { ...(s.ui || {}), sidebarCollapsed: false, sidebarAutoHide: false, layoutLocked: true };
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: quietUrl,
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);

  for (const id of ['acc-perf-v', 'acc-perf-b', 'acc-perf-c']) {
    try {
      panels.createPanel(id);
    } catch {
      /* already exists */
    }
    const entry = panels.getPanelCapture(id);
    if (entry && !entry.isDestroyed()) {
      entry.on('did-finish-load', () => onMaybeFirstFinish(id));
    }
  }

  const bw = mainWindow.getContentSize()[0] || 1400;
  const bh = mainWindow.getContentSize()[1] || 900;
  const w = Math.floor(bw / 3);
  const h = Math.max(240, bh - 80);
  panels.syncVisiblePanels([
    { accountId: 'acc-perf-v', x: 0, y: 80, width: w, height: h },
    { accountId: 'acc-perf-b', x: w, y: 80, width: w, height: h },
    { accountId: 'acc-perf-c', x: w * 2, y: 80, width: bw - w * 2, height: h },
  ]);

  panels.panelNavigate('acc-perf-v', videoUrl);
  panels.panelNavigate('acc-perf-b', quietUrl);
  panels.panelNavigate('acc-perf-c', quietUrl);

  await Promise.race([
    new Promise((resolve) => {
      if (firstPanelFinishMs != null) {
        resolve();
        return;
      }
      finishWaiters.push(resolve);
    }),
    (async () => {
      await waitForUrl('acc-perf-v', (u) => u.includes('127.0.0.1'), 30000);
      if (firstPanelFinishMs == null) onMaybeFirstFinish('acc-perf-v');
    })(),
  ]);

  await waitForUrl('acc-perf-b', (u) => u.includes('127.0.0.1'), 30000);
  await waitForUrl('acc-perf-c', (u) => u.includes('127.0.0.1'), 30000);
  await waitForLayoutSettle();

  const uiReadyMs = Date.now() - tProcStart;
  if (firstPanelFinishMs == null) firstPanelFinishMs = uiReadyMs;

  const winVisibleMs = Number(envGet('MULTIHEIZ_PERF_VISIBLE_MS')) || null;

  // Amostra CPU/RAM em repouso
  const samples = [];
  const tIdle0 = Date.now();
  while (Date.now() - tIdle0 < IDLE_MS) {
    const metrics = app.getAppMetrics();
    let ramKb = 0;
    let cpu = 0;
    for (const m of metrics) {
      const mem = m.memory || {};
      const kb =
        Number(mem.workingSetSize) ||
        Number(mem.privateBytes) ||
        Number(mem.workingSetSize) ||
        0;
      ramKb += kb;
      cpu += Number(m.cpu && m.cpu.percentCPUUsage) || 0;
    }
    samples.push({ ramKb, cpu, n: metrics.length });
    await sleep(1000);
  }

  const avgRamKb =
    samples.reduce((a, s) => a + s.ramKb, 0) / Math.max(1, samples.length);
  const avgCpu =
    samples.reduce((a, s) => a + s.cpu, 0) / Math.max(1, samples.length);

  const result = {
    method: 'selftest-perf',
    label: envGet('MULTIHEIZ_PERF_LABEL') || 'HEAD',
    startupMs: firstPanelFinishMs,
    firstPanelDidFinishLoadMs: firstPanelFinishMs,
    uiReadyMs,
    winVisibleMs,
    ramMb: Math.round((avgRamKb / 1024) * 10) / 10,
    cpuAvgPct: Math.round(avgCpu * 10) / 10,
    idleMs: IDLE_MS,
    samples: samples.length,
    panels: 3,
    videoPanels: 1,
    at: new Date().toISOString(),
  };

  console.log('PERF_JSON=' + JSON.stringify(result));
  assert(result.startupMs > 0, 'startupMs');
  assert(result.ramMb > 0, 'ramMb');
  console.log('PASS: selftest:perf complete');

  try {
    server.close();
  } catch {
    /* ignore */
  }
  app.exit(0);
}

module.exports = { runPerfSelftest };
