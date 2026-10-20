'use strict';

/**
 * Selftest: dual-button sidebar with real OS mouse (MULTIHEIZ_SELFTEST=realclick-sidebar2).
 * Handshake via MULTIHEIZ_REALCLICK_DIR (orchestrated by tools/realclick-sidebar2.js).
 *
 * Covers: pinned expanded↔compact; pin→autohide→edge reveal→arrow in overlay→pin back;
 * same from compact; persistence restart; legacy pin absent + arrow only.
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
async function runRealclickSidebar2Selftest(ctx) {
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
  console.log('SELFTEST realclick-sidebar2 phase=' + phase);

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
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>rc2</title></head>
<body style="margin:0;height:100vh;background:#2bb8a6;color:#fff;font:24px system-ui">
<div style="padding:24px">REALCLICK-SIDEBAR2</div>
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
    s.workspaces = [{ id: 'ws-rc2', name: 'RC2' }];
    s.activeWorkspaceId = 'ws-rc2';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-rc2-a',
        name: 'Painel A',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-rc2',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-rc2-b',
        name: 'Painel B',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-rc2',
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
      migrations: {
        ...((s.settings && s.settings.migrations) || {}),
        keepAlive120: true,
        sidebarDualButtons130: true,
      },
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await ctxSleep(700);
  await waitForLayoutSettle();
  await waitForUrl('acc-rc2-a', (u) => u.includes('127.0.0.1'), 30000);
  await waitForUrl('acc-rc2-b', (u) => u.includes('127.0.0.1'), 30000);
  await waitForLayoutSettle();

  const results = [];

  function panelBounds() {
    const info = panels.getPanelDebugInfo();
    const p = (info.panels || []).find((x) => x.accountId === 'acc-rc2-a');
    return { bounds: p && p.bounds, overlayW: info.sidebarOverlayWidth };
  }

  function near(a, b, tol = 4) {
    return Math.abs(a - b) <= tol;
  }

  async function measure() {
    const mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    const pb = panelBounds();
    return {
      mode,
      collapsed: !!(mode && mode.collapsed),
      autoHide: !!(mode && mode.autoHide),
      open: !!(mode && mode.open),
      legacyAlwaysActive: !!(mode && mode.legacyAlwaysActive),
      pinVisible: !!(mode && mode.pinVisible),
      collapseVisible: !!(mode && mode.collapseVisible),
      sidebarWidth: mode ? mode.sidebarWidth : 0,
      panel: pb.bounds
        ? { x: pb.bounds.x, y: pb.bounds.y, width: pb.bounds.width, height: pb.bounds.height }
        : null,
      overlayW: pb.overlayW,
    };
  }

  async function focusWin() {
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
  }

  /**
   * @param {string} stepName
   * @param {'collapse' | 'pin' | 'hover-edge'} action
   * @param {object} [expect]
   */
  async function realInput(stepName, action, expect = {}) {
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

    await focusWin();
    const before = await measure();

    let clientX = 0;
    let clientY = 0;
    let btnId = null;
    if (action === 'hover-edge') {
      clientX = 3;
      clientY = Math.round(WIN_H / 2);
    } else {
      btnId = action === 'pin' ? 'btn-sidebar-pin' : 'btn-sidebar-collapse';
      const hit = await rendererEval(`(function(){
        const btn = document.getElementById(${JSON.stringify(btnId)});
        if (!btn || btn.classList.contains('hidden')) return null;
        const r = btn.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })()`);
      if (!hit) throw new Error(btnId + ' missing for ' + stepName);
      clientX = hit.cx;
      clientY = hit.cy;
    }

    const contentBounds = mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(contentBounds);
    const scale = Number(display.scaleFactor) || 1;
    const physX = Math.round((contentBounds.x + clientX) * scale);
    const physY = Math.round((contentBounds.y + clientY) * scale);
    const token = String(Date.now()) + '-' + stepName;
    const kind = action === 'hover-edge' ? 'hover' : 'click';
    writeJson(readyPath, {
      mode: stepName,
      action,
      kind,
      btnId,
      token,
      physical: { x: physX, y: physY },
      scaleFactor: scale,
      before: {
        collapsed: before.collapsed,
        autoHide: before.autoHide,
        open: before.open,
        sidebarWidth: before.sidebarWidth,
        panel: before.panel,
        overlayW: before.overlayW,
      },
    });
    console.log('REALCLICK2_READY', stepName, action, 'phys=', physX, physY);

    const done = await waitForFile(donePath, 90000);
    if (!done || done.token !== token) {
      throw new Error('done token mismatch: ' + JSON.stringify(done));
    }
    await ctxSleep(action === 'hover-edge' ? 280 : 350);
    await waitForLayoutSettle();
    if (action === 'hover-edge') {
      // Show delay ~150ms — then park cursor inside the rail so the 700ms hide
      // timer does not fire before the next real click on arrow/pin.
      await ctxSleep(180);
      await waitForLayoutSettle();
      let openCheck = await measure();
      if (!openCheck.open) {
        // Retry edge once if polling missed the first hover.
        await focusWin();
        const cb = mainWindow.getContentBounds();
        const disp = screen.getDisplayMatching(cb);
        const sc = Number(disp.scaleFactor) || 1;
        const px = Math.round((cb.x + 3) * sc);
        const py = Math.round((cb.y + WIN_H / 2) * sc);
        const token2 = String(Date.now()) + '-' + stepName + '-retry';
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
        writeJson(readyPath, {
          mode: stepName + '-retry',
          action: 'hover-edge',
          kind: 'hover',
          token: token2,
          physical: { x: px, y: py },
          scaleFactor: sc,
        });
        const done2 = await waitForFile(donePath, 60000);
        if (!done2 || done2.token !== token2) {
          throw new Error('hover retry token mismatch');
        }
        await ctxSleep(280);
        await waitForLayoutSettle();
        openCheck = await measure();
      }
      if (openCheck.open) {
        const stay = await rendererEval(`(function(){
          const sb = document.getElementById('sidebar');
          if (!sb) return { cx: 40, cy: ${Math.round(WIN_H / 2)} };
          const r = sb.getBoundingClientRect();
          return { cx: Math.max(20, Math.min(r.left + r.width * 0.45, r.right - 8)), cy: r.top + Math.min(80, r.height / 2) };
        })()`);
        const cb = mainWindow.getContentBounds();
        const disp = screen.getDisplayMatching(cb);
        const sc = Number(disp.scaleFactor) || 1;
        const px = Math.round((cb.x + stay.cx) * sc);
        const py = Math.round((cb.y + stay.cy) * sc);
        const tokenStay = String(Date.now()) + '-' + stepName + '-stay';
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
        writeJson(readyPath, {
          mode: stepName + '-stay',
          action: 'hover-stay',
          kind: 'hover',
          token: tokenStay,
          physical: { x: px, y: py },
          scaleFactor: sc,
        });
        const doneStay = await waitForFile(donePath, 60000);
        if (!doneStay || doneStay.token !== tokenStay) {
          throw new Error('hover stay token mismatch');
        }
        await ctxSleep(80);
      }
    }

    const after = await measure();
    const entry = {
      step: stepName,
      action,
      ok: true,
      before: readyBeforeSnapshot(before),
      after: readyBeforeSnapshot(after),
      physical: { x: physX, y: physY },
    };

    function fail(msg) {
      entry.ok = false;
      entry.fail = msg;
      results.push(entry);
      console.log('FAIL:', stepName, msg, { before, after });
      throw new Error(stepName + ': ' + msg);
    }

    if (expect.collapsed !== undefined && after.collapsed !== expect.collapsed) {
      fail('collapsed expected ' + expect.collapsed + ' got ' + after.collapsed);
    }
    if (expect.autoHide !== undefined && after.autoHide !== expect.autoHide) {
      fail('autoHide expected ' + expect.autoHide + ' got ' + after.autoHide);
    }
    if (expect.open !== undefined && after.open !== expect.open) {
      fail('open expected ' + expect.open + ' got ' + after.open);
    }
    if (expect.legacyAlwaysActive !== undefined && after.legacyAlwaysActive !== expect.legacyAlwaysActive) {
      fail('legacy expected ' + expect.legacyAlwaysActive);
    }
    if (expect.pinVisible !== undefined && after.pinVisible !== expect.pinVisible) {
      fail('pinVisible expected ' + expect.pinVisible);
    }
    if (expect.sidebarWidthMin !== undefined && !(after.sidebarWidth >= expect.sidebarWidthMin)) {
      fail('sidebarWidth min ' + expect.sidebarWidthMin + ' got ' + after.sidebarWidth);
    }
    if (expect.sidebarWidthMax !== undefined && !(after.sidebarWidth <= expect.sidebarWidthMax)) {
      fail('sidebarWidth max ' + expect.sidebarWidthMax + ' got ' + after.sidebarWidth);
    }
    if (expect.panelXMin !== undefined && (!after.panel || !(after.panel.x >= expect.panelXMin))) {
      fail('panel.x min ' + expect.panelXMin + ' got ' + JSON.stringify(after.panel));
    }
    if (expect.panelXMax !== undefined && (!after.panel || !(after.panel.x <= expect.panelXMax))) {
      fail('panel.x max ' + expect.panelXMax + ' got ' + JSON.stringify(after.panel));
    }
    if (expect.overlayW !== undefined && after.overlayW !== expect.overlayW) {
      fail('overlayW expected ' + expect.overlayW + ' got ' + after.overlayW);
    }
    if (expect.overlayWMin !== undefined && !(after.overlayW >= expect.overlayWMin)) {
      fail('overlayW min ' + expect.overlayWMin + ' got ' + after.overlayW);
    }
    if (expect.panelWiderThan != null && after.panel) {
      if (!(after.panel.width > expect.panelWiderThan + 40)) {
        fail('panel should be wider than ' + expect.panelWiderThan);
      }
    }

    results.push(entry);
    console.log('PASS:', stepName, {
      collapsed: after.collapsed,
      autoHide: after.autoHide,
      open: after.open,
      sidebarWidth: after.sidebarWidth,
      panel: after.panel,
      overlayW: after.overlayW,
    });
    return { before, after };
  }

  function readyBeforeSnapshot(m) {
    return {
      collapsed: m.collapsed,
      autoHide: m.autoHide,
      open: m.open,
      legacyAlwaysActive: m.legacyAlwaysActive,
      pinVisible: m.pinVisible,
      sidebarWidth: m.sidebarWidth,
      panel: m.panel,
      overlayW: m.overlayW,
    };
  }

  try {
    await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(false)');
    updateState((s) => {
      s.ui = { ...(s.ui || {}), sidebarAutoHide: false, sidebarCollapsed: false, sidebarWidth: 240 };
      s.settings = { ...s.settings, sidebarAlwaysActive: false };
    });
    flushSave();
    emitToRenderer({ type: 'state:changed', state: publicState() });
    await ctxSleep(400);
    await waitForLayoutSettle();

    let m = await measure();
    if (m.autoHide || m.collapsed || !(m.sidebarWidth >= 160) || !m.pinVisible) {
      throw new Error('start must be pinned expanded: ' + JSON.stringify(readyBeforeSnapshot(m)));
    }
    const expandedPanelW = m.panel ? m.panel.width : 0;
    console.log('PASS: start pinned expanded', readyBeforeSnapshot(m));

    // --- From expanded: arrow → compact → expand ---
    await realInput('pinned-expand-to-compact', 'collapse', {
      collapsed: true,
      autoHide: false,
      open: false,
      sidebarWidthMin: 40,
      sidebarWidthMax: 70,
      panelXMin: 40,
      panelXMax: 90,
      overlayW: 0,
      panelWiderThan: expandedPanelW,
    });
    const compactFromExpanded = await measure();

    await realInput('pinned-compact-to-expand', 'collapse', {
      collapsed: false,
      autoHide: false,
      open: false,
      sidebarWidthMin: 160,
      panelXMin: 160,
      overlayW: 0,
    });

    // --- Pin → auto-hide (hidden) ---
    await realInput('pinned-to-autohide', 'pin', {
      autoHide: true,
      open: false,
      collapsed: false,
      overlayW: 0,
      panelXMax: 30,
    });
    const hidden = await measure();
    if (!(hidden.panel && hidden.panel.width > expandedPanelW + 50)) {
      throw new Error('autohide should free panel width: ' + JSON.stringify(hidden.panel));
    }

    // Edge hover → revealed (expanded overlay)
    await realInput('autohide-edge-reveal', 'hover-edge', {
      autoHide: true,
      open: true,
      collapsed: false,
      overlayWMin: 200,
    });
    m = await measure();
    if (!m.panel || !near(m.panel.x, m.overlayW, 6)) {
      throw new Error('revealed panel.x should match overlay: ' + JSON.stringify(m));
    }

    // Arrow inside overlay → compact overlay width
    await realInput('overlay-expand-to-compact', 'collapse', {
      autoHide: true,
      open: true,
      collapsed: true,
      sidebarWidthMin: 40,
      sidebarWidthMax: 70,
      overlayWMin: 40,
    });
    m = await measure();
    if (!(m.overlayW >= 40 && m.overlayW <= 70)) {
      throw new Error('compact overlay width ~52: ' + m.overlayW);
    }

    // Pin while compact overlay → fixed compact
    await realInput('overlay-compact-pin', 'pin', {
      autoHide: false,
      open: false,
      collapsed: true,
      overlayW: 0,
      sidebarWidthMin: 40,
      sidebarWidthMax: 70,
      panelXMin: 40,
      panelXMax: 90,
    });

    // --- From compact: pin → autohide → reveal → arrow expand → pin ---
    await realInput('compact-to-autohide', 'pin', {
      autoHide: true,
      open: false,
      collapsed: true,
      overlayW: 0,
      panelXMax: 30,
    });

    await realInput('autohide-compact-edge-reveal', 'hover-edge', {
      autoHide: true,
      open: true,
      collapsed: true,
      overlayWMin: 40,
    });
    m = await measure();
    if (!(m.overlayW >= 40 && m.overlayW <= 70)) {
      throw new Error('revealed compact overlay ~52: ' + m.overlayW);
    }

    await realInput('overlay-compact-to-expand', 'collapse', {
      autoHide: true,
      open: true,
      collapsed: false,
      sidebarWidthMin: 160,
      overlayWMin: 200,
    });

    await realInput('overlay-expanded-pin', 'pin', {
      autoHide: false,
      open: false,
      collapsed: false,
      overlayW: 0,
      sidebarWidthMin: 160,
      panelXMin: 160,
    });

    // Persist expanded+fixed for phase 2, then also save a compact+autohide marker via disk check
    flushSave();
    {
      const userData = app.getPath('userData');
      const statePath = path.join(userData, 'multiheiz-state.json');
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!raw.ui || raw.ui.sidebarAutoHide !== false || raw.ui.sidebarCollapsed !== false) {
        throw new Error('disk should be fixed+expanded before compact persist: ' + JSON.stringify(raw.ui));
      }
    }

    // Leave compact+autohide on disk for phase 2
    await rendererEval('window.__multiheizUi.toggleSidebarCollapsed()');
    await ctxSleep(150);
    await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
    await ctxSleep(200);
    await waitForLayoutSettle();
    flushSave();
    {
      const userData = app.getPath('userData');
      const statePath = path.join(userData, 'multiheiz-state.json');
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!raw.ui || raw.ui.sidebarAutoHide !== true || raw.ui.sidebarCollapsed !== true) {
        throw new Error('disk should be autohide+compact for phase2: ' + JSON.stringify(raw.ui));
      }
      console.log('PASS: persistence prepared (autohide+compact)');
    }

    // --- Legacy: pin absent, arrow only ---
    await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(true)');
    await ctxSleep(300);
    await waitForLayoutSettle();
    m = await measure();
    if (!m.legacyAlwaysActive || m.pinVisible || !m.collapseVisible || !m.collapsed) {
      throw new Error('legacy start compact without pin: ' + JSON.stringify(readyBeforeSnapshot(m)));
    }
    console.log('PASS: legacy pin absent + compact', readyBeforeSnapshot(m));

    await realInput('legacy-expand', 'collapse', {
      legacyAlwaysActive: true,
      autoHide: false,
      collapsed: false,
      pinVisible: false,
      sidebarWidthMin: 160,
      panelXMin: 160,
      overlayW: 0,
    });

    await realInput('legacy-compact', 'collapse', {
      legacyAlwaysActive: true,
      autoHide: false,
      collapsed: true,
      pinVisible: false,
      sidebarWidthMin: 40,
      sidebarWidthMax: 70,
      panelXMin: 40,
      panelXMax: 90,
      overlayW: 0,
    });

    // Restore standard + leave autohide+compact for phase 2
    await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(false)');
    await ctxSleep(200);
    updateState((s) => {
      s.ui = { ...(s.ui || {}), sidebarAutoHide: true, sidebarCollapsed: true };
      s.settings = { ...s.settings, sidebarAlwaysActive: false };
    });
    flushSave();
    emitToRenderer({ type: 'state:changed', state: publicState() });
    await ctxSleep(200);

    const allOk = results.every((r) => r.ok);
    writeJson(resultPath, {
      ok: allOk,
      results,
      at: new Date().toISOString(),
      note: 'phase1 done; phase2 checks autohide+compact persistence',
    });

    try {
      server.close();
    } catch {
      /* ignore */
    }

    if (!allOk) {
      console.log('FAIL: realclick-sidebar2 one or more steps');
      app.exit(1);
      return;
    }
    console.log('PASS: realclick-sidebar2 phase1');
    app.exit(0);
  } catch (err) {
    writeJson(resultPath, {
      ok: false,
      error: String(err && err.message ? err.message : err),
      results,
      at: new Date().toISOString(),
    });
    console.error('FAIL: realclick-sidebar2', err);
    try {
      server.close();
    } catch {
      /* ignore */
    }
    app.exit(1);
  }
}

async function runPhase2Persistence(ctx) {
  const { rendererEval, sleep: ctxSleep, waitForLayoutSettle } = ctx;
  console.log('SELFTEST realclick-sidebar2 phase2 persistence');
  await ctxSleep(800);
  await waitForLayoutSettle();
  const mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode || mode.legacyAlwaysActive) {
    console.log('FAIL: phase2 should not be legacy', mode);
    app.exit(1);
    return;
  }
  if (!mode.autoHide || !mode.collapsed) {
    console.log('FAIL: phase2 should restore autohide+compact', mode);
    app.exit(1);
    return;
  }
  if (!mode.pinVisible || !mode.collapseVisible) {
    console.log('FAIL: phase2 both buttons visible', mode);
    app.exit(1);
    return;
  }
  console.log('PASS: realclick-sidebar2 phase2 persistence', {
    autoHide: mode.autoHide,
    collapsed: mode.collapsed,
    pinVisible: mode.pinVisible,
  });
  app.exit(0);
}

module.exports = { runRealclickSidebar2Selftest };
