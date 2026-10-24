'use strict';

/**
 * Selftest: "Nova janela" → pending window with the start page inside the slot
 * (MULTIHEIZ_SELFTEST=newwindow-start).
 *
 * - "+" creates exactly ONE pending window (start page in panel mode, no WebContentsView,
 *   old catalog chooser NOT opened);
 * - picking a catalog app navigates THAT same window (catalog defaults applied);
 * - typing an address navigates that same window (local mock server);
 * - "Opções avançadas" opens the account dialog for the pending window and saving commits it;
 * - closing a pending window leaves no window / no leftover start page;
 * - empty area: "+ Nova janela" also creates one pending window.
 *
 * Local 127.0.0.1 server only; real sites are skipped by the selftest-offline policy.
 */

const http = require('node:http');

async function runNewWindowStartSelftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
    getState,
    rendererEval,
    app,
  } = ctx;

  console.log('SELFTEST newwindow-start');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>nw-${req.url}</title></head><body>nw ${req.url}</body></html>`
      );
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;

  const wsAccounts = () => (getState().accounts || []).filter((a) => a && a.workspaceId === 'ws-nw');
  const pendings = () => wsAccounts().filter((a) => a.pendingStartPage);
  const hasPanel = (id) => panels.getPanelDebugInfo().panels.some((p) => p.accountId === id);

  async function settle(ms = 500) {
    await sleep(ms);
    await waitForLayoutSettle();
  }

  async function closePanelUi(accountId) {
    // Real header close button (confirmOnRemove is off in this test).
    const clicked = await rendererEval(`(() => {
      const b = document.querySelector('.panel-slot[data-account-id=${JSON.stringify(accountId)}] [data-role=\"panel-close\"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    assert(clicked, 'close button found', accountId);
  }

  async function waitStartPage(accountId) {
    for (let i = 0; i < 40; i++) {
      const info = await rendererEval(
        `window.__multiheizUi.getStartPageInfo(${accountId ? JSON.stringify(accountId) : ''})`
      );
      if (info && info.present && info.apps && info.apps.length) return info;
      await sleep(100);
    }
    return rendererEval(
      `window.__multiheizUi.getStartPageInfo(${accountId ? JSON.stringify(accountId) : ''})`
    );
  }

  // Seed: one existing real window (local server) in an area with a conventional layout.
  updateState((s) => {
    s.workspaces = [{ id: 'ws-nw', name: 'NovaJanela' }];
    s.activeWorkspaceId = 'ws-nw';
    s.layout = '6'; // enough slots: no pagination while windows pile up
    s.page = 0;
    s.maximizedAccountId = null;
    if (!s.settings) s.settings = {};
    s.settings.confirmOnRemove = false;
    s.accounts = [
      {
        id: 'acc-nw-a',
        name: 'Existente',
        color: '#2bb8a6',
        startUrl: `${base}/existing`,
        workspaceId: 'ws-nw',
        partitionId: 'acc-nw-a',
        muted: false,
        volume: 100,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await settle(800);
  await waitForUrl('acc-nw-a', (u) => u.includes('/existing'), 15000);
  assert(wsAccounts().length === 1, 'seed: one window');

  // ---- 1) "+" creates exactly one pending window with the start page ----
  await rendererEval(`document.getElementById('btn-add-account').click()`);
  await settle(700);
  assert(wsAccounts().length === 2, '+ adds exactly one window', wsAccounts().length);
  assert(pendings().length === 1, 'exactly one pending window', pendings());
  const p1 = pendings()[0];
  assert(p1.startUrl === 'about:blank', 'pending placeholder start URL', p1.startUrl);
  let info = await waitStartPage(p1.id);
  assert(info.present && info.mode === 'panel' && info.accountId === p1.id, 'start page in the new window slot', info);
  assert(info.hasAddCustom && info.apps.length >= 3, 'pending page shows Apps', info);
  assert(!info.hasNewWindowBtn, 'panel mode has no "+ Nova janela"', info);
  assert(info.emptyHeadings.length === 0, 'no empty headings in pending window', info.emptyHeadings);
  assert(!hasPanel(p1.id), 'no WebContentsView for a pending window');
  const catalogOpen = await rendererEval(`!!(document.getElementById('dlg-catalog') || {}).open`);
  assert(catalogOpen === false, 'old catalog chooser is not opened');
  console.log('PASS: "+" creates one pending window with the start page');

  // ---- 2) Pick a catalog app → same window navigates ----
  const catTile = info.apps.find((a) => a.kind === 'catalog');
  assert(catTile && catTile.catalogId, 'catalog tile available', info.apps);
  const nBeforePick = wsAccounts().length;
  await rendererEval(
    `window.__multiheizUi.startPageClickTile(${JSON.stringify(catTile.catalogId)}, ${JSON.stringify(p1.id)})`
  );
  await settle(700);
  const p1After = wsAccounts().find((a) => a.id === p1.id);
  assert(wsAccounts().length === nBeforePick, 'catalog pick keeps the window count (same window)', wsAccounts().length);
  assert(p1After && !p1After.pendingStartPage, 'pending flag cleared after pick', p1After);
  assert(p1After.catalogId === catTile.catalogId, 'catalog defaults applied', p1After);
  assert(p1After.startUrl === catTile.url, 'start URL = catalog URL', { got: p1After.startUrl, want: catTile.url });
  assert(pendings().length === 0, 'no pending window left');
  const gone = await rendererEval(
    `!document.querySelector('.mh-start-page[data-account-id=${JSON.stringify(p1.id)}]')`
  );
  assert(gone, 'start page removed from the committed window');
  console.log('PASS: catalog pick navigates the same window');

  // ---- 3) Menu event "ui:new-account" → one pending; typed URL navigates same window ----
  emitToRenderer({ type: 'ui:new-account' });
  await settle(700);
  assert(pendings().length === 1, 'ui:new-account creates one pending window', pendings());
  const p2 = pendings()[0];
  const nBeforeType = wsAccounts().length;
  info = await waitStartPage(p2.id);
  assert(info.present && info.mode === 'panel', 'second pending start page', info);
  await rendererEval(
    `window.__multiheizUi.startPageOmniboxEnter(${JSON.stringify(base + '/typed')}, ${JSON.stringify(p2.id)})`
  );
  await settle(600);
  const p2After = wsAccounts().find((a) => a.id === p2.id);
  assert(p2After && !p2After.pendingStartPage, 'typed URL commits the pending window', p2After);
  assert(wsAccounts().length === nBeforeType, 'typed URL keeps the window count', wsAccounts().length);
  assert(String(p2After.startUrl).includes('/typed'), 'start URL = typed address', p2After.startUrl);
  const loaded = await waitForUrl(p2.id, (u) => u.includes('/typed'), 15000);
  assert(loaded.includes(`127.0.0.1:${port}/typed`), 'typed URL loads in that window', loaded);
  console.log('PASS: typed URL navigates the same window');

  // ---- 4) "Opções avançadas" → account dialog for the pending window ----
  emitToRenderer({ type: 'ui:new-account' });
  await settle(700);
  assert(pendings().length === 1, 'third pending window');
  const p3 = pendings()[0];
  info = await waitStartPage(p3.id);
  assert(info.hasAdvanced, 'Opções avançadas link present', info);
  const nBeforeAdv = wsAccounts().length;
  await rendererEval(`window.__multiheizUi.startPageClickAdvanced(${JSON.stringify(p3.id)})`);
  await sleep(300);
  const dlg = await rendererEval(`(() => {
    const d = document.getElementById('dlg-account');
    const f = document.getElementById('form-account');
    return { open: !!(d && d.open), url: f && f.startUrl ? f.startUrl.value : null };
  })()`);
  assert(dlg.open && dlg.url === '', 'advanced options opens account dialog (empty URL)', dlg);
  await rendererEval(`(() => {
    const f = document.getElementById('form-account');
    f.name.value = 'Avançada';
    f.startUrl.value = ${JSON.stringify(base + '/advanced')};
    f.requestSubmit();
  })()`);
  await settle(800);
  const p3After = wsAccounts().find((a) => a.id === p3.id);
  assert(p3After && !p3After.pendingStartPage, 'advanced save commits the pending window', p3After);
  assert(p3After.name === 'Avançada', 'advanced name kept', p3After.name);
  assert(String(p3After.startUrl).includes('/advanced'), 'advanced URL used', p3After.startUrl);
  assert(wsAccounts().length === nBeforeAdv, 'advanced keeps the window count');
  await waitForUrl(p3.id, (u) => u.includes('/advanced'), 15000);
  console.log('PASS: Opções avançadas commits the same window');

  // ---- 5) Closing a pending window removes it (existing close path) ----
  emitToRenderer({ type: 'ui:new-account' });
  await settle(700);
  assert(pendings().length === 1, 'fourth pending window');
  const p4 = pendings()[0];
  const nBeforeClose = wsAccounts().length;
  await closePanelUi(p4.id);
  await settle(700);
  assert(wsAccounts().length === nBeforeClose - 1, 'closing pending removes the account', wsAccounts().length);
  assert(!wsAccounts().some((a) => a.id === p4.id), 'pending account gone');
  const leftover = await rendererEval(
    `!!document.querySelector('.mh-start-page[data-account-id=${JSON.stringify(p4.id)}]')`
  );
  assert(!leftover, 'no leftover start page for the closed window');
  console.log('PASS: closing a pending window leaves no window');

  // ---- 6) Empty area: "+ Nova janela" button → one pending window; close → empty again ----
  updateState((s) => {
    s.accounts = (s.accounts || []).filter((a) => !a || a.workspaceId !== 'ws-nw');
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await settle(700);
  info = await waitStartPage('');
  assert(info.present && info.mode === 'workspace' && info.hasNewWindowBtn, 'empty area start page', info);
  await rendererEval(`document.querySelector('.mh-start-new').click()`);
  await settle(700);
  assert(wsAccounts().length === 1 && pendings().length === 1, 'empty-area + creates one pending window', wsAccounts());
  const p5 = pendings()[0];
  info = await waitStartPage(p5.id);
  assert(info.present && info.mode === 'panel', 'empty area → pending page in panel mode', info);
  await closePanelUi(p5.id);
  await settle(700);
  assert(wsAccounts().length === 0, 'closing the only pending window leaves no window', wsAccounts());
  info = await waitStartPage('');
  assert(info.present && info.mode === 'workspace', 'empty-area start page back', info);
  console.log('PASS: empty area "+ Nova janela" → pending window → close → empty');

  // ---- 7) Empty-area page still creates directly (typed URL → new window) ----
  await rendererEval(
    `window.__multiheizUi.startPageOmniboxEnter(${JSON.stringify(base + '/direct')})`
  );
  await settle(700);
  assert(
    wsAccounts().length === 1 &&
      !wsAccounts()[0].pendingStartPage &&
      String(wsAccounts()[0].startUrl).includes('/direct'),
    'empty-area omnibox creates a real window',
    wsAccounts()
  );
  console.log('PASS: empty-area start page still opens windows directly');

  try {
    server.close();
  } catch {
    /* ignore */
  }
  flushSave();
  console.log('PASS: selftest:newwindow-start complete');
  app.exit(0);
}

module.exports = { runNewWindowStartSelftest };
