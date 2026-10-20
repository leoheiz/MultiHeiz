'use strict';

/**
 * Selftest: real OS mouse hover for F11 sidebar edge-reveal
 * (MULTIHEIZ_SELFTEST=realhover-fullscreen).
 * Handshake via files in MULTIHEIZ_REALCLICK_DIR (tools/realhover-fullscreen.js).
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
async function runRealhoverFullscreenSelftest(ctx) {
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
    chromeFullscreen,
  } = ctx;

  const dir = handshakeDir();
  const readyPath = path.join(dir, 'ready.json');
  const donePath = path.join(dir, 'done.json');
  const resultPath = path.join(dir, 'result.json');

  console.log('SELFTEST realhover-fullscreen');
  console.log('handshake dir:', dir);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  const WIN_X = 60;
  const WIN_Y = 60;
  const WIN_W = 1280;
  const WIN_H = 800;
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
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>rh</title></head>
<body style="margin:0;height:100vh;background:#1a3040;color:#fff;font:20px system-ui">
<div style="padding:24px">REALHOVER FS PANEL</div>
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
    s.workspaces = [{ id: 'ws-rh', name: 'RealHover' }];
    s.activeWorkspaceId = 'ws-rh';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-rh',
        name: 'Painel RH',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-rh',
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
  await waitForUrl('acc-rh', (u) => u.includes('127.0.0.1'), 30000);
  await waitForLayoutSettle();

  const results = [];

  function near(a, b, tol = 6) {
    return Math.abs(a - b) <= tol;
  }

  function panelBounds() {
    const info = panels.getPanelDebugInfo();
    const p = info.panels.find((x) => x.accountId === 'acc-rh');
    return { bounds: p && p.bounds, overlayW: info.sidebarOverlayWidth };
  }

  /**
   * Ask orchestrator to move (and optionally click) at physical screen coords.
   * @param {string} modeName
   * @param {string} step
   * @param {{ x: number, y: number }} phys
   * @param {number} scale
   * @param {boolean} [click]
   */
  async function requestHover(modeName, step, phys, scale, click) {
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
    const payload = {
      mode: modeName,
      step,
      click: !!click,
      scaleFactor: scale,
      physical: { x: phys.x, y: phys.y },
      token,
    };
    writeJson(readyPath, payload);
    console.log('REALHOVER_READY', modeName, step, 'phys=', phys.x, phys.y, 'click=', !!click);
    const done = await waitForFile(donePath, 60000);
    if (!done || done.token !== token) {
      throw new Error('done token mismatch for ' + step);
    }
    await ctxSleep(200);
  }

  /**
   * @param {string} modeName
   * @param {'default' | 'legacy'} kind
   */
  async function runMode(modeName, kind) {
    mainWindow.show();
    mainWindow.focus();
    try {
      mainWindow.moveTop();
    } catch {
      /* ignore */
    }
    await ctxSleep(200);

    // Ensure windowed bounds before F11 so we can restore later.
    try {
      if (mainWindow.isFullScreen()) {
        chromeFullscreen.exit();
        await ctxSleep(400);
      }
    } catch {
      /* ignore */
    }
    try {
      mainWindow.setBounds({ x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H });
    } catch {
      /* ignore */
    }
    await ctxSleep(150);

    if (kind === 'legacy') {
      await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(true)');
    } else {
      await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(false)');
      // Fixed mode (default)
      const m0 = await rendererEval('window.__multiheizUi.getSidebarMode()');
      if (m0 && m0.autoHide) {
        await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
      }
    }
    await ctxSleep(200);
    await waitForLayoutSettle();

    const before = await rendererEval('window.__multiheizUi.getSidebarMode()');
    const beforePrefs = {
      autoHide: !!(before && before.autoHide),
      legacyAlwaysActive: !!(before && before.legacyAlwaysActive),
      collapsed: !!(before && before.collapsed),
    };

    chromeFullscreen.enter();
    await ctxSleep(600);
    await waitForLayoutSettle();
    await ctxSleep(400);

    if (!mainWindow.isFullScreen() || !chromeFullscreen.isChromeHidden()) {
      throw new Error('failed to enter F11');
    }

    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const scale = Number(display.scaleFactor) || 1;
    // Physical x=0 on the display of the fullscreen window; mid height.
    const edgePhysX = Math.round(bounds.x * scale);
    const midPhysY = Math.round((bounds.y + bounds.height / 2) * scale);
    const centerPhysX = Math.round((bounds.x + bounds.width / 2) * scale);

    let mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    if (!mode.chromeHidden || mode.open || mode.hotzoneHidden) {
      throw new Error('F11 start should be closed with hotzone: ' + JSON.stringify(mode));
    }

    // --- Edge hover → reveal ---
    await requestHover(modeName, 'edge-reveal', { x: edgePhysX, y: midPhysY }, scale, false);
    await ctxSleep(350);
    await waitForLayoutSettle();
    mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    const openB = panelBounds();
    if (!mode.open) {
      throw new Error('edge hover did not reveal: ' + JSON.stringify(mode));
    }
    if (kind === 'legacy' && beforePrefs.collapsed) {
      // Legacy compact: overlay ~52px icon rail.
      if (!(openB.overlayW >= 40 && openB.overlayW <= 70) || !near(openB.bounds.x, openB.overlayW, 8)) {
        throw new Error('legacy compact overlay should be ~52px: ' + JSON.stringify(openB));
      }
    } else if (!(openB.overlayW >= 200) || !near(openB.bounds.x, openB.overlayW, 8)) {
      throw new Error('panels not shifted left of overlay: ' + JSON.stringify(openB));
    }
    console.log('PASS', modeName, 'edge reveal + overlay above/left of panels', openB);

    // --- Center → hide after delay ---
    await requestHover(modeName, 'center-hide', { x: centerPhysX, y: midPhysY }, scale, false);
    await ctxSleep(900);
    await waitForLayoutSettle();
    mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    if (mode.open) {
      throw new Error('center leave did not hide: ' + JSON.stringify(mode));
    }
    console.log('PASS', modeName, 'center hide');

    // --- Reveal + real pin click → stays open ---
    await requestHover(modeName, 'edge-before-pin', { x: edgePhysX, y: midPhysY }, scale, false);
    await ctxSleep(350);
    await waitForLayoutSettle();
    mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    if (!mode.open || !mode.pinCenter) {
      throw new Error('need open sidebar + pinCenter before pin click: ' + JSON.stringify(mode));
    }
    const pin = mode.pinCenter;
    // pinCenter is content-relative; fullscreen uses window/content origin ≈ bounds.
    const pinPhysX = Math.round((bounds.x + pin.x) * scale);
    const pinPhysY = Math.round((bounds.y + pin.y) * scale);
    await requestHover(modeName, 'pin-click', { x: pinPhysX, y: pinPhysY }, scale, true);
    await ctxSleep(400);
    await waitForLayoutSettle();
    mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    if (!mode.fsPinned || !mode.open) {
      throw new Error('pin click should fs-pin open: ' + JSON.stringify(mode));
    }
    await requestHover(modeName, 'center-while-pinned', { x: centerPhysX, y: midPhysY }, scale, false);
    await ctxSleep(900);
    mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    if (!mode.open || !mode.fsPinned) {
      throw new Error('pinned must stay open at center: ' + JSON.stringify(mode));
    }
    console.log('PASS', modeName, 'pin keeps open');

    // --- Unpin ---
    mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    const pin2 = mode.pinCenter;
    const unpinPhysX = Math.round((bounds.x + pin2.x) * scale);
    const unpinPhysY = Math.round((bounds.y + pin2.y) * scale);
    await requestHover(modeName, 'unpin-click', { x: unpinPhysX, y: unpinPhysY }, scale, true);
    await ctxSleep(400);
    await waitForLayoutSettle();
    mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    if (mode.fsPinned || mode.open) {
      throw new Error('unpin should close: ' + JSON.stringify(mode));
    }
    console.log('PASS', modeName, 'unpin');

    // --- Exit F11 → restore prefs ---
    chromeFullscreen.exit();
    await ctxSleep(500);
    await waitForLayoutSettle();
    mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
    if (mode.chromeHidden || mode.fsPinned) {
      throw new Error('leave F11 should clear chrome-hidden: ' + JSON.stringify(mode));
    }
    if (mode.autoHide !== beforePrefs.autoHide) {
      throw new Error('autoHide pref changed: ' + JSON.stringify({ beforePrefs, mode }));
    }
    if (mode.legacyAlwaysActive !== beforePrefs.legacyAlwaysActive) {
      throw new Error('legacy pref changed: ' + JSON.stringify({ beforePrefs, mode }));
    }
    if (kind === 'default' && (mode.autoHide || mode.overlayMode)) {
      throw new Error('default should restore fixed: ' + JSON.stringify(mode));
    }
    if (kind === 'legacy' && (!mode.legacyAlwaysActive || mode.overlayMode)) {
      throw new Error('legacy should restore without overlay: ' + JSON.stringify(mode));
    }
    if (kind === 'legacy' && mode.collapsed !== beforePrefs.collapsed) {
      throw new Error('legacy compact/expand changed after F11: ' + JSON.stringify({ beforePrefs, mode }));
    }
    console.log('PASS', modeName, 'exit F11 restores mode', beforePrefs);

    results.push({ mode: modeName, ok: true, beforePrefs });
    return true;
  }

  try {
    await runMode('default-fixed', 'default');
    await runMode('legacy', 'legacy');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.log('FAIL:', msg);
    writeJson(resultPath, { ok: false, error: msg, results });
    writeJson(readyPath, { done: true, token: 'done-' + Date.now() });
    try {
      server.close();
    } catch {
      /* ignore */
    }
    chromeFullscreen.destroyHint();
    chromeFullscreen.ensureNotAlwaysOnTop();
    app.exit(1);
    return;
  }

  writeJson(resultPath, { ok: true, results });
  writeJson(readyPath, { done: true, token: 'done-' + Date.now() });
  try {
    server.close();
  } catch {
    /* ignore */
  }
  chromeFullscreen.destroyHint();
  chromeFullscreen.ensureNotAlwaysOnTop();
  console.log('PASS: selftest realhover-fullscreen complete');
  app.exit(0);
}

module.exports = { runRealhoverFullscreenSelftest };
