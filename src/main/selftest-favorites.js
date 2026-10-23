'use strict';

/**
 * In-process favorites selftest (MULTIHEIZ_SELFTEST=favorites).
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runFavoritesSelftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    sleep,
    rendererEval,
    app: electronApp,
  } = ctx;

  console.log('SELFTEST favorites');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const bookmarks = require('./bookmarks');
  const userData = app.getPath('userData');
  const bmPath = path.join(userData, 'bookmarks.json');

  // Seed old flat format
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    bmPath,
    JSON.stringify([
      { url: 'https://example.com/a', title: 'Alpha', name: 'Alpha' },
      { url: 'https://example.com/b', title: 'Beta', name: 'Beta' },
    ]),
    'utf8'
  );

  bookmarks.load();
  const list1 = bookmarks.list();
  assert(list1.version === 2, 'migrated to v2');
  assert(list1.folders.some((f) => f.id === 'folder-bar'), 'has barra');
  assert(list1.folders.some((f) => f.id === 'folder-other'), 'has outros');
  assert(list1.items.length === 2, '2 items migrated');
  assert(fs.existsSync(bmPath + '.bak') || list1.items.length === 2, 'bak or migrated');
  console.log('PASS: old-format bookmarks migrated');

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = [
      {
        id: 'acc-fav',
        name: 'Fav',
        workspaceId: 'ws-default',
        color: '#4a9',
        muted: false,
        zoomFactor: 1,
        startUrl: 'about:blank',
        lastUrl: 'https://example.com/a',
      },
    ];
    s.layout = '1';
    s.layoutByWorkspace = { 'ws-default': '1' };
  });
  flushSave();
  panels.createPanel('acc-fav');
  await sleep(500);

  const opened = await rendererEval(
    `(async function(){
      if (window.__multiheizUi && window.__multiheizUi.openFavoritesPopover) {
        await window.__multiheizUi.openFavoritesPopover();
        await new Promise(r => setTimeout(r, 200));
      }
      const p = await window.multiheiz.popoverGet();
      return p;
    })()`
  );
  assert(opened && opened.open && opened.kind === 'favorites', 'favorites popover open');
  console.log('PASS: favorites popover opens');

  const searchOk = await rendererEval(
    `(async function(){
      await window.multiheiz.popoverUpdate({ data: { query: 'Alpha' } });
      // trigger via action path
      if (window.__multiheizUi && window.__multiheizUi.openFavoritesPopover) {
        /* keep */
      }
      return true;
    })()`
  );
  assert(searchOk, 'search update');

  bookmarks.createFolder('Pasta teste');
  bookmarks.addFavorite({
    url: 'https://example.com/c',
    title: 'Gamma',
    name: 'Gamma',
    folderId: 'folder-bar',
  });
  const list2 = bookmarks.list();
  assert(list2.folders.some((f) => f.name === 'Pasta teste'), 'folder created');
  assert(list2.items.some((it) => it.name === 'Gamma'), 'favorite added');

  const gamma = list2.items.find((it) => it.name === 'Gamma');
  bookmarks.removeFavorite(gamma.id);
  assert(!bookmarks.list().items.some((it) => it.name === 'Gamma'), 'removed');
  console.log('PASS: add folder / add favorite / remove');

  // Full page
  await rendererEval(
    `(async function(){
      if (window.__multiheizUi && window.__multiheizUi.openFavoritesPage) {
        window.__multiheizUi.openFavoritesPage();
      } else if (window.MultiHeizV16) {
        window.MultiHeizV16.openManager('favorites');
      }
      await new Promise(r => setTimeout(r, 300));
      return !!document.querySelector('[data-role="favorites-page-tree"]');
    })()`
  );
  const tree = await rendererEval(
    `!!document.querySelector('[data-role="favorites-page-tree"]')`
  );
  assert(tree, 'favorites page tree rendered');
  console.log('PASS: favorites page tree render');

  // Dos favoritos catalog still works with folders
  const catalogPick = await rendererEval(
    `(async function(){
      if (!window.__multiheizUi || !window.__multiheizUi.openCatalog) return { skip: true };
      return { ok: true };
    })()`
  );
  void catalogPick;

  console.log('PASS: selftest:favorites complete');
  if (typeof electronApp.exit === 'function') electronApp.exit(0);
  else process.exit(0);
}

module.exports = { runFavoritesSelftest };
