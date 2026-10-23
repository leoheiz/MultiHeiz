'use strict';

/**
 * Selftest: multi-suspend + limpeza periódica de memória (MULTIHEIZ_SELFTEST=suspend).
 * - Suspende 3 painéis na mesma área e confirma que ficam suspendidos
 * - Timer curto: pula focado / audível / captura; limpa cache; cookies intactos
 */

const http = require('node:http');
const { session } = require('electron');

/**
 * @param {object} ctx
 */
async function runSuspendSelftest(ctx) {
  const {
    mainWindow,
    panels,
    memory,
    permissions,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    publicState,
    emitToRenderer,
    app,
  } = ctx;

  console.log('SELFTEST suspend');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  function wcOf(accountId) {
    return panels.getPanelCapture(accountId);
  }

  async function panelEval(accountId, code) {
    const wc = wcOf(accountId);
    assert(wc, 'webContents for ' + accountId);
    return wc.executeJavaScript(code, true);
  }

  const server = http.createServer((req, res) => {
    const url = String(req.url || '/');
    if (url.startsWith('/set-cookie')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'mh_suspend=alive; Path=/; Max-Age=86400',
      });
      res.end('<!doctype html><title>cookie</title><body>cookie-ok</body>');
      return;
    }
    if (url.startsWith('/tone')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>tone</title><body>
<script>
(async function(){
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    var osc = ctx.createOscillator();
    osc.frequency.value = 440;
    var g = ctx.createGain();
    g.gain.value = 0.25;
    osc.connect(g); g.connect(ctx.destination);
    osc.start();
    if (ctx.state === 'suspended') await ctx.resume();
    window.__mhToneOk = true;
  } catch (e) { window.__mhToneErr = String(e); }
})();
</script>tone</body>`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>idle</title><body>idle</body>');
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const idleUrl = base + '/idle';
  const toneUrl = base + '/tone';
  const cookieUrl = base + '/set-cookie';

  try {
    updateState((s) => {
      if (!s.workspaces.some((w) => w.id === 'ws-default')) {
        s.workspaces.push({ id: 'ws-default', name: 'Default' });
      }
      s.activeWorkspaceId = 'ws-default';
      s.accounts = (s.accounts || []).filter((a) => !String(a.id || '').startsWith('acc-sus-'));
      s.accounts.push(
        {
          id: 'acc-sus-a',
          name: 'SusA',
          workspaceId: 'ws-default',
          color: '#4a9',
          muted: false,
          zoomFactor: 1,
          startUrl: idleUrl,
          lastUrl: '',
          keepAliveInBackground: false,
        },
        {
          id: 'acc-sus-b',
          name: 'SusB',
          workspaceId: 'ws-default',
          color: '#a94',
          muted: false,
          zoomFactor: 1,
          startUrl: idleUrl,
          lastUrl: '',
          keepAliveInBackground: false,
        },
        {
          id: 'acc-sus-c',
          name: 'SusC',
          workspaceId: 'ws-default',
          color: '#94a',
          muted: false,
          zoomFactor: 1,
          startUrl: idleUrl,
          lastUrl: '',
          keepAliveInBackground: false,
        },
        {
          id: 'acc-sus-d',
          name: 'SusD',
          workspaceId: 'ws-default',
          color: '#9a4',
          muted: false,
          zoomFactor: 1,
          startUrl: cookieUrl,
          lastUrl: '',
          keepAliveInBackground: false,
        }
      );
      s.layout = '4';
      if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
        s.layoutByWorkspace = {};
      }
      s.layoutByWorkspace[s.activeWorkspaceId] = '4';
      s.settings = {
        ...s.settings,
        suspendHidden: false,
        keepBackgroundRunning: false,
        backgroundPreset: 'balanced',
        memoryCleanupEnabled: false,
        memoryCleanupIntervalMin: 30,
      };
    });
    flushSave();
    if (typeof emitToRenderer === 'function') {
      emitToRenderer({ type: 'state:changed', state: publicState() });
    }
    await sleep(400);

    const [bw, bh] = mainWindow.getContentSize();
    const halfW = Math.floor(bw / 2);
    const halfH = Math.floor((bh - 80) / 2);
    const slots4 = [
      { accountId: 'acc-sus-a', x: 0, y: 80, width: halfW, height: halfH },
      { accountId: 'acc-sus-b', x: halfW, y: 80, width: halfW, height: halfH },
      { accountId: 'acc-sus-c', x: 0, y: 80 + halfH, width: halfW, height: halfH },
      { accountId: 'acc-sus-d', x: halfW, y: 80 + halfH, width: halfW, height: halfH },
    ];
    panels.syncVisiblePanels(slots4);
    await waitForUrl('acc-sus-a', (u) => u.includes('127.0.0.1'), 20000);
    await waitForUrl('acc-sus-b', (u) => u.includes('127.0.0.1'), 20000);
    await waitForUrl('acc-sus-c', (u) => u.includes('127.0.0.1'), 20000);
    await waitForUrl('acc-sus-d', (u) => u.includes('127.0.0.1'), 20000);
    await sleep(400);

    // Cookie on D
    const sesD = session.fromPartition(panels.partitionFor('acc-sus-d'));
    {
      const cookies = await sesD.cookies.get({ url: base });
      const has = cookies.some((c) => c.name === 'mh_suspend' && c.value === 'alive');
      assert(has, 'cookie mh_suspend set on D before cleanup');
    }

    // --- Multi-suspend in same area ---
    panels.suspendForMemory('acc-sus-a', { force: true });
    panels.suspendForMemory('acc-sus-b', { force: true });
    panels.suspendForMemory('acc-sus-c', { force: true });
    // Trigger the sync path that previously un-suspended when needCreate.length > 1
    panels.syncVisiblePanels(slots4);
    await sleep(300);

    assert(panels.isForceSuspended('acc-sus-a'), 'A still force-suspended');
    assert(panels.isForceSuspended('acc-sus-b'), 'B still force-suspended');
    assert(panels.isForceSuspended('acc-sus-c'), 'C still force-suspended');
    assert(!panels.isPanelActive('acc-sus-a'), 'A webContents destroyed');
    assert(!panels.isPanelActive('acc-sus-b'), 'B webContents destroyed');
    assert(!panels.isPanelActive('acc-sus-c'), 'C webContents destroyed');
    console.log('PASS: 3 panels suspended in same area stay suspended after sync');

    // Reactivate for cleanup timer scenario
    panels.reactivatePanel('acc-sus-a');
    panels.reactivatePanel('acc-sus-b');
    panels.reactivatePanel('acc-sus-c');
    panels.syncVisiblePanels(slots4);
    await waitForUrl('acc-sus-a', (u) => u.includes('127.0.0.1'), 20000);
    await waitForUrl('acc-sus-b', (u) => u.includes('127.0.0.1'), 20000);
    await waitForUrl('acc-sus-c', (u) => u.includes('127.0.0.1'), 20000);
    await sleep(300);

    // Focus A; B plays tone; C marked as capturing; D is idle (should suspend)
    panels.setFocusedAccount('acc-sus-a');
    panels.panelNavigate('acc-sus-b', toneUrl);
    await waitForUrl('acc-sus-b', (u) => u.includes('/tone'), 15000);
    await sleep(800);
    // Wait until audible
    let audible = false;
    for (let i = 0; i < 30; i++) {
      audible = panels.panelIsAudible('acc-sus-b');
      if (audible) break;
      try {
        const ok = await panelEval('acc-sus-b', '!!window.__mhToneOk');
        if (ok && panels.panelIsAudible('acc-sus-b')) {
          audible = true;
          break;
        }
      } catch {
        /* ignore */
      }
      await sleep(200);
    }
    assert(audible, 'B should be audible (generated tone)');
    console.log('PASS: audible tone on B');

    permissions.setMediaInUse('acc-sus-c', { microphone: true, camera: true });
    const mediaC = permissions.getMediaInUse('acc-sus-c');
    assert(mediaC.microphone && mediaC.camera, 'C media in use');

    updateState((s) => {
      s.settings.memoryCleanupEnabled = true;
      s.settings.memoryCleanupIntervalMin = 15;
    });
    flushSave();
    memory.resyncCleanupTimer();
    assert(memory.isCleanupTimerRunning(), 'cleanup timer running under selftest');

    // Re-assert focus immediately before cleanup (nav/audio on B may steal focus)
    panels.setFocusedAccount('acc-sus-a');
    assert(panels.getFocusedAccountId() === 'acc-sus-a', 'focused id is A');

    // Run cleanup once immediately (don't wait for interval)
    const result = await memory.runPeriodicMemoryCleanup();
    assert(result && result.clearedCache === true, 'cache cleared flag');
    assert(
      result.skippedIds.includes('acc-sus-a'),
      'focused A skipped: ' + JSON.stringify(result)
    );
    assert(
      result.skippedIds.includes('acc-sus-b'),
      'audible B skipped: ' + JSON.stringify(result)
    );
    assert(
      result.skippedIds.includes('acc-sus-c'),
      'capturing C skipped: ' + JSON.stringify(result)
    );
    assert(
      result.suspendedIds.includes('acc-sus-d'),
      'idle D suspended: ' + JSON.stringify(result)
    );
    assert(panels.isForceSuspended('acc-sus-d'), 'D force-suspended');
    assert(panels.isPanelActive('acc-sus-a'), 'focused A still active');
    assert(panels.isPanelActive('acc-sus-b'), 'audible B still active');
    assert(panels.isPanelActive('acc-sus-c'), 'capturing C still active');
    console.log('PASS: cleanup skips focused + audible + capturing; suspends idle');

    // Cookies intact after clearCache
    const cookiesAfter = await sesD.cookies.get({ url: base });
    const cookieOk = cookiesAfter.some((c) => c.name === 'mh_suspend' && c.value === 'alive');
    assert(cookieOk, 'cookie survived clearCache: ' + JSON.stringify(cookiesAfter));
    console.log('PASS: cookies intact after cache clear');

    // Timer also fires on short interval
    await sleep(memory.SELFTEST_CLEANUP_MS + 800);
    const last = memory.getLastCleanupResult();
    assert(last && last.clearedCache, 'timer produced cleanup result');
    console.log('PASS: short-interval cleanup timer fired');

    console.log('PASS: suspend selftest complete');
    app.exit(0);
  } finally {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { runSuspendSelftest };
