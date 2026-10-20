'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { envGet } = require('./config');

/**
 * Selftest for sidebar auto-hide (1.3.0).
 * Overlay strategy under test: shift-x / keep-width on WebContentsView (see panels.js).
 */
async function runSidebarSelftest(ctx) {
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

  const phase = String(envGet('MULTIHEIZ_SELFTEST_PHASE') || '1');
  console.log('SELFTEST sidebar phase=' + phase);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  if (phase === '2') {
    await runPhase2Persistence(ctx);
    return;
  }

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>sb</title></head>
<body style="margin:0;background:#1a2030;color:#eee;font:16px sans-serif;padding:24px">
<h1 id="t">sidebar</h1>
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
    s.workspaces = [{ id: 'ws-sb', name: 'Sidebar' }];
    s.activeWorkspaceId = 'ws-sb';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-sb',
        name: 'Painel SB',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-sb',
        muted: false,
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
  await waitForUrl('acc-sb', (u) => u.includes('127.0.0.1'), 30000);
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-sb' && p.visible && !p.parked));

  function panelBounds() {
    const info = panels.getPanelDebugInfo();
    const p = info.panels.find((x) => x.accountId === 'acc-sb');
    return { bounds: p && p.bounds, overlayW: info.sidebarOverlayWidth, lastSlots: info.lastSlots };
  }

  function near(a, b, tol = 3) {
    return Math.abs(a - b) <= tol;
  }

  /* ---------- Fixed mode (default) ---------- */
  let mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode || mode.autoHide !== false || mode.open !== false) {
    console.log('FAIL: start should be fixed (autoHide false)', mode);
    app.exit(1);
    return;
  }
  if (mode.toggleTitle !== 'Esconder automaticamente') {
    console.log('FAIL: fixed tooltip', mode.toggleTitle);
    app.exit(1);
    return;
  }
  const fixed = panelBounds();
  if (!fixed.bounds || fixed.overlayW !== 0) {
    console.log('FAIL: fixed bounds/overlay', fixed);
    app.exit(1);
    return;
  }
  if (!(fixed.bounds.x >= 160)) {
    console.log('FAIL: fixed panel x should start after sidebar', fixed.bounds);
    app.exit(1);
    return;
  }
  const fixedX = fixed.bounds.x;
  const fixedW = fixed.bounds.width;
  console.log('PASS: fixed mode', { mode, bounds: fixed.bounds });

  /* ---------- Toggle → auto-hide (hidden) ---------- */
  mode = await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.autoHide || mode.open) {
    console.log('FAIL: after toggle should be autoHide hidden', mode);
    app.exit(1);
    return;
  }
  if (mode.toggleTitle !== 'Fixar barra lateral') {
    console.log('FAIL: auto-hide tooltip', mode.toggleTitle);
    app.exit(1);
    return;
  }
  if (mode.hotzoneHidden || !(mode.hotzoneWidth >= 3 && mode.hotzoneWidth <= 8)) {
    console.log('FAIL: hotzone should be visible ~5px', mode);
    app.exit(1);
    return;
  }
  const hidden = panelBounds();
  if (hidden.overlayW !== 0) {
    console.log('FAIL: overlay width should be 0 when hidden', hidden);
    app.exit(1);
    return;
  }
  if (!(hidden.bounds.x <= 10) || !(hidden.bounds.width > fixedW)) {
    console.log('FAIL: auto-hidden panels should use nearly full width', {
      hidden: hidden.bounds,
      fixedX,
      fixedW,
    });
    app.exit(1);
    return;
  }
  const hiddenX = hidden.bounds.x;
  const hiddenW = hidden.bounds.width;
  console.log('PASS: auto-hide hidden + hotzone', { mode, bounds: hidden.bounds });

  /* ---------- Hot-zone show (simulate + delay) ---------- */
  await rendererEval('window.__multiheizUi.sidebarHotzoneEnter()');
  await sleep(80);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: should still be closed before show delay', mode);
    app.exit(1);
    return;
  }
  await sleep(120);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: hotzone should open after ~150ms', mode);
    app.exit(1);
    return;
  }
  const openB = panelBounds();
  if (!(openB.overlayW >= 200)) {
    console.log('FAIL: overlay width should match sidebar when open', openB);
    app.exit(1);
    return;
  }
  // Shift-x keep-width: visual x moves to overlayW; width stays ~hiddenW (may clip right)
  if (!near(openB.bounds.x, openB.overlayW, 4)) {
    console.log('FAIL: open bounds.x should equal overlay width (shift-x)', openB);
    app.exit(1);
    return;
  }
  if (!near(openB.bounds.width, hiddenW, 6)) {
    console.log('FAIL: open bounds.width should keep logical width (no reflow)', {
      open: openB.bounds,
      hiddenW,
    });
    app.exit(1);
    return;
  }
  const logical = openB.lastSlots && openB.lastSlots.find((s) => s.accountId === 'acc-sb');
  if (!logical || !near(logical.x, hiddenX, 4) || !near(logical.width, hiddenW, 6)) {
    console.log('FAIL: lastSlots should stay logical (unshifted)', { logical, hiddenX, hiddenW });
    app.exit(1);
    return;
  }
  console.log('PASS: hotzone reveal + shift-x overlay bounds', openB);

  /* ---------- Leave → hide (delay) ---------- */
  await rendererEval('window.__multiheizUi.sidebarMouseLeave()');
  await sleep(120);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.open) {
    console.log('FAIL: should still be open before hide delay', mode);
    app.exit(1);
    return;
  }
  await sleep(250);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: should hide after ~300ms leave', mode);
    app.exit(1);
    return;
  }
  const afterHide = panelBounds();
  if (afterHide.overlayW !== 0 || !near(afterHide.bounds.x, hiddenX, 4)) {
    console.log('FAIL: bounds after hide', afterHide);
    app.exit(1);
    return;
  }
  console.log('PASS: leave hides sidebar', afterHide.bounds);

  /* ---------- Toggle back to fixed ---------- */
  mode = await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(200);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.autoHide || mode.open || mode.toggleTitle !== 'Esconder automaticamente') {
    console.log('FAIL: should be fixed again', mode);
    app.exit(1);
    return;
  }
  const fixedAgain = panelBounds();
  if (fixedAgain.overlayW !== 0 || !(fixedAgain.bounds.x >= 160)) {
    console.log('FAIL: fixed again bounds', fixedAgain);
    app.exit(1);
    return;
  }
  console.log('PASS: toggle back to fixed');

  /* ---------- Persist auto-hide for phase 2 ---------- */
  await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(200);
  await waitForLayoutSettle();
  flushSave();
  const userData = app.getPath('userData');
  const statePath = path.join(userData, 'multiheiz-state.json');
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!raw.ui || raw.ui.sidebarAutoHide !== true) {
    console.log('FAIL: sidebarAutoHide not written to state file', raw.ui);
    app.exit(1);
    return;
  }
  console.log('PASS: sidebarAutoHide persisted to disk');

  /* ---------- Migration of legacy sidebarCollapsed ---------- */
  {
    const { migrate } = require('./state');
    const m = migrate({
      version: 1,
      workspaces: [{ id: 'ws-sb', name: 'Sidebar' }],
      activeWorkspaceId: 'ws-sb',
      accounts: [],
      layout: '1',
      page: 0,
      ui: { sidebarCollapsed: true, layoutLocked: true, sidebarWidth: 240 },
      settings: { migrations: { keepAlive120: true } },
      appearance: { preset: 'escuro' },
      freeTiles: {},
    });
    if (!(m.ui.sidebarAutoHide === true && m.ui.sidebarCollapsed === false)) {
      console.log('FAIL: migration sidebarCollapsed → sidebarAutoHide', m.ui);
      app.exit(1);
      return;
    }
    console.log('PASS: legacy sidebarCollapsed migrates to sidebarAutoHide');
  }

  /* ---------- F11: chrome hidden, no hotzone reveal ---------- */
  chromeFullscreen.enter();
  await sleep(500);
  await waitForLayoutSettle();
  await sleep(400);
  const vis = await rendererEval('window.__multiheizUi.getChromeVisibility()');
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!vis.chromeHidden || !mode.chromeHidden) {
    console.log('FAIL: F11 should hide chrome', { vis, mode });
    app.exit(1);
    return;
  }
  if (!mode.hotzoneHidden || mode.open) {
    console.log('FAIL: F11 should hide hotzone and keep sidebar closed', mode);
    app.exit(1);
    return;
  }
  await rendererEval('window.__multiheizUi.sidebarHotzoneEnter()');
  await sleep(250);
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.open) {
    console.log('FAIL: F11 hotzone must not reveal sidebar', mode);
    app.exit(1);
    return;
  }
  const fsBounds = panelBounds();
  if (fsBounds.overlayW !== 0) {
    console.log('FAIL: F11 overlay width must stay 0', fsBounds);
    app.exit(1);
    return;
  }
  console.log('PASS: F11 keeps sidebar fully hidden (no hotzone)');

  chromeFullscreen.exit();
  await sleep(400);
  await waitForLayoutSettle();

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('SELFTEST sidebar phase1 OK — exiting for restart persistence check');
  app.exit(0);
}

/**
 * Phase 2: app restarted with same userdata — auto-hide must still be on.
 */
async function runPhase2Persistence(ctx) {
  const { sleep, rendererEval, waitForLayoutSettle, flushSave, publicState } = ctx;
  await sleep(800);
  await waitForLayoutSettle();
  const st = publicState();
  if (!st.ui || st.ui.sidebarAutoHide !== true) {
    console.log('FAIL: phase2 publicState.sidebarAutoHide', st.ui);
    app.exit(1);
    return;
  }
  const mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.autoHide || mode.open) {
    console.log('FAIL: phase2 renderer mode', mode);
    app.exit(1);
    return;
  }
  if (mode.toggleTitle !== 'Fixar barra lateral') {
    console.log('FAIL: phase2 tooltip', mode.toggleTitle);
    app.exit(1);
    return;
  }
  flushSave();
  console.log('PASS: persistence after restart (sidebarAutoHide)');
  console.log('SELFTEST sidebar OK');
  app.exit(0);
}

module.exports = { runSidebarSelftest };
