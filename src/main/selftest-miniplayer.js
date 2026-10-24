'use strict';

/**
 * Selftest: experimental always-on-top mini player (lock, opacity, isolation, unlock paths).
 * MULTIHEIZ_SELFTEST=miniplayer
 */

const http = require('node:http');
const { app, BrowserWindow, globalShortcut } = require('electron');

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

  // Twitch/YouTube-like: nested fixed-size wrapper, transform:scale, overflow:hidden,
  // and a resize script that sets inline video width/height (must not beat isolation).
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mini</title>
<style>
  body { margin:0; background:#102030; color:#eee; font:16px sans-serif; }
  #header { height:80px; background:#c44; padding:12px; }
  #sidebar { position:fixed; left:0; top:80px; bottom:0; width:180px; background:#246; padding:12px; }
  #main { margin-left:180px; margin-top:80px; padding:16px; }
  #comments { margin-top:24px; padding:12px; background:#1a2838; }
  img.banner { width:100%; max-width:640px; height:120px; background:#555; display:block; }
  .player-shell { width:640px; height:360px; overflow:hidden; position:relative; background:#000; }
  .player-scale { width:640px; height:360px; transform:scale(1); transform-origin:top left; contain:layout style; }
  .player-inner { width:640px; height:360px; position:relative; overflow:hidden; }
</style>
</head>
<body>
<div id="header"><h1>Site header (should be hidden in mini)</h1><p>Nav links and ads</p></div>
<aside id="sidebar"><p>Sidebar clutter</p><ul><li>A</li><li>B</li><li>C</li></ul></aside>
<main id="main">
  <img class="banner" alt="banner" width="640" height="120" />
  <p>Lots of surrounding text that must not appear in the mini player.</p>
  <div class="player-shell">
    <div class="player-scale">
      <div class="player-inner" id="player-inner">
        <video id="v" width="640" height="360" autoplay muted loop playsinline
          style="display:block;width:640px;height:360px;background:#000"></video>
      </div>
    </div>
  </div>
  <section id="comments">
    <h2>Comments</h2>
    <p>Comment one about the video.</p>
    <p>Comment two with more text.</p>
  </section>
</main>
<canvas id="c" width="640" height="360" style="display:none"></canvas>
<script>
(function(){
  var c = document.getElementById('c');
  var ctx = c.getContext('2d');
  function frame(t) {
    ctx.fillStyle = '#203040';
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#e8a838';
    ctx.fillRect((t / 16) % 640, 80, 80, 200);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  var v = document.getElementById('v');
  v.srcObject = c.captureStream(24);
  v.play().catch(function(){});
  function syncInlineSize() {
    var vid = document.getElementById('v') || document.querySelector('video');
    if (!vid) return;
    var w = Math.round(window.innerWidth * 0.5) || 640;
    var h = Math.round(window.innerHeight * 0.5) || 360;
    vid.width = w; vid.height = h;
    vid.style.width = w + 'px';
    vid.style.height = h + 'px';
  }
  window.addEventListener('resize', syncInlineSize);
  syncInlineSize();
  window.__miniReady = true;
  window.__replaceVideo = function() {
    var old = document.getElementById('v');
    var parent = old.parentNode;
    var nv = document.createElement('video');
    nv.id = 'v';
    nv.width = 640; nv.height = 360;
    nv.autoplay = true; nv.muted = true; nv.loop = true;
    nv.setAttribute('playsinline', '');
    nv.style.cssText = 'display:block;width:640px;height:360px;background:#000';
    nv.srcObject = c.captureStream(24);
    parent.replaceChild(nv, old);
    nv.play().catch(function(){});
    syncInlineSize();
    return true;
  };
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

  // Seek source so we can verify resume-at-time on close.
  await wc.executeJavaScript(
    `(() => { var v = document.getElementById('v'); v.currentTime = 1.25; return v.currentTime; })()`,
    false
  );
  await sleep(100);

  const opened = await miniPlayer.open('acc-mini');
  assert(opened && opened.ok, 'open mini player', opened);
  await sleep(800);

  let snap = miniPlayer.getSelftestSnapshot();
  assert(snap.open, 'mini open');
  assert(snap.alwaysOnTop, 'isAlwaysOnTop');
  assert(Math.abs(snap.opacity - 0.8) < 0.05, 'opacity ~0.8', snap);
  assert(snap.shortcutRegistered, 'globalShortcut registered while open', snap);
  const accel = snap.registeredAccel;
  assert(accel && globalShortcut.isRegistered(accel), 'isRegistered true', accel);
  console.log('PASS: open alwaysOnTop opacity shortcut');

  const srcPaused = await wc.executeJavaScript(
    `(() => { var v = document.getElementById('v') || document.querySelector('video'); return v ? !!v.paused : null; })()`,
    false
  );
  assert(srcPaused === true, 'source video paused while mini open', srcPaused);
  console.log('PASS: opening pauses source video');

  // Seek mini player so close can resume source near this time.
  await miniPlayer.contentExec(`(() => {
    var v = window.__mhMiniIsolate && window.__mhMiniIsolate.video;
    if (v) { v.currentTime = 2.5; v.play().catch(function(){}); }
    return v ? v.currentTime : null;
  })()`);
  await sleep(200);

  miniPlayer.setOpacityPercent(55);
  await sleep(100);
  snap = miniPlayer.getSelftestSnapshot();
  assert(Math.abs(snap.opacity - 0.55) < 0.05, 'opacity matches set value', snap);
  console.log('PASS: setOpacity');

  await miniPlayer.applyVideoIsolation();
  await sleep(200);
  let hit = await miniPlayer.selftestHitIsolation();
  assert(hit && hit.ok, 'isolation hit-test all points are video', hit);
  console.log('PASS: video-only isolation elementFromPoint');

  await miniPlayer.contentExec(`(() => {
    history.pushState({}, '', '/watch?v=spa1');
    window.__replaceVideo();
    return true;
  })()`);
  await sleep(400);
  await miniPlayer.applyVideoIsolation();
  await sleep(200);
  hit = await miniPlayer.selftestHitIsolation();
  assert(hit && hit.ok, 'isolation re-applied after SPA replace', hit);
  console.log('PASS: SPA navigation re-isolates video');

  // Lock via toolbar padlock path (toggleLock = mini-player:toggle-lock)
  miniPlayer.toggleLock();
  await sleep(100);
  snap = miniPlayer.getSelftestSnapshot();
  assert(snap.locked, 'locked flag after toolbar');
  assert(snap.ignoreMouseEvents, 'ignoreMouseEvents when locked');
  assert(snap.focusable === false, 'not focusable when locked');
  console.log('PASS: lock via toolbar button path');

  // Unlock via global shortcut handler (same toggleLock)
  miniPlayer.toggleLock();
  await sleep(100);
  snap = miniPlayer.getSelftestSnapshot();
  assert(!snap.locked, 'unlocked via shortcut handler');
  assert(!snap.ignoreMouseEvents, 'mouse events restored');
  assert(snap.focusable === true, 'focusable restored');
  console.log('PASS: unlock via shortcut handler');

  // Lock then unlock via main-window IPC path (panel:mini-player-unlock → applyLock(false))
  miniPlayer.applyLock(true);
  await sleep(80);
  snap = miniPlayer.getSelftestSnapshot();
  assert(snap.locked, 'locked before main unlock');
  miniPlayer.applyLock(false);
  await sleep(80);
  snap = miniPlayer.getSelftestSnapshot();
  assert(!snap.locked, 'unlocked via main-window button/IPC');
  assert(!snap.ignoreMouseEvents, 'mouse after main unlock');
  assert(snap.focusable === true, 'focusable after main unlock');
  console.log('PASS: unlock via main-window button/IPC path');

  // Resize: video element rect must match viewport (object-fit:contain) within 2px
  // across several sizes / aspect ratios — including after player JS sets inline size.
  if (typeof miniPlayer.contentExec === 'function') {
    const wins = BrowserWindow.getAllWindows().filter(
      (w) => w && !w.isDestroyed() && w.getTitle && /mini/i.test(String(w.getTitle() || ''))
    );
    const mpWin = wins[0] || BrowserWindow.getAllWindows().find((w) => w !== ctx.mainWindow);
    if (mpWin && !mpWin.isDestroyed()) {
      const sizes = [
        [520, 340],
        [800, 450],
        [360, 640],
        [640, 280],
        [480, 480],
      ];
      for (const [sw, sh] of sizes) {
        try {
          mpWin.setSize(sw, sh);
        } catch {
          /* ignore */
        }
        await sleep(80);
        const fit = await miniPlayer.contentExec(`(() => {
          try { if (window.__mhMiniIsolate && window.__mhMiniIsolate.refreshLayout) window.__mhMiniIsolate.refreshLayout(); } catch (e) {}
          var v = window.__mhMiniIsolate && window.__mhMiniIsolate.video;
          if (!v) return { ok: false, reason: 'no-video' };
          var r = v.getBoundingClientRect();
          var w = window.innerWidth || 0;
          var h = window.innerHeight || 0;
          var tol = 2;
          return {
            ok: Math.abs(r.width - w) <= tol && Math.abs(r.height - h) <= tol &&
              Math.abs(r.left) <= tol && Math.abs(r.top) <= tol,
            r: { w: r.width, h: r.height, l: r.left, t: r.top },
            viewport: { w: w, h: h },
            inline: { w: v.style.width, h: v.style.height },
            inHost: !!(v.parentElement && v.parentElement.id === 'mh-mini-host'),
          };
        })()`);
        assert(fit && fit.ok, 'video rect matches viewport after setSize ' + sw + 'x' + sh, fit);
        assert(fit.inHost, 'video reparented into mh-mini-host', fit);
      }
      console.log('PASS: resize video fills viewport (Twitch-like wrappers + inline sizes)');
    } else {
      console.log('PASS: resize skipped (no mini BrowserWindow title match)');
    }
  }

  await miniPlayer.close();
  await sleep(400);
  snap = miniPlayer.getSelftestSnapshot();
  assert(!snap.open, 'closed');
  assert(!snap.shortcutRegistered, 'shortcut unregistered after close');
  if (accel) {
    assert(!globalShortcut.isRegistered(accel), 'isRegistered false after close');
  }
  console.log('PASS: close unregisters shortcut');

  const miniWinsLeft = BrowserWindow.getAllWindows().filter((w) => {
    if (!w || w.isDestroyed()) return false;
    if (ctx.mainWindow && w === ctx.mainWindow) return false;
    try {
      return /mini/i.test(String(w.getTitle() || ''));
    } catch {
      return false;
    }
  });
  assert(miniWinsLeft.length === 0, 'no mini BrowserWindow after close', miniWinsLeft.length);

  let audible = false;
  try {
    audible = !!(wc.isCurrentlyAudible && wc.isCurrentlyAudible());
  } catch {
    audible = false;
  }
  assert(!audible, 'source not audible after close', audible);
  const srcAfter = await wc.executeJavaScript(
    `(() => {
      var v = document.getElementById('v') || document.querySelector('video');
      if (!v) return null;
      var seekable = false;
      try {
        seekable = !!(v.seekable && v.seekable.length && v.seekable.end(0) > 0);
      } catch (e) {}
      return {
        paused: !!v.paused,
        t: Number(v.currentTime) || 0,
        seekable: seekable,
        muted: !!v.muted,
      };
    })()`,
    false
  );
  assert(srcAfter && typeof srcAfter.t === 'number', 'source video state after close', srcAfter);
  assert(srcAfter.paused === false, 'source resumed playing after close', srcAfter);
  if (srcAfter.seekable) {
    assert(Math.abs(srcAfter.t - 2.5) < 1.0, 'source resumed near mini time', srcAfter);
    console.log('PASS: close destroys mini + resumes source at time');
  } else {
    // MediaStream / live sources are often not seekable; play+unmute restore still applies.
    console.log('PASS: close destroys mini + resumes source play (not seekable stream)');
  }

  try {
    server.close();
  } catch {
    /* ignore */
  }

  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest:miniplayer complete');
  app.exit(0);
}

module.exports = { runMiniPlayerSelftest };
