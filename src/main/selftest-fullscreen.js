'use strict';

const http = require('node:http');
const { app, screen } = require('electron');

/**
 * Selftest for MultiHeiz 1.2.0 phase 6 — F11 fullscreen focus mode.
 * Also asserts Windows activation/z-order helpers after enter/leave.
 */
async function runFullscreenSelftest(ctx) {
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
    waitForLayoutSettle,
    waitForPanels,
    chromeFullscreen,
  } = ctx;

  console.log('SELFTEST fullscreen');
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>fs</title></head>
<body style="margin:0;background:#1a2030;color:#eee;font:16px sans-serif;padding:24px">
<h1 id="t">fullscreen</h1>
<div id="stage" style="width:320px;height:180px;background:#0a2030;position:relative">
<video id="v" width="320" height="180" autoplay muted loop playsinline style="display:block;width:100%;height:100%"></video>
<canvas id="c" width="320" height="180" style="display:none"></canvas>
</div>
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
  var stage = document.getElementById('stage');
  window.__fsVideo = {
    enter: function() {
      var el = stage;
      if (!el.requestFullscreen) return Promise.reject(new Error('no-requestFullscreen'));
      return el.requestFullscreen();
    },
    exit: function() {
      if (!document.fullscreenElement) return Promise.resolve();
      return document.exitFullscreen();
    },
    active: function() { return !!document.fullscreenElement; },
    elementId: function() {
      return document.fullscreenElement ? (document.fullscreenElement.id || document.fullscreenElement.tagName) : null;
    }
  };
})();
</script>
</body></html>`;

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-fs', name: 'Fullscreen' }];
    s.activeWorkspaceId = 'ws-fs';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-fs-a',
        name: 'Painel FS',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-fs',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: base + '/',
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();
  await waitForUrl('acc-fs-a', (u) => u.includes('127.0.0.1'), 30000);
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-fs-a' && p.visible && !p.parked));

  function contentSize() {
    const [width, height] = mainWindow.getContentSize();
    return { width, height };
  }

  function unionBounds(list) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of list) {
      if (!b || !(b.width > 0) || !(b.height > 0)) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function nearEdge(a, b, tol) {
    return Math.abs(a - b) <= tol;
  }

  function assertUnionFillsContent(label, tol = 2) {
    const content = contentSize();
    const info = panels.getPanelDebugInfo();
    const vis = info.panels.filter((p) => p.visible && !p.parked);
    const u = unionBounds(vis.map((p) => p.bounds));
    if (!u) {
      console.log('FAIL: no visible panel bounds', label, info);
      app.exit(1);
      return false;
    }
    const ok =
      nearEdge(u.x, 0, tol) &&
      nearEdge(u.y, 0, tol) &&
      nearEdge(u.x + u.width, content.width, tol) &&
      nearEdge(u.y + u.height, content.height, tol);
    if (!ok) {
      console.log('FAIL: union of panel bounds != content', label, { u, content, vis });
      app.exit(1);
      return false;
    }
    console.log('PASS: panel union fills content', label, { u, content });
    return true;
  }

  async function sendPanelKey(keyCode) {
    const wc = panels.getPanelCapture('acc-fs-a');
    if (!wc) {
      console.log('FAIL: no panel webContents for key', keyCode);
      app.exit(1);
      return;
    }
    try {
      wc.focus();
    } catch {
      /* ignore */
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    await sleep(400);
    await waitForLayoutSettle();
  }

  /* ---------- Enter via API ---------- */
  if (chromeFullscreen.isChromeHidden()) {
    console.log('FAIL: chromeHidden should start false');
    app.exit(1);
    return;
  }
  chromeFullscreen.enter();
  await sleep(500);
  await waitForLayoutSettle();
  // Wait past the temporary alwaysOnTop pin (~250ms) used to raise the window on Windows
  await sleep(400);

  if (!mainWindow.isFullScreen()) {
    console.log('FAIL: window should be fullScreen after enter');
    app.exit(1);
    return;
  }
  if (!chromeFullscreen.isChromeHidden()) {
    console.log('FAIL: chromeHidden flag false after enter');
    app.exit(1);
    return;
  }
  if (mainWindow.isAlwaysOnTop()) {
    console.log('FAIL: isAlwaysOnTop should be false after enter settle');
    app.exit(1);
    return;
  }
  if (mainWindow.isFocused()) {
    console.log('PASS: isFocused()==true after enter');
  } else {
    console.log(
      'WARN: isFocused()==false after enter (OS may deny focus in headless/offscreen selftest)'
    );
  }
  try {
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const wa = display.bounds;
    const covers =
      bounds.x <= wa.x + 2 &&
      bounds.y <= wa.y + 2 &&
      bounds.x + bounds.width >= wa.x + wa.width - 2 &&
      bounds.y + bounds.height >= wa.y + wa.height - 2;
    if (!covers) {
      console.log('FAIL: fullscreen bounds should cover display', { bounds, display: wa });
      app.exit(1);
      return;
    }
    console.log('PASS: fullscreen bounds cover display', { bounds, display: wa });
  } catch (err) {
    console.log('FAIL: display matching check', err && err.message ? err.message : err);
    app.exit(1);
    return;
  }
  console.log('PASS: enter activation — fullscreen, not alwaysOnTop');

  const visEnter = await rendererEval('window.__multiheizUi.getChromeVisibility()');
  if (!visEnter || !visEnter.chromeHidden) {
    console.log('FAIL: renderer is-chrome-hidden missing', visEnter);
    app.exit(1);
    return;
  }
  if (
    visEnter.topbar.display !== 'none' &&
    visEnter.topbar.offsetHeight !== 0
  ) {
    console.log('FAIL: topbar still visible', visEnter.topbar);
    app.exit(1);
    return;
  }
  // Sidebar uses edge-reveal overlay: may have non-zero width while translated off-screen.
  if (visEnter.sidebar && visEnter.sidebar.visuallyOpen) {
    console.log('FAIL: sidebar overlay should start closed in F11', visEnter.sidebar);
    app.exit(1);
    return;
  }
  const modeEnter = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!modeEnter || modeEnter.open || modeEnter.hotzoneHidden || !modeEnter.overlayMode) {
    console.log('FAIL: F11 should start closed with hotzone edge-reveal', modeEnter);
    app.exit(1);
    return;
  }
  console.log('PASS: enter mode — fullscreen + chrome hidden + edge-reveal ready');

  if (!assertUnionFillsContent('after-enter')) return;

  /* ---------- F11 edge-reveal (cursor override, no real mouse) ---------- */
  const sidebarCursor = ctx.sidebarCursor;
  if (!sidebarCursor || typeof sidebarCursor.setCursorOverride !== 'function') {
    console.log('FAIL: sidebarCursor hooks missing for F11 edge-reveal');
    app.exit(1);
    return;
  }
  const midY = Math.round((mainWindow.getContentSize()[1] || 900) / 2);
  function setCursorContent(cx, cy) {
    const pt = sidebarCursor.contentPointToScreen(cx, cy);
    if (!pt) throw new Error('contentPointToScreen failed');
    sidebarCursor.setCursorOverride(pt);
  }
  function panelFsBounds() {
    const info = panels.getPanelDebugInfo();
    const p = info.panels.find((x) => x.accountId === 'acc-fs-a');
    return { bounds: p && p.bounds, overlayW: info.sidebarOverlayWidth };
  }
  function near(a, b, tol = 4) {
    return Math.abs(a - b) <= tol;
  }

  setCursorContent(400, midY);
  await sleep(100);
  setCursorContent(5, midY);
  await sleep(280);
  await waitForLayoutSettle();
  let modeFs = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!modeFs.open) {
    console.log('FAIL: F11 cursor edge should reveal sidebar', modeFs);
    app.exit(1);
    return;
  }
  let openFs = panelFsBounds();
  if (!(openFs.overlayW >= 200) || !near(openFs.bounds.x, openFs.overlayW, 4)) {
    console.log('FAIL: F11 reveal should shift panels left of overlay', openFs);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 edge reveal + panel shift-x', openFs);

  setCursorContent(500, midY);
  await sleep(900);
  await waitForLayoutSettle();
  modeFs = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (modeFs.open) {
    console.log('FAIL: F11 should hide after cursor leave', modeFs);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 leave hides sidebar');

  setCursorContent(5, midY);
  await sleep(280);
  await waitForLayoutSettle();
  await rendererEval('window.__multiheizUi.clickSidebarPinButton()');
  await sleep(150);
  modeFs = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!modeFs.fsPinned || !modeFs.open) {
    console.log('FAIL: F11 pin should keep overlay open', modeFs);
    app.exit(1);
    return;
  }
  setCursorContent(500, midY);
  await sleep(900);
  modeFs = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!modeFs.open || !modeFs.fsPinned) {
    console.log('FAIL: F11 pinned must stay open with cursor away', modeFs);
    app.exit(1);
    return;
  }
  await rendererEval('window.__multiheizUi.clickSidebarPinButton()');
  await sleep(150);
  modeFs = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (modeFs.fsPinned || modeFs.open) {
    console.log('FAIL: F11 unpin should close', modeFs);
    app.exit(1);
    return;
  }
  sidebarCursor.setCursorOverride(null);
  console.log('PASS: F11 temporary pin / unpin');

  /* ---------- Workspace switch keeps mode ---------- */
  updateState((s) => {
    s.workspaces.push({ id: 'ws-fs-b', name: 'Outro' });
    s.accounts.push({
      id: 'acc-fs-b',
      name: 'Painel B',
      color: '#e25c5c',
      startUrl: base + '/',
      workspaceId: 'ws-fs-b',
      muted: false,
      lastUrl: null,
      zoomFactor: 1,
    });
    s.activeWorkspaceId = 'ws-fs-b';
  });
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(500);
  await waitForLayoutSettle();
  if (!chromeFullscreen.isChromeHidden() || !mainWindow.isFullScreen()) {
    console.log('FAIL: mode lost on workspace switch');
    app.exit(1);
    return;
  }
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-fs-b' && p.visible && !p.parked));
  if (!assertUnionFillsContent('after-ws-switch')) return;
  console.log('PASS: workspace switch keeps chrome-hidden mode');

  // Back to first workspace for Esc / F11 on panel A
  updateState((s) => {
    s.activeWorkspaceId = 'ws-fs';
  });
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-fs-a' && p.visible && !p.parked));

  /* ---------- Esc via panel input ---------- */
  await sendPanelKey('Esc');
  if (chromeFullscreen.isChromeHidden() || mainWindow.isFullScreen()) {
    console.log('FAIL: Esc should exit mode', {
      chromeHidden: chromeFullscreen.isChromeHidden(),
      isFullScreen: mainWindow.isFullScreen(),
    });
    app.exit(1);
    return;
  }
  const visExit = await rendererEval('window.__multiheizUi.getChromeVisibility()');
  if (visExit && visExit.chromeHidden) {
    console.log('FAIL: renderer still chrome-hidden after Esc', visExit);
    app.exit(1);
    return;
  }
  if (!visExit || visExit.topbar.offsetHeight < 40) {
    console.log('FAIL: topbar not restored after Esc', visExit);
    app.exit(1);
    return;
  }
  console.log('PASS: Esc via panel exits mode and restores chrome');

  /* ---------- F11 via panel input ---------- */
  panels.setFocusedAccount('acc-fs-a');
  try {
    const wc = panels.getPanelCapture('acc-fs-a');
    if (wc) wc.focus();
  } catch {
    /* ignore */
  }
  await sendPanelKey('F11');
  if (!chromeFullscreen.isChromeHidden() || !mainWindow.isFullScreen()) {
    console.log('FAIL: F11 via panel should enter mode', chromeFullscreen.getDebugState());
    app.exit(1);
    return;
  }
  await waitForLayoutSettle();
  await sleep(400);
  if (mainWindow.isAlwaysOnTop()) {
    console.log('FAIL: isAlwaysOnTop should be false after F11 panel enter settle');
    app.exit(1);
    return;
  }
  if (!assertUnionFillsContent('after-f11')) return;
  console.log('PASS: F11 via panel enters mode (not alwaysOnTop)');

  await sendPanelKey('F11');
  await sleep(400);
  if (chromeFullscreen.isChromeHidden() || mainWindow.isFullScreen()) {
    console.log('FAIL: F11 again should exit', {
      chromeHidden: chromeFullscreen.isChromeHidden(),
      isFullScreen: mainWindow.isFullScreen(),
    });
    app.exit(1);
    return;
  }
  if (mainWindow.isAlwaysOnTop()) {
    console.log('FAIL: isAlwaysOnTop should be false after F11 exit');
    app.exit(1);
    return;
  }
  console.log('PASS: F11 again exits mode');

  /* ---------- leave-full-screen clears mode ---------- */
  chromeFullscreen.enter();
  await sleep(400);
  if (!chromeFullscreen.isChromeHidden()) {
    console.log('FAIL: re-enter before leave-full-screen check');
    app.exit(1);
    return;
  }
  mainWindow.setFullScreen(false);
  await sleep(500);
  await waitForLayoutSettle();
  if (chromeFullscreen.isChromeHidden()) {
    console.log('FAIL: leave-full-screen should clear chromeHidden');
    app.exit(1);
    return;
  }
  if (mainWindow.isAlwaysOnTop()) {
    console.log('FAIL: isAlwaysOnTop should be false after leave-full-screen');
    app.exit(1);
    return;
  }
  console.log('PASS: leave-full-screen clears chrome-hidden');

  /* ---------- HTML5 element fullscreen (synthetic local video) ---------- */
  async function panelEval(code) {
    const wc = panels.getPanelCapture('acc-fs-a');
    if (!wc) {
      console.log('FAIL: no panel webContents for eval');
      app.exit(1);
      return null;
    }
    return wc.executeJavaScript(code, true);
  }

  async function waitFs(want, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const active = await panelEval('window.__fsVideo && window.__fsVideo.active()');
      if (!!active === !!want) return true;
      await sleep(80);
    }
    return false;
  }

  function panelBoundsA() {
    const info = panels.getPanelDebugInfo();
    const p = info.panels.find((x) => x.accountId === 'acc-fs-a');
    return {
      bounds: p && p.bounds,
      htmlFsId: info.htmlFullscreenAccountId,
      content: contentSize(),
    };
  }

  function assertPanelFillsContent(label, tol = 4) {
    const snap = panelBoundsA();
    const b = snap.bounds;
    const c = snap.content;
    if (!b || !c) {
      console.log('FAIL: missing bounds', label, snap);
      app.exit(1);
      return false;
    }
    const ok =
      nearEdge(b.x, 0, tol) &&
      nearEdge(b.y, 0, tol) &&
      nearEdge(b.width, c.width, tol) &&
      nearEdge(b.height, c.height, tol);
    if (!ok) {
      console.log('FAIL: HTML5 FS panel should fill content', label, snap);
      app.exit(1);
      return false;
    }
    if (snap.htmlFsId !== 'acc-fs-a') {
      console.log('FAIL: htmlFullscreenAccountId', label, snap.htmlFsId);
      app.exit(1);
      return false;
    }
    console.log('PASS: HTML5 FS panel fills content', label, snap.bounds);
    return true;
  }

  // Ensure windowed (not F11) before scenario 1
  if (chromeFullscreen.isChromeHidden() || mainWindow.isFullScreen()) {
    chromeFullscreen.exit();
    await sleep(500);
    await waitForLayoutSettle();
  }
  const windowedBefore = {
    chromeHidden: chromeFullscreen.isChromeHidden(),
    isFullScreen: mainWindow.isFullScreen(),
  };
  const windowedBounds = panelBoundsA().bounds;

  // (1) element fullscreen while app windowed → exit → re-enter
  {
    const okEnter = await panelEval(
      'window.__fsVideo.enter().then(function(){return true}).catch(function(e){return String(e && e.message || e)})'
    );
    if (okEnter !== true) {
      console.log('FAIL: requestFullscreen while windowed', okEnter);
      app.exit(1);
      return;
    }
    if (!(await waitFs(true))) {
      console.log('FAIL: document.fullscreenElement not set (windowed)');
      app.exit(1);
      return;
    }
    await sleep(300);
    await waitForLayoutSettle();
    if (!assertPanelFillsContent('windowed-enter')) return;

    await panelEval('window.__fsVideo.exit()');
    if (!(await waitFs(false))) {
      console.log('FAIL: exitFullscreen did not clear fullscreenElement');
      app.exit(1);
      return;
    }
    await sleep(400);
    await waitForLayoutSettle();
    if (chromeFullscreen.isChromeHidden() !== windowedBefore.chromeHidden) {
      console.log('FAIL: chromeHidden changed after HTML5 exit (windowed)', {
        before: windowedBefore,
        after: chromeFullscreen.getDebugState(),
      });
      app.exit(1);
      return;
    }
    const afterExit = panelBoundsA();
    if (afterExit.htmlFsId) {
      console.log('FAIL: htmlFullscreenAccountId stuck after exit', afterExit);
      app.exit(1);
      return;
    }
    if (
      windowedBounds &&
      afterExit.bounds &&
      (!nearEdge(afterExit.bounds.x, windowedBounds.x, 6) ||
        !nearEdge(afterExit.bounds.y, windowedBounds.y, 6) ||
        !nearEdge(afterExit.bounds.width, windowedBounds.width, 12) ||
        !nearEdge(afterExit.bounds.height, windowedBounds.height, 12))
    ) {
      console.log('FAIL: layout not restored after HTML5 exit', {
        windowedBounds,
        after: afterExit.bounds,
      });
      app.exit(1);
      return;
    }

    const okRe = await panelEval(
      'window.__fsVideo.enter().then(function(){return true}).catch(function(e){return String(e && e.message || e)})'
    );
    if (okRe !== true) {
      console.log('FAIL: requestFullscreen again after exit', okRe);
      app.exit(1);
      return;
    }
    if (!(await waitFs(true))) {
      console.log('FAIL: re-enter fullscreenElement');
      app.exit(1);
      return;
    }
    await sleep(200);
    if (!assertPanelFillsContent('windowed-reenter')) return;
    await panelEval('window.__fsVideo.exit()');
    await waitFs(false);
    await sleep(300);
    console.log('PASS: HTML5 FS windowed enter/exit/re-enter');
  }

  // (2) element fullscreen while app in F11
  chromeFullscreen.enter();
  await sleep(500);
  await waitForLayoutSettle();
  await sleep(400);
  if (!chromeFullscreen.isChromeHidden() || !mainWindow.isFullScreen()) {
    console.log('FAIL: need F11 before HTML5-in-F11');
    app.exit(1);
    return;
  }
  {
    const okEnter = await panelEval(
      'window.__fsVideo.enter().then(function(){return true}).catch(function(e){return String(e && e.message || e)})'
    );
    if (okEnter !== true) {
      console.log('FAIL: requestFullscreen in F11', okEnter);
      app.exit(1);
      return;
    }
    if (!(await waitFs(true))) {
      console.log('FAIL: fullscreenElement in F11');
      app.exit(1);
      return;
    }
    await sleep(300);
    if (!assertPanelFillsContent('f11-enter')) return;

    await panelEval('window.__fsVideo.exit()');
    if (!(await waitFs(false))) {
      console.log('FAIL: exit HTML5 in F11');
      app.exit(1);
      return;
    }
    await sleep(600);
    await waitForLayoutSettle();
    if (!chromeFullscreen.isChromeHidden()) {
      console.log('FAIL: F11 chromeHidden lost after HTML5 exit', chromeFullscreen.getDebugState());
      app.exit(1);
      return;
    }
    // OS FS should be restored (may take a moment after Electron churn)
    const tFs = Date.now();
    while (!mainWindow.isFullScreen() && Date.now() - tFs < 2000) {
      await sleep(100);
    }
    if (!mainWindow.isFullScreen()) {
      console.log('FAIL: OS fullscreen not restored after HTML5 exit in F11');
      app.exit(1);
      return;
    }
    if (!assertUnionFillsContent('after-html5-exit-in-f11')) return;
    console.log('PASS: HTML5 FS inside F11 restores F11');
  }

  // (3) F11 toggled while element fullscreen — leave keys to the page (no chrome steal)
  {
    const okEnter = await panelEval(
      'window.__fsVideo.enter().then(function(){return true}).catch(function(e){return String(e && e.message || e)})'
    );
    if (okEnter !== true || !(await waitFs(true))) {
      console.log('FAIL: enter HTML5 before F11-key test', okEnter);
      app.exit(1);
      return;
    }
    await sleep(200);
    const beforeKey = {
      chromeHidden: chromeFullscreen.isChromeHidden(),
      isFullScreen: mainWindow.isFullScreen(),
    };
    await sendPanelKey('F11');
    await sleep(500);
    const stillHtml = await panelEval('window.__fsVideo.active()');
    const afterKey = chromeFullscreen.getDebugState();
    // Page may exit element FS on F11; our chrome must not end up cleared without restore.
    if (stillHtml) {
      if (!afterKey.chromeHidden) {
        console.log('FAIL: F11 cleared chrome while HTML5 FS still active', {
          beforeKey,
          afterKey,
          stillHtml,
        });
        app.exit(1);
        return;
      }
    } else {
      // Element FS exited — F11 chrome mode should remain (or be reasserted).
      const t0 = Date.now();
      while (!chromeFullscreen.isChromeHidden() && Date.now() - t0 < 2000) {
        await sleep(100);
      }
      if (!chromeFullscreen.isChromeHidden()) {
        console.log('FAIL: F11 during HTML5 left chromeHidden false after element exit', {
          beforeKey,
          afterKey: chromeFullscreen.getDebugState(),
        });
        app.exit(1);
        return;
      }
      const t1 = Date.now();
      while (!mainWindow.isFullScreen() && Date.now() - t1 < 2000) {
        await sleep(100);
      }
      if (!mainWindow.isFullScreen()) {
        console.log('FAIL: OS FS not restored after F11+HTML5 exit');
        app.exit(1);
        return;
      }
    }
    console.log('PASS: F11 while HTML5 FS (chrome preserved / restored)', {
      stillHtml,
      chromeHidden: chromeFullscreen.isChromeHidden(),
      isFullScreen: mainWindow.isFullScreen(),
    });
    if (stillHtml) {
      await panelEval('window.__fsVideo.exit()');
      await waitFs(false);
      await sleep(500);
    }
  }

  // (4) Esc paths: Esc exits HTML5 first; then Esc exits F11
  if (!chromeFullscreen.isChromeHidden()) {
    chromeFullscreen.enter();
    await sleep(500);
  }
  {
    const okEnter = await panelEval(
      'window.__fsVideo.enter().then(function(){return true}).catch(function(e){return String(e && e.message || e)})'
    );
    if (okEnter !== true || !(await waitFs(true))) {
      console.log('FAIL: enter HTML5 for Esc path', okEnter);
      app.exit(1);
      return;
    }
    await sendPanelKey('Esc');
    if (!(await waitFs(false, 3000))) {
      // Esc may be consumed by page; force exit then verify F11 still on
      await panelEval('window.__fsVideo.exit()');
      await waitFs(false);
    }
    await sleep(500);
    if (!chromeFullscreen.isChromeHidden()) {
      console.log('FAIL: Esc should exit HTML5 first and keep F11', chromeFullscreen.getDebugState());
      app.exit(1);
      return;
    }
    await sendPanelKey('Esc');
    await sleep(400);
    if (chromeFullscreen.isChromeHidden() || mainWindow.isFullScreen()) {
      console.log('FAIL: second Esc should exit F11', {
        chromeHidden: chromeFullscreen.isChromeHidden(),
        isFullScreen: mainWindow.isFullScreen(),
      });
      app.exit(1);
      return;
    }
    console.log('PASS: Esc exits HTML5 then F11');
  }

  /* ---------- F11 topbar edge-reveal (setting ON by default) ---------- */
  {
    let mode = await rendererEval('window.__multiheizUi.getTopbarRevealMode()');
    if (!mode || mode.setting !== true) {
      console.log('FAIL: fullscreenTopbarReveal should default ON', mode);
      app.exit(1);
      return;
    }
    const sidebarCursor = ctx.sidebarCursor;
    function setCursorContent(cx, cy) {
      const pt = sidebarCursor.contentPointToScreen(cx, cy);
      if (!pt) throw new Error('contentPointToScreen failed');
      sidebarCursor.setCursorOverride(pt);
    }

    // Prove OFF still keeps topbar hidden
    await rendererEval('window.__multiheizUi.setFullscreenTopbarReveal(false)');
    chromeFullscreen.enter();
    await sleep(500);
    await waitForLayoutSettle();
    setCursorContent(200, 3);
    await sleep(400);
    mode = await rendererEval('window.__multiheizUi.getTopbarRevealMode()');
    if (mode.open) {
      console.log('FAIL: topbar must not reveal when setting OFF', mode);
      app.exit(1);
      return;
    }
    console.log('PASS: topbar reveal stays OFF when setting disabled');

    mode = await rendererEval('window.__multiheizUi.setFullscreenTopbarReveal(true)');
    if (!mode || !mode.setting || !mode.active) {
      console.log('FAIL: enable fullscreenTopbarReveal', mode);
      app.exit(1);
      return;
    }
    setCursorContent(400, 200);
    await sleep(100);
    setCursorContent(200, 3);
    await sleep(280);
    await waitForLayoutSettle();
    mode = await rendererEval('window.__multiheizUi.getTopbarRevealMode()');
    const visOn = await rendererEval('window.__multiheizUi.getChromeVisibility()');
    if (!mode.open || !visOn.topbar.revealOpen || visOn.topbar.offsetHeight < 40) {
      console.log('FAIL: top edge should reveal topbar', { mode, visOn });
      app.exit(1);
      return;
    }
    const openTop = panels.getPanelDebugInfo();
    if (!(openTop.topbarOverlayHeight >= 40)) {
      console.log('FAIL: topbar overlay inset missing', openTop.topbarOverlayHeight);
      app.exit(1);
      return;
    }
    console.log('PASS: topbar edge reveal when setting ON', {
      overlayH: openTop.topbarOverlayHeight,
    });

    // HTML5 video fullscreen must inset under revealed topbar
    try {
      await panels.getPanelCapture('acc-fs-a').executeJavaScript(
        'window.__fsVideo && window.__fsVideo.enter()',
        true
      );
    } catch (err) {
      console.log('FAIL: enter HTML5 fullscreen', err && err.message);
      app.exit(1);
      return;
    }
    await sleep(600);
    await waitForLayoutSettle();
    setCursorContent(200, 3);
    await sleep(300);
    await waitForLayoutSettle();
    const htmlInfo = panels.getPanelDebugInfo();
    const htmlPanel = (htmlInfo.panels || []).find((p) => p.accountId === 'acc-fs-a');
    const overlayH = htmlInfo.topbarOverlayHeight || 0;
    if (!(overlayH >= 40) || !htmlPanel || !(htmlPanel.bounds && htmlPanel.bounds.y >= overlayH - 2)) {
      console.log('FAIL: HTML5 FS panel must sit below topbar overlay', {
        overlayH,
        bounds: htmlPanel && htmlPanel.bounds,
      });
      app.exit(1);
      return;
    }
    console.log('PASS: HTML5 FS respects topbar overlay inset', {
      overlayH,
      y: htmlPanel.bounds.y,
    });
    try {
      await panels.getPanelCapture('acc-fs-a').executeJavaScript(
        'window.__fsVideo && window.__fsVideo.exit()',
        true
      );
    } catch {
      /* ignore */
    }
    await sleep(400);

    setCursorContent(400, 400);
    await sleep(900);
    await waitForLayoutSettle();
    mode = await rendererEval('window.__multiheizUi.getTopbarRevealMode()');
    if (mode.open) {
      console.log('FAIL: topbar should hide after leave (~700ms)', mode);
      app.exit(1);
      return;
    }
    sidebarCursor.setCursorOverride(null);
    chromeFullscreen.exit();
    await sleep(400);
    console.log('PASS: topbar hide after cursor leave');
  }

  try {
    server.close();
  } catch {
    /* ignore */
  }
  chromeFullscreen.destroyHint();
  chromeFullscreen.ensureNotAlwaysOnTop();
  console.log('PASS: selftest:fullscreen complete');
  app.exit(0);
}

module.exports = { runFullscreenSelftest };
