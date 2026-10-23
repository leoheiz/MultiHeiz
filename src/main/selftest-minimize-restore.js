'use strict';

/**
 * In-process minimize/restore geometry selftest (MULTIHEIZ_SELFTEST=minimize-restore).
 * Real sidebar minimize button + sidebar item restore via sendInputEvent.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {object} ctx
 */
async function runMinimizeRestoreSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    emitToRenderer,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
    waitForPanels,
    rendererEval,
    publicState,
    getState,
    app,
  } = ctx;

  console.log('SELFTEST minimize-restore');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  function tileEq(a, b) {
    if (!a || !b) return false;
    return a.c === b.c && a.r === b.r && a.w === b.w && a.h === b.h;
  }

  async function sendHostMove(x, y) {
    mainWindow.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(x),
      y: Math.round(y),
    });
    await sleep(40);
  }

  async function sendHostClick(x, y) {
    const wc = mainWindow.webContents;
    await sendHostMove(x, y);
    wc.sendInputEvent({
      type: 'mouseDown',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
    });
    await sleep(40);
    wc.sendInputEvent({
      type: 'mouseUp',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
    });
    await sleep(80);
  }

  async function rectOf(selector) {
    return rendererEval(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height };
    })()`);
  }

  /**
   * Reveal sidebar actions then click minimize via sendInputEvent.
   * Actions are display:none until :hover; offscreen CSS :hover is unreliable, so force
   * visibility for hit-testing while the click still goes through real input + DOM handler.
   */
  async function clickSidebarMinimize(accountId) {
    const itemSel = `.sidebar-item[data-account-id="${accountId}"]`;
    const item = await rectOf(itemSel);
    assert(item && item.w > 0, 'sidebar item for hover', item);
    await sendHostMove(item.x, item.y);
    await rendererEval(`(() => {
      const actions = document.querySelector(${JSON.stringify(itemSel + ' .sidebar-item-actions')});
      if (actions) actions.style.display = 'inline-flex';
      return !!actions;
    })()`);
    await sleep(50);
    const minBtn = await rectOf(`${itemSel} [data-role="sidebar-minimize"]`);
    assert(minBtn && minBtn.w > 0, 'minimize button after reveal', minBtn);
    await sendHostClick(minBtn.x, minBtn.y);
    await rendererEval(`(() => {
      const actions = document.querySelector(${JSON.stringify(itemSel + ' .sidebar-item-actions')});
      if (actions) actions.style.display = '';
      return true;
    })()`);
  }

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mr</title></head>
<body style="margin:0;background:#1a1d23;color:#eee;font:16px system-ui;padding:24px">
<h1>minimize-restore</h1>
</body></html>`;

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

  const customTiles = {
    'acc-mr-a': { c: 1, r: 1, w: 4, h: 3 },
    'acc-mr-b': { c: 6, r: 2, w: 5, h: 4 },
  };

  updateState((s) => {
    s.workspaces = [{ id: 'ws-mr', name: 'MR' }];
    s.activeWorkspaceId = 'ws-mr';
    s.layout = 'livre';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace['ws-mr'] = 'livre';
    s.page = 0;
    s.maximizedAccountId = null;
    s.freeTiles = { 'ws-mr': { ...customTiles } };
    s.settings = {
      ...(s.settings || {}),
      openLastPage: false,
      homepage: base + '/',
      confirmOnRemove: false,
    };
    s.ui = {
      ...(s.ui || {}),
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      layoutLocked: true,
      sidebarWidth: 240,
    };
    s.accounts = [
      {
        id: 'acc-mr-a',
        name: 'Painel A',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-mr',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
        minimized: false,
      },
      {
        id: 'acc-mr-b',
        name: 'Painel B',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-mr',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
        minimized: false,
      },
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(800);
  await waitForLayoutSettle();
  await waitForPanels(
    (i) =>
      i.panels.some((p) => p.accountId === 'acc-mr-a' && p.visible && !p.parked) &&
      i.panels.some((p) => p.accountId === 'acc-mr-b' && p.visible && !p.parked)
  );
  await waitForUrl('acc-mr-a', (u) => u.includes('127.0.0.1'), 30000);

  const tilesBefore = await rendererEval('window.__multiheizUi.getFreeTiles()');
  assert(tileEq(tilesBefore['acc-mr-b'], customTiles['acc-mr-b']), 'custom tile before minimize', {
    tilesBefore,
    expected: customTiles['acc-mr-b'],
  });
  console.log('PASS: custom free-layout tiles set', tilesBefore['acc-mr-b']);

  // Real click on sidebar minimize button for B (hover reveals actions)
  await clickSidebarMinimize('acc-mr-b');
  await sleep(400);
  await waitForLayoutSettle();

  const stMin = publicState();
  assert(
    !!(stMin.accounts || []).find((a) => a.id === 'acc-mr-b' && a.minimized),
    'account minimized after real click'
  );
  const tilesWhileMin = await rendererEval('window.__multiheizUi.getFreeTiles()');
  assert(
    tileEq(tilesWhileMin['acc-mr-b'], customTiles['acc-mr-b']),
    'freeTiles kept while minimized',
    tilesWhileMin
  );
  const infoMin = panels.getPanelDebugInfo();
  const pMin = (infoMin.panels || []).find((p) => p.accountId === 'acc-mr-b');
  assert(pMin && pMin.parked, 'panel parked while minimized', pMin);
  console.log('PASS: minimize via real button keeps freeTiles');

  // Persist across flush / disk
  flushSave();
  const diskPath = path.join(app.getPath('userData'), 'multiheiz-state.json');
  const diskRaw = fs.readFileSync(diskPath, 'utf8');
  const disk = JSON.parse(diskRaw);
  assert(
    tileEq(disk.freeTiles && disk.freeTiles['ws-mr'] && disk.freeTiles['ws-mr']['acc-mr-b'], customTiles['acc-mr-b']),
    'freeTiles persisted to disk while minimized',
    disk.freeTiles
  );
  console.log('PASS: freeTiles survive disk while minimized');

  // Restore via real sidebar item click (not the minimize button)
  const itemRect = await rectOf('.sidebar-item[data-account-id="acc-mr-b"]');
  assert(itemRect && itemRect.w > 0, 'sidebar item rect', itemRect);
  // Click body area (left of actions) so we don't hit minimize again
  await sendHostClick(itemRect.left + 40, itemRect.y);
  await sleep(500);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-mr-b' && p.visible && !p.parked));

  const stRest = publicState();
  assert(
    !!(stRest.accounts || []).find((a) => a.id === 'acc-mr-b' && !a.minimized),
    'account restored'
  );
  const tilesAfter = await rendererEval('window.__multiheizUi.getFreeTiles()');
  assert(
    tileEq(tilesAfter['acc-mr-b'], customTiles['acc-mr-b']),
    'free-layout bounds identical after restore',
    { tilesAfter, expected: customTiles['acc-mr-b'] }
  );
  console.log('PASS: restore via sidebar click keeps exact free-layout bounds');

  /* ---------- Grid mode: slot / order preserved ---------- */
  updateState((s) => {
    s.layout = '4';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace['ws-mr'] = '4';
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-g1',
        name: 'G1',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-mr',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
        minimized: false,
      },
      {
        id: 'acc-g2',
        name: 'G2',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-mr',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
        minimized: false,
      },
      {
        id: 'acc-g3',
        name: 'G3',
        color: '#e8a54b',
        startUrl: base + '/',
        workspaceId: 'ws-mr',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
        minimized: false,
      },
      {
        id: 'acc-g4',
        name: 'G4',
        color: '#e25c5c',
        startUrl: base + '/',
        workspaceId: 'ws-mr',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
        minimized: false,
      },
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();
  await waitForPanels((i) => (i.panels || []).filter((p) => p.visible && !p.parked).length >= 4);

  const orderBefore = await rendererEval(`([...document.querySelectorAll('.panel-slot')]
    .map((n) => n.dataset.accountId || ''))`);
  assert(
    JSON.stringify(orderBefore) === JSON.stringify(['acc-g1', 'acc-g2', 'acc-g3', 'acc-g4']),
    'grid order before',
    orderBefore
  );

  await clickSidebarMinimize('acc-g2');
  await sleep(400);
  await waitForLayoutSettle();

  const orderMid = await rendererEval(`([...document.querySelectorAll('.panel-slot')]
    .map((n) => n.dataset.accountId || ''))`);
  assert(
    JSON.stringify(orderMid) === JSON.stringify(['acc-g1', 'acc-g3', 'acc-g4']),
    'grid drops minimized from slots',
    orderMid
  );

  const itemG2 = await rectOf('.sidebar-item[data-account-id="acc-g2"]');
  await sendHostClick(itemG2.left + 40, itemG2.y);
  await sleep(500);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-g2' && p.visible && !p.parked));

  const orderAfter = await rendererEval(`([...document.querySelectorAll('.panel-slot')]
    .map((n) => n.dataset.accountId || ''))`);
  assert(
    JSON.stringify(orderAfter) === JSON.stringify(['acc-g1', 'acc-g2', 'acc-g3', 'acc-g4']),
    'grid slot/order restored',
    orderAfter
  );
  console.log('PASS: grid mode slot/order preserved after minimize/restore');

  // Sanity: state still has freeTiles for earlier livre account if still present
  void getState;

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest minimize-restore complete');
  app.exit(0);
}

module.exports = { runMinimizeRestoreSelftest };
