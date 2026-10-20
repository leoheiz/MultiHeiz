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
