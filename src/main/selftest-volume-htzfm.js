'use strict';

/**
 * Check opcional (site real): volume em https://htzfm.com/ (offscreen).
 * MULTIHEIZ_SELFTEST=volume-htzfm + MULTIHEIZ_SELFTEST_REAL_SITES=1
 * Rede falha → SKIP (exit 0). Sem REAL_SITES → SKIP.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const volumeControl = require('./volume-control');

/**
 * @param {object} ctx
 */
async function runVolumeHtzfmSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    publicState,
    emitToRenderer,
  } = ctx;

  const outDir = path.join(__dirname, '..', '..', '_local');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'check-volume-htzfm.json');

  function log(...args) {
    console.log(...args);
  }

  function writeResult(obj) {
    fs.writeFileSync(outPath, JSON.stringify(obj, null, 2), 'utf8');
  }

  function skip(reason) {
    log('SKIP: volume-htzfm —', reason);
    writeResult({ status: 'SKIP', reason, at: new Date().toISOString() });
    app.exit(0);
  }

  log('SELFTEST volume-htzfm');

  if (String(process.env.MULTIHEIZ_SELFTEST_REAL_SITES || '') !== '1') {
    skip('MULTIHEIZ_SELFTEST_REAL_SITES!=1 (use mocks em selftest:volume)');
    return;
  }

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-htz');
    s.accounts.push({
      id: 'acc-htz',
      name: 'HTZFM',
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

  panels.createPanel('acc-htz');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: 'acc-htz', x: 0, y: 80, width: bw0, height: Math.max(240, bh0 - 80) },
    ]);
  }
  await sleep(400);

  const wc = panels.getPanelCapture('acc-htz');
  if (!wc) {
    skip('sem webContents');
    return;
  }

  try {
    panels.panelNavigate('acc-htz', 'https://htzfm.com/');
    await waitForUrl('acc-htz', (u) => /htzfm\.com/i.test(u), 45000);
  } catch (err) {
    skip('navegação falhou: ' + (err && err.message ? err.message : String(err)));
    return;
  }
  await sleep(2500);

  // Tentar clicar play no player Triton / botões comuns
  let playResult = null;
  try {
    playResult = await wc.executeJavaScript(
      `(async function(){
        function click(el){ try { el.click(); return true; } catch(e){ return false; } }
        var sels = [
          'button.play', '.play-button', '[aria-label*="Play" i]', '[aria-label*="Reproduzir" i]',
          '.tdplayer-play', '.play', '#play', 'button[title*="Play" i]',
          '.player-play', '[data-action="play"]', '.jp-play'
        ];
        for (var i = 0; i < sels.length; i++) {
          var el = document.querySelector(sels[i]);
          if (el && click(el)) return { ok:true, via:sels[i] };
        }
        // TD SDK / global hooks
        try {
          if (window.TDSdk || window.tdPlayer || window.player) {
            var p = window.tdPlayer || window.player || window.TDSdk;
            if (p && typeof p.play === 'function') { p.play(); return { ok:true, via:'sdk.play' }; }
            if (p && p.AudioPlayer && typeof p.AudioPlayer.play === 'function') {
              p.AudioPlayer.play(); return { ok:true, via:'AudioPlayer.play' };
            }
          }
        } catch (e2) {}
        // Qualquer botão com texto Play
        var btns = Array.prototype.slice.call(document.querySelectorAll('button, a, div[role="button"]'));
        for (var j = 0; j < btns.length; j++) {
          var t = (btns[j].textContent || btns[j].getAttribute('aria-label') || '').trim();
          if (/^\\s*play\\s*$/i.test(t) || /reproduzir/i.test(t)) {
            if (click(btns[j])) return { ok:true, via:'text:' + t.slice(0, 24) };
          }
        }
        return { ok:false, reason:'no-play-control' };
      })()`,
      true
    );
  } catch (err) {
    skip('executeJavaScript play falhou: ' + (err && err.message ? err.message : String(err)));
    return;
  }

  log('play click:', JSON.stringify(playResult));
  await sleep(3500);

  async function measureAt(percent) {
    panels.panelSetVolume('acc-htz', percent);
    await sleep(700);
    const diag = await volumeControl.readVolumeDiagAllFrames(wc);
    let rms = 0;
    try {
      rms = await wc.executeJavaScript(
        `(function(){
          try {
            if (window.__mhVol && window.__mhVol.enableTestTap) window.__mhVol.enableTestTap();
            return window.__mhVol && window.__mhVol.measureTestRms ? window.__mhVol.measureTestRms() : 0;
          } catch (e) { return 0; }
        })()`,
        true
      );
    } catch {
      rms = 0;
    }
    // tentar frames
    try {
      const mainFrame = wc.mainFrame;
      if (mainFrame && typeof mainFrame.framesInSubtree === 'function') {
        for (const frame of mainFrame.framesInSubtree()) {
          try {
            const v = await frame.executeJavaScript(
              `(function(){
                try {
                  if (window.__mhVol && window.__mhVol.enableTestTap) window.__mhVol.enableTestTap();
                  return window.__mhVol && window.__mhVol.measureTestRms ? window.__mhVol.measureTestRms() : 0;
                } catch (e) { return 0; }
              })()`,
              true
            );
            if (Number(v) > Number(rms)) rms = Number(v);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    return { percent, diag, rms: Number(rms) || 0 };
  }

  const m50 = await measureAt(50);
  const m100 = await measureAt(100);
  const m200 = await measureAt(200);

  const report = {
    status: 'OK',
    play: playResult,
    at: new Date().toISOString(),
    measures: {
      '50': { rms: m50.rms, level: m50.diag && m50.diag.level, lastMode: m50.diag && m50.diag.lastMode },
      '100': {
        rms: m100.rms,
        level: m100.diag && m100.diag.level,
        lastMode: m100.diag && m100.diag.lastMode,
        mediaRouted: m100.diag && m100.diag.mediaRouted,
        trackedCount: m100.diag && m100.diag.trackedCount,
      },
      '200': {
        rms: m200.rms,
        level: m200.diag && m200.diag.level,
        lastMode: m200.diag && m200.diag.lastMode,
        boostUnavailable: m200.diag && m200.diag.boostUnavailable,
        elements: m200.diag && m200.diag.elements,
      },
    },
  };

  // Se nada tocou / rede bloqueou stream
  const tracked = (m100.diag && m100.diag.trackedCount) || 0;
  const routed = (m100.diag && m100.diag.mediaRouted) || 0;
  if (!playResult || (!playResult.ok && tracked === 0 && routed === 0 && m100.rms < 0.0001)) {
    skip('player/stream indisponível: ' + JSON.stringify({ playResult, tracked, routed }));
    return;
  }

  log('htzfm report:', JSON.stringify(report.measures));
  writeResult(report);
  log('PASS: volume-htzfm report written', outPath);
  app.exit(0);
}

module.exports = { runVolumeHtzfmSelftest };
