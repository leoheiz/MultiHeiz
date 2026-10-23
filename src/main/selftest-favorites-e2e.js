'use strict';

/**
 * In-process favorites e2e (MULTIHEIZ_SELFTEST=favorites-e2e).
 * Expects a 1.3.0-format bookmarks.json already in userData (written by tools/).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {object} ctx
 */
async function runFavoritesE2eSelftest(ctx) {
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
    app,
  } = ctx;
  const popoverOverlay = require('./popover-overlay');

  console.log('SELFTEST favorites-e2e');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  async function sendHostClick(x, y) {
    const wc = mainWindow.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
    await sleep(30);
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

  const bookmarks = require('./bookmarks');
  const list0 = bookmarks.list();
  assert(list0.version === 2, 'startup migrated to v2', list0.version);
  assert(
    list0.items.some((it) => it.name === 'Legacy Fav' || it.url === 'https://example.com/legacy-fav'),
    'legacy items kept',
    list0.items
  );
  assert(
    list0.items.every((it) => it.folderId !== 'folder-default'),
    'legacy folder-default remapped'
  );
  assert(
    (list0.expandedFolders || []).includes('folder-other') ||
      list0.items.some((it) => (list0.expandedFolders || []).includes(it.folderId)),
    'folders with items are expanded after migrate/heal',
    list0.expandedFolders
  );
  console.log('PASS: 1.3.0 fixture loaded without wipe', {
    items: list0.items.length,
    expanded: list0.expandedFolders,
  });

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fav E2E</title></head>
<body style="margin:0;padding:24px;font:16px system-ui;background:#111;color:#eee">
<h1 id="t">favorites e2e mock</h1>
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

  updateState((s) => {
    s.workspaces = [{ id: 'ws-fav', name: 'Fav' }];
    s.activeWorkspaceId = 'ws-fav';
    s.layout = '1';
    if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
    s.layoutByWorkspace['ws-fav'] = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = { ...(s.settings || {}), openLastPage: false, homepage: base + '/', confirmOnRemove: false };
    s.ui = {
      ...(s.ui || {}),
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      layoutLocked: true,
      sidebarWidth: 240,
    };
    s.accounts = [
      {
        id: 'acc-fav-e2e',
        name: 'Fav Panel',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-fav',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(800);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-fav-e2e' && p.visible));
  await waitForUrl('acc-fav-e2e', (u) => u.includes('127.0.0.1'), 30000);

  // --- (a) Legacy items visible in popover, page, catalog ---
  const favBtn = await rectOf('#btn-favorites');
  assert(favBtn && favBtn.w > 0, 'favorites button', favBtn);
  await sendHostClick(favBtn.x, favBtn.y);
  await sleep(400);

  // Prefer explicit open (await) then also verify real button path already clicked
  await rendererEval(`(async () => {
    if (window.__multiheizUi && window.__multiheizUi.openFavoritesPopover) {
      await window.__multiheizUi.openFavoritesPopover();
    }
    await new Promise((r) => setTimeout(r, 250));
  })()`);

  const pop = await rendererEval(`(async () => {
    const p = await window.multiheiz.popoverGet();
    if (!p || !p.open || p.kind !== 'favorites') return { ok: false, p };
    const names = ((p.data && p.data.items) || []).map((it) => it.name || it.title || '');
    return { ok: true, names, expanded: (p.data && p.data.expandedFolders) || [] };
  })()`);
  assert(pop && pop.ok, 'favorites popover open', pop);
  assert(
    (pop.names || []).includes('Legacy Fav'),
    'legacy in popover data items',
    pop
  );

  const overlayRows = await popoverOverlay.evalOverlay(`([...document.querySelectorAll('[data-role="favorites-item"], .favorites-item-row')]
    .map((n) => (n.textContent || '').trim()))`);
  assert(
    (overlayRows || []).some((t) => /Legacy Fav/i.test(t)),
    'legacy visible in quick popover DOM',
    overlayRows
  );
  console.log('PASS: legacy in quick popover');

  await rendererEval(`(async () => {
    if (window.multiheiz.popoverClose) await window.multiheiz.popoverClose('selftest');
  })()`);
  await sleep(200);

  await rendererEval(`(async () => {
    if (window.__multiheizUi && window.__multiheizUi.openFavoritesPage) {
      window.__multiheizUi.openFavoritesPage();
    } else if (window.MultiHeizV16) {
      window.MultiHeizV16.openManager('favorites');
    }
    await new Promise((r) => setTimeout(r, 400));
  })()`);

  const pageNames = await rendererEval(`(() => {
    const rows = [...document.querySelectorAll('[data-role="favorites-page-list"] .favorites-page-row, .favorites-page-row')];
    return rows.map((r) => {
      const t = r.querySelector('strong, .favorites-page-name, span');
      return (t && t.textContent) || r.textContent || '';
    }).map((s) => String(s).trim());
  })()`);
  assert(
    (pageNames || []).some((n) => /Legacy Fav/i.test(n)),
    'legacy on favorites page DOM',
    pageNames
  );
  console.log('PASS: legacy on favorites page');

  await rendererEval(`(async () => {
    if (window.MultiHeizV16 && window.MultiHeizV16.closeManager) window.MultiHeizV16.closeManager();
    const host = document.getElementById('manager-host');
    if (host) host.innerHTML = '';
  })()`);
  await sleep(200);

  const cat = await rendererEval(`(async () => {
    if (window.__multiheizUi && window.__multiheizUi.openCatalogPicker) {
      window.__multiheizUi.openCatalogPicker();
    }
    await new Promise((r) => setTimeout(r, 200));
    if (window.__multiheizUi && window.__multiheizUi.openCatalogFavorites) {
      await window.__multiheizUi.openCatalogFavorites();
    }
    await new Promise((r) => setTimeout(r, 300));
    const names = window.__multiheizUi.getCatalogVisibleNames
      ? window.__multiheizUi.getCatalogVisibleNames()
      : [];
    return { open: window.__multiheizUi.isCatalogOpen ? window.__multiheizUi.isCatalogOpen() : true, names };
  })()`);
  assert(cat && cat.open, 'catalog open on favorites', cat);
  assert(
    (cat.names || []).some((n) => /Legacy Fav/i.test(n)),
    'legacy in new-window favorites list DOM',
    cat
  );
  console.log('PASS: legacy in catalog Dos favoritos');

  // --- (b) Add favorite via real star UI ---
  await rendererEval(`(async () => {
    if (window.__multiheizUi && window.__multiheizUi.closeCatalogPicker) {
      window.__multiheizUi.closeCatalogPicker();
    }
    const dlg = document.getElementById('dlg-catalog');
    if (dlg && dlg.open) dlg.close();
  })()`);
  await sleep(200);

  // Navigate panel to a distinct mock URL to favorite
  const addUrl = base + '/#added-fav';
  try {
    const wc = panels.getPanelCapture('acc-fav-e2e');
    await wc.loadURL(addUrl);
  } catch {
    /* ignore */
  }
  await waitForUrl('acc-fav-e2e', (u) => u.includes('added-fav'), 15000);
  await sleep(300);

  const star = await rectOf('.panel-slot[data-account-id="acc-fav-e2e"] [data-role="panel-star"]');
  assert(star && star.w > 0, 'star button', star);
  await sendHostClick(star.x, star.y);
  await sleep(400);

  const dlgOpen = await rendererEval(`!!(document.getElementById('dlg-favorite') && document.getElementById('dlg-favorite').open)`);
  assert(dlgOpen, 'favorite dialog opened via star');

  await rendererEval(`(() => {
    const form = document.getElementById('form-favorite');
    if (!form) return false;
    form.name.value = 'Added Fav';
    form.url.value = ${JSON.stringify(addUrl)};
    const folder = document.getElementById('fav-folder-select');
    if (folder) folder.value = 'folder-bar';
    form.requestSubmit();
    return true;
  })()`);
  await sleep(500);

  const afterAdd = bookmarks.list();
  assert(
    afterAdd.items.some((it) => it.name === 'Added Fav' || it.url === addUrl),
    'added favorite in store',
    afterAdd.items.map((i) => i.name)
  );

  // Visible in all three surfaces
  await sendHostClick(favBtn.x, favBtn.y);
  await sleep(350);
  const pop2 = await rendererEval(`(async () => {
    const snap = await window.multiheiz.popoverGet();
    const items = (snap && snap.data && snap.data.items) || [];
    const expanded = new Set((snap && snap.data && snap.data.expandedFolders) || []);
    // New fav defaults to bar; ensure bar expanded for visibility check
    return items
      .filter((it) => expanded.has(it.folderId) || it.folderId === 'folder-bar')
      .map((it) => it.name || '');
  })()`);
  // Refresh expanded from store after add
  const storeExpanded = bookmarks.list().expandedFolders || [];
  assert(
    afterAdd.items.some((it) => it.name === 'Added Fav'),
    'Added Fav stored'
  );
  // Force expand bar if needed then re-open
  if (!storeExpanded.includes('folder-bar')) {
    bookmarks.setExpandedFolders([...storeExpanded, 'folder-bar']);
  }
  await rendererEval(`(async () => {
    if (window.multiheiz.popoverClose) await window.multiheiz.popoverClose('selftest');
  })()`);
  await sleep(100);
  await sendHostClick(favBtn.x, favBtn.y);
  await sleep(350);
  const pop3 = await rendererEval(`(async () => {
    const snap = await window.multiheiz.popoverGet();
    return ((snap && snap.data && snap.data.items) || []).map((it) => it.name || '');
  })()`);
  assert((pop3 || []).includes('Added Fav'), 'Added Fav in popover data', { pop2, pop3 });
  console.log('PASS: added fav in popover');

  await rendererEval(`(async () => {
    if (window.multiheiz.popoverClose) await window.multiheiz.popoverClose('selftest');
    if (window.__multiheizUi && window.__multiheizUi.openFavoritesPage) {
      window.__multiheizUi.openFavoritesPage();
    }
    await new Promise((r) => setTimeout(r, 400));
    // Select folder-bar if needed
    const bar = document.querySelector('.favorites-page-folder[data-folder-id="folder-bar"] .favorites-page-folder-name');
    if (bar) bar.click();
    await new Promise((r) => setTimeout(r, 200));
  })()`);
  const page2 = await rendererEval(`([...document.querySelectorAll('.favorites-page-row')]
    .map((r) => (r.textContent || '').trim()))`);
  assert(
    (page2 || []).some((n) => /Added Fav/i.test(n)),
    'Added Fav on favorites page',
    page2
  );
  console.log('PASS: added fav on favorites page');

  await rendererEval(`(async () => {
    if (window.MultiHeizV16 && window.MultiHeizV16.closeManager) window.MultiHeizV16.closeManager();
  })()`);

  const cat2 = await rendererEval(`(async () => {
    if (window.__multiheizUi.openCatalogPicker) window.__multiheizUi.openCatalogPicker();
    await new Promise((r) => setTimeout(r, 150));
    await window.__multiheizUi.openCatalogFavorites();
    await new Promise((r) => setTimeout(r, 300));
    return window.__multiheizUi.getCatalogVisibleNames();
  })()`);
  assert((cat2 || []).some((n) => /Added Fav/i.test(n)), 'Added Fav in catalog', cat2);
  console.log('PASS: added fav in catalog');

  // Open Added Fav from catalog into a panel
  const openRes = await rendererEval(`(async () => {
    const data = await window.multiheiz.bookmarksList();
    const it = (data.items || []).find((x) => x.name === 'Added Fav');
    if (!it) return { ok: false, reason: 'missing' };
    return window.__multiheizUi.pickCatalogFavoriteById(it.id);
  })()`);
  assert(openRes && openRes.ok, 'pick catalog favorite', openRes);
  await sleep(800);
  await waitForLayoutSettle();

  let openedUrl = '';
  const st = publicState();
  const panelsInfo = panels.getPanelDebugInfo();
  for (const p of panelsInfo.panels || []) {
    try {
      const wc = panels.getPanelCapture(p.accountId);
      if (wc && !wc.isDestroyed()) {
        const u = wc.getURL();
        if (u && u.includes('added-fav')) {
          openedUrl = u;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
  // Also check focused / any account lastUrl
  if (!openedUrl) {
    for (const a of st.accounts || []) {
      if (a.lastUrl && String(a.lastUrl).includes('added-fav')) {
        openedUrl = a.lastUrl;
        break;
      }
    }
  }
  assert(
    openedUrl.includes('added-fav') || openedUrl.includes(String(port)),
    'panel opened favorite URL',
    { openedUrl, openRes, accounts: (st.accounts || []).map((a) => a.lastUrl) }
  );
  console.log('PASS: open from catalog into panel', openedUrl);

  // Disk still has legacy + new (never wiped)
  const disk = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'bookmarks.json'), 'utf8'));
  assert((disk.items || []).length >= 3, 'disk keeps legacy+new', disk.items && disk.items.length);
  assert(
    (disk.items || []).some((it) => /legacy-fav/i.test(it.url || '')),
    'legacy still on disk'
  );

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest favorites-e2e complete');
  app.exit(0);
}

module.exports = { runFavoritesE2eSelftest };
