'use strict';

/**
 * Selftest: popover/menu layout at several sizes (MULTIHEIZ_SELFTEST=layout).
 * Migrates failing popovers are covered by popover-scroll; this checks fit.
 */

const { app } = require('electron');

async function runLayoutSelftest(ctx) {
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

  console.log('SELFTEST layout');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  updateState((s) => {
    s.workspaces = [{ id: 'ws-lay', name: 'Lay' }];
    s.activeWorkspaceId = 'ws-lay';
    s.layout = '2';
    s.page = 0;
    s.accounts = [
      {
        id: 'acc-lay',
        name: 'L',
        color: '#2bb8a6',
        startUrl: 'about:blank',
        workspaceId: 'ws-lay',
        muted: false,
        lastUrl: null,
      },
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();

  const sizes = [
    [800, 600],
    [1024, 700],
    [1280, 720],
    [1920, 1080],
  ];
  const zooms = [1, 1.25, 1.5];
  const popoverOverlay = require('./popover-overlay');

  for (const [w, h] of sizes) {
    for (const z of zooms) {
      try {
        mainWindow.setContentSize(w, h);
        if (typeof mainWindow.webContents.setZoomFactor === 'function') {
          mainWindow.webContents.setZoomFactor(z);
        }
      } catch {
        /* ignore */
      }
      await sleep(200);
      await waitForLayoutSettle();

      await rendererEval(
        `window.__multiheizUi.openMemPopover && window.__multiheizUi.openMemPopover()`
      );
      await sleep(500);
      const view = popoverOverlay.getView && popoverOverlay.getView();
      assert(view, 'mem overlay at ' + w + 'x' + h + ' z=' + z);
      const cur = popoverOverlay.getCurrent && popoverOverlay.getCurrent();
      assert(cur && cur.bounds, 'mem bounds', cur);
      const b = cur.bounds;
      assert(b.x >= 0 && b.y >= 0, 'mem non-neg', b);
      assert(b.x + b.width <= w + 2, 'mem inside width', { b, w });
      assert(b.y + b.height <= h + 2, 'mem inside height', { b, h });
      popoverOverlay.hide('layout-test');
      await sleep(100);

      // Empty start page at this size
      updateState((s) => {
        s.accounts = [];
      });
      flushSave();
      emitToRenderer({ type: 'state:changed', state: publicState() });
      await sleep(400);
      const start = await rendererEval(`(() => {
        const el = document.querySelector('.mh-start-page') || document.querySelector('.empty-hint');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, ow: el.scrollWidth > el.clientWidth + 2 };
      })()`);
      assert(start && start.w > 40 && start.h > 40, 'start page visible', start);
      assert(!start.ow, 'start page no horizontal overflow', start);

      // Restore one account for next iteration
      updateState((s) => {
        s.accounts = [
          {
            id: 'acc-lay',
            name: 'L',
            color: '#2bb8a6',
            startUrl: 'about:blank',
            workspaceId: 'ws-lay',
            muted: false,
            lastUrl: null,
          },
        ];
      });
      flushSave();
      emitToRenderer({ type: 'state:changed', state: publicState() });
      await sleep(300);
    }
  }

  try {
    mainWindow.webContents.setZoomFactor(1);
  } catch {
    /* ignore */
  }

  // Top bar overlap smoke
  const topbar = await rendererEval(`(() => {
    const bar = document.getElementById('topbar') || document.querySelector('.topbar');
    if (!bar) return { ok: true, skip: true };
    const btns = [...bar.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
    for (let i = 0; i < btns.length; i++) {
      for (let j = i + 1; j < btns.length; j++) {
        const a = btns[i], c = btns[j];
        const overlap = !(a.right <= c.left || c.right <= a.left || a.bottom <= c.top || c.bottom <= a.top);
        if (overlap && a.width > 4 && c.width > 4) {
          return { ok: false, i, j };
        }
      }
    }
    return { ok: true };
  })()`);
  assert(topbar && topbar.ok, 'top bar buttons no overlap', topbar);
  console.log('PASS: sizes/zooms + start page + topbar');

  console.log('PASS: selftest:layout complete');
  app.exit(0);
}

module.exports = { runLayoutSelftest };
