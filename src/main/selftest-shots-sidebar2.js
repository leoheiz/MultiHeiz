'use strict';

/**
 * Screenshots of dual-button sidebar states (MULTIHEIZ_SELFTEST=shots-sidebar2).
 * Output dir: MULTIHEIZ_SHOTS_OUT (default handled by tools/shots-sidebar2.js).
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { envGet } = require('./config');

async function runShotsSidebar2(ctx) {
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
  } = ctx;

  const outDir = path.resolve(String(envGet('MULTIHEIZ_SHOTS_OUT') || '').trim());
  if (!outDir) {
    console.log('FAIL: MULTIHEIZ_SHOTS_OUT missing');
    app.exit(1);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  console.log('SELFTEST shots-sidebar2 →', outDir);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  const WIN_W = 1280;
  const WIN_H = 800;
  try {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
  } catch {
    /* ignore */
  }
  try {
    mainWindow.setBounds({ x: 60, y: 60, width: WIN_W, height: WIN_H });
  } catch {
    mainWindow.setSize(WIN_W, WIN_H);
  }
  mainWindow.show();
  await sleep(300);

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>shot</title></head>
<body style="margin:0;height:100vh;background:linear-gradient(135deg,#e85d4c,#f0c14a,#2bb8a6,#3d8bfd);color:#fff;font:bold 36px system-ui">
<div style="padding:28px;text-shadow:0 2px 8px rgba(0,0,0,.4)">SIDEBAR2 SHOT</div>
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
    s.workspaces = [{ id: 'ws-shot', name: 'Shots' }];
    s.activeWorkspaceId = 'ws-shot';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-shot-a',
        name: 'Painel A',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-shot',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-shot-b',
        name: 'Painel B',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-shot',
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
  await sleep(700);
  await waitForLayoutSettle();
  await waitForUrl('acc-shot-a', (u) => u.includes('127.0.0.1'), 30000);
  await waitForUrl('acc-shot-b', (u) => u.includes('127.0.0.1'), 30000);
  await waitForPanels(
    (i) =>
      i.panels.filter((p) => (p.accountId === 'acc-shot-a' || p.accountId === 'acc-shot-b') && p.visible)
        .length >= 2
  );

  async function shot(name) {
    await sleep(180);
    let img = null;
    try {
      if (typeof mainWindow.capturePage === 'function') {
        img = await mainWindow.capturePage();
      }
    } catch (err) {
      console.log('capturePage failed', name, err && err.message);
    }
    if (!img || img.isEmpty()) {
      console.log('FAIL: empty shot', name);
      app.exit(1);
      return false;
    }
    const file = path.join(outDir, name);
    fs.writeFileSync(file, img.toPNG());
    console.log('SHOT:', file);
    return true;
  }

  await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(false)');
  updateState((s) => {
    s.ui = { ...(s.ui || {}), sidebarAutoHide: false, sidebarCollapsed: false };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();
  if (!(await shot('default-pinned-expanded.png'))) return;

  await rendererEval('window.__multiheizUi.toggleSidebarCollapsed()');
  await sleep(250);
  await waitForLayoutSettle();
  if (!(await shot('default-pinned-compact.png'))) return;

  await rendererEval('window.__multiheizUi.toggleSidebarCollapsed()');
  await sleep(150);
  await rendererEval('window.__multiheizUi.toggleSidebarAutoHide()');
  await sleep(200);
  await rendererEval('window.__multiheizUi.setSidebarAutoHideOpen(true)');
  await sleep(350);
  await waitForLayoutSettle();
  if (!(await shot('default-autohide-revealed.png'))) return;

  await rendererEval('window.__multiheizUi.setSidebarAlwaysActive(true)');
  await sleep(300);
  await waitForLayoutSettle();
  let mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (!mode.collapsed) {
    await rendererEval('window.__multiheizUi.toggleSidebarCollapsed()');
    await sleep(200);
    await waitForLayoutSettle();
  }
  if (!(await shot('legacy-compact.png'))) return;

  await rendererEval('window.__multiheizUi.toggleSidebarCollapsed()');
  await sleep(250);
  await waitForLayoutSettle();
  mode = await rendererEval('window.__multiheizUi.getSidebarMode()');
  if (mode.collapsed) {
    console.log('FAIL: legacy expand for shot', mode);
    app.exit(1);
    return;
  }
  if (!(await shot('legacy-expanded.png'))) return;

  try {
    server.close();
  } catch {
    /* ignore */
  }
  console.log('PASS: shots-sidebar2');
  app.exit(0);
}

module.exports = { runShotsSidebar2 };
