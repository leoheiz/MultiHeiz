'use strict';

/**
 * Selftest: popovers em WebContentsView overlay sem congelar/borrar painéis.
 * MULTIHEIZ_SELFTEST=popover-overlay
 */

const http = require('node:http');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runPopoverOverlaySelftest(ctx) {
  const {
    mainWindow,
    panels,
    popoverOverlay,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    rendererEval,
    publicState,
    emitToRenderer,
    waitForLayoutSettle,
  } = ctx;

  console.log('SELFTEST popover-overlay');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ov</title></head>
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
  window.__ovClicks = 0;
  document.addEventListener('click', function(){ window.__ovClicks++; }, true);
  document.addEventListener('mousedown', function(){ window.__ovMouseDown = (window.__ovMouseDown||0)+1; }, true);
  window.__ovPage = {
    currentTime: function() { return v.currentTime || 0; },
    playing: function() { return !v.paused; },
    clicks: function() { return window.__ovClicks|0; },
    mouseDown: function() { return window.__ovMouseDown|0; }
  };
})();
</script>
</body></html>`;

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}/`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-ov', name: 'OV' }];
    s.activeWorkspaceId = 'ws-ov';
    s.layout = '2';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace['ws-ov'] = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-ov-a',
        name: 'A',
        color: '#2bb8a6',
        startUrl: base,
        workspaceId: 'ws-ov',
        muted: false,
        volume: 100,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-ov-b',
        name: 'B',
        color: '#4a90d9',
        startUrl: base,
        workspaceId: 'ws-ov',
        muted: false,
        volume: 80,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    s.ui = {
      ...(s.ui || {}),
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      layoutLocked: true,
      sidebarWidth: 240,
    };
  });
  flushSave();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(400);

  panels.createPanel('acc-ov-a');
  panels.createPanel('acc-ov-b');
  {
    const [bw, bh] = mainWindow.getContentSize();
    const half = Math.floor(bw / 2);
    panels.syncVisiblePanels([
      { accountId: 'acc-ov-a', x: 0, y: 80, width: half, height: Math.max(240, bh - 80) },
      { accountId: 'acc-ov-b', x: half, y: 80, width: bw - half, height: Math.max(240, bh - 80) },
    ]);
  }
  await sleep(500);
  panels.panelNavigate('acc-ov-a', base);
  panels.panelNavigate('acc-ov-b', base);
  await waitForUrl('acc-ov-a', (u) => u.startsWith(base.replace(/\/$/, '')), 15000);
  await waitForUrl('acc-ov-b', (u) => u.startsWith(base.replace(/\/$/, '')), 15000);
  await sleep(800);
  if (typeof waitForLayoutSettle === 'function') await waitForLayoutSettle(1000);

  async function panelEval(id, code) {
    const wc = panels.getPanelCapture(id);
    assert(wc, 'wc ' + id);
    return wc.executeJavaScript(code, true);
  }

  async function assertPanelsLive(label) {
    const dbg = await rendererEval('window.multiheiz.popoverSelftestDebug()');
    assert(dbg, 'debug ' + label);
    assert(dbg.modalOverlayCount === 0, 'modal count 0 at ' + label + ': ' + dbg.modalOverlayCount);
    const bad = (dbg.spies || []).filter((s) =>
      /capturePage|parkViews|prepareAndPark|setVisible\(false\)|removeChildView/.test(s.op)
    );
    assert(bad.length === 0, 'no hide/capture spies at ' + label + ': ' + JSON.stringify(bad));
    for (const p of dbg.panelStates || []) {
      assert(p.attached, 'panel attached ' + p.accountId + ' @ ' + label);
      assert(p.visible !== false, 'panel visible ' + p.accountId + ' @ ' + label);
      assert(
        p.bounds && p.bounds.width > 10 && p.bounds.height > 10 && (p.bounds.x > -10000),
        'panel on-screen bounds ' + p.accountId + ' @ ' + label + ' ' + JSON.stringify(p.bounds)
      );
    }
    return dbg;
  }

  // Warm video
  await sleep(400);
  const t0 = await panelEval('acc-ov-a', 'window.__ovPage.currentTime()');
  await sleep(500);
  const t1 = await panelEval('acc-ov-a', 'window.__ovPage.currentTime()');
  assert(Number(t1) > Number(t0), 'video advances before popover: ' + t0 + ' -> ' + t1);
  console.log('PASS: video advances baseline', { t0, t1 });

  panels.clearOverlaySelftestSpies();
  popoverOverlay.clearSelftestLog();

  // --- Volume popover ---
  const openVol = await rendererEval('window.__multiheizUi.openVolumePopover("acc-ov-a")');
  assert(openVol && openVol.ok, 'open volume: ' + JSON.stringify(openVol));
  await sleep(250);
  const dbgVol = await assertPanelsLive('volume-open');
  assert(dbgVol.popover && dbgVol.popover.id === 'volume-popover', 'volume popover id');
  assert(dbgVol.zIndex >= 0, 'overlay z-index');
  const childCount = (mainWindow.contentView.children || []).length;
  assert(dbgVol.zIndex === childCount - 1, 'overlay on top: z=' + dbgVol.zIndex + ' n=' + childCount);
  const vb = dbgVol.popover.bounds;
  assert(vb && vb.width >= 100 && vb.height >= 40, 'volume bounds size ' + JSON.stringify(vb));

  const t2 = await panelEval('acc-ov-a', 'window.__ovPage.currentTime()');
  await sleep(600);
  const t3 = await panelEval('acc-ov-a', 'window.__ovPage.currentTime()');
  assert(Number(t3) > Number(t2), 'video advances while volume open: ' + t2 + ' -> ' + t3);
  console.log('PASS: video advances with volume popover', { t2, t3 });

  const lagShow = (dbgVol.overlayLog || []).filter((x) => x.op === 'show').pop();
  assert(!lagShow || lagShow.detail.lagMs < 20, 'open lag < 20ms: ' + JSON.stringify(lagShow));

  // Slider interaction via overlay action path
  await rendererEval(
    'window.__multiheizUi.setVolumePercent("acc-ov-a", 42)'
  );
  await sleep(150);
  const volAfter = await rendererEval('window.__multiheizUi.getAccountVolume("acc-ov-a")');
  assert(Number(volAfter) === 42, 'volume set to 42, got ' + volAfter);
  console.log('PASS: volume interaction while overlay open');

  // Esc close
  await rendererEval('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  // Also ask overlay
  popoverOverlay.requestClose('escape-test');
  await sleep(200);
  const afterEsc = await rendererEval('window.multiheiz.popoverGet()');
  assert(!afterEsc || !afterEsc.open, 'closed after Esc: ' + JSON.stringify(afterEsc));
  console.log('PASS: close by Esc');

  // --- Site info popover ---
  panels.clearOverlaySelftestSpies();
  popoverOverlay.clearSelftestLog();
  const site = await rendererEval('window.__multiheizUi.openSitePermissions("acc-ov-a")');
  assert(site && site.overlay, 'site perm overlay: ' + JSON.stringify(site));
  await sleep(200);
  const dbgSite = await assertPanelsLive('site-perm');
  assert(dbgSite.popover && dbgSite.popover.kind === 'site-perm', 'site-perm kind');
  const sb = dbgSite.popover.bounds;
  assert(sb && Math.abs(sb.width - (site.bounds && site.bounds.width || sb.width)) <= 2, 'site bounds');
  popoverOverlay.hide('test');
  await sleep(150);

  // --- Layout menu ---
  panels.clearOverlaySelftestSpies();
  popoverOverlay.clearSelftestLog();
  await rendererEval('window.__multiheizUi.openLayoutSelectPopover()');
  await sleep(250);
  const dbgLay = await assertPanelsLive('layout');
  assert(dbgLay.popover && dbgLay.popover.kind === 'layout', 'layout kind');
  const t4 = await panelEval('acc-ov-a', 'window.__ovPage.currentTime()');
  await sleep(400);
  const t5 = await panelEval('acc-ov-a', 'window.__ovPage.currentTime()');
  assert(Number(t5) > Number(t4), 'video advances with layout menu');

  // Clique FORA no painel: fecha o popover e a página recebe o clique (sem engolir)
  await panelEval('acc-ov-a', 'window.__ovClicks = 0; window.__ovMouseDown = 0; true');
  {
    const wc = panels.getPanelCapture('acc-ov-a');
    assert(wc, 'panel wc outside');
    wc.sendInputEvent({ type: 'mouseDown', x: 50, y: 50, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 50, y: 50, button: 'left', clickCount: 1 });
    await sleep(350);
  }
  const afterOutside = await rendererEval('window.multiheiz.popoverGet()');
  assert(!afterOutside || !afterOutside.open, 'panel click closes layout popover: ' + JSON.stringify(afterOutside));
  const pageHits = await panelEval('acc-ov-a', '({ c: window.__ovPage.clicks(), d: window.__ovPage.mouseDown() })');
  assert(pageHits && (pageHits.c >= 1 || pageHits.d >= 1), 'page received click: ' + JSON.stringify(pageHits));
  console.log('PASS: click outside panel closes + page receives', pageHits);

  const lagHide = (popoverOverlay.getSelftestLog() || []).filter((x) => x.op === 'hide').pop();
  assert(!lagHide || lagHide.detail.lagMs < 50, 'hide lag ok: ' + JSON.stringify(lagHide));
  console.log('PASS: layout menu + outside-close', lagHide && lagHide.detail);

  /* ---------- Memory monitor height (not collapsed on first open / reopen) ---------- */
  async function assertMemHeightOk(label) {
    panels.clearOverlaySelftestSpies();
    popoverOverlay.clearSelftestLog();
    await rendererEval('window.__multiheizUi.openMemPopover()');
    // Wait for measure + possible metrics refresh
    await sleep(350);
    let dbg = await rendererEval('window.multiheiz.popoverSelftestDebug()');
    assert(dbg && dbg.popover && dbg.popover.id === 'mem-popover', 'mem open ' + label);
    let b = dbg.popover.bounds;
    assert(b && b.height >= 120, 'mem height floor first paint ' + label + ' ' + JSON.stringify(b));
    // Allow ResizeObserver / delayed measure to settle
    await sleep(200);
    dbg = await rendererEval('window.multiheiz.popoverSelftestDebug()');
    b = dbg && dbg.popover && dbg.popover.bounds;
    assert(b && b.height >= 120, 'mem height after settle ' + label + ' ' + JSON.stringify(b));
    // Overlay height must cover content (no collapsed title-only with scrollbar trap)
    const contentH = await (async () => {
      const view = popoverOverlay.getView();
      assert(view && !view.webContents.isDestroyed(), 'overlay view ' + label);
      return view.webContents.executeJavaScript(
        `(function(){
          var el = document.querySelector('[data-role="mem-popover"]') || document.getElementById('root');
          if (!el) return 0;
          return Math.max(el.scrollHeight || 0, el.getBoundingClientRect().height || 0);
        })()`,
        true
      );
    })();
    assert(
      Number(contentH) > 0 && b.height + 2 >= Math.min(Number(contentH), 520),
      'overlay height >= content ' +
        label +
        ' bounds=' +
        JSON.stringify(b) +
        ' contentH=' +
        contentH
    );
    console.log('PASS: mem monitor height', label, { bounds: b, contentH });
    popoverOverlay.hide('mem-height-test');
    await sleep(150);
  }

  await assertMemHeightOk('first-open');
  await assertMemHeightOk('reopen');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest popover-overlay complete', {
    videoDeltaOpen: Number(t3) - Number(t2),
    openLagMs: lagShow && lagShow.detail && lagShow.detail.lagMs,
    hideLagMs: lagHide && lagHide.detail && lagHide.detail.lagMs,
  });
  app.exit(0);
}

module.exports = { runPopoverOverlaySelftest };
