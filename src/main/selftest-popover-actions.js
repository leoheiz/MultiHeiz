'use strict';

/**
 * Selftest: ações restauradas nos popovers do overlay (Suspender/Reativar, layout, menus).
 * MULTIHEIZ_SELFTEST=popover-actions
 */

const http = require('node:http');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runPopoverActionsSelftest(ctx) {
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
    getState,
    waitForLayoutSettle,
  } = ctx;

  console.log('SELFTEST popover-actions');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>pa</title></head>
<body style="margin:0;background:#234;color:#fff;font:14px system-ui;width:100%;height:100%">
Popover actions
<script>
window.__paClicks = 0;
document.addEventListener('click', function(){ window.__paClicks++; }, true);
document.addEventListener('mousedown', function(){ window.__paMouseDown = (window.__paMouseDown||0)+1; }, true);
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
  const base = `http://127.0.0.1:${port}/`;

  updateState((s) => {
    s.workspaces = [
      { id: 'ws-pa', name: 'Área PA' },
      { id: 'ws-pb', name: 'Área PB' },
    ];
    s.activeWorkspaceId = 'ws-pa';
    s.layout = '2';
    if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
      s.layoutByWorkspace = {};
    }
    s.layoutByWorkspace['ws-pa'] = '2';
    s.layoutByWorkspace['ws-pb'] = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-pa-a',
        name: 'Janela A',
        color: '#2bb8a6',
        startUrl: base,
        workspaceId: 'ws-pa',
        muted: false,
        volume: 100,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-pa-b',
        name: 'Janela B',
        color: '#4a90d9',
        startUrl: base,
        workspaceId: 'ws-pa',
        muted: false,
        volume: 80,
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
  });
  flushSave();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(400);

  panels.createPanel('acc-pa-a');
  panels.createPanel('acc-pa-b');
  {
    const [bw, bh] = mainWindow.getContentSize();
    const half = Math.floor(bw / 2);
    panels.syncVisiblePanels([
      { accountId: 'acc-pa-a', x: 0, y: 80, width: half, height: Math.max(240, bh - 80) },
      { accountId: 'acc-pa-b', x: half, y: 80, width: bw - half, height: Math.max(240, bh - 80) },
    ]);
  }
  await sleep(400);
  panels.panelNavigate('acc-pa-a', base);
  panels.panelNavigate('acc-pa-b', base);
  await waitForUrl('acc-pa-a', (u) => u.startsWith(base.replace(/\/$/, '')), 15000);
  await waitForUrl('acc-pa-b', (u) => u.startsWith(base.replace(/\/$/, '')), 15000);
  if (typeof waitForLayoutSettle === 'function') await waitForLayoutSettle(800);
  await sleep(300);

  async function overlayEval(code) {
    const view = popoverOverlay.getView();
    assert(view && view.webContents && !view.webContents.isDestroyed(), 'overlay webContents');
    return view.webContents.executeJavaScript(code, true);
  }

  function seedMetrics(extra) {
    const baseMetrics = {
      totalRamMb: 120,
      totalCpu: 2.5,
      processCount: 4,
      metric: 'workingSetSize',
      breakdown: { panelsMb: 90, interfaceMb: 15, gpuMb: 10, outrosMb: 5 },
      panels: [
        {
          accountId: 'acc-pa-a',
          name: 'Janela A',
          workspaceName: 'Área PA',
          state: 'ativo',
          active: true,
          suspended: false,
          forced: false,
          visible: true,
          focused: true,
          ramMb: 50,
          cpu: 1.2,
          pid: 1001,
          shared: false,
          sharedWith: [],
        },
        {
          accountId: 'acc-pa-b',
          name: 'Janela B',
          workspaceName: 'Área PA',
          state: 'ativo',
          active: true,
          suspended: false,
          forced: false,
          visible: true,
          focused: false,
          ramMb: 40,
          cpu: 0.8,
          pid: 1002,
          shared: false,
          sharedWith: [],
        },
      ],
    };
    emitToRenderer({
      type: 'memory:metrics',
      metrics: { ...baseMetrics, ...(extra || {}) },
    });
  }

  // --- Memory: Suspender / Reativar via clique no DOM da overlay ---
  seedMetrics();
  await sleep(80);
  await rendererEval('window.__multiheizUi.openMemPopover()');
  await sleep(250);
  const dbgMem = await rendererEval('window.multiheiz.popoverGet()');
  assert(dbgMem && dbgMem.open && dbgMem.id === 'mem-popover', 'mem open: ' + JSON.stringify(dbgMem));

  const suspendClick = await overlayEval(`(() => {
    const btn = document.querySelector('[data-role="mem-suspend"][data-account-id="acc-pa-b"]');
    if (!btn) {
      return {
        ok: false,
        reason: 'no-suspend',
        text: (document.body && document.body.innerText || '').slice(0, 400),
      };
    }
    btn.click();
    return { ok: true, label: btn.textContent };
  })()`);
  assert(suspendClick && suspendClick.ok, 'click Suspender: ' + JSON.stringify(suspendClick));
  await sleep(500);
  assert(panels.isForceSuspended('acc-pa-b'), 'acc-pa-b suspended after overlay click');
  assert(!panels.isForceSuspended('acc-pa-a'), 'acc-pa-a still active');
  console.log('PASS: Suspender via overlay');

  // Ensure monitor still open with Reativar (reopen if race closed it)
  let dbgAfterSusp = await rendererEval('window.multiheiz.popoverGet()');
  if (!dbgAfterSusp || !dbgAfterSusp.open || dbgAfterSusp.id !== 'mem-popover') {
    await rendererEval('window.__multiheizUi.openMemPopover()');
    await sleep(250);
    dbgAfterSusp = await rendererEval('window.multiheiz.popoverGet()');
  }
  assert(dbgAfterSusp && dbgAfterSusp.open, 'mem still open after suspend: ' + JSON.stringify(dbgAfterSusp));

  const reactivateClick = await overlayEval(`(() => {
    const btn = document.querySelector('[data-role="mem-reactivate"][data-account-id="acc-pa-b"]');
    if (!btn) {
      return {
        ok: false,
        reason: 'no-reactivate',
        roles: [...document.querySelectorAll('[data-role]')].map((n) => n.getAttribute('data-role') + ':' + (n.dataset.accountId || '')),
        text: (document.body && document.body.innerText || '').slice(0, 400),
      };
    }
    btn.click();
    return { ok: true };
  })()`);
  assert(reactivateClick && reactivateClick.ok, 'click Reativar: ' + JSON.stringify(reactivateClick));
  await sleep(400);
  assert(!panels.isForceSuspended('acc-pa-b'), 'acc-pa-b reactivated');
  console.log('PASS: Reativar via overlay');

  // Clique DENTRO (Suspender de novo) NÃO fecha o popover
  seedMetrics({
    panels: [
      {
        accountId: 'acc-pa-a',
        name: 'Janela A',
        workspaceName: 'Área PA',
        state: 'ativo',
        active: true,
        suspended: false,
        forced: false,
        visible: true,
        focused: true,
        ramMb: 50,
        cpu: 1.2,
        pid: 1001,
        shared: false,
        sharedWith: [],
      },
      {
        accountId: 'acc-pa-b',
        name: 'Janela B',
        workspaceName: 'Área PA',
        state: 'ativo',
        active: true,
        suspended: false,
        forced: false,
        visible: true,
        focused: false,
        ramMb: 40,
        cpu: 0.8,
        pid: 1002,
        shared: false,
        sharedWith: [],
      },
    ],
  });
  await sleep(80);
  {
    let open = await rendererEval('window.multiheiz.popoverGet()');
    if (!open || !open.open) {
      await rendererEval('window.__multiheizUi.openMemPopover()');
      await sleep(250);
    }
    await overlayEval(`(() => {
      const btn = document.querySelector('[data-role="mem-suspend"][data-account-id="acc-pa-b"]');
      if (btn) btn.click();
      return true;
    })()`);
    await sleep(500);
    const still = await rendererEval('window.multiheiz.popoverGet()');
    assert(still && still.open && still.id === 'mem-popover', 'Suspender inside must keep mem open: ' + JSON.stringify(still));
    console.log('PASS: Suspender dentro não fecha');
  }

  // Clique FORA num painel fecha E a página recebe o clique
  {
    await panels.getPanelCapture('acc-pa-a').executeJavaScript('window.__paClicks = 0; window.__paMouseDown = 0;', true);
    const wc = panels.getPanelCapture('acc-pa-a');
    assert(wc, 'panel wc for outside click');
    wc.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
    await sleep(350);
    const afterOut = await rendererEval('window.multiheiz.popoverGet()');
    assert(!afterOut || !afterOut.open, 'click panel must close popover: ' + JSON.stringify(afterOut));
    const clicks = await wc.executeJavaScript(
      '({ clicks: window.__paClicks|0, down: window.__paMouseDown|0 })',
      true
    );
    assert(
      clicks && (clicks.clicks >= 1 || clicks.down >= 1),
      'page must receive click: ' + JSON.stringify(clicks)
    );
    console.log('PASS: clique no painel fecha popover e página recebe', clicks);
  }

  // Esc fecha
  await rendererEval('window.__multiheizUi.openMemPopover()');
  await sleep(250);
  {
    const view = popoverOverlay.getView();
    assert(view, 'overlay for Esc');
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(250);
    const afterEsc = await rendererEval('window.multiheiz.popoverGet()');
    assert(!afterEsc || !afterEsc.open, 'Esc must close: ' + JSON.stringify(afterEsc));
    console.log('PASS: Esc fecha mem-popover');
  }

  // Clique na linha foca a janela
  await rendererEval('window.__multiheizUi.openMemPopover()');
  await sleep(250);
  panels.setFocusedAccount('acc-pa-a');
  await sleep(100);
  const focusClick = await overlayEval(`(() => {
    const row = document.querySelector('.mem-row[data-account-id="acc-pa-b"]');
    if (!row) return { ok: false };
    row.click();
    return { ok: true };
  })()`);
  assert(focusClick && focusClick.ok, 'click mem-row focus');
  await sleep(250);
  assert(panels.getFocusedAccountId() === 'acc-pa-b', 'focused acc-pa-b after row click');
  console.log('PASS: clique na linha foca janela');

  popoverOverlay.hide('test');
  await sleep(120);

  // --- Layout: aplicar Livre via overlay ---
  await rendererEval('window.__multiheizUi.openLayoutSelectPopover()');
  await sleep(250);
  const layoutClick = await overlayEval(`(() => {
    const btns = [...document.querySelectorAll('.layout-menu button')];
    const livre = btns.find((b) => /livre/i.test(b.textContent || ''));
    if (!livre) return { ok: false, labels: btns.map((b) => b.textContent) };
    livre.click();
    return { ok: true };
  })()`);
  assert(layoutClick && layoutClick.ok, 'layout Livre click: ' + JSON.stringify(layoutClick));
  await sleep(400);
  const stLay = getState();
  assert(
    stLay && (stLay.layout === 'livre' || (stLay.layoutByWorkspace && stLay.layoutByWorkspace['ws-pa'] === 'livre')),
    'layout applied livre: ' + JSON.stringify({ layout: stLay && stLay.layout, by: stLay && stLay.layoutByWorkspace })
  );
  console.log('PASS: layout Livre via overlay');

  // Volta para grade 2 (próximos testes)
  await rendererEval('window.__multiheizUi.openLayoutSelectPopover()');
  await sleep(200);
  await overlayEval(`(() => {
    const btns = [...document.querySelectorAll('.layout-menu button')];
    const two = btns.find((b) => String(b.textContent || '').trim() === '2');
    if (two) two.click();
    return true;
  })()`);
  await sleep(300);

  // --- Menu de área: Renomear ---
  await rendererEval('window.__multiheizUi.showWsContextMenu("ws-pa", 80, 60)');
  await sleep(250);
  const renameClick = await overlayEval(`(() => {
    const btns = [...document.querySelectorAll('.context-menu button')];
    const rename = btns.find((b) => (b.textContent || '').trim() === 'Renomear');
    if (!rename) return { ok: false, labels: btns.map((b) => b.textContent) };
    rename.click();
    return { ok: true };
  })()`);
  assert(renameClick && renameClick.ok, 'rename click: ' + JSON.stringify(renameClick));
  await sleep(300);
  const dlgOpen = await rendererEval(
    '!!(document.getElementById("dlg-workspace") && document.getElementById("dlg-workspace").open)'
  );
  assert(dlgOpen, 'dlg-workspace opened after Renomear');
  await rendererEval(
    'document.getElementById("dlg-workspace") && document.getElementById("dlg-workspace").close()'
  );
  await sleep(100);
  console.log('PASS: menu de área Renomear');

  // --- Overflow de abas: trocar área ---
  await rendererEval('window.__multiheizUi.showTabsOverflowMenu()');
  await sleep(250);
  const wsClick = await overlayEval(`(() => {
    const btns = [...document.querySelectorAll('.context-menu button')];
    const pb = btns.find((b) => /Área PB/.test(b.textContent || ''));
    if (!pb) return { ok: false, labels: btns.map((b) => b.textContent) };
    pb.click();
    return { ok: true };
  })()`);
  assert(wsClick && wsClick.ok, 'tabs overflow click: ' + JSON.stringify(wsClick));
  await sleep(400);
  const stWs = getState();
  assert(stWs && stWs.activeWorkspaceId === 'ws-pb', 'switched to ws-pb');
  // Volta
  updateState((s) => {
    s.activeWorkspaceId = 'ws-pa';
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(200);
  console.log('PASS: menu overflow de abas');

  // --- Ext menu (vazio): Adicionar extensão ---
  await rendererEval('window.__multiheizUi.openPanelExtMenu("acc-pa-a", 100, 100)');
  await sleep(250);
  const addExt = await overlayEval(`(() => {
    const add = document.querySelector('[data-role="ext-add"]');
    if (!add) {
      return {
        ok: false,
        text: (document.body && document.body.innerText || '').slice(0, 300),
      };
    }
    add.click();
    return { ok: true };
  })()`);
  assert(addExt && addExt.ok, 'Adicionar extensão: ' + JSON.stringify(addExt));
  await sleep(350);
  const settingsOpen = await rendererEval(
    '!!(document.getElementById("dlg-settings") && document.getElementById("dlg-settings").open)'
  );
  assert(settingsOpen, 'settings opened from Adicionar extensão');
  await rendererEval(
    'document.getElementById("dlg-settings") && document.getElementById("dlg-settings").close()'
  );
  await sleep(100);
  console.log('PASS: panel-ext Adicionar extensão');

  // --- Volume continua OK ---
  const openVol = await rendererEval('window.__multiheizUi.openVolumePopover("acc-pa-a")');
  assert(openVol && openVol.ok, 'open volume: ' + JSON.stringify(openVol));
  await sleep(200);
  await rendererEval('window.__multiheizUi.setVolumePercent("acc-pa-a", 55)');
  await sleep(150);
  const vol = await rendererEval('window.__multiheizUi.getAccountVolume("acc-pa-a")');
  assert(Number(vol) === 55, 'volume 55 got ' + vol);
  popoverOverlay.hide('test');
  console.log('PASS: volume OK');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest popover-actions complete');
  app.exit(0);
}

module.exports = { runPopoverActionsSelftest };
