'use strict';

/**
 * Selftest volume fino — MULTIHEIZ_SELFTEST=volume
 * Phase 1: fixtures A–F (same-origin, detached CORS, detached no-CORS,
 *          iframe, volume spam, WebAudio) + popover; Phase 2: persistência.
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
  const corsUrl = process.env.MULTIHEIZ_VOLUME_CORS_URL || '';
  const noCorsUrl =
    process.env.MULTIHEIZ_VOLUME_NOCORS_URL || process.env.MULTIHEIZ_VOLUME_XO_URL || '';
  const iframeUrl = process.env.MULTIHEIZ_VOLUME_IFRAME_URL || '';

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
  assert(corsUrl && corsUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_VOLUME_CORS_URL local');
  assert(noCorsUrl && noCorsUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_VOLUME_NOCORS_URL local');
  assert(iframeUrl && iframeUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_VOLUME_IFRAME_URL local');

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
    s.layout = '1';
    if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
      s.layoutByWorkspace = {};
    }
    s.layoutByWorkspace[s.activeWorkspaceId] = '1';
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

  async function readDiag() {
    return volumeControl.readVolumeDiagAllFrames(wcOf('acc-vol'));
  }

  async function stopAll() {
    await panelEval('acc-vol', 'window.__volPage && window.__volPage.stopAll && window.__volPage.stopAll()');
    await sleep(200);
  }

  async function measureRmsSamples(n, gapMs) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const v = await panelEval(
        'acc-vol',
        `(function(){
          try {
            if (window.__mhVol && window.__mhVol.enableTestTap) window.__mhVol.enableTestTap();
            return window.__mhVol && window.__mhVol.measureTestRms
              ? window.__mhVol.measureTestRms()
              : (window.__volPage && window.__volPage.measureRms ? window.__volPage.measureRms() : 0);
          } catch (e) { return 0; }
        })()`
      );
      samples.push(Number(v) || 0);
      await sleep(gapMs || 80);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  async function measureAt(percent) {
    panels.panelSetVolume('acc-vol', percent);
    await sleep(500);
    const diag = await readDiag();
    const rms = await measureRmsSamples(5, 70);
    return { percent, diag, rms };
  }

  function assertRmsBoostCurve(label, m50, m100, m200, opts) {
    const allowElement = !!(opts && opts.allowElementFallback);
    console.log(
      'RMS ' + label,
      JSON.stringify({
        rms50: m50.rms,
        rms100: m100.rms,
        rms200: m200.rms,
        mode: m100.diag && m100.diag.lastMode,
        routed: m100.diag && m100.diag.mediaRouted,
        boostUnavailable: m200.diag && m200.diag.boostUnavailable,
      })
    );
    assert(m100.rms > 0.001 || allowElement, label + ': RMS(100) deve ser > 0');
    if (allowElement && m100.rms < 0.001) {
      // modo element: validar volumes efetivos
      const els = (m200.diag && m200.diag.elements) || [];
      const playing = els.filter((e) => e && !e.paused);
      assert(playing.length > 0, label + ': elemento tocando no diag');
      assert(!!(m200.diag && m200.diag.boostUnavailable), label + ': boostUnavailable em 200%');
      for (const e of playing) {
        if (e.mode === 'element') {
          assert(
            Math.abs(Number(e.effectiveVolume) - Number(e.pageVolume || 1)) < 0.08,
            label + ': effective~page em 200% element: ' + JSON.stringify(e)
          );
        }
      }
      const m50el = (m50.diag && m50.diag.elements) || [];
      const p50 = m50el.find((e) => e && !e.paused && e.mode === 'element');
      if (p50) {
        assert(
          Number(p50.effectiveVolume) < Number(p50.pageVolume || 1) * 0.7,
          label + ': effective em 50% < page: ' + JSON.stringify(p50)
        );
      }
      return;
    }
    const ratio50 = m50.rms / m100.rms;
    assert(
      ratio50 > 0.35 && ratio50 < 0.75,
      label + ': RMS(50)~metade RMS(100) (±25% margem ampla), got ' + ratio50
    );
    const ratio200 = m200.rms / m100.rms;
    assert(
      ratio200 > 1.4,
      label + ': RMS(200) > 1.4x RMS(100), got ' + ratio200
    );
  }

  // --- Fixture F: WebAudio oscilador ---
  await stopAll();
  await panelEval('acc-vol', 'window.__volPage.startOsc()');
  await sleep(400);
  {
    const m100 = await measureAt(100);
    const m50 = await measureAt(50);
    const m200 = await measureAt(200);
    assert(
      m100.diag && (m100.diag.webaudioRouted > 0 || m100.diag.chainCount > 0),
      'F: webaudio routed'
    );
    assertRmsBoostCurve('F-webaudio', m50, m100, m200);
    console.log('PASS: fixture F WebAudio boost curve');
  }

  // --- Fixture A: <audio> same-origin no DOM ---
  await stopAll();
  await panelEval('acc-vol', 'window.__volPage.startSame()');
  await sleep(700);
  {
    const m100 = await measureAt(100);
    const m50 = await measureAt(50);
    const m200 = await measureAt(200);
    assert(m100.diag && m100.diag.mediaRouted > 0, 'A: mediaRouted gain: ' + JSON.stringify(m100.diag));
    assertRmsBoostCurve('A-same-origin', m50, m100, m200);
    console.log('PASS: fixture A same-origin gain');
  }

  // --- Fixture B: new Audio() desanexado + CORS ---
  await stopAll();
  await panelEval(
    'acc-vol',
    `window.__volPage.startDetachedCors(${JSON.stringify(corsUrl)})`
  );
  await sleep(900);
  {
    const m100 = await measureAt(100);
    assert(
      m100.diag && m100.diag.mediaRouted > 0,
      'B: deve usar rota gain (CORS): ' + JSON.stringify(m100.diag)
    );
    const els = (m100.diag && m100.diag.elements) || [];
    const detached = els.find((e) => e && e.detached && !e.paused);
    assert(detached, 'B: elemento desanexado no diag: ' + JSON.stringify(els));
    assert(detached.mode === 'gain', 'B: mode=gain, got ' + JSON.stringify(detached));

    // anti-regressão: mudar nível com desanexado já tocando
    const before = await measureRmsSamples(4, 60);
    panels.panelSetVolume('acc-vol', 50);
    await sleep(450);
    const after = await measureRmsSamples(4, 60);
    assert(after < before * 0.85, 'B anti-reg: 50% baixa saída ' + before + ' -> ' + after);
    console.log('PASS: B anti-regressão nível em desanexado tocando', { before, after });

    const m50 = await measureAt(50);
    const m200 = await measureAt(200);
    assertRmsBoostCurve('B-detached-cors', m50, m100, m200);
    console.log('PASS: fixture B detached CORS gain');
  }

  // --- Fixture E: spam audio.volume=1 (Triton-like) ---
  await stopAll();
  await panelEval('acc-vol', `window.__volPage.startSpam(${JSON.stringify(corsUrl)})`);
  await sleep(900);
  {
    const m100 = await measureAt(100);
    assert(m100.diag && m100.diag.mediaRouted > 0, 'E: gain apesar do spam volume');
    const m50 = await measureAt(50);
    await sleep(600); // deixa o spam correr
    const page = await panelEval('acc-vol', 'window.__volPage.readMediaVolumes()');
    assert(page && page.spam && Math.abs(Number(page.spam.volume) - 1) < 0.05, 'E: getter mostra 1 (página)');
    const els = (m50.diag && m50.diag.elements) || [];
    const spamEl = els.find((e) => e && e.detached && !e.paused);
    if (spamEl && spamEl.mode === 'gain') {
      // pageVolume 1; saída controlada pelo gain
      assert(Math.abs(Number(m50.diag.level) - 0.5) < 0.01, 'E: level 0.5');
    } else if (spamEl && spamEl.mode === 'element') {
      assert(
        Number(spamEl.effectiveVolume) < 0.7,
        'E: effective reduzido sob spam: ' + JSON.stringify(spamEl)
      );
    }
    const m200 = await measureAt(200);
    assertRmsBoostCurve('E-spam-volume', m50, m100, m200);
    console.log('PASS: fixture E volume spam + gain');
  }

  // --- Fixture C: detached sem CORS ---
  await stopAll();
  await panelEval(
    'acc-vol',
    `window.__volPage.startDetachedNoCors(${JSON.stringify(noCorsUrl)})`
  );
  // CORS upgrade→revert pode levar 1–2s até o elemento voltar a tocar
  {
    let readyC = null;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      readyC = await panelEval(
        'acc-vol',
        `(function(){
          var a = window.__volPage && window.__volPage.detachedNoCors;
          if (!a) return { ok:false };
          var d = window.__mhVol && window.__mhVol.getDiag ? window.__mhVol.getDiag() : null;
          var els = (d && d.elements) || [];
          var me = els.find(function(e){ return e && e.detached; });
          return {
            ok: !a.paused,
            paused: !!a.paused,
            volume: a.volume,
            mode: me && me.mode,
            reason: me && me.reason,
            corsReverts: d && d.corsReverts
          };
        })()`
      );
      if (readyC && readyC.ok) break;
    }
    assert(readyC && readyC.ok, 'C: detached no-CORS tocando após revert: ' + JSON.stringify(readyC));
  }
  {
    const m100 = await measureAt(100);
    const m50 = await measureAt(50);
    const m200 = await measureAt(200);
    assert(
      m200.diag && m200.diag.boostUnavailable === true,
      'C: boostUnavailable em 200%: ' + JSON.stringify(m200.diag)
    );
    const els = (m200.diag && m200.diag.elements) || [];
    const el =
      els.find((e) => e && e.detached && e.mode === 'element') ||
      els.find((e) => e && e.detached && !e.paused) ||
      els.find((e) => e && !e.paused);
    assert(el, 'C: elemento no diag');
    assert(el.mode === 'element', 'C: mode element: ' + JSON.stringify(el));
    // 50% deve reduzir effective; 200% clampa (não silencioso)
    const page = await panelEval('acc-vol', 'window.__volPage.readMediaVolumes()');
    assert(page && page.detachedNoCors && !page.detachedNoCors.paused, 'C: não silencioso/pausado');
    assert(
      Math.abs(Number(page.detachedNoCors.volume) - 1) < 0.05 ||
        Number(page.detachedNoCors.volume) > 0.4,
      'C: volume efetivo audível em 200%: ' + JSON.stringify(page.detachedNoCors)
    );
    const els50 = (m50.diag && m50.diag.elements) || [];
    const el50 = els50.find((e) => e && e.detached && e.mode === 'element');
    if (el50) {
      assert(
        Number(el50.effectiveVolume) < Number(el50.pageVolume || 1) * 0.7,
        'C: effective em 50% < page: ' + JSON.stringify(el50)
      );
    }
    const els200 = (m200.diag && m200.diag.elements) || [];
    const el200 = els200.find((e) => e && e.detached && e.mode === 'element');
    if (el200) {
      assert(
        Math.abs(Number(el200.effectiveVolume) - Number(el200.pageVolume || 1)) < 0.08,
        'C: em 200% effective~page (clamp): ' + JSON.stringify(el200)
      );
    }
    console.log('PASS: fixture C no-CORS element + boostUnavailable', {
      rms50: m50.rms,
      rms100: m100.rms,
      rms200: m200.rms,
    });
  }

  // --- Fixture D: iframe cross-origin ---
  await stopAll();
  await panelEval('acc-vol', `window.__volPage.startIframe(${JSON.stringify(iframeUrl)})`);
  await sleep(1500);
  {
    // reaplicar volume em frames
    panels.panelSetVolume('acc-vol', 100);
    await sleep(600);
    const diag = await readDiag();
    assert(diag && diag.frames >= 1, 'D: frames diag: ' + JSON.stringify(diag));
    const hasIframeMedia =
      (diag.mediaRouted || 0) + (diag.mediaElementFallback || 0) + (diag.trackedCount || 0) > 0;
    assert(hasIframeMedia, 'D: mídia no iframe rastreada: ' + JSON.stringify(diag));

    async function measureIframeRms() {
      const wc = wcOf('acc-vol');
      const code = `(function(){
        try {
          if (!window.__mhVol) return -1;
          if (window.__mhVol.enableTestTap) window.__mhVol.enableTestTap();
          return window.__mhVol.measureTestRms ? window.__mhVol.measureTestRms() : 0;
        } catch (e) { return -2; }
      })()`;
      let best = 0;
      try {
        const mainFrame = wc.mainFrame;
        if (mainFrame && typeof mainFrame.framesInSubtree === 'function') {
          for (const frame of mainFrame.framesInSubtree()) {
            try {
              const v = await frame.executeJavaScript(code, true);
              if (Number(v) > best) best = Number(v);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      return best;
    }

    panels.panelSetVolume('acc-vol', 100);
    await sleep(500);
    const r100 = await measureIframeRms();
    panels.panelSetVolume('acc-vol', 50);
    await sleep(500);
    const r50 = await measureIframeRms();
    panels.panelSetVolume('acc-vol', 200);
    await sleep(500);
    const r200 = await measureIframeRms();
    const d200 = await readDiag();
    console.log('D iframe RMS', { r50, r100, r200, boostUnavailable: d200 && d200.boostUnavailable });
    if (r100 > 0.001) {
      assert(r50 / r100 > 0.35 && r50 / r100 < 0.75, 'D: RMS 50/100 ratio ' + r50 / r100);
      assert(r200 / r100 > 1.4, 'D: RMS 200/100 ratio ' + r200 / r100);
      console.log('PASS: fixture D iframe gain curve');
    } else {
      // same-process inject pode rotear em element se CORS do tone no iframe falhar — aceitar tracked
      assert(
        (d200 && d200.trackedCount > 0) || (diag && diag.trackedCount > 0),
        'D: pelo menos tracked no iframe'
      );
      console.log('PASS: fixture D iframe injetado (RMS baixo / element ok)');
    }
  }

  // mute + popover (regressão UI)
  panels.panelSetMuted('acc-vol', true);
  await sleep(200);
  const mutedWc = wcOf('acc-vol');
  assert(mutedWc && mutedWc.isAudioMuted(), 'webContents muted');
  panels.panelSetMuted('acc-vol', false);
  await sleep(200);
  assert(mutedWc && !mutedWc.isAudioMuted(), 'webContents unmuted');
  console.log('PASS: mute via setAudioMuted');

  await stopAll();
  await panelEval('acc-vol', 'window.__volPage.addDynamic()');
  await sleep(500);
  panels.panelSetVolume('acc-vol', 40);
  await sleep(400);
  const afterDyn = await panelEval('acc-vol', 'window.__volPage.readMediaVolumes()');
  assert(afterDyn && afterDyn.dyn, 'dynamic audio present');
  const dynOk =
    (afterDyn.mh && afterDyn.mh.mediaRouted > 0) ||
    (afterDyn.mh && afterDyn.mh.trackedCount > 0);
  assert(dynOk, 'dynamic element affected: ' + JSON.stringify(afterDyn));
  console.log('PASS: dynamic element affected');

  panels.panelSetVolume('acc-vol', 150);
  flushSave();
  const pub = publicState();
  const pubAcc = (pub.accounts || []).find((a) => a.id === 'acc-vol');
  assert(pubAcc && pubAcc.volume === 150, 'publicState volume 150');
  console.log('PASS: state volume=150 saved');

  function clampPct(v) {
    return Math.max(0, Math.min(200, Math.round(v)));
  }

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
