'use strict';

/**
 * Selftest: real OS mouse click on sidebar pin / collapse (MULTIHEIZ_SELFTEST=realclick-sidebar).
 * Handshake via files in MULTIHEIZ_REALCLICK_DIR (orchestrated by tools/realclick-sidebar.js).
 * Standard: #btn-sidebar-pin (auto-hide). Legacy: #btn-sidebar-collapse (compact/expand).
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
async function runRealclickSidebarSelftest(ctx) {
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

  console.log('SELFTEST realclick-sidebar');
  console.log('handshake dir:', dir);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  // Visible, known position (orchestrator will click with real OS mouse).
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
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>rc</title></head>
<body style="margin:0;height:100vh;background:#2bb8a6;color:#fff;font:24px system-ui">
<div style="padding:24px">REALCLICK PANEL</div>
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
    s.workspaces = [{ id: 'ws-rc', name: 'RealClick' }];
    s.activeWorkspaceId = 'ws-rc';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-rc-a',
        name: 'Painel A',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-rc',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-rc-b',
        name: 'Painel B',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-rc',
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
  await waitForUrl('acc-rc-a', (u) => u.includes('127.0.0.1'), 30000);
  await waitForUrl('acc-rc-b', (u) => u.includes('127.0.0.1'), 30000);
  await waitForLayoutSettle();

  const results = [];

  /**
   * @param {string} modeName
   * @param {'autoHide' | 'legacyCollapse'} expectKind
   */
  async function runMode(modeName, expectKind) {
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
    await ctxSleep(250);
    // Ensure content bounds match known on-screen position (DPI-safe DIP).
    try {
      mainWindow.setBounds({ x: WIN_X, y: WIN_Y, width: WIN_W, height: WIN_H });
    } catch {
      /* ignore */
    }
    await ctxSleep(150);

    const before = await rendererEval('window.__multiheizUi.getSidebarMode()');
    const btnId =
      expectKind === 'legacyCollapse' ? 'btn-sidebar-collapse' : 'btn-sidebar-pin';
    const hit = await rendererEval(`(function(){
      const btn = document.getElementById(${JSON.stringify(btnId)});
      if (!btn || btn.classList.contains('hidden')) return null;
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const topEl = document.elementFromPoint(cx, cy);
      const topbar = document.getElementById('topbar');
      const spacer = topbar && topbar.querySelector('.spacer');
      const regionOf = (el) => {
        if (!el) return '';
        const cs = getComputedStyle(el);
        return cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || '';
      };
      const ancestors = [];
      let n = btn;
      while (n && n !== document.documentElement) {
        ancestors.push({
          tag: n.id ? n.tagName.toLowerCase() + '#' + n.id : (n.className ? n.tagName.toLowerCase() + '.' + String(n.className).split(' ')[0] : n.tagName.toLowerCase()),
          region: regionOf(n),
        });
        n = n.parentElement;
      }
      return {
        btnId: ${JSON.stringify(btnId)},
        btnRect: { left: r.left, top: r.top, width: r.width, height: r.height, cx, cy },
        elementFromPoint: topEl ? (topEl.id || topEl.className || topEl.tagName) : null,
        topbarRect: topbar ? (() => { const t = topbar.getBoundingClientRect(); return { left: t.left, top: t.top, width: t.width, height: t.height }; })() : null,
        topbarRegion: regionOf(topbar),
        spacerRegion: regionOf(spacer),
        ancestors,
        viewTargets: window.__multiheizUi.getViewTargetRects ? window.__multiheizUi.getViewTargetRects() : [],
      };
    })()`);

    const contentBounds = mainWindow.getContentBounds();
    const display = screen.getDisplayMatching(contentBounds);
    const scale = Number(display.scaleFactor) || 1;
    const cx = hit && hit.btnRect ? hit.btnRect.cx : 0;
    const cy = hit && hit.btnRect ? hit.btnRect.cy : 0;
    // SetCursorPos wants physical pixels; Electron bounds are DIP.
    const physX = Math.round((contentBounds.x + cx) * scale);
    const physY = Math.round((contentBounds.y + cy) * scale);

    const panelInfo = panels.getPanelDebugInfo ? panels.getPanelDebugInfo() : null;
    const covering = [];
    if (panelInfo && Array.isArray(panelInfo.panels) && hit && hit.btnRect) {
      const bx = hit.btnRect.cx;
      const by = hit.btnRect.cy;
      for (const p of panelInfo.panels) {
        const b = p.bounds;
        if (!b || !p.visible || p.parked) continue;
        if (bx >= b.x && bx < b.x + b.width && by >= b.y && by < b.y + b.height) {
          covering.push({ accountId: p.accountId || p.id, bounds: b });
        }
      }
    }

    const payload = {
      mode: modeName,
      expectKind,
      before: {
        autoHide: !!(before && before.autoHide),
        collapsed: !!(before && before.collapsed),
        legacyAlwaysActive: !!(before && before.legacyAlwaysActive),
        open: !!(before && before.open),
      },
      contentBounds,
      scaleFactor: scale,
      client: { x: cx, y: cy },
      physical: { x: physX, y: physY },
      hit,
      coveringViews: covering,
      token: String(Date.now()),
    };
    writeJson(readyPath, payload);
    console.log('REALCLICK_READY', modeName, 'phys=', physX, physY, 'covering=', covering.length);

    const done = await waitForFile(donePath, 60000);
    if (!done || done.token !== payload.token) {
      console.log('FAIL: done token mismatch', done);
      app.exit(1);
      return null;
    }
    await ctxSleep(350);
    await waitForLayoutSettle();

    const after = await rendererEval('window.__multiheizUi.getSidebarMode()');
    let ok = false;
    let detail = '';
    if (expectKind === 'autoHide') {
      ok = !!(after && after.autoHide !== before.autoHide);
      detail = `autoHide ${before.autoHide} -> ${after && after.autoHide}`;
      // Toggle back so the next step starts from a known state when needed
      if (ok && after.autoHide) {
        // Leave auto-hide on for a second click path only if requested; default mode test toggles once.
      }
    } else if (expectKind === 'legacyCollapse') {
      ok = !!(after && after.collapsed !== before.collapsed && after.legacyAlwaysActive);
      detail = `collapsed ${before.collapsed} -> ${after && after.collapsed}`;
    }

    const entry = {
      mode: modeName,
      expectKind,
      ok,
      detail,
      before: payload.before,
      after: after
        ? {
            autoHide: !!after.autoHide,
            collapsed: !!after.collapsed,
            legacyAlwaysActive: !!after.legacyAlwaysActive,
            open: !!after.open,
            headAppRegion: after.headAppRegion,
            pinAppRegion: after.pinAppRegion,
          }
        : null,
      physical: payload.physical,
      coveringViews: covering,
      elementFromPoint: hit && hit.elementFromPoint,
      topbarRegion: hit && hit.topbarRegion,
      spacerRegion: hit && hit.spacerRegion,
    };
    results.push(entry);
    console.log(ok ? 'PASS:' : 'FAIL:', 'realclick', modeName, detail, entry);
    return entry;
  }

  // --- Mode padrão: fixed → click enables auto-hide ---
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

  const def1 = await runMode('default-enable-autohide', 'autoHide');
  if (!def1) return;

  // Still in auto-hide (hidden). Reveal then click pin to go back to fixed.
  await rendererEval('window.__multiheizUi.setSidebarAutoHideOpen(true)');
  await ctxSleep(300);
  await waitForLayoutSettle();
  const def2 = await runMode('default-pin-while-open', 'autoHide');
  if (!def2) return;

  // --- Modo legado: inicia compacto → expand → compact ---
  await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(true)');
  updateState((s) => {
    s.ui = { ...(s.ui || {}), sidebarAutoHide: false, sidebarCollapsed: true };
    s.settings = { ...s.settings, sidebarAlwaysActive: true };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await ctxSleep(400);
  await waitForLayoutSettle();
  await rendererEval('window.__multiheizUi.syncSidebarAfterLegacyChange()');
  await waitForLayoutSettle();

  const leg1 = await runMode('legacy-expand', 'legacyCollapse');
  if (!leg1) return;
  const leg2 = await runMode('legacy-compact', 'legacyCollapse');
  if (!leg2) return;

  const allOk = results.every((r) => r.ok);
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

  if (!allOk) {
    console.log('FAIL: realclick-sidebar one or more modes');
    app.exit(1);
    return;
  }
  console.log('PASS: realclick-sidebar all modes');
  app.exit(0);
}

module.exports = { runRealclickSidebarSelftest };
