'use strict';

/**
 * Mede latência de input na UI do app com painel “estilo YouTube” (vídeo + pushState + favicon + mídia).
 * MULTIHEIZ_SELFTEST=ui-input-lag
 * MULTIHEIZ_UI_LAG_LEGACY=1 → caminhos caros (antes)
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { envGet } = require('./config');

const LEGACY = envGet('MULTIHEIZ_UI_LAG_LEGACY') === '1';
const PHASE = LEGACY ? 'before' : 'after';

const YT_SIM = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>yt-sim 0</title>
<link id="fav" rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>">
</head>
<body style="margin:0;background:#111;color:#eee;font:14px system-ui">
<video id="v" width="480" height="270" autoplay muted loop playsinline></video>
<canvas id="c" width="480" height="270" style="display:none"></canvas>
<script>
(function(){
  var c = document.getElementById('c');
  var ctx = c.getContext('2d');
  var t0 = performance.now();
  var n = 0;
  function frame(t) {
    var x = ((t - t0) / 16) % 480;
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0,0,480,270);
    ctx.fillStyle = '#f00';
    ctx.fillRect(x, 80, 60, 80);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  var v = document.getElementById('v');
  v.srcObject = c.captureStream(30);
  v.play().catch(function(){});
  v.addEventListener('timeupdate', function(){});
  v.addEventListener('playing', function(){});
  setInterval(function(){
    n++;
    document.title = 'yt-sim ' + n + ' · video · ' + Date.now();
    try { history.pushState({}, '', '/watch?v=sim&t=' + n + '&x=' + (n%7)); } catch(e){}
    var fav = document.getElementById('fav');
    if (fav) fav.href = 'data:image/svg+xml,' + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg'><rect width='16' height='16' fill='rgb(" +
      (n%200) + "," + (50+(n%100)) + ",80)'/></svg>"
    );
    try { v.dispatchEvent(new Event('timeupdate')); } catch(e){}
  }, 40);
  window.__ytSim = { n: function(){ return n; }, playing: function(){ return !v.paused; } };
})();
</script>
</body></html>`;

/**
 * @param {object} ctx
 */
async function runUiInputLagSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    rendererEval,
  } = ctx;

  console.log('SELFTEST ui-input-lag phase=' + PHASE + ' legacy=' + LEGACY);

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(YT_SIM);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}/`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-uil', name: 'UIL' }];
    s.activeWorkspaceId = 'ws-uil';
    s.layout = '1';
    s.page = 0;
    // Várias entradas na sidebar: renderSidebar legado fica caro
    const extras = [];
    for (let i = 0; i < 12; i++) {
      extras.push({
        id: 'acc-uil-x' + i,
        name: 'Extra ' + (i + 1),
        color: '#2bb8a6',
        startUrl: 'about:blank',
        workspaceId: 'ws-uil',
        muted: false,
        volume: 100,
        lastUrl: null,
        zoomFactor: 1,
      });
    }
    s.accounts = [
      {
        id: 'acc-uil-v',
        name: 'Vídeo',
        color: '#e35d6a',
        startUrl: base,
        workspaceId: 'ws-uil',
        muted: false,
        volume: 100,
        lastUrl: null,
        zoomFactor: 1,
      },
      ...extras,
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(300);

  panels.createPanel('acc-uil-v');
  {
    const [bw, bh] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      {
        accountId: 'acc-uil-v',
        x: 0,
        y: 80,
        width: Math.max(480, bw - 40),
        height: Math.max(320, bh - 100),
      },
    ]);
  }
  panels.panelNavigate('acc-uil-v', base);
  await waitForUrl('acc-uil-v', (u) => u.includes('127.0.0.1'), 20000);
  await sleep(800);

  // Liga modo legado no renderer se pedido
  await rendererEval(`window.__mhUiLagLegacy = ${LEGACY ? 'true' : 'false'}; true`);

  // Injeta campo de busca na UI + observadores de longtask / input timing
  await rendererEval(`(function(){
    var existing = document.getElementById('mh-uil-probe');
    if (existing) existing.remove();
    var inp = document.createElement('input');
    inp.id = 'mh-uil-probe';
    inp.type = 'text';
    inp.style.cssText = 'position:fixed;z-index:99999;left:8px;top:8px;width:220px;height:28px;';
    document.body.appendChild(inp);
    window.__uil = {
      latencies: [],
      longTasks: [],
      lastKeyTs: 0
    };
    try {
      var po = new PerformanceObserver(function(list){
        list.getEntries().forEach(function(e){
          if (e.duration >= 50) {
            window.__uil.longTasks.push({ duration: e.duration, start: e.startTime, type: e.entryType });
          }
        });
      });
      if (PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.indexOf('longtask') >= 0) {
        po.observe({ type: 'longtask', buffered: true });
      } else {
        po.observe({ entryTypes: ['longtask'] });
      }
      window.__uil._po = po;
    } catch (e) {
      window.__uil._poErr = String(e && e.message || e);
    }
    // Fallback: gaps de rAF > 50 ms contam como long task no renderer da UI
    window.__uil._raf = { last: 0, running: true };
    function rafLoop(ts) {
      var s = window.__uil._raf;
      if (!s.running) return;
      if (s.last) {
        var gap = ts - s.last;
        if (gap > 50) window.__uil.longTasks.push({ duration: gap, start: s.last, type: 'raf-gap' });
      }
      s.last = ts;
      requestAnimationFrame(rafLoop);
    }
    requestAnimationFrame(rafLoop);
    inp.addEventListener('keydown', function(){
      window.__uil.lastKeyTs = performance.now();
    });
    inp.addEventListener('input', function(){
      var t0 = window.__uil.lastKeyTs;
      if (!t0) return;
      var dt = performance.now() - t0;
      window.__uil.latencies.push(dt);
      window.__uil.lastKeyTs = 0;
    });
    return true;
  })()`);

  // Foca o input da UI e digita várias teclas enquanto o painel “YouTube” bombardeia eventos
  await rendererEval(`(function(){
    var inp = document.getElementById('mh-uil-probe');
    if (inp) { inp.focus(); inp.value = ''; }
    return !!(inp && document.activeElement === inp);
  })()`);
  await sleep(100);

  const wc = mainWindow.webContents;
  // Enquanto digita: inundar a UI com metrics (simula barra de status + sidebar)
  const flood = setInterval(() => {
    try {
      emitToRenderer({
        type: 'memory:metrics',
        metrics: {
          totalRamMb: 400 + Math.floor(Math.random() * 40),
          totalCpu: 5 + Math.floor(Math.random() * 20),
          processCount: 8,
          metric: 'workingSetSize',
          breakdown: { panelsMb: 300, interfaceMb: 50, gpuMb: 30, outrosMb: 20 },
          panels: [
            {
              accountId: 'acc-uil-v',
              name: 'Vídeo',
              ramMb: 280 + Math.floor(Math.random() * 30),
              cpu: 3 + Math.floor(Math.random() * 10),
              active: true,
              visible: true,
              state: 'ativo',
              workspaceName: 'UIL',
            },
          ],
        },
      });
      emitToRenderer({
        type: 'panel:favicon',
        accountId: 'acc-uil-v',
        favicon:
          'data:image/svg+xml,' +
          encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" fill="rgb(${Date.now() % 200},80,80)"/></svg>`
          ),
      });
      emitToRenderer({
        type: 'panel:nav',
        accountId: 'acc-uil-v',
        url: base + 'watch?v=sim&t=' + Date.now(),
        title: 'yt-sim flood ' + Date.now(),
        domain: '127.0.0.1',
        canGoBack: true,
        canGoForward: false,
        muted: false,
      });
    } catch {
      /* ignore */
    }
  }, 30);

  const sampleChars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 50; i++) {
    const ch = sampleChars[i % sampleChars.length];
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch.toUpperCase() });
    wc.sendInputEvent({ type: 'char', keyCode: ch });
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch.toUpperCase() });
    await sleep(16);
  }
  clearInterval(flood);
  await sleep(400);
  await rendererEval(`(function(){ if (window.__uil && window.__uil._raf) window.__uil._raf.running = false; return true; })()`);

  const stats = await rendererEval(`(function(){
    function pct(arr, p) {
      if (!arr.length) return null;
      var a = arr.slice().sort(function(x,y){ return x-y; });
      var i = Math.min(a.length - 1, Math.max(0, Math.ceil(p / 100 * a.length) - 1));
      return a[i];
    }
    var L = window.__uil && window.__uil.latencies || [];
    var T = window.__uil && window.__uil.longTasks || [];
    var maxLt = 0;
    for (var i = 0; i < T.length; i++) if (T[i].duration > maxLt) maxLt = T[i].duration;
    return {
      n: L.length,
      p50: pct(L, 50),
      p95: pct(L, 95),
      max: L.length ? Math.max.apply(null, L) : null,
      longTaskCount: T.length,
      longTaskMaxMs: maxLt,
      longTasksOver50: T.filter(function(t){ return t.duration > 50; }).length,
      probeValueLen: (document.getElementById('mh-uil-probe') || {}).value
        ? document.getElementById('mh-uil-probe').value.length
        : 0,
      legacy: !!window.__mhUiLagLegacy,
      poErr: window.__uil && window.__uil._poErr || null
    };
  })()`);

  console.log('UI_INPUT_LAG', PHASE, JSON.stringify(stats));

  const logDir = path.join(__dirname, '..', '..', '_local');
  fs.mkdirSync(logDir, { recursive: true });
  const jsonPath = path.join(logDir, 'ui-input-lag-' + PHASE + '.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ phase: PHASE, legacy: LEGACY, stats, at: new Date().toISOString() }, null, 2), 'utf8');

  // Metas só na fase after
  if (!LEGACY) {
    assert(stats && stats.n >= 10, 'amostras de latência insuficientes: ' + (stats && stats.n));
    assert(
      stats.longTasksOver50 === 0,
      'long tasks > 50 ms: ' + stats.longTasksOver50 + ' max=' + stats.longTaskMaxMs
    );
    assert(
      typeof stats.p95 === 'number' && stats.p95 < 30,
      'p95 input latency >= 30 ms: ' + stats.p95
    );
    console.log('PASS: metas after (sem longtask>50, p95<30ms)');
  } else {
    console.log('PASS: baseline before registrada');
  }

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest ui-input-lag ' + PHASE);
  app.exit(0);
}

module.exports = { runUiInputLagSelftest };
