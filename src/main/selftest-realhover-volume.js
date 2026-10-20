'use strict';

/**
 * Selftest: real OS mouse hover on volume icon → overlay popover.
 * MULTIHEIZ_SELFTEST=realhover-volume
 * Handshake via MULTIHEIZ_REALCLICK_DIR (tools/realhover-volume.js).
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
async function runRealhoverVolumeSelftest(ctx) {
  const {
    mainWindow,
    panels,
    popoverOverlay,
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

  console.log('SELFTEST realhover-volume');
  console.log('handshake dir:', dir);

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const WIN_X = 80;
  const WIN_Y = 80;
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

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>rhv</title></head>
<body style="margin:0;height:100vh;background:#1a3040;color:#fff;font:18px system-ui">
<div style="padding:24px">REALHOVER VOLUME</div>
</body></html>`;

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}/`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-rhv', name: 'RHV' }];
    s.activeWorkspaceId = 'ws-rhv';
    s.layout = '1';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace['ws-rhv'] = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-rhv',
        name: 'Áudio RH',
        color: '#2bb8a6',
        startUrl: base,
        workspaceId: 'ws-rhv',
        muted: false,
        volume: 120,
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
  });
  flushSave();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await ctxSleep(400);

  panels.createPanel('acc-rhv');
  {
    const [bw, bh] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: 'acc-rhv', x: 0, y: 80, width: bw, height: Math.max(240, bh - 80) },
    ]);
  }
  await ctxSleep(400);
  panels.panelNavigate('acc-rhv', base);
  await waitForUrl('acc-rhv', (u) => u.startsWith(base.replace(/\/$/, '')), 15000);
  await ctxSleep(600);
  if (typeof waitForLayoutSettle === 'function') await waitForLayoutSettle(1200);
  await rendererEval(
    'typeof window.__multiheizUi.syncNow === "function" && window.__multiheizUi.syncNow()'
  );
  await ctxSleep(300);

  const iconInfo = await rendererEval(`(() => {
    const btn = document.querySelector('.panel-slot[data-account-id="acc-rhv"] [data-role="panel-volume"]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    };
  })()`);
  assert(iconInfo && iconInfo.width > 4, 'volume icon rect: ' + JSON.stringify(iconInfo));

  const contentBounds = mainWindow.getContentBounds();
  const dipScale = (() => {
    try {
      const disp = screen.getDisplayMatching(contentBounds);
      return disp.scaleFactor || 1;
    } catch {
      return 1;
    }
  })();

  // Physical screen coords for SetCursorPos
  const physIconX = Math.round((contentBounds.x + iconInfo.x) * (process.platform === 'win32' ? 1 : 1));
  // On Windows Electron, getContentBounds is already in DIP; SetCursorPos wants physical.
  const scale = dipScale;
  const phys = {
    iconX: Math.round(contentBounds.x * scale + iconInfo.x * scale),
    iconY: Math.round(contentBounds.y * scale + iconInfo.y * scale),
    scale,
    contentBounds,
    iconInfo,
  };

  // Step 1: hover icon
  if (fs.existsSync(donePath)) fs.unlinkSync(donePath);
  writeJson(readyPath, {
    token: 'hover-icon-' + Date.now(),
    step: 'hover-icon',
    physX: phys.iconX,
    physY: phys.iconY,
    click: false,
    meta: phys,
  });
  await waitForFile(donePath, 60000);
  await ctxSleep(500);

  let dbg = await rendererEval('window.multiheiz.popoverSelftestDebug()');
  assert(dbg && dbg.popover && dbg.popover.id === 'volume-popover', 'popover open after hover: ' + JSON.stringify(dbg && dbg.popover));
  assert((dbg.spies || []).length === 0 || !(dbg.spies || []).some((s) => /capturePage|park/.test(s.op)), 'no snapshot spies');
  for (const p of dbg.panelStates || []) {
    assert(p.attached && p.visible !== false, 'panel live ' + JSON.stringify(p));
  }
  console.log('PASS: hover icon opened overlay popover', dbg.popover.bounds);

  const popBounds = dbg.popover.bounds;
  const popCenter = {
    x: popBounds.x + popBounds.width / 2,
    y: popBounds.y + popBounds.height / 2,
  };
  const physPop = {
    x: Math.round(contentBounds.x * scale + popCenter.x * scale),
    y: Math.round(contentBounds.y * scale + popCenter.y * scale),
  };

  // Step 2: move into popover (must stay open)
  if (fs.existsSync(donePath)) fs.unlinkSync(donePath);
  writeJson(readyPath, {
    token: 'hover-pop-' + Date.now(),
    step: 'hover-popover',
    physX: physPop.x,
    physY: physPop.y,
    click: false,
  });
  await waitForFile(donePath, 60000);
  await ctxSleep(400);
  dbg = await rendererEval('window.multiheiz.popoverSelftestDebug()');
  assert(dbg && dbg.popover && dbg.popover.id === 'volume-popover', 'stays open over popover');
  console.log('PASS: hover into popover keeps open');

  // Step 3: move far away → close
  if (fs.existsSync(donePath)) fs.unlinkSync(donePath);
  writeJson(readyPath, {
    token: 'hover-away-' + Date.now(),
    step: 'hover-away',
    physX: Math.round(contentBounds.x * scale + 40 * scale),
    physY: Math.round(contentBounds.y * scale + 40 * scale),
    click: false,
  });
  await waitForFile(donePath, 60000);
  await ctxSleep(700);
  dbg = await rendererEval('window.multiheiz.popoverSelftestDebug()');
  assert(!dbg.popover, 'closed after leave: ' + JSON.stringify(dbg.popover));
  console.log('PASS: leave closes popover');

  writeJson(resultPath, {
    ok: true,
    phys,
    popBounds,
  });

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest realhover-volume complete');
  app.exit(0);
}

module.exports = { runRealhoverVolumeSelftest };
