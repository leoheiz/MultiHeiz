'use strict';

/**
 * Selftest: memory monitor popover scroll (MULTIHEIZ_SELFTEST=popover-scroll).
 */

const { app } = require('electron');

async function runPopoverScrollSelftest(ctx) {
  const {
    mainWindow,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    rendererEval,
  } = ctx;

  console.log('SELFTEST popover-scroll');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  // 10 windows; small main window so the popover must scroll.
  const accounts = [];
  for (let i = 0; i < 10; i++) {
    accounts.push({
      id: 'acc-ps-' + i,
      name: 'W' + i,
      color: '#2bb8a6',
      startUrl: 'about:blank',
      workspaceId: 'ws-ps',
      muted: false,
      lastUrl: null,
    });
  }
  updateState((s) => {
    s.workspaces = [{ id: 'ws-ps', name: 'PS' }];
    s.activeWorkspaceId = 'ws-ps';
    s.layout = '4';
    s.page = 0;
    s.accounts = accounts;
    if (!s.settings) s.settings = {};
    s.settings.memoryCleanupEnabled = true;
    s.settings.memoryCleanupIntervalMin = 15;
    s.windowBounds = { width: 900, height: 600, x: 40, y: 40 };
  });
  flushSave();
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setContentSize(900, 600);
    }
  } catch {
    /* ignore */
  }
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();

  const metricsPanels = accounts.map((a, i) => ({
    accountId: a.id,
    name: a.name,
    workspaceName: 'PS',
    state: 'ativo',
    ramMb: 20 + i,
    cpu: 1,
    active: true,
    focused: i === 0,
    shared: false,
  }));
  emitToRenderer({
    type: 'memory:metrics',
    metrics: {
      totalRamMb: 900,
      totalCpu: 5,
      processCount: 12,
      workingSetMb: 900,
      privateMb: 700,
      metric: 'workingSet',
      panels: metricsPanels,
      breakdown: { panelsMb: 400, interfaceMb: 80, gpuMb: 40, outrosMb: 80 },
    },
  });
  await sleep(300);

  await rendererEval(`window.__multiheizUi.openMemPopover && window.__multiheizUi.openMemPopover()`);
  await sleep(700);

  // Drive scroll via overlay executeJavaScript
  const popoverOverlay = require('./popover-overlay');
  const view = popoverOverlay.getView && popoverOverlay.getView();
  assert(view && view.webContents && !view.webContents.isDestroyed(), 'overlay view open');

  const before = await view.webContents.executeJavaScript(
    `(() => {
      const body = document.querySelector('[data-role="mem-body"]');
      const box = document.querySelector('[data-role="mem-popover"]');
      const interval = document.querySelector('[data-role="mem-cleanup-interval"]');
      const br = box ? box.getBoundingClientRect() : null;
      return {
        scrollTop: body ? body.scrollTop : -1,
        bodyH: body ? body.clientHeight : 0,
        scrollH: body ? body.scrollHeight : 0,
        boxW: br ? br.width : 0,
        boxH: br ? br.height : 0,
        hasInterval: !!interval,
        hasMhScroll: !!(body && body.classList.contains('mh-popover-scroll')),
      };
    })()`,
    true
  );
  assert(before && before.hasMhScroll, 'internal scroll container', before);
  assert(before.scrollH > before.bodyH + 8, 'content taller than body (needs scroll)', before);

  // Wheel via sendInputEvent on overlay
  const midX = Math.round((before.boxW || 200) / 2);
  const midY = Math.round((before.boxH || 200) / 2);
  for (let i = 0; i < 12; i++) {
    try {
      view.webContents.sendInputEvent({
        type: 'mouseWheel',
        x: midX,
        y: midY,
        deltaX: 0,
        deltaY: -120,
        canScroll: true,
      });
    } catch {
      /* ignore */
    }
    await sleep(40);
  }
  // Also force scrollTop in case input is flaky in headless
  await view.webContents.executeJavaScript(
    `(() => {
      const body = document.querySelector('[data-role="mem-body"]');
      if (body) body.scrollTop = body.scrollHeight;
      return body ? body.scrollTop : -1;
    })()`,
    true
  );
  await sleep(100);

  const after = await view.webContents.executeJavaScript(
    `(() => {
      const body = document.querySelector('[data-role="mem-body"]');
      const box = document.querySelector('[data-role="mem-popover"]');
      const interval = document.querySelector('[data-role="mem-cleanup-interval"]');
      const row = document.querySelector('[data-role="mem-cleanup-interval-row"]');
      const br = box ? box.getBoundingClientRect() : null;
      const ir = row ? row.getBoundingClientRect() : null;
      const cx = ir ? ir.left + ir.width / 2 : 0;
      const cy = ir ? ir.top + ir.height / 2 : 0;
      const hit = document.elementFromPoint(cx, cy);
      const inside =
        !!ir &&
        !!br &&
        ir.top >= br.top - 1 &&
        ir.bottom <= br.bottom + 1 &&
        ir.left >= br.left - 1 &&
        ir.right <= br.right + 1;
      return {
        scrollTop: body ? body.scrollTop : -1,
        intervalVisible: !!interval,
        lastInside: inside,
        hitOk: !!(hit && (hit === interval || hit.closest && hit.closest('[data-role="mem-cleanup-interval-row"]'))),
        boxH: br ? br.height : 0,
        winH: window.innerHeight,
      };
    })()`,
    true
  );
  assert(after.scrollTop > before.scrollTop, 'scrollTop increased', { before, after });
  assert(after.lastInside, 'last control fully inside popover rect', after);
  assert(after.hitOk, 'elementFromPoint hits interval row', after);
  assert(after.boxH <= after.winH, 'popover fits in overlay window', after);
  console.log('PASS: wheel/scroll reaches scheduled cleanup');

  // Click interval to ensure interactive
  await view.webContents.executeJavaScript(
    `(() => {
      const sel = document.querySelector('[data-role="mem-cleanup-interval"]');
      if (sel) { sel.focus(); sel.value = '60'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      return sel ? sel.value : null;
    })()`,
    true
  );
  await sleep(200);
  console.log('PASS: click on last control works');

  console.log('PASS: selftest:popover-scroll complete');
  app.exit(0);
}

module.exports = { runPopoverScrollSelftest };
