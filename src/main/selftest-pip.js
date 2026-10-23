'use strict';

/**
 * Selftest: native Picture-in-Picture + settings toggle for toolbar button.
 * MULTIHEIZ_SELFTEST=pip
 */

const http = require('node:http');
const { app } = require('electron');

async function runPipSelftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
    waitForPanels,
    rendererEval,
    pictureInPicture,
    emitToRenderer,
    publicState,
  } = ctx;

  console.log('SELFTEST pip');
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

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>pip</title></head>
<body style="margin:0;background:#102030;color:#eee;font:16px sans-serif;padding:16px">
<h1>pip selftest</h1>
<video id="v" width="320" height="180" autoplay muted loop playsinline
  style="display:block;width:320px;height:180px;background:#000"></video>
<canvas id="c" width="320" height="180" style="display:none"></canvas>
<script>
(function(){
  var c = document.getElementById('c');
  var ctx = c.getContext('2d');
  var t0 = performance.now();
  function frame(t) {
    var x = ((t - t0) / 16) % 320;
    ctx.fillStyle = '#102030';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#3d8bfd';
    ctx.fillRect(x, 50, 48, 80);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  var v = document.getElementById('v');
  v.srcObject = c.captureStream(30);
  v.play().catch(function(){});
  window.__pipReady = true;
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
    s.workspaces = [{ id: 'ws-pip', name: 'PiP' }];
    s.activeWorkspaceId = 'ws-pip';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-pip',
        name: 'PiP',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-pip',
        muted: false,
        volume: 100,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    if (!s.settings || typeof s.settings !== 'object') s.settings = {};
    s.settings.showPipToolbarButton = true;
    s.settings.openLastPage = false;
    s.settings.homepage = base + '/';
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(800);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-pip' && p.visible));
  await waitForUrl('acc-pip', (u) => u.includes('127.0.0.1'), 30000);
  await sleep(400);

  const wc = panels.getPanelCapture('acc-pip');
  assert(wc && !wc.isDestroyed(), 'panel wc');

  async function panelEval(code) {
    return wc.executeJavaScript(code, true);
  }

  for (let i = 0; i < 40; i++) {
    const ready = await panelEval('!!window.__pipReady && !!document.getElementById("v")');
    if (ready) break;
    await sleep(100);
  }
  await panelEval('document.getElementById("v").play().catch(function(){})');
  await sleep(300);

  const probe = await pictureInPicture.probeVideo('acc-pip');
  assert(probe && probe.count >= 1, 'probe has video', probe);
  console.log('PASS: local video present');

  const btnShown = await rendererEval(`!!document.querySelector('[data-role="panel-pip"]')`);
  assert(btnShown, 'pip toolbar button shown when setting on');
  console.log('PASS: toolbar button shown');

  const on = await pictureInPicture.togglePip('acc-pip');
  assert(on && on.ok, 'toggle pip on', on);
  await sleep(500);
  let st = await pictureInPicture.getPipState('acc-pip');
  assert(st && st.active, 'pictureInPictureElement set', st);
  assert(await panelEval('!!document.pictureInPictureElement'), 'document.pictureInPictureElement');
  console.log('PASS: PiP entered');

  const off = await pictureInPicture.togglePip('acc-pip');
  assert(off && off.ok, 'toggle pip off', off);
  await sleep(500);
  st = await pictureInPicture.getPipState('acc-pip');
  assert(st && !st.active, 'pictureInPictureElement cleared', st);
  assert(!(await panelEval('!!document.pictureInPictureElement')), 'PiP cleared');
  console.log('PASS: PiP exited');

  const hideRes = await rendererEval(
    `(async () => window.__multiheizUi.setShowPipToolbarButton(false))()`
  );
  assert(hideRes && hideRes.ok && hideRes.shown === false, 'pip toolbar button hidden', hideRes);
  console.log('PASS: settings toggle hides toolbar button');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest:pip complete');
  app.exit(0);
}

module.exports = { runPipSelftest };
