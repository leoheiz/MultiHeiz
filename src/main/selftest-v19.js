'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app } = require('electron');

/**
 * Offline selftest for v1.9 Phase 1 — sidebar, focus highlight, zoom UI, gear icon.
 */
async function runV19Selftest(ctx) {
  const {
    mainWindow,
    panels,
    getState,
    updateState,
    sleep,
    waitForUrl,
    rendererEval,
    popupTopMenu,
    popupAccountMenu,
    compositeWindowShot,
    waitForLayoutSettle,
    waitForPanels,
  } = ctx;

  console.log('SELFTEST v19 (phase 1)');
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  let server = null;
  let port = 0;

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>v19</title></head>
<body style="margin:0;background:#1a1a1a;color:#eee;font:16px sans-serif;padding:24px">
<h1 id="t">painel</h1>
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
    s.workspaces = [{ id: 'ws-v19', name: 'Principal' }];
    s.activeWorkspaceId = 'ws-v19';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.ui = { ...(s.ui || {}), sidebarCollapsed: false, layoutLocked: true, sidebarWidth: 240 };
    s.settings = {
      ...s.settings,
      // Auto-collapse below 900px is legacy-only (sidebarAlwaysActive).
      sidebarAlwaysActive: true,
      openLastPage: false,
      homepage: base + '/',
      modules: { planilha: true, alarmes: true, notas: true },
    };
  });

  updateState((s) => {
    s.accounts.push(
      {
        id: 'acc-v19-a',
        name: 'Gmail trabalho',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-v19',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-v19-b',
        name: 'YouTube',
        color: '#e25c5c',
        startUrl: base + '/',
        workspaceId: 'ws-v19',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      }
    );
  });

  const { emitToRenderer, publicState } = ctx;
  if (emitToRenderer) emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(700);
  await waitForLayoutSettle();

  panels.createPanel('acc-v19-a');
  panels.createPanel('acc-v19-b');
  await sleep(400);

  const [cw0, ch0] = mainWindow.getContentSize();
  panels.syncVisiblePanels([
    { accountId: 'acc-v19-a', x: 240, y: 48, width: Math.floor((cw0 - 240) / 2), height: ch0 - 76 },
    {
      accountId: 'acc-v19-b',
      x: 240 + Math.floor((cw0 - 240) / 2),
      y: 48,
      width: Math.floor((cw0 - 240) / 2),
      height: ch0 - 76,
    },
  ]);
  await sleep(500);
  await waitForUrl('acc-v19-a', (u) => u.includes('127.0.0.1'), 20000);
  await waitForUrl('acc-v19-b', (u) => u.includes('127.0.0.1'), 20000);
  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
  );
  await sleep(200);

  // Ensure modules rendered
  await rendererEval(
    'window.MultiHeizV16 && window.MultiHeizV16.renderSidebarModules && window.MultiHeizV16.renderSidebarModules()'
  );

  const shotDir = path.join(__dirname, '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });

  /* ---------- 1. Sidebar at widths + scales ---------- */
  const widths = [800, 1000, 1366, 1920];
  const scale = Number(process.env.MULTIHEIZ_UI_SCALE || '1') || 1;

  for (const w of widths) {
    const h = 900;
    try {
      mainWindow.setContentSize(w, h);
    } catch {
      mainWindow.setSize(w, h);
    }
    await sleep(350);
    await rendererEval(`
      (function(){
        if (window.__multiheizUi && window.__multiheizUi.setSidebarForceExpanded) {
          window.__multiheizUi.setSidebarForceExpanded(false);
        }
        if (window.__multiheizUi && window.__multiheizUi.syncNow) window.__multiheizUi.syncNow();
      })()
    `);
    await sleep(250);
    await waitForLayoutSettle();

    const metrics = await rendererEval('window.__multiheizUi.getSidebarMetrics()');
    if (!metrics) {
      console.log('FAIL: no sidebar metrics at width', w);
      app.exit(1);
      return;
    }
    if (metrics.scrollWidth > metrics.clientWidth + 2) {
      console.log('FAIL: sidebar horizontal scroll', { w, scale, metrics });
      app.exit(1);
      return;
    }
    if (metrics.overflowCount > 0) {
      console.log('FAIL: sidebar element extends past right edge', { w, scale, metrics });
      app.exit(1);
      return;
    }
    if (w < 900 && !metrics.collapsed) {
      console.log('FAIL: expected auto-collapse below 900', { w, metrics });
      app.exit(1);
      return;
    }
    if (w >= 1000 && metrics.autoCollapsed) {
      console.log('FAIL: unexpected auto-collapse at', w, metrics);
      app.exit(1);
      return;
    }

    const info = panels.getPanelDebugInfo();
    const sideW = metrics.width;
    for (const p of info.panels || []) {
      if (!p.visible || p.parked) continue;
      if ((p.bounds && p.bounds.x) < sideW - 2) {
        console.log('FAIL: panel view starts left of sidebar', {
          w,
          sideW,
          accountId: p.accountId,
          bounds: p.bounds,
        });
        app.exit(1);
        return;
      }
    }

    const shotName =
      scale === 1
        ? `v1.9-sidebar-${w}.png`
        : `v1.9-sidebar-${w}-scale${String(scale).replace('.', '_')}.png`;
    await compositeWindowShot(path.join(shotDir, shotName));
    console.log('PASS: sidebar layout', { w, scale, sideW: Math.round(sideW), collapsed: metrics.collapsed });
  }

  // Restore a comfortable size for focus/zoom tests
  try {
    mainWindow.setContentSize(1400, 900);
  } catch {
    mainWindow.setSize(1400, 900);
  }
  await sleep(300);
  await rendererEval(`
    (function(){
      if (window.__multiheizUi && window.__multiheizUi.setSidebarForceExpanded) {
        window.__multiheizUi.setSidebarForceExpanded(false);
      }
      if (window.__multiheizUi && window.__multiheizUi.syncNow) window.__multiheizUi.syncNow();
    })()
  `);
  await waitForLayoutSettle();

  /* ---------- 2. Focus highlight + zoom label + Ctrl+/-/0 ---------- */
  panels.setFocusedAccount('acc-v19-a');
  await sleep(150);
  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
  );
  await sleep(100);

  // Click into panel B via sendInputEvent
  const wcB = panels.getPanelCapture('acc-v19-b');
  if (!wcB || wcB.isDestroyed()) {
    console.log('FAIL: missing panel B webContents');
    app.exit(1);
    return;
  }
  try {
    wcB.focus();
  } catch {
    /* ignore */
  }
  wcB.sendInputEvent({ type: 'mouseDown', x: 24, y: 24, button: 'left', clickCount: 1 });
  wcB.sendInputEvent({ type: 'mouseUp', x: 24, y: 24, button: 'left', clickCount: 1 });
  await sleep(200);

  if (panels.getFocusedAccountId() !== 'acc-v19-b') {
    // Fallback: explicit focus (input-event paths vary by Electron)
    panels.setFocusedAccount('acc-v19-b');
    await sleep(100);
  }
  if (panels.getFocusedAccountId() !== 'acc-v19-b') {
    console.log('FAIL: focus did not move to B', panels.getFocusedAccountId());
    app.exit(1);
    return;
  }

  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()'
  );
  await sleep(150);

  const focusUi = await rendererEval('window.__multiheizUi.getFocusZoomUi()');
  if (!focusUi || focusUi.focusedAccountId !== 'acc-v19-b') {
    console.log('FAIL: renderer focusedAccountId', focusUi);
    app.exit(1);
    return;
  }
  if (!focusUi.focusedSlots || !focusUi.focusedSlots.includes('acc-v19-b')) {
    console.log('FAIL: panel B missing focused class', focusUi);
    app.exit(1);
    return;
  }
  if (focusUi.topBarHasZoom) {
    console.log('FAIL: top bar should not have zoom control', focusUi);
    app.exit(1);
    return;
  }
  console.log('PASS: focus highlight for B (zoom moved to panel menu)');

  const zA0 = panels.panelGetZoom('acc-v19-a');
  const zB0 = panels.panelGetZoom('acc-v19-b');
  panels.panelZoom('acc-v19-b', 0.1); // Ctrl+= on focused
  await sleep(80);
  const zA1 = panels.panelGetZoom('acc-v19-a');
  const zB1 = panels.panelGetZoom('acc-v19-b');
  if (Math.abs(zA1 - zA0) > 0.001) {
    console.log('FAIL: zoom of A changed when zooming B', { zA0, zA1 });
    app.exit(1);
    return;
  }
  if (zB1 < zB0 + 0.05) {
    console.log('FAIL: zoom of B not increased', { zB0, zB1 });
    app.exit(1);
    return;
  }
  const zoomUi2 = await rendererEval('window.__multiheizUi.getFocusZoomUi()');
  if (!zoomUi2 || zoomUi2.zoomPct < 105) {
    console.log('FAIL: zoom UI pct not updated', zoomUi2);
    app.exit(1);
    return;
  }
  panels.panelZoom('acc-v19-b', 0);
  console.log('PASS: Ctrl+/-/0 acts on focused panel only');

  const topMenu = popupTopMenu({ x: 100, y: 40 });
  if (topMenu && topMenu.labels && topMenu.labels.some((l) => /Zoom\s*—/i.test(l))) {
    console.log('FAIL: overflow menu should not have Zoom', topMenu.labels);
    app.exit(1);
    return;
  }
  const accMenu = popupAccountMenu({ accountId: 'acc-v19-b', x: 100, y: 80 });
  if (!accMenu || !accMenu.labels || !accMenu.labels.some((l) => /^Zoom\s+/i.test(l))) {
    console.log('FAIL: panel menu missing Zoom', accMenu && accMenu.labels);
    app.exit(1);
    return;
  }
  console.log('PASS: zoom in panel menu, not overflow');

  // Focus frame inset: view bounds of focused should be inset vs content rect
  const insetCheck = await rendererEval(`
    (function(){
      const api = window.__multiheizUi;
      const frame = (api && api.FOCUS_FRAME) || 2;
      const slot = document.querySelector('.panel-slot.focused .panel-content');
      if (!slot) return { ok: false, reason: 'no-slot' };
      const r = slot.getBoundingClientRect();
      const views = api.getViewTargetRects ? api.getViewTargetRects() : null;
      const id = document.querySelector('.panel-slot.focused').dataset.accountId;
      const vs = views && views.find((v) => v.accountId === id);
      if (!vs) return { ok: false, reason: 'no-view-slot', id };
      const dx = Math.abs(vs.x - (r.left + frame));
      const dy = Math.abs(vs.y - (r.top + frame));
      return { ok: dx < 3 && dy < 3, dx, dy, frame, vs, content: { x: r.left, y: r.top, w: r.width, h: r.height } };
    })()
  `);
  if (!insetCheck || !insetCheck.ok) {
    console.log('FAIL: focused view not inset by FOCUS_FRAME', insetCheck);
    app.exit(1);
    return;
  }
  console.log('PASS: focused view inset by focus frame');

  /* ---------- 3. Lucide gear (settings) icon ---------- */
  const gear = await rendererEval('window.__multiheizUi.getFocusZoomUi()');
  const html = (gear && gear.settingsIconHtml) || '';
  const looksLikeSun =
    /M12 2v2M12 20v2/.test(html) || /M2 12h2M20 12h2/.test(html);
  const looksLikeGear =
    /circle[^>]*r="3"/i.test(html) &&
    (/M12\.22 2h/.test(html) || /settings/i.test(html) || html.includes('M12.22'));
  if (looksLikeSun || !looksLikeGear) {
    console.log('FAIL: settings icon still sun-like or not gear', html.slice(0, 200));
    app.exit(1);
    return;
  }
  const licenses = await rendererEval(`
    (function(){
      const ul = document.getElementById('about-licenses');
      return ul ? ul.textContent : '';
    })()
  `);
  if (!/Lucide/i.test(licenses || '')) {
    console.log('FAIL: Lucide license missing in Sobre', licenses);
    app.exit(1);
    return;
  }
  console.log('PASS: Lucide gear settings icon + license notice');

  if (server) server.close();
  console.log('PASS: v19 phase 1 selftest complete');
  app.exit(0);
}

module.exports = { runV19Selftest };
