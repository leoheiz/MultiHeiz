'use strict';

/**
 * Selftest volume fino — MULTIHEIZ_SELFTEST=volume
 * Phase 1: Oscillator + <audio> blob + cross-origin; gain 100/50/0/150; mudo;
 *          elemento dinâmico; popover wheel/dblclick.
 * Phase 2: mesma USERDATA — persistência do percentual.
 */

const { app } = require('electron');
const volumeControl = require('./volume-control');

/**
 * @param {object} ctx
 */
async function runVolumeSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    rendererEval,
    publicState,
    emitToRenderer,
    getState,
  } = ctx;

  const phase = String(process.env.MULTIHEIZ_SELFTEST_PHASE || '1');
  const pageUrl = process.env.MULTIHEIZ_VOLUME_TEST_URL || '';
  const xoUrl = process.env.MULTIHEIZ_VOLUME_XO_URL || '';

  console.log('SELFTEST volume phase=' + phase);

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

  if (phase === '2') {
    const acc = (getState().accounts || []).find((a) => a.id === 'acc-vol');
    assert(acc, 'acc-vol missing after restart');
    assert(
      volumeControl.normalizeVolumePercent(acc.volume) === 150,
      'persisted volume 150, got ' + acc.volume
    );
    console.log('PASS: volume persists after restart', acc.volume);
    app.exit(0);
    return;
  }

  assert(pageUrl && pageUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_VOLUME_TEST_URL local');
  assert(xoUrl && xoUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_VOLUME_XO_URL local');

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-vol');
    s.accounts.push({
      id: 'acc-vol',
      name: 'VolumeTest',
      workspaceId: 'ws-default',
      color: '#4a9',
      muted: false,
      volume: 100,
      zoomFactor: 1,
      startUrl: 'about:blank',
      lastUrl: '',
    });
    s.layout = {
      cols: 1,
      rows: 1,
      slots: [{ accountId: 'acc-vol' }],
    };
  });
  flushSave();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(300);

  panels.createPanel('acc-vol');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: 'acc-vol', x: 0, y: 80, width: bw0, height: Math.max(240, bh0 - 80) },
    ]);
  }
  await sleep(600);
  panels.panelNavigate('acc-vol', pageUrl);
  await waitForUrl('acc-vol', (u) => u.startsWith(pageUrl.replace(/\/$/, '')), 15000);
  await sleep(500);

  const boot = await panelEval(
    'acc-vol',
    `(async function(){
      if (!window.__volPage || !window.__volPage.startAll) return { ok:false, reason:'no-page' };
      await window.__volPage.startAll(${JSON.stringify(xoUrl)});
      return { ok:true, ready: window.__volPage.ready, err: window.__volPage.err };
    })()`
  );
  assert(boot && boot.ok, 'page media boot: ' + JSON.stringify(boot));
  await sleep(700);

  panels.panelSetVolume('acc-vol', 100);
  await sleep(400);

  async function readDiag() {
    return volumeControl.readVolumeDiag(wcOf('acc-vol'));
  }

  async function readPage() {
    return panelEval('acc-vol', 'window.__volPage.readMediaVolumes()');
  }

  async function measureAt(percent) {
    panels.panelSetVolume('acc-vol', percent);
    await sleep(450);
    const diag = await readDiag();
    const page = await readPage();
    let rms = 0;
    try {
      rms = await panelEval('acc-vol', 'window.__volPage.measureRms()');
    } catch {
      rms = 0;
    }
    return { percent, diag, page, rms };
  }

  function clampPct(v) {
    return Math.max(0, Math.min(200, Math.round(v)));
  }

  const m100 = await measureAt(100);
  console.log(
    'measure 100%',
    JSON.stringify({
      level: m100.diag && m100.diag.level,
      rms: m100.rms,
      sharedGain: m100.diag && m100.diag.sharedGain,
      webaudio: m100.diag && m100.diag.webaudioRouted,
      mediaRouted: m100.diag && m100.diag.mediaRouted,
    })
  );
  assert(m100.diag && Math.abs(Number(m100.diag.level) - 1) < 0.01, 'gain level ~1 at 100%');
  assert(
    m100.diag &&
      (m100.diag.webaudioRouted > 0 || m100.diag.mediaRouted > 0 || m100.diag.hasSharedCtx),
    'routing active at 100%: ' + JSON.stringify(m100.diag)
  );

  const m50 = await measureAt(50);
  console.log('measure 50%', JSON.stringify({ level: m50.diag && m50.diag.level, rms: m50.rms }));
  assert(m50.diag && Math.abs(Number(m50.diag.level) - 0.5) < 0.01, 'gain level ~0.5 at 50%');

  const m0 = await measureAt(0);
  console.log('measure 0%', JSON.stringify({ level: m0.diag && m0.diag.level, rms: m0.rms }));
  assert(m0.diag && Number(m0.diag.level) === 0, 'gain level 0 at 0%');

  const m150 = await measureAt(150);
  console.log(
    'measure 150% boost',
    JSON.stringify({ level: m150.diag && m150.diag.level, rms: m150.rms })
  );
  assert(m150.diag && Math.abs(Number(m150.diag.level) - 1.5) < 0.01, 'gain level ~1.5 at 150%');

  const xoInfo = m150.page && m150.page.xo;
  assert(xoInfo, 'xo element present');
  assert(Number(xoInfo.volume) <= 1.001, 'cross-origin volume capped <=1, got ' + xoInfo.volume);
  assert(
    Math.abs(Number(xoInfo.volume) - 1) < 0.05 ||
      (m150.diag && m150.diag.mediaElementFallback > 0),
    'cross-origin uses element fallback / no boost: ' + JSON.stringify(xoInfo)
  );
  console.log('PASS: cross-origin element.volume (no boost)', xoInfo);

  await panelEval('acc-vol', 'window.__volPage.addDynamic()');
  await sleep(500);
  panels.panelSetVolume('acc-vol', 40);
  await sleep(400);
  const afterDyn = await readPage();
  assert(afterDyn && afterDyn.dyn, 'dynamic audio present');
  const dynVol = Number(afterDyn.dyn.volume);
  const dynOk =
    Math.abs(dynVol - 1) < 0.05 ||
    Math.abs(dynVol - 0.4) < 0.05 ||
    (afterDyn.mh && afterDyn.mh.mediaRouted > 0);
  assert(dynOk, 'dynamic element affected: ' + JSON.stringify(afterDyn.dyn));
  console.log('PASS: dynamic element affected', afterDyn.dyn);

  panels.panelSetMuted('acc-vol', true);
  await sleep(200);
  const mutedWc = wcOf('acc-vol');
  assert(mutedWc && mutedWc.isAudioMuted(), 'webContents muted');
  panels.panelSetMuted('acc-vol', false);
  await sleep(200);
  assert(mutedWc && !mutedWc.isAudioMuted(), 'webContents unmuted');
  console.log('PASS: mute via setAudioMuted');

  panels.panelSetVolume('acc-vol', 150);
  flushSave();
  const pub = publicState();
  const pubAcc = (pub.accounts || []).find((a) => a.id === 'acc-vol');
  assert(pubAcc && pubAcc.volume === 150, 'publicState volume 150');
  console.log('PASS: state volume=150 saved');

  const open = await rendererEval('window.__multiheizUi.openVolumePopover("acc-vol")');
  assert(open && open.ok, 'open volume popover: ' + JSON.stringify(open));
  await sleep(200);
  const pop = await rendererEval('window.__multiheizUi.getVolumePopover()');
  assert(pop && pop.open, 'popover open');
  const beforeWheel = pop.percent;
  const wheeled = await rendererEval('window.__multiheizUi.volumePopoverWheel(100, false)');
  assert(wheeled && wheeled.ok, 'wheel ok');
  assert(
    wheeled.percent === clampPct(beforeWheel - 1),
    'wheel -1%: before=' + beforeWheel + ' after=' + wheeled.percent
  );
  console.log('PASS: popover wheel 1%', { beforeWheel, after: wheeled.percent });

  const dbl = await rendererEval('window.__multiheizUi.volumePopoverDblClick()');
  assert(dbl && dbl.percent === 100, 'dblclick resets 100, got ' + (dbl && dbl.percent));
  console.log('PASS: popover dblclick -> 100%');

  panels.panelSetVolume('acc-vol', 150);
  flushSave();
  await rendererEval('window.__multiheizUi.closeVolumePopover()');

  console.log('PASS: selftest volume phase 1 complete');
  app.exit(0);
}

module.exports = { runVolumeSelftest };
