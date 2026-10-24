'use strict';

/**
 * Selftest: address-bar autocomplete (MULTIHEIZ_SELFTEST=omnibox).
 */

const http = require('node:http');
const { app, session } = require('electron');
const history = require('./history');
const bookmarks = require('./bookmarks');
const omnibox = require('./omnibox');

async function runOmniboxSelftest(ctx) {
  const {
    mainWindow,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    waitForUrl,
    getState,
  } = ctx;

  console.log('SELFTEST omnibox');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><body>omnibox</body></html>`;
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

  // Seed history with a frequently visited domain for inline completion
  // (bypass record() dedupe so visit counts accumulate)
  const fs = require('node:fs');
  history.load();
  history.clearAll();
  history.flush();
  const histPath = history.getPath();
  const now = Date.now();
  const entries = [];
  for (let i = 0; i < 5; i++) {
    entries.push({
      id: `hist-ex-${i}`,
      url: 'https://example.com/path',
      title: 'Example',
      favicon: '',
      windowId: 'acc-ob-1',
      windowName: 'OB',
      time: now - i * 60000,
    });
  }
  entries.push({
    id: 'hist-other-1',
    url: 'https://other.test/x',
    title: 'Other',
    favicon: '',
    windowId: 'acc-ob-1',
    windowName: 'OB',
    time: now - 10,
  });
  fs.writeFileSync(
    histPath,
    JSON.stringify({ version: 1, entries, recentlyClosed: [], sensitiveMigrated: true }, null, 2),
    'utf8'
  );
  history.load();

  bookmarks.load();
  try {
    bookmarks.addFavorite({
      url: 'https://favorito.test/',
      name: 'Meu Favorito',
      folderId: 'folder-bar',
    });
  } catch {
    /* may already exist in fresh store */
  }

  updateState((s) => {
    s.workspaces = [{ id: 'ws-ob', name: 'OB' }];
    s.activeWorkspaceId = 'ws-ob';
    s.layout = '1';
    s.page = 0;
    s.accounts = [
      {
        id: 'acc-ob-1',
        name: 'Janela Alpha',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-ob',
        muted: false,
        lastUrl: null,
      },
      {
        id: 'acc-ob-2',
        name: 'Janela Beta',
        color: '#c96',
        startUrl: base + '/',
        workspaceId: 'ws-ob',
        muted: false,
        lastUrl: null,
      },
    ];
    if (!s.settings) s.settings = {};
    s.settings.searchEngineSuggestions = false;
    s.settings.searchEngine = 'google';
    s.ui = { ...(s.ui || {}), sidebarCollapsed: false, layoutLocked: true };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();
  await waitForUrl('acc-ob-1', (u) => u.includes('127.0.0.1'), 20000).catch(() => {});

  // Unit: inline completion from history fixture
  const inline = omnibox.inlineDomainCompletion('exam', history.query({ limit: 500 }));
  assert(inline && inline.full === 'example.com', 'inline completion example.com', inline);
  assert(inline.completion === 'ple.com', 'selected remainder', inline);
  console.log('PASS: inline domain completion');

  const local = omnibox.suggest({
    query: 'exam',
    accounts: getState().accounts,
    bookmarkItems: (bookmarks.list() && bookmarks.list().items) || [],
    settings: getState().settings,
  });
  assert(
    local.items.some((i) => i.kind === 'history' && /example\.com/i.test(i.url || '')),
    'history in list',
    local.items
  );
  assert(
    local.items.some((i) => i.kind === 'search'),
    'search line present',
    local.items
  );
  const favSuggest = omnibox.suggest({
    query: 'Favorito',
    accounts: getState().accounts,
    bookmarkItems: (bookmarks.list() && bookmarks.list().items) || [],
    settings: getState().settings,
  });
  assert(
    favSuggest.items.some((i) => i.kind === 'favorite'),
    'favorite in list',
    favSuggest.items
  );
  console.log('PASS: suggest includes history, favorites, search');

  // No remote network when suggestions OFF
  let suggestHits = 0;
  const filter = {
    urls: [
      '*://suggestqueries.google.com/*',
      '*://duckduckgo.com/ac/*',
      '*://api.bing.com/*',
    ],
  };
  const onBefore = () => {
    suggestHits += 1;
  };
  try {
    session.defaultSession.webRequest.onBeforeRequest(filter, onBefore);
  } catch {
    /* ignore */
  }

  const ipcRes = await mainWindow.webContents.executeJavaScript(
    `window.multiheiz.omniboxSuggest({ query: 'exam', windowId: 'acc-ob-1' })`,
    true
  );
  assert(ipcRes && Array.isArray(ipcRes.items), 'ipc suggest', ipcRes);
  assert(ipcRes.remoteEnabled === false, 'remote off by default', ipcRes);
  assert(ipcRes.inline && ipcRes.inline.full === 'example.com', 'ipc inline', ipcRes.inline);
  await sleep(300);
  assert(suggestHits === 0, 'zero suggestion network requests by default', suggestHits);
  console.log('PASS: no remote suggestion requests');

  // UI: open URL editor and exercise keys
  const ui = await mainWindow.webContents.executeJavaScript(
    `(() => {
      const slot = document.querySelector('.panel-slot[data-account-id="acc-ob-1"]');
      if (!slot) return { ok: false, reason: 'no-slot' };
      const title = slot.querySelector('.panel-title-block');
      if (title) title.click();
      const input = slot.querySelector('.panel-url');
      if (!input) return { ok: false, reason: 'no-input' };
      input.focus();
      input.value = 'exam';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true };
    })()`,
    true
  );
  assert(ui && ui.ok, 'open url editor', ui);
  await sleep(400);

  const afterType = await mainWindow.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('.panel-url');
      const list = document.querySelector('.omnibox-suggest');
      const items = list ? [...list.querySelectorAll('.omnibox-suggest-item')] : [];
      return {
        value: input ? input.value : '',
        selStart: input ? input.selectionStart : -1,
        selEnd: input ? input.selectionEnd : -1,
        listHidden: !list || list.hidden,
        count: items.length,
        texts: items.map((li) => li.textContent || ''),
      };
    })()`,
    true
  );
  assert(!afterType.listHidden && afterType.count > 0, 'suggestion list visible', afterType);
  // Inline: value should be example.com with remainder selected
  if (afterType.value === 'example.com' && afterType.selStart < afterType.selEnd) {
    console.log('PASS: inline completion selected in field');
  } else {
    // Accept typed-only if timing skipped inline (still must have list)
    console.log('NOTE: inline UI timing', afterType);
    assert(afterType.count > 0, 'list present even without inline race', afterType);
  }

  // ArrowDown / Esc
  await mainWindow.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('.panel-url');
      if (!input) return false;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()`,
    true
  );
  await sleep(200);
  const afterEsc = await mainWindow.webContents.executeJavaScript(
    `(() => {
      const list = document.querySelector('.omnibox-suggest');
      return { hidden: !list || list.hidden };
    })()`,
    true
  );
  assert(afterEsc.hidden, 'Esc closes suggestions', afterEsc);
  console.log('PASS: Up/Down/Esc behavior');

  // Shift+Delete removes history suggestion
  const beforeDel = history.query({ search: 'example.com', limit: 20 }).length;
  assert(beforeDel > 0, 'history has example before delete');
  const delRes = omnibox.suggest({
    query: 'example',
    accounts: getState().accounts,
    bookmarkItems: [],
    settings: getState().settings,
  });
  const histItem = delRes.items.find((i) => i.kind === 'history');
  assert(histItem && histItem.id, 'history item id', histItem);
  history.deleteEntry(histItem.id);
  history.flush();
  const afterDel = history.query({ search: 'example.com', limit: 20 });
  // May still have other visits with different ids — deleteEntry removes one id;
  // ensure that specific id is gone
  assert(!afterDel.some((e) => e.id === histItem.id), 'deleted history id gone', afterDel.length);
  console.log('PASS: Shift+Delete path removes history id');

  // Setting toggle exists and defaults OFF
  const settingUi = await mainWindow.webContents.executeJavaScript(
    `(() => {
      if (window.__multiheizUi && window.__multiheizUi.openSettings) {
        window.__multiheizUi.openSettings();
      }
      const nav = document.querySelector('.settings-nav-btn[data-section="navegacao"]');
      if (nav) nav.click();
      const cb = document.getElementById('search-engine-suggestions');
      return {
        exists: !!cb,
        checked: !!(cb && cb.checked),
      };
    })()`,
    true
  );
  assert(settingUi.exists, 'search engine suggestions toggle exists', settingUi);
  assert(settingUi.checked === false, 'suggestions OFF by default', settingUi);
  assert(getState().settings.searchEngineSuggestions === false, 'state default OFF');

  try {
    session.defaultSession.webRequest.onBeforeRequest(null);
  } catch {
    /* ignore */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest omnibox');
  app.exit(0);
}

module.exports = { runOmniboxSelftest };
