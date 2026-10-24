'use strict';

/**
 * Selftest: empty-workspace start page (MULTIHEIZ_SELFTEST=start-page).
 */

const { app, session } = require('electron');
const { envGet } = require('./config');
const history = require('./history');
const bookmarks = require('./bookmarks');

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
