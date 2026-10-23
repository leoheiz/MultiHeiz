'use strict';

/**
 * Selftest: experimental always-on-top mini player (lock, opacity, globalShortcut).
 * MULTIHEIZ_SELFTEST=miniplayer
 */

const http = require('node:http');
const { app, globalShortcut } = require('electron');

async function runMiniPlayerSelftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
    waitForPanels,
    miniPlayer,
    emitToRenderer,
    publicState,
  } = ctx;

  console.log('SELFTEST miniplayer');
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mini</title></head>
<body style="margin:0;background:#102030;color:#eee;font:16px sans-serif;padding:16px">
<h1>mini player</h1>
<video id="v" width="320" height="180" autoplay muted loop playsinline
  style="display:block;width:320px;height:180px;background:#000"></video>
<canvas id="c" width="320" height="180" style="display:none"></canvas>
<script>
(function(){
  var c = document.getElementById('c');
  var ctx = c.getContext('2d');
  function frame(t) {
    ctx.fillStyle = '#203040';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#e8a838';
    ctx.fillRect((t / 16) % 320, 40, 40, 100);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  var v = document.getElementById('v');
  v.srcObject = c.captureStream(24);
  v.play().catch(function(){});
  window.__miniReady = true;
})();
</script>
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
  const base = `http://127.0.0.1:${port}`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-mini', name: 'Mini' }];
    s.activeWorkspaceId = 'ws-mini';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-mini',
        name: 'Mini',
        color: '#e8a838',
        startUrl: base + '/',
        workspaceId: 'ws-mini',
        muted: false,
        volume: 100,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    if (!s.settings) s.settings = {};
    s.settings.miniPlayerOpacity = 80;
    s.settings.openLastPage = false;
    s.settings.homepage = base + '/';
    s.miniPlayer = { width: 400, height: 260, opacityPercent: 80, x: -20000, y: 40 };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(800);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-mini' && p.visible));
  await waitForUrl('acc-mini', (u) => u.includes('127.0.0.1'), 30000);
  await sleep(400);

  const wc = panels.getPanelCapture('acc-mini');
  assert(wc && !wc.isDestroyed(), 'panel wc');
  for (let i = 0; i < 30; i++) {
    const ready = await wc.executeJavaScript('!!window.__miniReady', false);
    if (ready) break;
    await sleep(100);
  }

  const opened = await miniPlayer.open('acc-mini');
  assert(opened && opened.ok, 'open mini player', opened);
  await sleep(600);

  let snap = miniPlayer.getSelftestSnapshot();
  assert(snap.open, 'mini open');
  assert(snap.alwaysOnTop, 'isAlwaysOnTop');
  assert(Math.abs(snap.opacity - 0.8) < 0.05, 'opacity ~0.8', snap);
  assert(snap.shortcutRegistered, 'globalShortcut registered while open', snap);
  const accel = snap.registeredAccel;
  assert(accel && globalShortcut.isRegistered(accel), 'isRegistered true', accel);
  console.log('PASS: open alwaysOnTop opacity shortcut');

  miniPlayer.setOpacityPercent(55);
  await sleep(100);
  snap = miniPlayer.getSelftestSnapshot();
  assert(Math.abs(snap.opacity - 0.55) < 0.05, 'opacity matches set value', snap);
  console.log('PASS: setOpacity');

  miniPlayer.applyLock(true);
  await sleep(100);
  snap = miniPlayer.getSelftestSnapshot();
  assert(snap.locked, 'locked flag');
  assert(snap.ignoreMouseEvents, 'ignoreMouseEvents when locked');
  assert(snap.focusable === false, 'not focusable when locked');
  console.log('PASS: lock');

  miniPlayer.applyLock(false);
  await sleep(100);
  snap = miniPlayer.getSelftestSnapshot();
  assert(!snap.locked, 'unlocked');
  assert(!snap.ignoreMouseEvents, 'mouse events restored');
  assert(snap.focusable === true, 'focusable restored');
  console.log('PASS: unlock');

  miniPlayer.close();
  await sleep(200);
  snap = miniPlayer.getSelftestSnapshot();
  assert(!snap.open, 'closed');
  assert(!snap.shortcutRegistered, 'shortcut unregistered after close');
  if (accel) {
    assert(!globalShortcut.isRegistered(accel), 'isRegistered false after close');
  }
  console.log('PASS: close unregisters shortcut');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  // Ensure no leftover global shortcuts from this test
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest:miniplayer complete');
  app.exit(0);
}

module.exports = { runMiniPlayerSelftest };
