'use strict';

/**
 * In-process favorites quick-popover selftest (MULTIHEIZ_SELFTEST=favorites-popover).
 * Adds one bookmark to Barra and one to Outros, opens the popover, asserts both
 * item rows are visible (non-zero size), then checks search filtering.
 */

/**
 * @param {object} ctx
 */
async function runFavoritesPopoverSelftest(ctx) {
  const {
    updateState,
    flushSave,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    waitForPanels,
    rendererEval,
    publicState,
    app: electronApp,
  } = ctx;
  const popoverOverlay = require('./popover-overlay');
  const bookmarks = require('./bookmarks');

  console.log('SELFTEST favorites-popover');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  updateState((s) => {
    s.workspaces = [{ id: 'ws-fav-pop', name: 'FavPop' }];
    s.activeWorkspaceId = 'ws-fav-pop';
    s.layout = '1';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace['ws-fav-pop'] = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = {
      ...(s.settings || {}),
      openLastPage: false,
      homepage: 'about:blank',
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
        id: 'acc-fav-pop',
        name: 'Fav Pop',
        color: '#2bb8a6',
        startUrl: 'about:blank',
        workspaceId: 'ws-fav-pop',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-fav-pop' && p.visible));

  bookmarks.addFavorite({
    url: 'https://example.com/barra-item',
    name: 'Barra Item Pop',
    title: 'Barra Item Pop',
    folderId: bookmarks.FOLDER_BAR,
  });
  bookmarks.addFavorite({
    url: 'https://example.com/outros-item',
    name: 'Outros Item Pop',
    title: 'Outros Item Pop',
    folderId: bookmarks.FOLDER_OTHER,
  });
  // Simulate a profile where only the empty-looking bar folder was expanded.
  bookmarks.setExpandedFolders([bookmarks.FOLDER_BAR]);

  const list = bookmarks.list();
  assert(
    list.items.some((it) => it.name === 'Barra Item Pop' && it.folderId === 'folder-bar'),
    'barra item stored',
    list.items
  );
  assert(
    list.items.some((it) => it.name === 'Outros Item Pop' && it.folderId === 'folder-other'),
    'outros item stored',
    list.items
  );
  console.log('PASS: seeded Barra + Outros favorites');

  await rendererEval(`(async () => {
    if (window.__multiheizUi && window.__multiheizUi.openFavoritesPopover) {
      await window.__multiheizUi.openFavoritesPopover();
    }
    await new Promise((r) => setTimeout(r, 450));
  })()`);

  const pop = await rendererEval(`(async () => {
    const p = await window.multiheiz.popoverGet();
    if (!p || !p.open || p.kind !== 'favorites') return { ok: false, p };
    return {
      ok: true,
      bounds: p.bounds || null,
      names: ((p.data && p.data.items) || []).map((it) => it.name || ''),
      expanded: (p.data && p.data.expandedFolders) || [],
    };
  })()`);
  assert(pop && pop.ok, 'favorites popover open', pop);
  assert(
    (pop.expanded || []).includes('folder-bar') &&
      (pop.expanded || []).includes('folder-other'),
    'both folders expanded in popover data',
    pop.expanded
  );
  assert(
    pop.bounds && pop.bounds.height >= 160,
    'popover bounds tall enough for tree (not chrome-only)',
    pop.bounds
  );

  const visible = await popoverOverlay.evalOverlay(`(() => {
    const rows = [...document.querySelectorAll('[data-role="favorites-item"], .favorites-item-row')];
    return rows.map((n) => {
      const r = n.getBoundingClientRect();
      const style = window.getComputedStyle(n);
      return {
        text: (n.textContent || '').trim(),
        w: r.width,
        h: r.height,
        display: style.display,
        visibility: style.visibility,
      };
    });
  })()`);
  assert(Array.isArray(visible) && visible.length >= 2, 'overlay has item rows', visible);

  function isVisibleRow(row, re) {
    return (
      row &&
      re.test(row.text) &&
      row.w > 0 &&
      row.h > 0 &&
      row.display !== 'none' &&
      row.visibility !== 'hidden'
    );
  }
  assert(
    (visible || []).some((row) => isVisibleRow(row, /Barra Item Pop/i)),
    'Barra item visible in popover DOM',
    visible
  );
  assert(
    (visible || []).some((row) => isVisibleRow(row, /Outros Item Pop/i)),
    'Outros item visible in popover DOM',
    visible
  );
  console.log('PASS: both favorites visible in quick popover');

  // Search filters across folders (real search input → action → flat popoverUpdate).
  const searchFired = await popoverOverlay.evalOverlay(`(() => {
    const search = document.querySelector('[data-role="favorites-search"]');
    if (!search) return false;
    search.value = 'Outros';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert(searchFired, 'favorites search input present');
  await sleep(400);

  const filtered = await popoverOverlay.evalOverlay(`(() => {
    const rows = [...document.querySelectorAll('[data-role="favorites-item"], .favorites-item-row')];
    return rows.map((n) => {
      const r = n.getBoundingClientRect();
      return { text: (n.textContent || '').trim(), w: r.width, h: r.height };
    }).filter((row) => row.w > 0 && row.h > 0);
  })()`);
  assert(
    (filtered || []).some((row) => /Outros Item Pop/i.test(row.text)),
    'search keeps matching Outros item',
    filtered
  );
  assert(
    !(filtered || []).some((row) => /Barra Item Pop/i.test(row.text)),
    'search hides non-matching Barra item',
    filtered
  );
  console.log('PASS: favorites popover search filters items');

  await rendererEval(`(async () => {
    if (window.multiheiz.popoverClose) await window.multiheiz.popoverClose('selftest');
  })()`);

  console.log('PASS: selftest favorites-popover complete');
  if (typeof electronApp.exit === 'function') electronApp.exit(0);
  else process.exit(0);
}

module.exports = { runFavoritesPopoverSelftest };
