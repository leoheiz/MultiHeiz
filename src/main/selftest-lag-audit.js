'use strict';

/**
 * Selftest: auditoria de lag (MULTIHEIZ_SELFTEST=lag-audit).
 * Mede monitorEventLoopDelay no main + maior gap de rAF no renderer
 * para cada ação; espiona hide/capturePage de painéis.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { app } = require('electron');
const { envGet } = require('./config');
const contextMenu = require('./context-menu');

const PHASE = String(envGet('MULTIHEIZ_LAG_PHASE') || 'check').toLowerCase();
/** Fail check if light action max main lag exceeds this (ms). */
const LIGHT_BUDGET_MS = Number(envGet('MULTIHEIZ_LAG_BUDGET_MS')) || 100;
/** Soft target used in the report (fix when above). */
const SOFT_TARGET_MS = 50;

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>lag</title></head>
<body style="margin:0;background:#123;color:#fff;font:16px system-ui">
<video id="v" width="320" height="180" autoplay muted loop playsinline></video>
<canvas id="c" width="320" height="180" style="display:none"></canvas>
<script>
(function(){
  var c = document.getElementById('c');
  var ctx = c.getContext('2d');
  var t0 = performance.now();
  function frame(t) {
    var x = ((t - t0) / 16) % 320;
    ctx.fillStyle = '#0a2030';
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#2bb8a6';
    ctx.fillRect(x, 60, 40, 60);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  var stream = c.captureStream(30);
  var v = document.getElementById('v');
  v.srcObject = stream;
  v.play().catch(function(){});
  window.__lagPage = {
    currentTime: function() { return v.currentTime || 0; },
    playing: function() { return !v.paused; }
  };
})();
</script>
</body></html>`;

/**
 * @param {object} ctx
 */
async function runLagAuditSelftest(ctx) {
  const {
    mainWindow,
    panels,
    popoverOverlay,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    rendererEval,
    publicState,
    emitToRenderer,
    waitForLayoutSettle,
    getState,
  } = ctx;

  console.log('SELFTEST lag-audit phase=' + PHASE + ' lightBudgetMs=' + LIGHT_BUDGET_MS);

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const logDir = path.join(__dirname, '..', '..', '_local');
  fs.mkdirSync(logDir, { recursive: true });
  const mdPath = path.join(logDir, 'lag-audit.md');
  const jsonPath = path.join(logDir, 'lag-audit-results-' + PHASE + '.json');

  let server = null;
  let port = 0;
  const quietHtml =
    '<!DOCTYPE html><html><body style="margin:0;background:#234;color:#fff;font:18px sans-serif;padding:24px">quiet</body></html>';
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = String(req.url || '');
      if (u.startsWith('/quiet')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(quietHtml);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}/`;
  const quiet = `http://127.0.0.1:${port}/quiet`;

  updateState((s) => {
    s.workspaces = [
      { id: 'ws-lag-a', name: 'LagA' },
      { id: 'ws-lag-b', name: 'LagB' },
    ];
    s.activeWorkspaceId = 'ws-lag-a';
    s.layout = '3';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace['ws-lag-a'] = '3';
    s.layoutByWorkspace['ws-lag-b'] = 'auto';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-lag-v',
        name: 'Video',
        color: '#2bb8a6',
        startUrl: base,
        workspaceId: 'ws-lag-a',
        muted: false,
        volume: 100,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-lag-b',
        name: 'B',
        color: '#4a90d9',
        startUrl: quiet,
        workspaceId: 'ws-lag-a',
        muted: false,
        volume: 80,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-lag-c',
        name: 'C',
        color: '#d94a4a',
        startUrl: quiet,
        workspaceId: 'ws-lag-a',
        muted: false,
        volume: 60,
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
      ...(s.settings || {}),
      openLastPage: false,
      homepage: quiet,
      doh: { mode: 'off', provider: 'cloudflare', customUrl: '' },
      lightMode: false,
      modules: { planilha: true, alarmes: true, notas: true },
      adblock: {
        ...((s.settings && s.settings.adblock) || {}),
        enabled: true,
      },
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(500);

  for (const id of ['acc-lag-v', 'acc-lag-b', 'acc-lag-c']) {
    panels.createPanel(id);
  }
  {
    const [bw, bh] = mainWindow.getContentSize();
    const w = Math.floor(bw / 3);
    const h = Math.max(240, bh - 80);
    panels.syncVisiblePanels([
      { accountId: 'acc-lag-v', x: 0, y: 80, width: w, height: h },
      { accountId: 'acc-lag-b', x: w, y: 80, width: w, height: h },
      { accountId: 'acc-lag-c', x: w * 2, y: 80, width: bw - w * 2, height: h },
    ]);
  }
  await sleep(400);
  panels.panelNavigate('acc-lag-v', base);
  panels.panelNavigate('acc-lag-b', quiet);
  panels.panelNavigate('acc-lag-c', quiet);
  await waitForUrl('acc-lag-v', (u) => u.includes('127.0.0.1'), 20000);
  await waitForUrl('acc-lag-b', (u) => u.includes('127.0.0.1'), 20000);
  await waitForUrl('acc-lag-c', (u) => u.includes('127.0.0.1'), 20000);
  await sleep(700);
  if (typeof waitForLayoutSettle === 'function') await waitForLayoutSettle(1200);

  async function panelEval(id, code) {
    const wc = panels.getPanelCapture(id);
    assert(wc, 'wc ' + id);
    return wc.executeJavaScript(code, true);
  }

  // Warm video
  const t0 = await panelEval('acc-lag-v', 'window.__lagPage.currentTime()');
  await sleep(500);
  const t1 = await panelEval('acc-lag-v', 'window.__lagPage.currentTime()');
  assert(Number(t1) > Number(t0), 'video advances baseline');
  console.log('PASS: video baseline', { t0, t1 });

  // --- probes ---
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();

  await rendererEval(`(function(){
    window.__lagRaf = { maxGap: 0, last: 0, running: false, id: 0, frames: 0 };
    function loop(ts) {
      var s = window.__lagRaf;
      if (!s.running) return;
      s.frames++;
      if (s.last) {
        var g = ts - s.last;
        if (g > s.maxGap) s.maxGap = g;
      }
      s.last = ts;
      s.id = requestAnimationFrame(loop);
    }
    window.__lagRaf.start = function() {
      var s = window.__lagRaf;
      s.maxGap = 0;
      s.last = 0;
      s.frames = 0;
      s.running = true;
      s.id = requestAnimationFrame(loop);
    };
    window.__lagRaf.stop = function() {
      var s = window.__lagRaf;
      s.running = false;
      if (s.id) cancelAnimationFrame(s.id);
      s.id = 0;
      return { maxGap: s.maxGap, frames: s.frames };
    };
    return true;
  })()`);

  function resetProbes() {
    h.reset();
    panels.clearOverlaySelftestSpies();
    if (popoverOverlay && popoverOverlay.clearSelftestLog) popoverOverlay.clearSelftestLog();
  }

  async function measureAction(name, kind, fn) {
    resetProbes();
    await rendererEval('window.__lagRaf.start()');
    // settle a couple frames
    await sleep(40);
    h.reset();
    const tStart = performance.now();
    await fn();
    const wallMs = performance.now() - tStart;
    await sleep(100);
    const rafInfo = await rendererEval('window.__lagRaf.stop()');
    const frameGapMs =
      rafInfo && typeof rafInfo === 'object'
        ? Number(rafInfo.maxGap) || 0
        : Number(rafInfo) || 0;
    // monitorEventLoopDelay: max is in nanoseconds
    const maxLagMs = Number(h.max) / 1e6;
    const meanLagMs = Number(h.mean) / 1e6;
    const spies = panels.getOverlaySelftestSpies
      ? panels.getOverlaySelftestSpies()
      : [];
    const badSpies = spies.filter((s) =>
      /capturePage|parkViews|prepareAndPark|setVisible\(false\)/.test(String(s.op || ''))
    );
    const hidOrSnap = badSpies.length > 0;
    const row = {
      action: name,
      kind,
      maxLagMs: Math.round(maxLagMs * 10) / 10,
      meanLagMs: Math.round(meanLagMs * 10) / 10,
      frameGapMs: Math.round(frameGapMs * 10) / 10,
      wallMs: Math.round(wallMs * 10) / 10,
      hidOrSnap,
      spies: badSpies.map((s) => s.op),
      expectModal: kind === 'modal',
    };
    console.log(
      'LAG',
      name,
      'lag=' + row.maxLagMs.toFixed(1) + 'ms',
      'raf=' + row.frameGapMs.toFixed(1) + 'ms',
      'hide=' + hidOrSnap
    );
    return row;
  }

  /** @type {Array<object>} */
  const rows = [];

  async function closePopovers() {
    try {
      if (popoverOverlay) popoverOverlay.hide('lag-audit');
    } catch {
      /* ignore */
    }
    await rendererEval(`(function(){
      if (window.__multiheizUi && window.__multiheizUi.closeVolumePopover) {
        window.__multiheizUi.closeVolumePopover();
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()`);
    await sleep(120);
  }

  // --- Light: volume ---
  rows.push(
    await measureAction('popover-volume-open', 'light', async () => {
      const r = await rendererEval('window.__multiheizUi.openVolumePopover("acc-lag-v")');
      assert(r && r.ok, 'volume open');
      await sleep(120);
    })
  );
  rows.push(
    await measureAction('popover-volume-close', 'light', async () => {
      await closePopovers();
    })
  );

  // --- site info ---
  rows.push(
    await measureAction('popover-site-info', 'light', async () => {
      const r = await rendererEval('window.__multiheizUi.openSitePermissions("acc-lag-v")');
      assert(r && r.overlay, 'site overlay');
      await sleep(100);
      await closePopovers();
    })
  );

  // --- layout select ---
  rows.push(
    await measureAction('popover-layout', 'light', async () => {
      await rendererEval('window.__multiheizUi.openLayoutSelectPopover()');
      await sleep(120);
      await closePopovers();
    })
  );

  // --- topbar menus (intercepted) ---
  rows.push(
    await measureAction('menu-topbar', 'light', async () => {
      const r = await rendererEval(
        'window.multiheiz.popupTopMenu && window.multiheiz.popupTopMenu(80, 40)'
      );
      // fallback: invoke via IPC path if API name differs
      if (!r) {
        await mainWindow.webContents.executeJavaScript(
          'window.multiheiz.popupAppMenu ? window.multiheiz.popupAppMenu(80,40) : null',
          true
        );
      }
      await sleep(60);
    })
  );

  // --- account menu (intercepted) ---
  rows.push(
    await measureAction('menu-account', 'light', async () => {
      await rendererEval('window.multiheiz.popupAccountMenu("acc-lag-v", 200, 120)');
      await sleep(60);
    })
  );

  // --- workspace switch ---
  rows.push(
    await measureAction('workspace-switch', 'light', async () => {
      await rendererEval('window.multiheiz.setWorkspace("ws-lag-b")');
      await sleep(200);
      await rendererEval('window.multiheiz.setWorkspace("ws-lag-a")');
      await sleep(200);
    })
  );

  // --- layout change ---
  rows.push(
    await measureAction('layout-change', 'light', async () => {
      await rendererEval('window.multiheiz.setLayout("2")');
      await sleep(200);
      await rendererEval('window.multiheiz.setLayout("3")');
      await sleep(200);
    })
  );

  // --- add / remove window ---
  rows.push(
    await measureAction('window-add-remove', 'light', async () => {
      const created = await rendererEval(`(async function(){
        const res = await window.multiheiz.createAccount({
          name: 'Temp',
          startUrl: ${JSON.stringify(quiet)},
          workspaceId: 'ws-lag-a'
        });
        return res && res.account ? res.account.id : null;
      })()`);
      assert(created, 'create account');
      await sleep(250);
      await rendererEval(
        `window.multiheiz.removeAccount(${JSON.stringify(created)})`
      );
      await sleep(250);
    })
  );

  // --- sidebar arrow ---
  rows.push(
    await measureAction('sidebar-arrow', 'light', async () => {
      await rendererEval('window.__multiheizUi.clickSidebarToggleButton()');
      await sleep(150);
      await rendererEval('window.__multiheizUi.clickSidebarToggleButton()');
      await sleep(150);
    })
  );

  // --- sidebar pin ---
  rows.push(
    await measureAction('sidebar-pin', 'light', async () => {
      if (typeof rendererEval === 'function') {
        const has = await rendererEval(
          '!!(window.__multiheizUi && window.__multiheizUi.clickSidebarPinButton)'
        );
        if (has) {
          await rendererEval('window.__multiheizUi.clickSidebarPinButton()');
          await sleep(200);
          await rendererEval('window.__multiheizUi.clickSidebarPinButton()');
          await sleep(200);
        } else {
          await rendererEval(`(async function(){
            await window.multiheiz.updateUi({ sidebarAutoHide: true });
            await window.multiheiz.updateUi({ sidebarAutoHide: false });
            return true;
          })()`);
          await sleep(200);
        }
      }
    })
  );

  // --- settings (modal — snapshot expected) ---
  rows.push(
    await measureAction('settings-open', 'modal', async () => {
      await rendererEval('window.__multiheizUi.openSettings()');
      await sleep(300);
    })
  );
  // Toggles with settings modal open count as light (budget); open modal stays modal.
  rows.push(
    await measureAction('settings-toggle-appearance', 'light', async () => {
      await rendererEval(`(async function(){
        if (window.MultiHeizV16 && window.MultiHeizV16.openSettingsSection) {
          window.MultiHeizV16.openSettingsSection('aparencia');
        }
        await window.multiheiz.updateSettings({ lightMode: true });
        await window.multiheiz.updateSettings({ lightMode: false });
        return true;
      })()`);
      await sleep(80);
    })
  );
  rows.push(
    await measureAction('settings-toggle-doh', 'light', async () => {
      await rendererEval(`(async function(){
        if (window.MultiHeizV16 && window.MultiHeizV16.openSettingsSection) {
          window.MultiHeizV16.openSettingsSection('rede');
        }
        await window.multiheiz.updateSettings({
          doh: { mode: 'automatic', provider: 'cloudflare', customUrl: '' }
        });
        await window.multiheiz.updateSettings({
          doh: { mode: 'off', provider: 'cloudflare', customUrl: '' }
        });
        return true;
      })()`);
      await sleep(80);
    })
  );
  rows.push(
    await measureAction('settings-toggle-adblock', 'light', async () => {
      await rendererEval(`(async function(){
        if (window.MultiHeizV16 && window.MultiHeizV16.openSettingsSection) {
          window.MultiHeizV16.openSettingsSection('bloqueador');
        }
        const ab = (await window.multiheiz.getState()).settings.adblock || {};
        const on = ab.enabled !== false;
        // Only enabled — must not ship lists/cosmetic (deep-diff + no rebuild).
        await window.multiheiz.updateSettings({ adblock: { enabled: !on } });
        await window.multiheiz.updateSettings({ adblock: { enabled: on } });
        return true;
      })()`);
      await sleep(120);
    })
  );
  rows.push(
    await measureAction('settings-close', 'modal', async () => {
      await rendererEval(`(function(){
        const dlg = document.getElementById('dlg-settings');
        if (dlg && dlg.open) dlg.close();
        return true;
      })()`);
      await sleep(250);
      // Guarantee no leftover modal overlays before modules.
      if (typeof panels.setOverlayCount === 'function') {
        await panels.setOverlayCount([]);
      }
      await sleep(100);
    })
  );

  // --- Notes / Alarms / Sheet (module-view modal) ---
  for (const mod of ['notas', 'alarmes', 'planilha']) {
    rows.push(
      await measureAction('module-' + mod, 'modal', async () => {
        await rendererEval(`window.__multiheizUi.openModule(${JSON.stringify(mod)})`);
        await sleep(450);
        const active = await rendererEval(
          'window.__multiheizUi.getActiveModule && window.__multiheizUi.getActiveModule()'
        );
        assert(active === mod, 'module open ' + mod + ' got ' + active);
        await rendererEval('window.__multiheizUi.closeModule()');
        await sleep(250);
        if (typeof panels.setOverlayCount === 'function') {
          await panels.setOverlayCount([]);
        }
      })
    );
  }

  // --- context menu (spy, no native popup) ---
  rows.push(
    await measureAction('context-menu', 'light', async () => {
      const wc = panels.getPanelCapture('acc-lag-v');
      assert(wc, 'wc for ctx');
      let got = false;
      contextMenu.setSelftestHooks({
        onPopup: () => {
          got = true;
        },
      });
      try {
        wc.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'right', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'right', clickCount: 1 });
        await sleep(200);
      } finally {
        contextMenu.setSelftestHooks(null);
      }
      void got;
    })
  );

  h.disable();

  // --- budgets ---
  /** Settings toggles (modal open): soft meta is the hard gate (< 50 ms). */
  const SETTINGS_TOGGLE_BUDGET_MS = SOFT_TARGET_MS;
  const failures = [];
  for (const r of rows) {
    if (r.kind === 'light') {
      if (r.hidOrSnap) {
        failures.push(r.action + ': escondeu/fotografou painel (não é modal)');
      }
      if (PHASE === 'check' || PHASE === 'after') {
        const isSettingsToggle = /^settings-toggle-/.test(String(r.action || ''));
        const budget = isSettingsToggle ? SETTINGS_TOGGLE_BUDGET_MS : LIGHT_BUDGET_MS;
        if (r.maxLagMs > budget) {
          failures.push(
            r.action + ': lag main ' + r.maxLagMs + 'ms > budget ' + budget + 'ms'
          );
        }
      }
    }
  }

  const payload = {
    phase: PHASE,
    at: new Date().toISOString(),
    softTargetMs: SOFT_TARGET_MS,
    lightBudgetMs: LIGHT_BUDGET_MS,
    rows,
    failures,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote', jsonPath);

  // Merge tables into lag-audit.md
  updateLagAuditMarkdown(mdPath, PHASE, rows, failures);

  if (failures.length) {
    console.log('FAIL: lag-audit budgets', failures);
    throw new Error('lag-audit failures: ' + failures.join('; '));
  }

  console.log('PASS: lag-audit phase=' + PHASE + ' actions=' + rows.length);
  try {
    server.close();
  } catch {
    /* ignore */
  }
  app.exit(0);
}

/**
 * @param {string} mdPath
 * @param {string} phase
 * @param {Array<object>} rows
 * @param {string[]} failures
 */
function updateLagAuditMarkdown(mdPath, phase, rows, failures) {
  let md = '';
  try {
    md = fs.readFileSync(mdPath, 'utf8');
  } catch {
    md = '# Auditoria de lag MultiHeiz 1.3.0\n\n';
  }

  const tableLines = [
    `| Ação | Tipo | Lag main (ms) | RAF gap (ms) | Hide/snap |`,
    `|---|---|---:|---:|---|`,
  ];
  for (const r of rows) {
    tableLines.push(
      `| ${r.action} | ${r.kind} | ${r.maxLagMs.toFixed(1)} | ${r.frameGapMs.toFixed(1)} | ${
        r.hidOrSnap ? 'sim (' + (r.spies || []).join(',') + ')' : 'não'
      } |`
    );
  }
  const block =
    `\n## Medição ${phase.toUpperCase()} (${new Date().toISOString()})\n\n` +
    tableLines.join('\n') +
    '\n\n' +
    (failures.length
      ? 'Falhas: ' + failures.map((f) => '`' + f + '`').join('; ') + '\n'
      : 'Sem falhas de orçamento nesta fase.\n');

  const markerStart = `<!-- LAG-TABLE:${phase} -->`;
  const markerEnd = `<!-- /LAG-TABLE:${phase} -->`;
  const wrapped = `${markerStart}\n${block}\n${markerEnd}`;
  if (md.includes(markerStart) && md.includes(markerEnd)) {
    md = md.replace(
      new RegExp(markerStart + '[\\s\\S]*?' + markerEnd),
      wrapped
    );
  } else {
    md = md.trimEnd() + '\n\n' + wrapped + '\n';
  }
  fs.writeFileSync(mdPath, md, 'utf8');
}

module.exports = { runLagAuditSelftest };
