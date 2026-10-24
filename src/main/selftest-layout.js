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

  // Real-shaped fixtures in the THROWAWAY profile (never the user's profile):
  // favorites bar with a loose item + a sub-folder, and history that only exists in
  // OTHER areas' windows (the empty area must still show most-visited from it).
  const bookmarks = require('./bookmarks');
  const history = require('./history');
  bookmarks.load();
  bookmarks.addFavorite({
    url: 'https://lay-fav.example/',
    title: 'Lay Fav',
    folderId: bookmarks.FOLDER_BAR,
  });
  const layFolder = bookmarks.createFolder('Pasta Lay', bookmarks.FOLDER_BAR);
  bookmarks.addFavorite({
    url: 'https://lay-in-folder.example/',
    title: 'Lay In Folder',
    folderId: layFolder.id,
  });
  bookmarks.flush();
  history.load();
  history.clearAll();
  for (let i = 0; i < 10; i++) {
    history.record({
      url: `https://lay-other-${i}.example/`,
      title: `Lay Other ${i}`,
      favicon: '',
      windowId: 'acc-lay-other',
      windowName: 'Other area',
    });
  }
  history.flush();

  updateState((s) => {
    s.workspaces = [
      { id: 'ws-lay', name: 'Lay' },
      { id: 'ws-lay-other', name: 'Other' },
    ];
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
      {
        id: 'acc-lay-other',
        name: 'O',
        color: '#3d8bfd',
        startUrl: 'about:blank',
        workspaceId: 'ws-lay-other',
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
        s.accounts = (s.accounts || []).filter((a) => a && a.workspaceId !== 'ws-lay');
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

      // Wait for async data paint, then check the Apps / favorites / most-visited layout.
      let info = null;
      for (let i = 0; i < 30; i++) {
        info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
        if (info && info.present && info.apps && info.apps.length && info.mvTiles) break;
        await sleep(100);
      }
      const tag = ' at ' + w + 'x' + h + ' z=' + z;
      assert(info && info.present && info.mode === 'workspace', 'workspace start page' + tag, info);
      assert(!info.appsSectionHidden && info.appsTitle === 'Apps', 'Apps section visible' + tag, info);
      assert(info.apps.length >= 3 && info.hasAddCustom, 'Apps tiles + custom tile' + tag, info);
      assert(
        info.appIconSize >= 60 && info.appIconSize <= 76,
        'Apps icons 64-72px' + tag,
        info.appIconSize
      );
      assert(
        info.omniboxHeight >= 44 && info.omniboxHeight <= 52,
        'search ~48px tall' + tag,
        info.omniboxHeight
      );
      assert(info.columnWidth <= 901, 'column max ~900px' + tag, info.columnWidth);
      assert(
        info.favs.some((u) => u.includes('lay-fav.example')) &&
          info.favFolders.length >= 1 &&
          info.favFolderItems.some((u) => u.includes('lay-in-folder.example')),
        'global favorites bar + folder shown in empty area' + tag,
        { favs: info.favs, folders: info.favFolders, items: info.favFolderItems }
      );
      assert(
        info.mvTiles.some((t) => t.url.includes('lay-other-')),
        'most visited from other areas shown' + tag,
        info.mvTiles
      );
      assert(
        Array.isArray(info.emptyHeadings) && info.emptyHeadings.length === 0,
        'no section heading without content' + tag,
        info.emptyHeadings
      );
      assert(info.appsPerRow >= 2, 'Apps wrap responsively' + tag, info.appsPerRow);
      if (w / z >= 1100) {
        assert(info.appsPerRow >= 6 && info.appsPerRow <= 8, '6-8 Apps per row' + tag, info.appsPerRow);
      }
      const gear = await rendererEval(`(() => {
        const g = document.querySelector('.mh-start-gear');
        const p = document.querySelector('.mh-start-page');
        if (!g || !p) return null;
        const a = g.getBoundingClientRect();
        const b = p.getBoundingClientRect();
        return { right: b.right - a.right, top: a.top - b.top, w: a.width };
      })()`);
      assert(
        gear && gear.w > 4 && gear.right >= 0 && gear.right < 80 && gear.top >= 0 && gear.top < 60,
        'gear at top-right' + tag,
        gear
      );

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
          ...(s.accounts || []).filter((a) => a && a.workspaceId !== 'ws-lay'),
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

  // Pending "Nova janela" page (panel mode) uses the same layout inside the slot.
  try {
    mainWindow.setContentSize(1280, 720);
  } catch {
    /* ignore */
  }
  await sleep(200);
  await waitForLayoutSettle();
  const pend = await rendererEval(`window.__multiheizUi.createPendingStartWindow().then((a) => a && a.id)`);
  assert(pend, 'pending window created');
  let pinfo = null;
  for (let i = 0; i < 30; i++) {
    pinfo = await rendererEval(`window.__multiheizUi.getStartPageInfo(${JSON.stringify(pend)})`);
    if (pinfo && pinfo.present && pinfo.apps && pinfo.apps.length) break;
    await sleep(100);
  }
  assert(pinfo && pinfo.present && pinfo.mode === 'panel', 'pending start page in panel mode', pinfo);
  assert(pinfo.width > 100 && pinfo.height > 100, 'pending start page size', pinfo);
  assert(!pinfo.hasNewWindowBtn, 'panel mode hides "+ Nova janela"', pinfo);
  assert(!pinfo.appsSectionHidden && pinfo.apps.length >= 3, 'pending page shows Apps', pinfo);
  assert(pinfo.emptyHeadings.length === 0, 'pending page: no empty headings', pinfo.emptyHeadings);
  assert(pinfo.hasAdvanced, 'pending page has Opções avançadas', pinfo);
  console.log('PASS: pending start page layout');

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
