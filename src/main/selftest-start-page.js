'use strict';

/**
 * Selftest: empty-workspace start page (MULTIHEIZ_SELFTEST=start-page).
 */

const { app, session } = require('electron');
const { envGet } = require('./config');
const history = require('./history');
const bookmarks = require('./bookmarks');
const startPage = require('./start-page');

async function runStartPageSelftest(ctx) {
  const {
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    getState,
    rendererEval,
  } = ctx;

  const phase = String(envGet('MULTIHEIZ_SELFTEST_PHASE') || '1');
  console.log('SELFTEST start-page phase=' + phase);

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  if (phase === '2') {
    await sleep(600);
    await waitForLayoutSettle();
    await rendererEval(`(async () => {
      if (window.MultiHeizStartPage && window.MultiHeizStartPage.refresh) {
        await window.MultiHeizStartPage.refresh();
      }
      return true;
    })()`);
    await sleep(200);
    const info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
    assert(info && info.present && info.width > 40 && info.height > 40, 'phase2 start page', info);
    const data =
      info.data ||
      (await rendererEval(`window.multiheiz.startPageGet('ws-sp')`));
    assert(data && data.opts && data.opts.showFavoritesBar === false, 'opts persist hide favbar', data);
    assert(data && data.opts && data.opts.mostVisitedRows === 3, 'opts persist rows', data);
    const custom = (data && data.customTiles) || [];
    assert(custom.some((t) => t && t.title === 'Pin Persist'), 'custom tile persists', custom);
    const order = custom.map((t) => t.title);
    assert(
      order.indexOf('Pin A') >= 0 &&
        order.indexOf('Pin B') >= 0 &&
        order.indexOf('Pin A') < order.indexOf('Pin B'),
      'custom order persists',
      order
    );
    const hidden = (data.opts && data.opts.hiddenSuggested) || [];
    assert(
      hidden.some((u) => String(u).includes('hidden-site.example')),
      'hidden suggested persists',
      hidden
    );
    assert(
      custom.some((t) => t && t.title === 'UI Persist' && t.url === 'https://ui-persist.example/path'),
      'UI-added custom site persists globally',
      custom
    );
    const stNow = getState();
    assert(
      (stNow.startPageHiddenCatalogApps || []).length === 1 &&
        !(data.apps || []).some((a) => a.catalogId === stNow.startPageHiddenCatalogApps[0]) &&
        (data.hiddenCatalogApps || []).length === 1,
      'hidden built-in app persists',
      { hidden: stNow.startPageHiddenCatalogApps, apps: (data.apps || []).length }
    );
    const otherArea = await rendererEval(`window.multiheiz.startPageGet('ws-sp-other')`);
    assert(
      (otherArea.apps || []).some((a) => a.title === 'UI Persist'),
      'custom site global after restart',
      otherArea.apps
    );
    assert(
      (info.apps || []).some((a) => a.kind === 'catalog') && !(info.emptyHeadings || []).length,
      'phase2: Apps shown, no empty headings',
      info
    );
    console.log('PASS: start page persistence after restart');
    console.log('PASS: selftest:start-page complete');
    app.exit(0);
    return;
  }

  // --- Network guard: count external http(s) from default session while page is shown ---
  let netHits = 0;
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  const onBefore = (details, callback) => {
    const u = String(details.url || '');
    if (/^https?:\/\//i.test(u) && !u.includes('127.0.0.1') && !u.includes('localhost')) {
      netHits += 1;
    }
    callback({ cancel: false });
  };
  try {
    session.defaultSession.webRequest.onBeforeRequest(filter, onBefore);
  } catch {
    /* ignore */
  }

  history.load();
  history.clearAll();
  for (let i = 0; i < 4; i++) {
    history.record({
      url: `https://most.example/page${i}`,
      title: `Mais ${i}`,
      favicon: '',
      windowId: 'acc-old',
      windowName: 'Old',
    });
    history.record({
      url: `https://most.example/page${i}`,
      title: `Mais ${i}`,
      favicon: '',
      windowId: 'acc-old',
      windowName: 'Old',
    });
  }
  history.record({
    url: 'https://hidden-site.example/',
    title: 'Hidden',
    favicon: '',
    windowId: 'acc-old',
    windowName: 'Old',
  });
  history.flush();

  bookmarks.load();
  bookmarks.addFavorite({
    url: 'https://fav.example/',
    title: 'Fav Bar',
    folderId: bookmarks.FOLDER_BAR,
  });
  bookmarks.flush();

  updateState((s) => {
    s.workspaces = [{ id: 'ws-sp', name: 'Start' }];
    s.activeWorkspaceId = 'ws-sp';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [];
    if (!s.settings) s.settings = {};
    s.settings.confirmOnRemove = false;
    s.settings.homepage = 'https://www.google.com';
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(700);
  await waitForLayoutSettle();

  let info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
  assert(info && info.present, 'start page present', info);
  assert(info.width > 80 && info.height > 80, 'start page non-zero size', info);
  assert(info.hasOmnibox, 'omnibox present', info);
  console.log('PASS: start page visible');

  // Omnibox Enter → new window in this workspace
  const before = (getState().accounts || []).length;
  await rendererEval(`window.__multiheizUi.startPageOmniboxEnter('https://omnibox.example/from-start')`);
  await sleep(800);
  let accs = getState().accounts || [];
  assert(accs.length >= before + 1, 'omnibox created window', { before, after: accs.length });
  assert(
    accs.some(
      (a) =>
        a &&
        a.workspaceId === 'ws-sp' &&
        String(a.startUrl || '').includes('omnibox.example')
    ),
    'omnibox window in workspace'
  );
  console.log('PASS: omnibox Enter opens window');

  async function clearWsWindows() {
    updateState((s) => {
      s.accounts = (s.accounts || []).filter((a) => !a || a.workspaceId !== 'ws-sp');
    });
    flushSave();
    emitToRenderer({ type: 'state:changed', state: publicState() });
    await sleep(600);
    await waitForLayoutSettle();
    for (let i = 0; i < 40; i++) {
      const ready = await rendererEval(`(() => {
        const root = document.querySelector('.mh-start-page');
        if (!root) return false;
        // Wait until async start-page refresh painted (omnibox always there)
        return !!root.querySelector('.mh-start-omnibox');
      })()`);
      if (ready) break;
      await sleep(100);
    }
    // Force a data refresh (keeps pageApi from build — do not pass a noop openUrl)
    await rendererEval(`(async () => {
      if (!window.MultiHeizStartPage || !window.MultiHeizStartPage.refresh) return false;
      await window.MultiHeizStartPage.refresh();
      return true;
    })()`);
    await sleep(150);
  }

  // Back to empty
  await clearWsWindows();

  // Favorite click
  info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
  assert(info && info.present, 'start page before fav click', info);
  const beforeFav = (getState().accounts || []).length;
  const favClick = await rendererEval(
    `window.__multiheizUi.startPageClickFavorite('https://fav.example/')`
  );
  assert(favClick && favClick.ok, 'favorite click', favClick);
  await sleep(700);
  accs = getState().accounts || [];
  assert(accs.length >= beforeFav + 1, 'favorite created window', {
    before: beforeFav,
    after: accs.length,
  });
  console.log('PASS: favorite click opens window');

  await clearWsWindows();

  // Suggested tile click (may need refresh after history seed)
  await rendererEval(`window.__multiheizUi.startPageSetOpts({})`);
  await sleep(300);
  info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
  const sug = (info.tiles || []).find((t) => t.kind === 'suggested' && t.url);
  assert(!!sug, 'has suggested tile', info.tiles);
  const beforeTile = (getState().accounts || []).length;
  const tileClick = await rendererEval(
    `window.__multiheizUi.startPageClickTile(${JSON.stringify(sug.url)})`
  );
  assert(tileClick && tileClick.ok, 'tile click', tileClick);
  await sleep(700);
  accs = getState().accounts || [];
  assert(accs.length >= beforeTile + 1, 'tile created window');
  console.log('PASS: tile click opens window');

  await clearWsWindows();

  // ------------------------------------------------------------------
  // bookmarks migration: remap old built-in folder ids BEFORE orphan sweep
  // (root cause of the empty favorites bar) + heal from backup.
  // ------------------------------------------------------------------
  {
    const legacy = {
      version: 2,
      folders: [
        { id: 'folder-legacy-bar', name: 'Barra', order: 0, builtIn: 'bar' },
        { id: 'folder-legacy-other', name: 'Outros', order: 1, builtIn: 'other' },
        { id: 'sub-legacy', name: 'Pasta Legacy', order: 2, parentId: 'folder-legacy-bar' },
      ],
      items: [
        { id: 'l1', url: 'https://legacy-bar.example/', title: 'L1', folderId: 'folder-legacy-bar' },
        { id: 'l2', url: 'https://legacy-sub.example/', title: 'L2', folderId: 'sub-legacy' },
        { id: 'l3', url: 'https://legacy-other.example/', title: 'L3', folderId: 'folder-legacy-other' },
        { id: 'l4', url: 'https://legacy-orphan.example/', title: 'L4', folderId: 'gone-folder' },
        { id: 'l5', url: 'https://legacy-stray-bar.example/', title: 'L5', folderId: 'favorites-bar' },
      ],
      expandedFolders: ['folder-legacy-bar'],
    };
    const mig = bookmarks.migrateBookmarksData(JSON.parse(JSON.stringify(legacy))).data;
    const by = (id) => mig.items.find((i) => i.id === id);
    assert(by('l1').folderId === bookmarks.FOLDER_BAR, 'migration: old bar id items → folder-bar', by('l1'));
    assert(by('l2').folderId === 'sub-legacy', 'migration: sub-folder items kept', by('l2'));
    const sub = mig.folders.find((f) => f.id === 'sub-legacy');
    assert(sub && sub.parentId === bookmarks.FOLDER_BAR, 'migration: sub-folder parent remapped', sub);
    assert(by('l3').folderId === bookmarks.FOLDER_OTHER, 'migration: old other id → folder-other', by('l3'));
    assert(by('l4').folderId === bookmarks.FOLDER_OTHER, 'migration: true orphan → folder-other', by('l4'));
    assert(
      by('l5').folderId === bookmarks.FOLDER_BAR,
      'migration: stray item pointing at missing old-bar id → folder-bar',
      by('l5')
    );
    assert(
      mig.expandedFolders.includes(bookmarks.FOLDER_BAR),
      'migration: expanded ids remapped',
      mig.expandedFolders
    );
    // Idempotent on already-migrated data.
    const again = bookmarks.migrateBookmarksData(JSON.parse(JSON.stringify(mig))).data;
    assert(
      again.items.find((i) => i.id === 'l1').folderId === bookmarks.FOLDER_BAR &&
        again.items.find((i) => i.id === 'l3').folderId === bookmarks.FOLDER_OTHER,
      'migration idempotent',
      again.items
    );
    // Heal data damaged by the old migration using the .bak shape.
    const damaged = {
      version: 2,
      folders: [
        { id: bookmarks.FOLDER_BAR, name: 'Barra de favoritos', order: 0, builtIn: 'bar' },
        { id: bookmarks.FOLDER_OTHER, name: 'Outros favoritos', order: 1, builtIn: 'other' },
      ],
      items: [
        { id: 'd1', url: 'https://legacy-bar.example/', title: 'D1', folderId: bookmarks.FOLDER_OTHER },
        { id: 'd2', url: 'https://legacy-other.example/', title: 'D2', folderId: bookmarks.FOLDER_OTHER },
      ],
      expandedFolders: [bookmarks.FOLDER_OTHER],
    };
    const changed = bookmarks.healFromBackup(damaged, legacy);
    assert(changed, 'heal from backup changed data');
    assert(
      damaged.items[0].folderId === bookmarks.FOLDER_BAR &&
        damaged.items[1].folderId === bookmarks.FOLDER_OTHER,
      'heal from backup: bar items back in bar',
      damaged.items
    );
    console.log('PASS: bookmarks migration keeps bar items (root cause fix)');
  }

  // ------------------------------------------------------------------
  // start-page data module: legacy per-area tiles → global Apps, once.
  // ------------------------------------------------------------------
  {
    const fake = {
      customStartApps: [],
      startPageByWorkspace: {
        'ws-x': {
          customTiles: [{ id: 'old-1', title: 'Old One', url: 'old-one.example/p', order: 0 }],
        },
        'ws-y': { customTiles: [{ id: 'old-2', title: 'Old Two', url: 'https://old-two.example/' }] },
      },
    };
    assert(startPage.needsMigration(fake), 'needs migration');
    startPage.migrateCustomTiles(fake);
    assert(
      fake.customStartApps.length === 2 &&
        fake.customStartApps[0].url === 'https://old-one.example/p',
      'legacy tiles migrated to global Apps',
      fake.customStartApps
    );
    assert(
      !startPage.needsMigration(fake) && fake.startPageByWorkspace['ws-x'].customTiles.length === 0,
      'legacy tiles cleared after migration'
    );
    startPage.migrateCustomTiles(fake);
    assert(fake.customStartApps.length === 2, 'migration runs once', fake.customStartApps);
    const bad = startPage.normalizeCustomApps([{ url: 'javascript:alert(1)' }, { url: 'ok.example' }]);
    assert(bad.length === 1 && bad[0].url === 'https://ok.example/', 'custom apps http(s) only', bad);
    console.log('PASS: custom Apps migrate to global once');
  }

  // ------------------------------------------------------------------
  // New empty area still shows Apps + favorites (global) + most visited
  // from OTHER areas; never an empty heading; fallback to catalog tiles.
  // ------------------------------------------------------------------
  {
    // Real-shaped favorites in the THROWAWAY profile: loose item + folder on the bar.
    const sp2Folder = bookmarks.createFolder('Pasta SP', bookmarks.FOLDER_BAR);
    bookmarks.addFavorite({
      url: 'https://sp-in-folder.example/',
      title: 'SP In Folder',
      folderId: sp2Folder.id,
    });
    bookmarks.flush();
    history.clearAll();
    for (let i = 0; i < 12; i++) {
      history.record({
        url: `https://other-area-${i}.example/`,
        title: `Outra área ${i}`,
        favicon: '',
        windowId: i % 2 ? 'acc-sp-o1' : 'acc-sp-o2',
        windowName: 'Other area',
      });
    }
    history.flush();
    updateState((s) => {
      s.workspaces = [
        { id: 'ws-sp', name: 'Start' },
        { id: 'ws-sp-other', name: 'Other' },
      ];
      s.activeWorkspaceId = 'ws-sp';
      s.accounts = [
        { id: 'acc-sp-o1', name: 'O1', color: '#3d8bfd', startUrl: 'http://127.0.0.1:9/', workspaceId: 'ws-sp-other', muted: false, lastUrl: null },
        { id: 'acc-sp-o2', name: 'O2', color: '#3d8bfd', startUrl: 'http://127.0.0.1:9/', workspaceId: 'ws-sp-other', muted: false, lastUrl: null },
      ];
    });
    flushSave();
    emitToRenderer({ type: 'state:changed', state: publicState() });
    await sleep(600);
    await waitForLayoutSettle();
    await rendererEval(`window.__multiheizUi.startPageSetOpts({ showFavoritesBar: true, showApps: true, showMostVisited: true, mostVisitedRows: 2, hiddenSuggested: [] })`);
    await sleep(300);

    info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
    assert(info && info.present && info.mode === 'workspace', 'new empty area start page', info);
    assert(!info.appsSectionHidden && info.appsTitle === 'Apps', 'Apps section in empty area', info);
    assert(
      info.apps.length >= 3 && info.apps.every((a) => a.kind === 'catalog' || a.kind === 'custom'),
      'Apps lists catalog tiles',
      info.apps
    );
    assert(info.hasAddCustom, '"Site personalizado…" tile present', info);
    assert(info.hasAdvanced, '"Opções avançadas" link present', info);
    assert(
      info.favs.some((u) => u.includes('fav.example')) &&
        info.favFolders.some((n) => n.includes('Pasta SP')) &&
        info.favFolderItems.some((u) => u.includes('sp-in-folder.example')),
      'fav bar items + folder from global bookmarks',
      { favs: info.favs, folders: info.favFolders, items: info.favFolderItems }
    );
    assert(
      info.mvTiles.some((t) => t.kind === 'suggested' && t.url.includes('other-area-')),
      'most visited filled from other areas',
      info.mvTiles
    );
    assert(info.emptyHeadings.length === 0, 'no empty headings (empty area)', info.emptyHeadings);
    assert(info.mvTitle === 'Mais acessados', 'most visited heading', info.mvTitle);
    console.log('PASS: empty area shows Apps + favorites + most visited from other areas');

    // Fallback: no history anywhere → catalog tiles, heading still has content.
    history.clearAll();
    history.flush();
    await rendererEval(`window.MultiHeizStartPage.refresh()`);
    await sleep(300);
    info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
    assert(
      info.mvTiles.length > 0 && info.mvTiles.every((t) => t.kind === 'catalog-fallback'),
      'catalog fallback tiles when history is empty',
      info.mvTiles
    );
    assert(info.emptyHeadings.length === 0, 'no empty headings (fallback)', info.emptyHeadings);
    // A fallback tile opens the catalog app with its catalog defaults.
    const fbTile = info.mvTiles[0];
    const beforeFb = (getState().accounts || []).length;
    await rendererEval(`window.__multiheizUi.startPageClickTile(${JSON.stringify(fbTile.url)})`);
    await sleep(700);
    const fbAcc = (getState().accounts || []).find(
      (a) => a && a.workspaceId === 'ws-sp' && a.catalogId === fbTile.catalogId
    );
    assert(
      (getState().accounts || []).length === beforeFb + 1 && fbAcc,
      'fallback tile opens catalog app',
      { catalogId: fbTile.catalogId }
    );
    await clearWsWindows();

    // Hiding most-visited removes the heading entirely.
    await rendererEval(`window.__multiheizUi.startPageSetOpts({ showMostVisited: false })`);
    await sleep(250);
    info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
    assert(info.mvSectionHidden && info.mvTitle === '', 'most visited off → no heading', info);
    await rendererEval(`window.__multiheizUi.startPageSetOpts({ showApps: false })`);
    await sleep(250);
    info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
    assert(info.appsSectionHidden && info.appsTitle === '', 'apps off → no heading', info);
    assert(info.emptyHeadings.length === 0, 'no empty headings (sections off)', info.emptyHeadings);
    await rendererEval(`window.__multiheizUi.startPageSetOpts({ showApps: true, showMostVisited: true })`);
    await sleep(250);
    // Re-seed history (the old most.example rows) for the sections below.
    history.record({ url: 'https://hidden-site.example/', title: 'Hidden', favicon: '', windowId: 'acc-old', windowName: 'Old' });
    history.record({ url: 'https://most.example/page0', title: 'Mais 0', favicon: '', windowId: 'acc-old', windowName: 'Old' });
    history.flush();
    console.log('PASS: catalog fallback + sections hide without empty headings');
  }

  // Custom tiles add / reorder / options / hide suggested
  await rendererEval(`window.__multiheizUi.startPageSetCustomTiles([
    { id: 'ct-b', title: 'Pin B', url: 'https://pin-b.example/', order: 0 },
    { id: 'ct-a', title: 'Pin A', url: 'https://pin-a.example/', order: 1 },
    { id: 'ct-p', title: 'Pin Persist', url: 'https://pin-p.example/', order: 2 }
  ])`);
  // Reorder A before B
  await rendererEval(`window.__multiheizUi.startPageSetCustomTiles([
    { id: 'ct-a', title: 'Pin A', url: 'https://pin-a.example/', order: 0 },
    { id: 'ct-b', title: 'Pin B', url: 'https://pin-b.example/', order: 1 },
    { id: 'ct-p', title: 'Pin Persist', url: 'https://pin-p.example/', order: 2 }
  ])`);
  await rendererEval(`window.__multiheizUi.startPageSetOpts({
    showFavoritesBar: false,
    showMostVisited: true,
    mostVisitedRows: 3,
    hiddenSuggested: ['https://hidden-site.example/']
  })`);
  await sleep(300);
  info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
  assert(info.favBarHidden === true, 'favorites bar hidden', info);
  assert(
    !(info.tiles || []).some((t) => String(t.url).includes('hidden-site.example')),
    'hidden suggested not shown',
    info.tiles
  );
  const customTitles = (info.tiles || []).filter((t) => t.kind === 'custom').map((t) => t.label);
  assert(customTitles[0] === 'Pin A' && customTitles[1] === 'Pin B', 'custom reorder', customTitles);
  console.log('PASS: custom tiles, options, hide suggested');

  // ------------------------------------------------------------------
  // Apps: custom site via UI is GLOBAL + persists; edit/remove with inline
  // confirm; hide/restore a built-in app.
  // ------------------------------------------------------------------
  {
    let r = await rendererEval(
      `window.__multiheizUi.startPageAddCustomApp('UI Persist', 'ui-persist.example/path')`
    );
    assert(r && r.ok && !r.invalid, 'add custom site via UI', r);
    let customs = getState().customStartApps || [];
    const added = customs.find((c) => c.title === 'UI Persist');
    assert(added && added.url === 'https://ui-persist.example/path', 'custom site stored globally', customs);
    const otherAreaData = await rendererEval(`window.multiheiz.startPageGet('ws-sp-other')`);
    assert(
      (otherAreaData.apps || []).some((a) => a.kind === 'custom' && a.title === 'UI Persist'),
      'custom site visible in another area (global)',
      otherAreaData.apps
    );
    const brandNewArea = await rendererEval(`window.multiheiz.startPageGet('ws-never-seen')`);
    assert(
      (brandNewArea.apps || []).some((a) => a.kind === 'custom' && a.title === 'UI Persist'),
      'custom site visible in a brand-new area',
      brandNewArea.apps
    );

    // Invalid address keeps the form open (no silent drop).
    r = await rendererEval(`window.__multiheizUi.startPageAddCustomApp('Bad', 'not a url')`);
    assert(r && r.ok && r.invalid, 'invalid address keeps form open', r);
    await rendererEval(
      `document.querySelectorAll('.mh-start-dialog-backdrop').forEach((n) => n.remove())`
    );
    assert(
      !(getState().customStartApps || []).some((c) => c.title === 'Bad'),
      'invalid custom site not stored'
    );

    // Edit
    r = await rendererEval(
      `window.__multiheizUi.startPageEditCustomApp(${JSON.stringify(added.id)}, 'UI Edited', 'ui-edited.example')`
    );
    assert(r && r.ok, 'edit custom site', r);
    customs = getState().customStartApps || [];
    assert(
      customs.some((c) => c.id === added.id && c.title === 'UI Edited' && c.url === 'https://ui-edited.example/'),
      'edit persisted',
      customs
    );
    r = await rendererEval(
      `window.__multiheizUi.startPageEditCustomApp(${JSON.stringify(added.id)}, 'UI Persist', 'ui-persist.example/path')`
    );
    assert(r && r.ok, 'edit back', r);

    // Remove with inline confirm (cancel first, then confirm) — no native dialog.
    await rendererEval(`window.__multiheizUi.startPageAddCustomApp('To Remove', 'to-remove.example')`);
    const rem = (getState().customStartApps || []).find((c) => c.title === 'To Remove');
    assert(rem, 'to-remove added');
    r = await rendererEval(
      `window.__multiheizUi.startPageRemoveCustomApp(${JSON.stringify(rem.id)}, false)`
    );
    assert(r && r.ok && r.cancelled, 'remove cancel path', r);
    assert((getState().customStartApps || []).some((c) => c.id === rem.id), 'cancel keeps site');
    r = await rendererEval(
      `window.__multiheizUi.startPageRemoveCustomApp(${JSON.stringify(rem.id)}, true)`
    );
    assert(r && r.ok, 'remove confirm path', r);
    assert(!(getState().customStartApps || []).some((c) => c.id === rem.id), 'site removed');

    // Click a custom site: creates a window with that URL (empty-area mode).
    const beforeCustom = (getState().accounts || []).length;
    await rendererEval(`window.__multiheizUi.startPageClickTile(${JSON.stringify(added.id)})`);
    await sleep(700);
    assert(
      (getState().accounts || []).length === beforeCustom + 1 &&
        (getState().accounts || []).some((a) => a && a.startUrl === 'https://ui-persist.example/path'),
      'custom site click opens window'
    );
    await clearWsWindows();

    // Hide / restore a built-in app (global).
    info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
    const builtin = info.apps.find((a) => a.kind === 'catalog');
    assert(builtin && builtin.catalogId, 'has a built-in app', info.apps);
    r = await rendererEval(`window.__multiheizUi.startPageHideApp(${JSON.stringify(builtin.catalogId)})`);
    assert(r && r.ok, 'hide built-in app', r);
    info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
    assert(!info.apps.some((a) => a.catalogId === builtin.catalogId), 'hidden app gone from grid', info.apps);
    assert(
      (getState().startPageHiddenCatalogApps || []).includes(builtin.catalogId),
      'hidden app persisted in state',
      getState().startPageHiddenCatalogApps
    );
    r = await rendererEval(`window.__multiheizUi.startPageRestoreApp(${JSON.stringify(builtin.catalogId)})`);
    assert(r && r.ok, 'restore via gear', r);
    info = await rendererEval(`window.__multiheizUi.getStartPageInfo()`);
    assert(info.apps.some((a) => a.catalogId === builtin.catalogId), 'restored app back', info.apps);
    assert(
      !(getState().startPageHiddenCatalogApps || []).includes(builtin.catalogId),
      'restore persisted'
    );
    // Hide once more so phase 2 can prove hidden state survives a restart.
    r = await rendererEval(`window.__multiheizUi.startPageHideApp(${JSON.stringify(builtin.catalogId)})`);
    assert(r && r.ok, 'hide again for persistence', r);
    flushSave();
    console.log('PASS: Apps — custom site global/persist, edit/remove, hide/restore built-in');
  }

  // Workspace bg menu still works on empty areas
  const menu = await rendererEval(`window.multiheiz.popupWorkspaceBgMenu(40, 40)`);
  assert(menu && menu.ok, 'workspace bg menu on start page', menu);
  console.log('PASS: workspace bg context menu on start page');

  await sleep(200);
  assert(netHits === 0, 'zero external network from start page', netHits);
  console.log('PASS: no external network from start page');

  try {
    session.defaultSession.webRequest.onBeforeRequest(null);
  } catch {
    /* ignore */
  }

  flushSave();
  console.log('PASS: selftest:start-page phase=1');
  app.exit(0);
}

module.exports = { runStartPageSelftest };
