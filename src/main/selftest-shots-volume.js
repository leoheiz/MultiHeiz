'use strict';

/**
 * Screenshots do popover de volume (perfil descartável).
 * MULTIHEIZ_SELFTEST=shots-volume
 * Saída: _local/shots-volume/volume-slider.png (~140% Reforço)
 *        _local/shots-volume/volume-slider-normal.png (~60%)
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runShotsVolumeSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    sleep,
    rendererEval,
    waitForLayoutSettle,
    publicState,
    emitToRenderer,
  } = ctx;

  const outDir =
    process.env.MULTIHEIZ_SHOTS_OUT ||
    path.join(__dirname, '..', '..', '_local', 'shots-volume');

  console.log('SELFTEST shots-volume');
  console.log('outDir:', outDir);
  fs.mkdirSync(outDir, { recursive: true });

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-shot-vol');
    s.accounts.push({
      id: 'acc-shot-vol',
      name: 'Áudio',
      workspaceId: 'ws-default',
      color: '#2bb8a6',
      muted: false,
      volume: 140,
      zoomFactor: 1,
      startUrl: 'about:blank',
      lastUrl: '',
    });
    s.layout = '1';
    if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
      s.layoutByWorkspace = {};
    }
    s.layoutByWorkspace[s.activeWorkspaceId] = '1';
    if (!s.ui) s.ui = {};
    s.ui.sidebarCollapsed = false;
    s.ui.sidebarAutoHide = false;
  });
  flushSave();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(400);

  panels.createPanel('acc-shot-vol');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      {
        accountId: 'acc-shot-vol',
        x: 0,
        y: 80,
        width: bw0,
        height: Math.max(240, bh0 - 80),
      },
    ]);
  }
  await sleep(800);
  if (typeof waitForLayoutSettle === 'function') {
    await waitForLayoutSettle(1200);
  } else {
    await sleep(500);
  }

  await rendererEval(
    'typeof window.__multiheizUi.syncNow === "function" && window.__multiheizUi.syncNow()'
  );
  await sleep(300);

  // Layout <select> must show a real option (never empty) in the top bar.
  {
    const layoutInfo = await rendererEval(`(() => {
      const sel = document.getElementById('layout-select');
      if (window.__multiheizUi && window.__multiheizUi.getLayoutSelectValue) {
        window.__multiheizUi.getLayoutSelectValue();
      }
      const opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      const cs = sel ? getComputedStyle(sel) : null;
      const r = sel ? sel.getBoundingClientRect() : null;
      return {
        value: sel && sel.value,
        selectedIndex: sel && sel.selectedIndex,
        text: opt ? String(opt.textContent || '').trim() : '',
        color: cs ? cs.color : '',
        bg: cs ? cs.backgroundColor : '',
        width: r ? r.width : 0,
        height: r ? r.height : 0,
        x: r ? r.x : 0,
        y: r ? r.y : 0,
      };
    })()`);
    assert(
      layoutInfo &&
        layoutInfo.value &&
        ['1', '2', '4', '6', 'auto', 'livre'].includes(layoutInfo.value) &&
        layoutInfo.selectedIndex >= 0 &&
        layoutInfo.text.length > 0 &&
        layoutInfo.width >= 40 &&
        layoutInfo.height >= 16,
      'Layout select must show a value, got: ' + JSON.stringify(layoutInfo)
    );
    console.log('PASS: Layout select value', layoutInfo);
    // Crop for visual check (Layout box alone)
    try {
      const pad = 4;
      const img = await mainWindow.webContents.capturePage({
        x: Math.max(0, Math.floor(layoutInfo.x) - pad),
        y: Math.max(0, Math.floor(layoutInfo.y) - pad),
        width: Math.ceil(layoutInfo.width) + pad * 2,
        height: Math.ceil(layoutInfo.height) + pad * 2,
      });
      const cropPath = path.join(outDir, 'layout-select-crop.png');
      fs.writeFileSync(cropPath, img.toPNG());
      console.log('wrote', cropPath, 'bytes', fs.statSync(cropPath).size);
    } catch (err) {
      console.log('WARN: layout crop failed', err && err.message ? err.message : err);
    }
  }

  async function shot(name, percent) {
    panels.panelSetVolume('acc-shot-vol', percent);
    await sleep(200);
    await rendererEval(
      `window.__multiheizUi.setVolumePercent("acc-shot-vol", ${percent})`
    );
    await sleep(150);
    const open = await rendererEval(
      'window.__multiheizUi.openVolumePopover("acc-shot-vol")'
    );
    assert(open && open.ok, 'open popover for ' + name + ': ' + JSON.stringify(open));
    await sleep(350);
    const pop = await rendererEval('window.__multiheizUi.getVolumePopover()');
    assert(pop && pop.open, 'popover visible for ' + name);
    const dest = path.join(outDir, name);
    const img = await mainWindow.webContents.capturePage();
    const png = img.toPNG();
    fs.writeFileSync(dest, png);
    console.log('wrote', dest, 'bytes', png.length, 'percent', pop.percent);
    await rendererEval('window.__multiheizUi.closeVolumePopover()');
    await sleep(150);
    return dest;
  }

  const p1 = await shot('volume-slider.png', 140);
  const p2 = await shot('volume-slider-normal.png', 60);
  assert(fs.existsSync(p1) && fs.statSync(p1).size > 1000, 'boost shot ok');
  assert(fs.existsSync(p2) && fs.statSync(p2).size > 1000, 'normal shot ok');

  console.log('PASS: shots-volume complete');
  app.exit(0);
}

module.exports = { runShotsVolumeSelftest };
