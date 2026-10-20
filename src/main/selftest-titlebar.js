'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app } = require('electron');

/**
 * Offline selftest for v1.9 Phase 1b — custom title bar merged with workspace tabs.
 */
async function runTitlebarSelftest(ctx) {
  const {
    mainWindow,
    panels,
    getState,
    updateState,
    sleep,
    waitForUrl,
    rendererEval,
    compositeWindowShot,
    waitForLayoutSettle,
    publicState,
    emitToRenderer,
    recordedWindowChrome,
    lastTitleBarOverlay,
    applyTitleBarOverlay,
  } = ctx;

  console.log('SELFTEST titlebar (phase 1b)');
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  let server = null;
  let port = 0;

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>tb</title></head>
<body style="margin:0;background:#222;color:#eee;font:16px sans-serif;padding:24px">
<h1>titlebar</h1>
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
    s.accounts = [];
    s.workspaces = [
      { id: 'ws-tb', name: 'Principal' },
      { id: 'ws-tb-2', name: 'teste' },
    ];
    s.activeWorkspaceId = 'ws-tb';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.ui = { ...(s.ui || {}), sidebarCollapsed: false, layoutLocked: true, sidebarWidth: 240 };
    s.appearance = {
      preset: 'escuro',
      accent: '#2bb8a6',
      background: '#14181f',
      surface: '#1e2430',
      text: '#e6ebea',
      panelHeader: '#243040',
      sidebar: '#181c24',
    };
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: base + '/',
      modules: { planilha: true, alarmes: true, notas: true },
    };
  });

  updateState((s) => {
    s.accounts.push(
      {
        id: 'acc-tb-a',
        name: 'Janela A',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-tb',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-tb-b',
        name: 'Janela B',
        color: '#e25c5c',
        startUrl: base + '/',
        workspaceId: 'ws-tb',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      }
    );
  });

  if (emitToRenderer) emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(700);
  await waitForLayoutSettle();

  panels.createPanel('acc-tb-a');
  panels.createPanel('acc-tb-b');
  await sleep(400);

  const [cw0, ch0] = mainWindow.getContentSize();
  panels.syncVisiblePanels([
    { accountId: 'acc-tb-a', x: 240, y: 48, width: Math.floor((cw0 - 240) / 2), height: ch0 - 76 },
    {
      accountId: 'acc-tb-b',
      x: 240 + Math.floor((cw0 - 240) / 2),
      y: 48,
      width: Math.floor((cw0 - 240) / 2),
      height: ch0 - 76,
    },
  ]);
  await sleep(500);
  await waitForUrl('acc-tb-a', (u) => u.includes('127.0.0.1'), 20000);
  await waitForUrl('acc-tb-b', (u) => u.includes('127.0.0.1'), 20000);
  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
  );
  await sleep(200);

  const scale = Number(process.env.MULTIHEIZ_UI_SCALE || '1') || 1;
  const shotDir = path.join(__dirname, '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });

  /* ---------- 1. Window chrome options ---------- */
  const chrome = typeof recordedWindowChrome === 'function' ? recordedWindowChrome() : recordedWindowChrome;
  if (!chrome) {
    console.log('FAIL: no recorded window chrome');
    app.exit(1);
    return;
  }
  if (!mainWindow.isMaximizable()) {
    console.log('FAIL: window should be maximizable');
    app.exit(1);
    return;
  }
  if (process.platform === 'win32') {
    if (chrome.titleBarStyle !== 'hidden') {
      console.log('FAIL: expected titleBarStyle hidden on Windows', chrome);
      app.exit(1);
      return;
    }
    if (!chrome.titleBarOverlay || chrome.titleBarOverlay.height !== 48) {
      console.log('FAIL: expected titleBarOverlay height 48', chrome.titleBarOverlay);
      app.exit(1);
      return;
    }
  } else {
    if (chrome.frame !== false) {
      console.log('FAIL: expected frame:false on non-Windows', chrome);
      app.exit(1);
      return;
    }
  }
  if (chrome.topbarHeight !== 48 || chrome.fullscreenKeepsRow !== false) {
    console.log('FAIL: chrome policy mismatch', chrome);
    app.exit(1);
    return;
  }
  console.log('PASS: window chrome options', {
    platform: chrome.platform,
    titleBarStyle: chrome.titleBarStyle,
    frame: chrome.frame,
  });

  /* ---------- 2. Top row height + drag regions ---------- */
  const metrics = await rendererEval('window.__multiheizUi.getTitlebarMetrics()');
  if (!metrics) {
    console.log('FAIL: no titlebar metrics');
    app.exit(1);
    return;
  }
  if (Math.abs(metrics.height - 48) > 2) {
    console.log('FAIL: top row height', metrics.height);
    app.exit(1);
    return;
  }
  if (!metrics.hasAppIcon) {
    console.log('FAIL: app icon missing in topbar');
    app.exit(1);
    return;
  }
  if (metrics.appRegion !== 'drag') {
    console.log('FAIL: expected app-region drag on #topbar', metrics);
    app.exit(1);
    return;
  }
  if (metrics.spacerRegion && metrics.spacerRegion !== 'drag') {
    console.log('FAIL: expected drag region on .spacer', metrics.spacerRegion);
    app.exit(1);
    return;
  }
  if (metrics.tabRegion && metrics.tabRegion !== 'no-drag') {
    console.log('FAIL: tabs should be no-drag', metrics.tabRegion);
    app.exit(1);
    return;
  }
  if (metrics.settingsBtnRegion && metrics.settingsBtnRegion !== 'no-drag') {
    console.log('FAIL: settings button should be no-drag', metrics.settingsBtnRegion);
    app.exit(1);
    return;
  }
  if (process.platform === 'win32') {
    // Overlay buttons reserve padding (or WCO visible)
    const wcoVisible = metrics.wco && metrics.wco.visible;
    if (!wcoVisible && metrics.paddingRight < 8) {
      console.log('WARN: WCO padding small (may be env fallback lag)', metrics.paddingRight);
    }
    if (metrics.winControlsVisible) {
      console.log('FAIL: HTML win-controls should be hidden on Windows overlay');
      app.exit(1);
      return;
    }
  } else if (!metrics.winControlsVisible) {
    console.log('FAIL: HTML win-controls should be visible when frameless');
    app.exit(1);
    return;
  }
  console.log('PASS: top row + drag regions', {
    height: metrics.height,
    appRegion: metrics.appRegion,
    tabRegion: metrics.tabRegion,
    padRight: metrics.paddingRight,
  });

  /* ---------- 3. Panel top == row bottom at scales ---------- */
  try {
    mainWindow.setContentSize(1400, 900);
  } catch {
    mainWindow.setSize(1400, 900);
  }
  await sleep(300);
  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
  );
  await waitForLayoutSettle();

  const align = await rendererEval('window.__multiheizUi.getPanelTopVsRow()');
  // #grid top must sit on the title-row bottom (±1px). Panel slots may have a small CSS gap.
  const gridDelta = align ? (typeof align.gridDelta === 'number' ? align.gridDelta : align.delta) : 99;
  if (!align || gridDelta > 1) {
    console.log('FAIL: panel/grid top vs row bottom', align, 'scale', scale);
    app.exit(1);
    return;
  }
  // Native WebContentsView must not draw above the title row
  const info = panels.getPanelDebugInfo();
  const rowBottom = align.barBottom;
  for (const p of info.panels || []) {
    if (!p.visible || p.parked || !p.bounds) continue;
    if (p.bounds.y < rowBottom - 2) {
      console.log('FAIL: panel view above title row', { bounds: p.bounds, rowBottom, scale });
      app.exit(1);
      return;
    }
  }
  console.log('PASS: panel top aligned under title row', { gridDelta, slotDelta: align.delta, scale });

  /* ---------- 4. Maximize / restore via IPC ---------- */
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    await sleep(250);
  }
  const toggleRes = await rendererEval(`
    (async function(){
      return await window.multiheiz.windowToggleMaximize();
    })()
  `);
  await sleep(400);
  if (!toggleRes || !toggleRes.ok || !mainWindow.isMaximized()) {
    console.log('FAIL: windowToggleMaximize did not maximize', toggleRes, mainWindow.isMaximized());
    app.exit(1);
    return;
  }
  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
  );
  await waitForLayoutSettle();
  const alignMax = await rendererEval('window.__multiheizUi.getPanelTopVsRow()');
  const gridDeltaMax = alignMax
    ? typeof alignMax.gridDelta === 'number'
      ? alignMax.gridDelta
      : alignMax.delta
    : 99;
  if (!alignMax || gridDeltaMax > 1.5) {
    console.log('FAIL: panel alignment after maximize', alignMax);
    app.exit(1);
    return;
  }
  const restoreRes = await rendererEval(`
    (async function(){
      return await window.multiheiz.windowToggleMaximize();
    })()
  `);
  await sleep(400);
  if (!restoreRes || !restoreRes.ok || mainWindow.isMaximized()) {
    console.log('FAIL: windowToggleMaximize did not restore', restoreRes, mainWindow.isMaximized());
    app.exit(1);
    return;
  }
  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
  );
  await waitForLayoutSettle();
  const alignRest = await rendererEval('window.__multiheizUi.getPanelTopVsRow()');
  const gridDeltaRest = alignRest
    ? typeof alignRest.gridDelta === 'number'
      ? alignRest.gridDelta
      : alignRest.delta
    : 99;
  if (!alignRest || gridDeltaRest > 1.5) {
    console.log('FAIL: panel alignment after restore', alignRest);
    app.exit(1);
    return;
  }
  console.log('PASS: maximize/restore keeps panels below row');

  /* ---------- 5. Theme updates overlay colors ---------- */
  const darkOverlay =
    typeof lastTitleBarOverlay === 'function' ? lastTitleBarOverlay() : lastTitleBarOverlay;
  await rendererEval(`window.__multiheizUi.applyThemePreset('claro')`);
  await sleep(200);
  let lightOverlay =
    typeof lastTitleBarOverlay === 'function' ? lastTitleBarOverlay() : lastTitleBarOverlay;
  if (typeof applyTitleBarOverlay === 'function') {
    const st = getState();
    lightOverlay = applyTitleBarOverlay(st.appearance) || lightOverlay;
  }
  if (process.platform === 'win32') {
    if (!lightOverlay || !lightOverlay.color) {
      console.log('FAIL: no overlay after light theme', lightOverlay);
      app.exit(1);
      return;
    }
    const darkColor = (darkOverlay && darkOverlay.color) || '#1e2430';
    if (String(lightOverlay.color).toLowerCase() === String(darkColor).toLowerCase()) {
      // claro surface is #ffffff — should differ from escuro #1e2430
      console.log('FAIL: overlay color did not change with theme', {
        dark: darkOverlay,
        light: lightOverlay,
      });
      app.exit(1);
      return;
    }
    if (!/#fff|#ffffff/i.test(String(lightOverlay.color)) && lightOverlay.color !== '#ffffff') {
      // accept any change away from dark; claro uses #ffffff
      const st = getState();
      if (st.appearance && st.appearance.preset === 'claro' && lightOverlay.color !== st.appearance.surface) {
        console.log('FAIL: overlay color != appearance.surface', lightOverlay, st.appearance);
        app.exit(1);
        return;
      }
    }
  }
  console.log('PASS: theme change updates overlay', {
    platform: process.platform,
    light: lightOverlay,
  });

  /* ---------- 6. Screenshots dark + light (scale 1 only writes canonical names) ---------- */
  await rendererEval(`window.__multiheizUi.applyThemePreset('escuro')`);
  await sleep(250);
  await waitForLayoutSettle();
  if (scale === 1) {
    await compositeWindowShot(path.join(shotDir, 'v1.9-titlebar-dark.png'));
  } else {
    await compositeWindowShot(
      path.join(shotDir, `v1.9-titlebar-dark-scale${String(scale).replace('.', '_')}.png`)
    );
  }

  await rendererEval(`window.__multiheizUi.applyThemePreset('claro')`);
  await sleep(250);
  await waitForLayoutSettle();
  if (scale === 1) {
    await compositeWindowShot(path.join(shotDir, 'v1.9-titlebar-light.png'));
  } else {
    await compositeWindowShot(
      path.join(shotDir, `v1.9-titlebar-light-scale${String(scale).replace('.', '_')}.png`)
    );
  }
  console.log('PASS: titlebar screenshots written');

  if (server) server.close();
  console.log('PASS: titlebar phase 1b selftest complete');
  app.exit(0);
}

module.exports = { runTitlebarSelftest };
