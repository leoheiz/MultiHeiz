'use strict';

/**
 * Selftest: real OS drag / click / double-click on the topbar
 * (MULTIHEIZ_SELFTEST=realdrag-topbar).
 * Handshake via files in MULTIHEIZ_REALCLICK_DIR (tools/realdrag-topbar.js).
 *
 * (a) drag empty topbar moves window (fixed, auto-hide open, legacy)
 * (c) real click on settings opens dialog
 * (d) double-click empty area maximize / restore
 * (b) is covered by npm run check:realclick-sidebar
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, screen } = require('electron');
const { envGet } = require('./config');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function handshakeDir() {
  const d = envGet('MULTIHEIZ_REALCLICK_DIR');
  if (!d) throw new Error('MULTIHEIZ_REALCLICK_DIR missing');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

async function waitForFile(filePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
      } catch {
        /* retry */
      }
    }
    await sleep(50);
  }
  throw new Error('timeout waiting for ' + filePath);
}

/**
 * @param {object} ctx
 */
async function runRealdragTopbarSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep: ctxSleep,
    waitForUrl,
    rendererEval,
    waitForLayoutSettle,
  } = ctx;

  const dir = handshakeDir();
  const readyPath = path.join(dir, 'ready.json');
  const donePath = path.join(dir, 'done.json');
  const resultPath = path.join(dir, 'result.json');

  console.log('SELFTEST realdrag-topbar');
  console.log('handshake dir:', dir);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  const WIN_X = 120;
  const WIN_Y = 100;
  const WIN_W = 1400;
  const WIN_H = 900;
  const DRAG_DX = 80;
  const DRAG_DY = 50;

  try {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
  } catch {
    /* ignore */
  }
  try {
    mainWindow.setBounds({ x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H });
  } catch {
    mainWindow.setSize(WIN_W, WIN_H);
    mainWindow.setPosition(WIN_X, WIN_Y);
  }
  mainWindow.show();
  mainWindow.focus();
  try {
    mainWindow.moveTop();
  } catch {
    /* ignore */
  }
  await ctxSleep(400);

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>rd</title></head>
<body style="margin:0;height:100vh;background:#2bb8a6;color:#fff;font:24px system-ui">
<div style="padding:24px">REALDRAG PANEL</div>
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
    s.workspaces = [{ id: 'ws-rd', name: 'RealDrag' }];
    s.activeWorkspaceId = 'ws-rd';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-rd',
        name: 'Painel RD',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-rd',
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
      sidebarAlwaysActive: false,
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await ctxSleep(700);
  await waitForLayoutSettle();
  await waitForUrl('acc-rd', (u) => u.includes('127.0.0.1'), 30000);
  await waitForLayoutSettle();

  const results = { a: [], c: null, d: null };

  async function placeWindow() {
    try {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
    } catch {
      /* ignore */
    }
    mainWindow.show();
    mainWindow.focus();
    try {
      mainWindow.moveTop();
    } catch {
      /* ignore */
    }
    await ctxSleep(200);
    try {
      mainWindow.setBounds({ x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H });
    } catch {
      /* ignore */
    }
    await ctxSleep(150);
  }

  /**
   * @param {string} step
   * @param {object} extra
   */
  async function requestOsAction(step, extra) {
    try {
      fs.unlinkSync(readyPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(donePath);
    } catch {
      /* ignore */
    }
    const token = String(Date.now()) + '-' + step;
    const payload = { step, token, done: false, ...extra };
    writeJson(readyPath, payload);
    console.log('REALDRAG_READY', step, extra.action, extra.mode || '');
    const done = await waitForFile(donePath, 60000);
    if (!done || done.token !== token) {
      throw new Error('done token mismatch for ' + step);
    }
    await ctxSleep(280);
  }

  function physFromClient(clientX, clientY) {
    const contentBounds = mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(contentBounds);
    const scale = Number(display.scaleFactor) || 1;
    return {
      contentBounds,
      scale,
      physical: {
        x: Math.round((contentBounds.x + clientX) * scale),
        y: Math.round((contentBounds.y + clientY) * scale),
      },
      deltaPhys: {
        x: Math.round(DRAG_DX * scale),
        y: Math.round(DRAG_DY * scale),
      },
    };
  }

  /**
   * @param {string} modeName
   */
  async function runDragMode(modeName) {
    await placeWindow();
    const probe = await rendererEval('window.__multiheizUi.getTopbarDragProbe()');
    if (!probe || !probe.emptyPoint || !probe.emptyEffective || probe.emptyEffective.region !== 'drag') {
      const entry = { mode: modeName, ok: false, detail: 'empty point not drag', probe };
      results.a.push(entry);
      console.log('FAIL: drag prep', modeName, entry);
      return entry;
    }
    const before = mainWindow.getBounds();
    const geo = physFromClient(probe.emptyPoint.x, probe.emptyPoint.y);
    await requestOsAction('drag-' + modeName, {
      action: 'Drag',
      mode: modeName,
      physical: geo.physical,
      deltaPhys: geo.deltaPhys,
      steps: 10,
      client: probe.emptyPoint,
      scaleFactor: geo.scale,
    });
    const after = mainWindow.getBounds();
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const ok =
      Math.abs(dx - DRAG_DX) <= 12 &&
      Math.abs(dy - DRAG_DY) <= 12 &&
      !mainWindow.isMaximized();
    const entry = {
      mode: modeName,
      ok,
      before: { x: before.x, y: before.y },
      after: { x: after.x, y: after.y },
      delta: { x: dx, y: dy },
      expected: { x: DRAG_DX, y: DRAG_DY },
      emptyRegion: probe.emptyEffective.region,
      topbarRegion: probe.topbarRegion,
    };
    results.a.push(entry);
    console.log(ok ? 'PASS:' : 'FAIL:', 'drag', modeName, entry);
    // Reset position for next mode
    await placeWindow();
    return entry;
  }

  // --- (a) fixed ---
  await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(false)');
  updateState((s) => {
    s.ui = { ...(s.ui || {}), sidebarAutoHide: false, sidebarCollapsed: false };
    s.settings = { ...s.settings, sidebarAlwaysActive: false };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await ctxSleep(400);
  await waitForLayoutSettle();
  await rendererEval('window.__multiheizUi.syncSidebarAfterLegacyChange()');
  await waitForLayoutSettle();
  await runDragMode('fixed');

  // --- (a) auto-hide open ---
  await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await ctxSleep(250);
  await waitForLayoutSettle();
  await rendererEval('window.__multiheizUi.setSidebarAutoHideOpen(true)');
  await ctxSleep(300);
  await waitForLayoutSettle();
  await runDragMode('auto-hide-open');

  // --- (a) legacy ---
  await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(true)');
  updateState((s) => {
    s.ui = { ...(s.ui || {}), sidebarAutoHide: false, sidebarCollapsed: false };
    s.settings = { ...s.settings, sidebarAlwaysActive: true };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await ctxSleep(400);
  await waitForLayoutSettle();
  await rendererEval('window.__multiheizUi.syncSidebarAfterLegacyChange()');
  await waitForLayoutSettle();
  await runDragMode('legacy');

  // Back to fixed for (c)(d)
  await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(false)');
  updateState((s) => {
    s.ui = { ...(s.ui || {}), sidebarAutoHide: false, sidebarCollapsed: false };
    s.settings = { ...s.settings, sidebarAlwaysActive: false };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await ctxSleep(400);
  await waitForLayoutSettle();
  await rendererEval('window.__multiheizUi.syncSidebarAfterLegacyChange()');
  await waitForLayoutSettle();
  await placeWindow();

  // --- (c) click settings ---
  await rendererEval('window.__multiheizUi.closeSettingsDialog()');
  await ctxSleep(100);
  const probeBtn = await rendererEval('window.__multiheizUi.getTopbarDragProbe()');
  if (!probeBtn || !probeBtn.settingsPoint) {
    results.c = { ok: false, detail: 'no settings point' };
    console.log('FAIL: settings click prep', results.c);
  } else {
    const geo = physFromClient(probeBtn.settingsPoint.x, probeBtn.settingsPoint.y);
    await requestOsAction('click-settings', {
      action: 'Click',
      mode: 'fixed',
      physical: geo.physical,
      client: probeBtn.settingsPoint,
      scaleFactor: geo.scale,
    });
    const open = await rendererEval('window.__multiheizUi.isSettingsDialogOpen()');
    results.c = {
      ok: !!open,
      settingsRegion: probeBtn.settingsRegion,
      open: !!open,
    };
    console.log(open ? 'PASS:' : 'FAIL:', 'settings click', results.c);
    await rendererEval('window.__multiheizUi.closeSettingsDialog()');
    await ctxSleep(150);
  }

  // --- (d) double-click maximize / restore ---
  await placeWindow();
  const wasMax = mainWindow.isMaximized();
  if (wasMax) {
    mainWindow.unmaximize();
    await ctxSleep(200);
  }
  const probeDbl = await rendererEval('window.__multiheizUi.getTopbarDragProbe()');
  const geoDbl = physFromClient(probeDbl.emptyPoint.x, probeDbl.emptyPoint.y);
  await requestOsAction('dblclick-maximize', {
    action: 'DoubleClick',
    mode: 'fixed',
    physical: geoDbl.physical,
    client: probeDbl.emptyPoint,
    scaleFactor: geoDbl.scale,
  });
  await ctxSleep(250);
  const max1 = mainWindow.isMaximized();
  // After maximize, screen coords of the caption change — re-probe empty point.
  const probeRestore = await rendererEval('window.__multiheizUi.getTopbarDragProbe()');
  const geoRestore = physFromClient(probeRestore.emptyPoint.x, probeRestore.emptyPoint.y);
  await requestOsAction('dblclick-restore', {
    action: 'DoubleClick',
    mode: 'fixed',
    physical: geoRestore.physical,
    client: probeRestore.emptyPoint,
    scaleFactor: geoRestore.scale,
  });
  await ctxSleep(250);
  const max2 = mainWindow.isMaximized();
  results.d = {
    ok: max1 === true && max2 === false,
    afterFirst: max1,
    afterSecond: max2,
    restorePhys: geoRestore.physical,
  };
  console.log(results.d.ok ? 'PASS:' : 'FAIL:', 'double-click maximize/restore', results.d);

  // Signal orchestrator that no more OS actions are needed
  writeJson(readyPath, {
    step: 'finished',
    token: String(Date.now()) + '-done',
    done: true,
    action: 'Click',
    physical: { x: 0, y: 0 },
  });
  await ctxSleep(200);

  const allA = results.a.every((r) => r.ok);
  const allOk = allA && results.c && results.c.ok && results.d && results.d.ok;
  writeJson(resultPath, {
    ok: allOk,
    results,
    at: new Date().toISOString(),
  });

  try {
    server.close();
  } catch {
    /* ignore */
  }

  // Avoid unused panels lint in some configs
  void panels;

  if (!allOk) {
    console.log('FAIL: realdrag-topbar one or more checks', results);
    app.exit(1);
    return;
  }
  console.log('PASS: realdrag-topbar all checks');
  app.exit(0);
}

module.exports = { runRealdragTopbarSelftest };
