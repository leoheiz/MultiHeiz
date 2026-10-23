'use strict';

/**
 * Selftest catálogo de apps (MULTIHEIZ_SELFTEST=catalog).
 * Janela offscreen; não carrega sites reais (url-policy offline).
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runCatalogSelftest(ctx) {
  const {
    sleep,
    rendererEval,
    publicState,
    updateState,
    flushSave,
    catalog,
  } = ctx;

  console.log('SELFTEST catalog');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  // --- Node: load + validate + filter ---
  catalog.clearCatalogCache();
  const apps = catalog.loadCatalog();
  assert(apps.length === 21, 'expected 21 catalog apps, got ' + apps.length);
  const ids = apps.map((a) => a.id);
  assert(ids.includes('whatsapp') && ids.includes('x'), 'whatsapp + x present');
  assert(ids.includes('google'), 'google present');
  assert(ids.includes('youtube'), 'youtube present');
  assert(ids.includes('claude'), 'claude present');
  for (const a of apps) {
    assert(a.url.startsWith('https://'), 'https only: ' + a.id);
    assert(fs.existsSync(a.iconPath), 'icon exists: ' + a.iconPath);
  }
  console.log('PASS: catalog JSON + icons on disk (21 apps)');

  const zap = catalog.filterApps(apps, 'zap');
  assert(zap.length === 1 && zap[0].id === 'whatsapp', 'zap -> WhatsApp');
  const tw = catalog.filterApps(apps, 'twitter');
  assert(tw.length === 1 && tw[0].id === 'x', 'twitter -> X');
  console.log('PASS: filterApps keywords');

  const uniq = catalog.uniqueNameInWorkspace(
    'WhatsApp',
    [
      { name: 'WhatsApp', workspaceId: 'ws-default' },
      { name: 'Other', workspaceId: 'ws-default' },
    ],
    'ws-default'
  );
  assert(uniq === 'WhatsApp 2', 'uniqueName WhatsApp 2 got ' + uniq);
  const uniq3 = catalog.uniqueNameInWorkspace(
    'WhatsApp',
    [
      { name: 'WhatsApp', workspaceId: 'ws-default' },
      { name: 'WhatsApp 2', workspaceId: 'ws-default' },
    ],
    'ws-default'
  );
  assert(uniq3 === 'WhatsApp 3', 'uniqueName WhatsApp 3');
  console.log('PASS: uniqueNameInWorkspace');

  // Entrada inválida ignorada
  const bad = catalog.validateEntry({
    id: 'bad',
    name: 'Bad',
    url: 'http://insecure.example/',
    defaultName: 'Bad',
    icon: 'icons/whatsapp.svg',
    color: '#000',
  });
  assert(bad === null, 'http entry rejected');
  console.log('PASS: invalid http entry rejected');

  // --- UI: open picker ---
  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Padrão' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => !String(a.id || '').startsWith('acc-cat-'));
  });
  flushSave();

  await rendererEval('window.__multiheizUi.openCatalogPicker()');
  await sleep(400);
  const open1 = await rendererEval('window.__multiheizUi.isCatalogOpen()');
  assert(open1 === true, 'catalog dialog open');

  const visible = await rendererEval('window.__multiheizUi.getCatalogVisibleIds()');
  assert(Array.isArray(visible), 'visible ids array');
  assert(visible.includes('custom'), 'Site personalizado card');
  assert(visible.includes('favorites'), 'Dos favoritos card');
  assert(visible.includes('whatsapp'), 'whatsapp card');
  assert(visible.includes('x'), 'x card');
  assert(visible.includes('google'), 'google card');
  assert(visible.includes('youtube'), 'youtube card');
  assert(visible.includes('claude'), 'claude card');
  assert(visible.length === 23, '21 apps + custom + favorites = 23, got ' + visible.length);
  console.log('PASS: picker lists 21 apps + Site personalizado + Dos favoritos');

  await rendererEval('window.__multiheizUi.setCatalogSearch("zap")');
  await sleep(100);
  const zapIds = await rendererEval('window.__multiheizUi.getCatalogVisibleIds()');
  assert(zapIds.includes('whatsapp'), 'search zap shows WhatsApp');
  assert(!zapIds.includes('discord'), 'search zap hides Discord');
  console.log('PASS: UI search zap -> WhatsApp');

  await rendererEval('window.__multiheizUi.setCatalogSearch("twitter")');
  await sleep(100);
  const twIds = await rendererEval('window.__multiheizUi.getCatalogVisibleIds()');
  assert(twIds.includes('x'), 'search twitter shows X');
  assert(!twIds.includes('whatsapp'), 'search twitter hides WhatsApp');
  console.log('PASS: UI search twitter -> X');

  await rendererEval('window.__multiheizUi.setCatalogSearch("")');
  await sleep(50);

  // Esc cancela
  await rendererEval(`(() => {
    const dlg = document.getElementById('dlg-catalog');
    if (dlg && dlg.open) dlg.close();
    return true;
  })()`);
  await sleep(100);
  assert(
    (await rendererEval('window.__multiheizUi.isCatalogOpen()')) === false,
    'catalog closed'
  );
  console.log('PASS: close cancels');

  // Site personalizado abre diálogo de conta
  await rendererEval('window.__multiheizUi.openCatalogPicker()');
  await sleep(200);
  await rendererEval('window.__multiheizUi.pickCatalogById("custom")');
  await sleep(300);
  const acctOpen = await rendererEval(
    '!!(document.getElementById("dlg-account") && document.getElementById("dlg-account").open)'
  );
  assert(acctOpen === true, 'Site personalizado opens account dialog');
  await rendererEval('window.__multiheizUi.closeAccountDialog()');
  await sleep(100);
  console.log('PASS: Site personalizado -> diálogo atual');

  // Escolher WhatsApp cria janela na área atual
  await rendererEval('window.__multiheizUi.openCatalogPicker()');
  await sleep(200);
  const before = publicState().accounts.length;
  await rendererEval('window.__multiheizUi.pickCatalogById("whatsapp")');
  await sleep(600);
  let st = publicState();
  const wa = (st.accounts || []).find((a) => a.catalogId === 'whatsapp' || a.name === 'WhatsApp');
  assert(wa, 'WhatsApp account created');
  assert(wa.startUrl === 'https://web.whatsapp.com/', 'WhatsApp URL');
  assert(wa.name === 'WhatsApp', 'WhatsApp name');
  assert(wa.workspaceId === st.activeWorkspaceId, 'current workspace');
  assert(wa.catalogIcon, 'catalogIcon persisted');
  assert(wa.catalogIconUrl && String(wa.catalogIconUrl).startsWith('file:'), 'catalogIconUrl');
  assert(st.accounts.length === before + 1, 'one new account');
  console.log('PASS: pick WhatsApp creates window with url/name/icon');

  // Duplicata -> WhatsApp 2
  await rendererEval('window.__multiheizUi.openCatalogPicker()');
  await sleep(200);
  await rendererEval('window.__multiheizUi.pickCatalogById("whatsapp")');
  await sleep(600);
  st = publicState();
  const wa2 = (st.accounts || []).find((a) => a.name === 'WhatsApp 2');
  assert(wa2, 'WhatsApp 2 created');
  assert(wa2.startUrl === 'https://web.whatsapp.com/', 'WhatsApp 2 URL');
  assert(wa2.catalogId === 'whatsapp', 'WhatsApp 2 catalogId');
  console.log('PASS: duplicate name -> WhatsApp 2');

  // Ícones no sidebar (src do catálogo enquanto sem favicon de página)
  const sidebarIcon = await rendererEval(`(() => {
    const items = [...document.querySelectorAll('.sidebar-item')];
    const names = items.map((it) => {
      const n = it.querySelector('.sidebar-name');
      const fav = it.querySelector('.sidebar-fav');
      return { name: n ? n.textContent : '', src: fav ? fav.getAttribute('src') || '' : '' };
    });
    return names.find((x) => x.name === 'WhatsApp') || null;
  })()`);
  assert(sidebarIcon && sidebarIcon.src, 'sidebar shows catalog icon src');
  assert(
    /whatsapp\.svg/i.test(sidebarIcon.src) || sidebarIcon.src.startsWith('file:'),
    'sidebar icon is catalog file: ' + sidebarIcon.src
  );
  console.log('PASS: sidebar shows catalog icon before page favicon');

  // --- Dos favoritos: seed bookmarks.json e cria janela ---
  const bookmarks = require('./bookmarks');
  bookmarks.load();
  bookmarks.addFavorite({
    url: 'https://example.com/catalog-fav',
    name: 'Fav Catalog Test',
    title: 'Fav Catalog Test',
  });
  bookmarks.addFavorite({
    url: 'https://example.org/other-fav',
    name: 'Other Fav',
    title: 'Other Fav',
  });
  bookmarks.flush();
  const seeded = bookmarks.list();
  assert(
    (seeded.items || []).some((it) => it.url === 'https://example.com/catalog-fav'),
    'seeded bookmark present'
  );
  const seedId = (seeded.items || []).find((it) => it.url === 'https://example.com/catalog-fav').id;

  await rendererEval('window.__multiheizUi.openCatalogPicker()');
  await sleep(200);
  await rendererEval('window.__multiheizUi.pickCatalogById("favorites")');
  await sleep(300);
  const mode = await rendererEval('window.__multiheizUi.getCatalogMode()');
  assert(mode === 'favorites', 'catalog mode favorites, got ' + mode);
  const favIds = await rendererEval('window.__multiheizUi.getCatalogVisibleIds()');
  assert(Array.isArray(favIds) && favIds.includes(seedId), 'seeded fav visible in list');
  await rendererEval('window.__multiheizUi.setCatalogSearch("Catalog Test")');
  await sleep(100);
  const filtered = await rendererEval('window.__multiheizUi.getCatalogVisibleNames()');
  assert(
    Array.isArray(filtered) && filtered.some((n) => /Fav Catalog Test/i.test(n)),
    'search filters favorites'
  );
  assert(!filtered.some((n) => /Other Fav/i.test(n)), 'search hides other fav');
  console.log('PASS: Dos favoritos list + search');

  const beforeFav = publicState().accounts.length;
  await rendererEval(`window.__multiheizUi.pickCatalogFavoriteById(${JSON.stringify(seedId)})`);
  await sleep(600);
  const stFav = publicState();
  const createdFav = (stFav.accounts || []).find(
    (a) => a.startUrl === 'https://example.com/catalog-fav' || a.name === 'Fav Catalog Test'
  );
  assert(createdFav, 'favorite created account');
  assert(createdFav.startUrl === 'https://example.com/catalog-fav', 'favorite URL');
  assert(stFav.accounts.length === beforeFav + 1, 'one account from favorite');
  console.log('PASS: Dos favoritos creates window from seeded bookmarks');

  console.log('PASS: selftest catalog complete');
  app.exit(0);
}

module.exports = { runCatalogSelftest };
