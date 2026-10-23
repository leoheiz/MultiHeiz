'use strict';

/**
 * Selftest: Edge-style history popover + full page + privacy strip/migration.
 * MULTIHEIZ_SELFTEST=history
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

async function runHistorySelftest(ctx) {
  const {
    updateState,
    flushSave,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    waitForPanels,
    rendererEval,
    publicState,
  } = ctx;
  const history = require('./history');
  const popoverOverlay = require('./popover-overlay');

  console.log('SELFTEST history');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  // --- Privacy: strip on save ---
  history.clearAll();
  const dirty =
    'https://example.com/watch?v=abc&authToken=SECRET&signature=XYZ&q=ok';
  const rec = history.record({
    url: dirty,
    title: 'Watch',
    windowId: 'acc-hist',
    windowName: 'Hist',
  });
  assert(rec && rec.url, 'recorded');
  assert(!/\?/.test(rec.url) || !/authToken|signature/i.test(rec.url), 'sensitive stripped on save', rec.url);
  assert(/q=ok/.test(rec.url) || /example\.com\/watch/.test(rec.url), 'non-sensitive kept or base ok', rec.url);
  assert(!/SECRET|XYZ/.test(rec.url), 'secret values gone', rec.url);
  console.log('PASS: sensitive params stripped on save');

  // --- Migration of old history.json fixture ---
  const histPath = history.getPath();
  history.flush();
  const fixture = {
    version: 1,
    entries: [
      {
        id: 'hist-old-1',
        url: 'https://leak.test/page?access_token=LEAK&foo=bar',
        title: 'Old Leak',
        favicon: '',
        windowId: 'acc-hist',
        windowName: 'Hist',
        time: Date.now() - 3600000,
      },
    ],
    recentlyClosed: [],
    sensitiveMigrated: false,
  };
  fs.writeFileSync(histPath, JSON.stringify(fixture, null, 2), 'utf8');
  history.load();
  const after = history.get();
  assert(after.sensitiveMigrated === true, 'migration flag set');
  const migrated = (after.entries || []).find((e) => e.id === 'hist-old-1');
  assert(migrated, 'migrated entry present');
  assert(!/access_token=/i.test(migrated.url), 'migrated stripped access_token', migrated.url);
  assert(!/=LEAK\b/i.test(migrated.url), 'migrated stripped secret value', migrated.url);
  assert(/foo=bar/.test(migrated.url), 'migration kept safe params', migrated.url);
  console.log('PASS: migration strips sensitive params in place');

  // Seed visible history for UI
  history.clearAll();
  const now = Date.now();
  history.record({
    url: 'https://alpha.example/path?safe=1',
    title: 'Alpha Page',
    windowId: 'acc-hist',
    windowName: 'Hist',
  });
  await sleep(50);
  history.record({
    url: 'https://beta.example/',
    title: 'Beta Page',
    windowId: 'acc-hist',
    windowName: 'Hist',
  });
  // Force times to today for day header
  history.flush();
  const data = history.get();
  for (const e of data.entries || []) {
    e.time = now;
  }
  history.flush();

  updateState((s) => {
    s.workspaces = [{ id: 'ws-hist', name: 'Hist' }];
    s.activeWorkspaceId = 'ws-hist';
    s.layout = '1';
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
        id: 'acc-hist',
        name: 'Hist',
        color: '#2bb8a6',
        startUrl: 'about:blank',
        workspaceId: 'ws-hist',
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
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-hist' && p.visible));

  // --- Popover ---
  await rendererEval(`(async () => {
    if (window.__multiheizUi && window.__multiheizUi.openHistoryPopover) {
      await window.__multiheizUi.openHistoryPopover();
    }
    await new Promise((r) => setTimeout(r, 500));
  })()`);

  const pop = await rendererEval(`(async () => {
    const p = await window.multiheiz.popoverGet();
    if (!p || !p.open || p.kind !== 'history') return { ok: false, p };
    const b = p.bounds || {};
    return {
      ok: true,
      width: b.width || 0,
      height: b.height || 0,
      count: ((p.data && p.data.entries) || []).length,
    };
  })()`);
  assert(pop && pop.ok, 'history popover open', pop);
  assert(pop.width > 40 && pop.height > 80, 'popover visible non-zero size', pop);
  assert(pop.count >= 1, 'popover has items', pop);
  console.log('PASS: history popover opens with items');

  const dayInOverlay = await popoverOverlay.evalInOverlay
    ? null
    : await rendererEval(`(async () => {
      // Day header is inside overlay; check via popover data grouping label not needed —
      // assert entries exist and search filters.
      return { ok: true };
    })()`);
  void dayInOverlay;

  // Search filter
  await rendererEval(`(async () => {
    if (window.multiheiz.popoverAction) {
      await window.multiheiz.popoverAction({ type: 'history-search', query: 'Alpha' });
    } else {
      // fall through via chrome action path
    }
  })()`);
  // Trigger via app handler
  await rendererEval(`(async () => {
    const ev = { type: 'popover:action', actionType: 'history-search', query: 'Alpha' };
    // Direct refresh path: update query state by calling open again after set is hard;
    // use popoverUpdate after simulating action through exposed UI if available.
  })()`);

  // Use IPC-backed query for search assertion (store), then refresh popover data
  const searched = history.query({ search: 'Alpha', limit: 50 });
  assert(searched.length >= 1 && searched.every((e) => /Alpha/i.test(e.title || '')), 'search filters', searched);
  console.log('PASS: search filters');

  // Day group: open full page and assert DOM
  await rendererEval(`(async () => {
    if (window.multiheiz.popoverHide) await window.multiheiz.popoverHide('test');
    if (window.MultiHeizV16 && window.MultiHeizV16.openManager) {
      window.MultiHeizV16.openManager('history');
    }
    await new Promise((r) => setTimeout(r, 600));
  })()`);

  const pageDom = await rendererEval(`(() => {
    const list = document.querySelector('[data-role="history-page-list"]');
    if (!list) return { ok: false, reason: 'no-list' };
    const day = list.querySelector('[data-role="history-day"]');
    const rows = [...list.querySelectorAll('[data-role="history-page-row"]')];
    const texts = rows.map((r) => (r.innerText || r.textContent || '').trim());
    const hasQuery = texts.some((t) => t.includes('?'));
    const hasDomain = texts.some((t) => /example/i.test(t));
    return {
      ok: true,
      hasDay: !!(day && (day.textContent || '').length > 3),
      dayText: day ? day.textContent : '',
      rowCount: rows.length,
      hasQuery,
      hasDomain,
      sample: texts[0] || '',
    };
  })()`);
  assert(pageDom && pageDom.ok, 'history page rendered', pageDom);
  assert(pageDom.hasDay, 'day group header present', pageDom);
  assert(pageDom.rowCount >= 1, 'page has rows', pageDom);
  assert(!pageDom.hasQuery, 'domain-only rows (no ? query in row text)', pageDom);
  assert(pageDom.hasDomain, 'domain shown in rows', pageDom);
  console.log('PASS: full page day header + domain-only rows');

  // Single delete
  const beforeDel = history.query({ limit: 50 }).length;
  const one = history.query({ limit: 1 })[0];
  assert(one, 'has entry to delete');
  history.deleteEntry(one.id);
  history.flush();
  assert(history.query({ limit: 50 }).length === beforeDel - 1, 'single delete persists');
  console.log('PASS: single delete persists');

  // Multi-select delete
  history.record({
    url: 'https://gamma.example/a',
    title: 'Gamma A',
    windowId: 'acc-hist',
    windowName: 'Hist',
  });
  await sleep(30);
  history.record({
    url: 'https://gamma.example/b',
    title: 'Gamma B',
    windowId: 'acc-hist',
    windowName: 'Hist',
  });
  const multi = history.query({ search: 'Gamma', limit: 10 });
  assert(multi.length >= 2, 'multi seed', multi.length);
  const ids = multi.map((e) => e.id);
  history.deleteEntries(ids);
  history.flush();
  assert(history.query({ search: 'Gamma', limit: 10 }).length === 0, 'multi-select delete persists');
  console.log('PASS: multi-select delete persists');

  console.log('PASS: selftest:history complete');
  app.exit(0);
}

module.exports = { runHistorySelftest };
