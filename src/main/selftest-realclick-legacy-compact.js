'use strict';

/**
 * Selftest: real OS click toggles legacy sidebar compact ↔ expanded and measures
 * sidebar/panel bounds. Phase 2 (same userdata) asserts compact persistence.
 * Handshake: MULTIHEIZ_REALCLICK_DIR (tools/realclick-legacy-compact.js).
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

function near(a, b, tol = 4) {
  return Math.abs(a - b) <= tol;
}

/**
 * @param {object} ctx
 */
async function runRealclickLegacyCompactSelftest(ctx) {
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

  const phase = String(envGet('MULTIHEIZ_SELFTEST_PHASE') || '1');
  console.log('SELFTEST realclick-legacy-compact phase=' + phase);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  if (phase === '2') {
    await runPhase2(ctx);
    return;
  }

  const dir = handshakeDir();
  const readyPath = path.join(dir, 'ready.json');
  const donePath = path.join(dir, 'done.json');
  const resultPath = path.join(dir, 'result.json');

  const WIN_X = 80;
  const WIN_Y = 80;
  const WIN_W = 1400;
  const WIN_H = 900;
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
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>lc</title></head>
<body style="margin:0;height:100vh;background:#3d8bfd;color:#fff;font:24px system-ui">
<div style="padding:24px">LEGACY COMPACT PANEL</div>
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
    s.workspaces = [{ id: 'ws-lc', name: 'LegacyCompact' }];
    s.activeWorkspaceId = 'ws-lc';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-lc',
        name: 'Painel LC',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-lc',
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
  await waitForUrl('acc-lc', (u) => u.includes('127.0.0.1'), 30000);
  await waitForLayoutSettle();

  function panelBounds() {
    const info = panels.getPanelDebugInfo();
    const p = (info.panels || []).find((x) => x.accountId === 'acc-lc');
    return {
      bounds: p && p.bounds,
      overlayW: info.sidebarOverlayWidth,
    };
  }

  async function measure() {
    const mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    const pb = panelBounds();
    return {
      collapsed: !!(mode && mode.collapsed),
      legacyAlwaysActive: !!(mode && mode.legacyAlwaysActive),
      autoHide: !!(mode && mode.autoHide),
      open: !!(mode && mode.open),
      toggleTitle: mode && mode.toggleTitle,
      sidebarWidth: mode ? mode.sidebarWidth : 0,
      panel: pb.bounds
        ? { x: pb.bounds.x, y: pb.bounds.y, width: pb.bounds.width, height: pb.bounds.height }
        : null,
      overlayW: pb.overlayW,
    };
  }

  /**
   * @param {string} stepName
   * @param {{ expectCollapsed: boolean }} expect
   */
  async function realClickToggle(stepName, expect) {
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
    await ctxSleep(120);

    const before = await measure();
    const hit = await rendererEval(`(function(){
      const btn = document.getElementById('btn-sidebar-collapse');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return {
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      };
    })()`);
    if (!hit) throw new Error('btn-sidebar-collapse missing');

    const contentBounds = mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(contentBounds);
    const scale = Number(display.scaleFactor) || 1;
    const physX = Math.round((contentBounds.x + hit.cx) * scale);
    const physY = Math.round((contentBounds.y + hit.cy) * scale);
    const token = String(Date.now()) + '-' + stepName;
    writeJson(readyPath, {
      mode: stepName,
      expectKind: 'legacyCollapse',
      token,
      physical: { x: physX, y: physY },
      scaleFactor: scale,
      before,
    });
    console.log('REALCLICK_READY', stepName, 'phys=', physX, physY);

    const done = await waitForFile(donePath, 60000);
    if (!done || done.token !== token) {
      throw new Error('done token mismatch: ' + JSON.stringify(done));
    }
    await ctxSleep(350);
    await waitForLayoutSettle();

    const after = await measure();
    if (!after.legacyAlwaysActive || after.autoHide || after.open) {
      throw new Error('legacy must stay visible (never auto-hide): ' + JSON.stringify(after));
    }
    if (after.collapsed !== expect.expectCollapsed) {
      throw new Error(
        'expected collapsed=' + expect.expectCollapsed + ' after ' + stepName + ': ' + JSON.stringify(after)
      );
    }
    if (after.overlayW !== 0) {
      throw new Error('legacy must not use overlay: ' + JSON.stringify(after));
    }
    if (expect.expectCollapsed) {
      if (!(after.sidebarWidth >= 40 && after.sidebarWidth <= 70)) {
        throw new Error('compact sidebar ~52px: ' + JSON.stringify(after));
      }
      if (!after.panel || !(after.panel.x >= 40 && after.panel.x <= 90)) {
        throw new Error('compact panel x after ~52px rail: ' + JSON.stringify(after));
      }
    } else {
      if (!(after.sidebarWidth >= 160)) {
        throw new Error('expanded sidebar width: ' + JSON.stringify(after));
      }
      if (!after.panel || !(after.panel.x >= 160)) {
        throw new Error('expanded panel x: ' + JSON.stringify(after));
      }
    }
    console.log('PASS:', stepName, {
      sidebarWidth: after.sidebarWidth,
      panel: after.panel,
      collapsed: after.collapsed,
    });
    return { before, after };
  }

  // Enter legacy → must start compact
  await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(true)');
  await ctxSleep(250);
  await waitForLayoutSettle();
  let m0 = await measure();
  if (!m0.legacyAlwaysActive || !m0.collapsed || m0.autoHide) {
    console.log('FAIL: legacy should start compact', m0);
    app.exit(1);
    return;
  }
  if (!(m0.sidebarWidth >= 40 && m0.sidebarWidth <= 70)) {
    console.log('FAIL: initial compact width', m0);
    app.exit(1);
    return;
  }
  console.log('PASS: legacy initial compact', m0);

  const steps = [];
  steps.push({
    step: 'initial-compact',
    ...m0,
  });

  const expand = await realClickToggle('legacy-expand', { expectCollapsed: false });
  steps.push({ step: 'after-expand', ...expand.after });
  if (!(expand.after.panel.x > m0.panel.x + 80)) {
    console.log('FAIL: expand should push panel x', { before: m0.panel, after: expand.after.panel });
    app.exit(1);
    return;
  }
  if (!(expand.after.panel.width < m0.panel.width - 80)) {
    console.log('FAIL: expand should shrink panel width', {
      before: m0.panel,
      after: expand.after.panel,
    });
    app.exit(1);
    return;
  }

  const compact = await realClickToggle('legacy-compact', { expectCollapsed: true });
  steps.push({ step: 'after-compact', ...compact.after });
  if (!near(compact.after.sidebarWidth, m0.sidebarWidth, 3)) {
    console.log('FAIL: re-compact width should match initial', {
      initial: m0.sidebarWidth,
      again: compact.after.sidebarWidth,
    });
    app.exit(1);
    return;
  }
  if (!near(compact.after.panel.x, m0.panel.x, 6)) {
    console.log('FAIL: re-compact panel x should match initial', {
      initial: m0.panel,
      again: compact.after.panel,
    });
    app.exit(1);
    return;
  }

  flushSave();
  const userData = app.getPath('userData');
  const statePath = path.join(userData, 'multiheiz-state.json');
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!raw.settings || raw.settings.sidebarAlwaysActive !== true) {
    console.log('FAIL: sidebarAlwaysActive not on disk', raw.settings);
    app.exit(1);
    return;
  }
  if (!raw.ui || raw.ui.sidebarCollapsed !== true) {
    console.log('FAIL: sidebarCollapsed true not on disk for phase2', raw.ui);
    app.exit(1);
    return;
  }

  // Drop localhost panels so phase 2 does not hit a dead server.
  updateState((s) => {
    s.accounts = [];
    s.maximizedAccountId = null;
    s.settings = { ...(s.settings || {}), sidebarAlwaysActive: true };
    s.ui = { ...(s.ui || {}), sidebarCollapsed: true, sidebarAutoHide: false };
  });
  flushSave();

  writeJson(resultPath, {
    ok: true,
    steps,
    at: new Date().toISOString(),
  });

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('SELFTEST realclick-legacy-compact phase1 OK — exiting for restart');
  app.exit(0);
}

/**
 * @param {object} ctx
 */
async function runPhase2(ctx) {
  const { sleep: ctxSleep, rendererEval, waitForLayoutSettle, flushSave, publicState, updateState, emitToRenderer } =
    ctx;
  updateState((s) => {
    s.accounts = [];
    s.maximizedAccountId = null;
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await ctxSleep(600);
  await waitForLayoutSettle();

  const st = publicState();
  if (!st.settings || st.settings.sidebarAlwaysActive !== true) {
    console.log('FAIL: phase2 sidebarAlwaysActive', st.settings);
    app.exit(1);
    return;
  }
  if (!st.ui || st.ui.sidebarCollapsed !== true) {
    console.log('FAIL: phase2 sidebarCollapsed', st.ui);
    app.exit(1);
    return;
  }
  const mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.legacyAlwaysActive || !mode.collapsed || mode.autoHide || mode.open || mode.appClassAutoHide) {
    console.log('FAIL: phase2 must stay legacy compact (never auto-hide)', mode);
    app.exit(1);
    return;
  }
  if (!(mode.sidebarWidth >= 40 && mode.sidebarWidth <= 70)) {
    console.log('FAIL: phase2 width ~52px', mode.sidebarWidth);
    app.exit(1);
    return;
  }
  console.log('PASS: phase2 persistence legacy compact', {
    sidebarWidth: mode.sidebarWidth,
    collapsed: mode.collapsed,
  });
  console.log('SELFTEST realclick-legacy-compact OK');
  app.exit(0);
}

module.exports = { runRealclickLegacyCompactSelftest };
