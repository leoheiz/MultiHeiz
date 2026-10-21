'use strict';

/**
 * Selftest: indicador de FPS na barra de status (MULTIHEIZ_SELFTEST=fps).
 * Após o lançamento, #stat-fps mostra um número (não "—") em ~3 s.
 * Com a janela minimizada/oculta o loop rAF para; ao restaurar, volta o número.
 */

const http = require('node:http');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runFpsSelftest(ctx) {
  const {
    mainWindow,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    rendererEval,
    waitForLayoutSettle,
  } = ctx;

  console.log('SELFTEST fps');

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  function assert(cond, msg, detail) {
    if (!cond) {
      console.log('FAIL:', msg, detail != null ? detail : '');
      throw new Error(msg + (detail != null ? ': ' + JSON.stringify(detail) : ''));
    }
  }

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><body style="margin:0;background:#234;color:#fff;padding:24px;font:18px sans-serif">fps</body></html>`;
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
  const base = `http://127.0.0.1:${port}`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-fps', name: 'FPS' }];
    s.activeWorkspaceId = 'ws-fps';
    s.layout = '1';
    s.page = 0;
    s.accounts = [
      {
        id: 'acc-fps-1',
        name: 'FPS',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-fps',
        muted: false,
        lastUrl: null,
      },
    ];
    s.ui = { ...(s.ui || {}), sidebarCollapsed: false, layoutLocked: true };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } catch {
    /* ignore */
  }
  await waitForLayoutSettle();
  await waitForUrl('acc-fps-1', (u) => u.includes('127.0.0.1'), 20000).catch(() => {});

  async function probe() {
    return rendererEval('window.__multiheizUi.getFpsProbe()');
  }

  // Within ~3s the status bar must show a number (not "—").
  let seen = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 3500) {
    seen = await probe();
    if (seen && seen.fps > 0 && /FPS\s+\d+/.test(seen.text || '') && !/—/.test(seen.text || '')) {
      break;
    }
    await sleep(150);
  }
  assert(
    seen && seen.fps > 0 && /FPS\s+\d+/.test(seen.text || ''),
    'FPS number within 3s',
    seen
  );
  assert(seen.running, 'rAF loop running while visible', seen);
  console.log('PASS: status bar FPS', seen.text);

  // Minimize → counter stops (no rAF loop). window:visibility from main pauses it.
  try {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
  } catch {
    /* ignore */
  }
  mainWindow.minimize();
  await sleep(500);
  let hiddenProbe = await probe();
  if (hiddenProbe && hiddenProbe.running) {
    // Fallback: hide (also emits window:visibility)
    try {
      mainWindow.hide();
    } catch {
      /* ignore */
    }
    await sleep(400);
    hiddenProbe = await probe();
  }
  assert(!hiddenProbe.running, 'FPS rAF paused when minimized/hidden', hiddenProbe);
  console.log('PASS: FPS probe paused when hidden', hiddenProbe);

  // Restore → number again.
  try {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } catch {
    /* ignore */
  }
  await sleep(300);

  let restored = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 3500) {
    restored = await probe();
    if (
      restored &&
      restored.running &&
      restored.fps > 0 &&
      /FPS\s+\d+/.test(restored.text || '')
    ) {
      break;
    }
    await sleep(150);
  }
  assert(
    restored && restored.running && restored.fps > 0,
    'FPS number after restore',
    restored
  );
  console.log('PASS: FPS restored after show', restored.text);

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest fps');
  app.exit(0);
}

module.exports = { runFpsSelftest };
