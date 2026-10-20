'use strict';

const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');
const { envGet } = require('./config');

/**
 * Selftest: deleting a workspace force-closes its windows via removeAccountById
 * (same path as individual account removal). MULTIHEIZ_SELFTEST=workspace-delete
 */
async function runWorkspaceDeleteSelftest(ctx) {
  const {
    panels,
    getState,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    rendererEval,
    waitForLayoutSettle,
    waitForPanels,
  } = ctx;

  const phase = String(envGet('MULTIHEIZ_SELFTEST_PHASE') || '1');
  console.log('SELFTEST workspace-delete phase=' + phase);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  if (phase === '2') {
    await runPhase2Persistence(ctx);
    return;
  }

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ws-del</title></head>
<body style="margin:0;background:#1a2030;color:#eee;font:16px sans-serif;padding:24px">
<h1 id="t">workspace-delete</h1>
</body></html>`;

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
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

  function fail(msg, detail) {
    console.log('FAIL:', msg, detail != null ? detail : '');
    app.exit(1);
  }

  function panelIds() {
    const info = panels.getPanelDebugInfo();
    return (info.panels || []).map((p) => p.accountId).sort();
  }

  function hasPanel(id) {
    return panelIds().includes(id);
  }

  async function setWorkspaceUi(id) {
    const active = await rendererEval(
      `(async () => {
        const st = await window.multiheiz.setWorkspace(${JSON.stringify(id)});
        const apply = window.__mhV16Hooks && window.__mhV16Hooks.applyState;
        if (st && apply) apply(st);
        return st && st.activeWorkspaceId;
      })()`
    );
    return active;
  }

  /* ---- Confirm message copy (renderer helper) ---- */
  const msg0 = await rendererEval(
    'window.__multiheizUi.workspaceDeleteConfirmMessage("Vazia", 0)'
  );
  if (msg0 !== 'Excluir a área "Vazia"?') {
    fail('confirm N=0', msg0);
    return;
  }
  const msg1 = await rendererEval(
    'window.__multiheizUi.workspaceDeleteConfirmMessage("Uma", 1)'
  );
  if (msg1 !== 'Excluir a área "Uma" e sua 1 janela? Isso não pode ser desfeito.') {
    fail('confirm N=1', msg1);
    return;
  }
  const msg2 = await rendererEval(
    'window.__multiheizUi.workspaceDeleteConfirmMessage("Várias", 3)'
  );
  if (msg2 !== 'Excluir a área "Várias" e suas 3 janelas? Isso não pode ser desfeito.') {
    fail('confirm N=3', msg2);
    return;
  }
  console.log('PASS: confirm message with window count');

  /* ---- Setup: Principal (active) + Extra + Terceira ---- */
  updateState((s) => {
    s.workspaces = [
      { id: 'ws-main', name: 'Principal' },
      { id: 'ws-extra', name: 'Extra' },
      { id: 'ws-third', name: 'Terceira' },
    ];
    s.activeWorkspaceId = 'ws-main';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.maximizedByWorkspace = { 'ws-extra': 'acc-extra-a' };
    s.pageByWorkspace = { 'ws-main': 0, 'ws-extra': 0, 'ws-third': 0 };
    s.freeTiles = {
      'ws-extra': {
        'acc-extra-a': { col: 0, row: 0, w: 6, h: 6 },
        'acc-extra-b': { col: 6, row: 0, w: 6, h: 6 },
      },
      'ws-main': {
        'acc-main-a': { col: 0, row: 0, w: 12, h: 12 },
      },
    };
    s.accounts = [
      {
        id: 'acc-main-a',
        name: 'Main A',
        color: '#2bb8a6',
        startUrl: base + '/?m=a',
        workspaceId: 'ws-main',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-main-b',
        name: 'Main B',
        color: '#3d8bfd',
        startUrl: base + '/?m=b',
        workspaceId: 'ws-main',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-extra-a',
        name: 'Extra A',
        color: '#e8a54b',
        startUrl: base + '/?e=a',
        workspaceId: 'ws-extra',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-extra-b',
        name: 'Extra B',
        color: '#e83e8c',
        startUrl: base + '/?e=b',
        workspaceId: 'ws-extra',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-third-a',
        name: 'Third A',
        color: '#6f42c1',
        startUrl: base + '/?t=a',
        workspaceId: 'ws-third',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: base + '/',
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();
  await waitForUrl('acc-main-a', (u) => u.includes('127.0.0.1'), 30000);
  await waitForPanels((i) =>
    i.panels.some((p) => p.accountId === 'acc-main-a' && p.visible && !p.parked)
  );

  // Warm inactive workspace panels so delete must destroy real views.
  await setWorkspaceUi('ws-extra');
  await sleep(400);
  await waitForLayoutSettle();
  await waitForUrl('acc-extra-a', (u) => u.includes('127.0.0.1'), 30000);
  await waitForPanels((i) =>
    i.panels.some((p) => p.accountId === 'acc-extra-a' && p.visible && !p.parked)
  );

  await setWorkspaceUi('ws-main');
  await sleep(400);
  await waitForLayoutSettle();

  const beforeIds = new Set(publicState().accounts.map((a) => a.id));
  if (
    !beforeIds.has('acc-extra-a') ||
    !beforeIds.has('acc-extra-b') ||
    !beforeIds.has('acc-main-a') ||
    !beforeIds.has('acc-third-a')
  ) {
    fail('setup accounts missing', [...beforeIds]);
    return;
  }
  if (!hasPanel('acc-extra-a') && !hasPanel('acc-extra-b')) {
    // Extra panels may be parked after switch; ensure they still exist as views.
    const info = panels.getPanelDebugInfo();
    const ids = (info.panels || []).map((p) => p.accountId);
    if (!ids.includes('acc-extra-a') || !ids.includes('acc-extra-b')) {
      fail('extra panels should exist (parked ok)', ids);
      return;
    }
  }
  console.log('PASS: setup 3 workspaces with windows');

  /* ---- Spy: same cleanup path as account:remove (clearAccountSession) ---- */
  let clearCalls = [];
  const origClear = panels.clearAccountSession.bind(panels);
  panels.clearAccountSession = async (accountId) => {
    clearCalls.push(accountId);
    return origClear(accountId);
  };

  /* ---- Delete non-active Extra (2 windows) ---- */
  clearCalls = [];
  const afterExtra = await rendererEval(
    'window.multiheiz.deleteWorkspace("ws-extra").then(s => ({ accounts: s.accounts.map(a => a.id), workspaces: s.workspaces.map(w => w.id), active: s.activeWorkspaceId, freeTiles: s.freeTiles }))'
  );
  await sleep(300);
  await waitForLayoutSettle();

  if (clearCalls.sort().join(',') !== 'acc-extra-a,acc-extra-b') {
    fail('clearAccountSession should run for Extra windows', clearCalls);
    return;
  }
  if (afterExtra.workspaces.includes('ws-extra')) {
    fail('ws-extra should be gone', afterExtra.workspaces);
    return;
  }
  if (afterExtra.accounts.includes('acc-extra-a') || afterExtra.accounts.includes('acc-extra-b')) {
    fail('Extra accounts should be removed', afterExtra.accounts);
    return;
  }
  if (!afterExtra.accounts.includes('acc-main-a') || !afterExtra.accounts.includes('acc-main-b')) {
    fail('Main accounts must stay', afterExtra.accounts);
    return;
  }
  if (!afterExtra.accounts.includes('acc-third-a')) {
    fail('Third account must stay', afterExtra.accounts);
    return;
  }
  if (afterExtra.active !== 'ws-main') {
    fail('active should stay Principal', afterExtra.active);
    return;
  }
  if (afterExtra.freeTiles && afterExtra.freeTiles['ws-extra']) {
    fail('freeTiles for Extra should be gone', afterExtra.freeTiles);
    return;
  }
  if (hasPanel('acc-extra-a') || hasPanel('acc-extra-b')) {
    fail('Extra panel views should be destroyed', panelIds());
    return;
  }
  if (!hasPanel('acc-main-a') && !hasPanel('acc-main-b')) {
    // at least one main panel should still exist
    const ids = panelIds();
    if (!ids.includes('acc-main-a') && !ids.includes('acc-main-b')) {
      fail('Main panels should remain', ids);
      return;
    }
  }
  const stFull = getState();
  if (stFull.maximizedByWorkspace && stFull.maximizedByWorkspace['ws-extra'] != null) {
    fail('maximizedByWorkspace orphan for Extra', stFull.maximizedByWorkspace);
    return;
  }
  if (stFull.pageByWorkspace && stFull.pageByWorkspace['ws-extra'] != null) {
    fail('pageByWorkspace orphan for Extra', stFull.pageByWorkspace);
    return;
  }
  console.log('PASS: delete non-active area removes its windows (same clearAccountSession path)');

  /* ---- Delete active Terceira while on it → switch away ---- */
  await setWorkspaceUi('ws-third');
  await sleep(400);
  await waitForLayoutSettle();
  await waitForUrl('acc-third-a', (u) => u.includes('127.0.0.1'), 30000);

  clearCalls = [];
  const afterThird = await rendererEval(
    'window.multiheiz.deleteWorkspace("ws-third").then(s => ({ accounts: s.accounts.map(a => a.id), workspaces: s.workspaces.map(w => w.id), active: s.activeWorkspaceId }))'
  );
  await sleep(300);
  await waitForLayoutSettle();

  if (clearCalls.join(',') !== 'acc-third-a') {
    fail('clearAccountSession for third', clearCalls);
    return;
  }
  if (afterThird.workspaces.includes('ws-third')) {
    fail('ws-third should be gone', afterThird.workspaces);
    return;
  }
  if (afterThird.accounts.includes('acc-third-a')) {
    fail('third account should be gone', afterThird.accounts);
    return;
  }
  if (afterThird.active === 'ws-third') {
    fail('active should switch off deleted area', afterThird.active);
    return;
  }
  if (!afterThird.workspaces.includes('ws-main') || afterThird.workspaces.length !== 1) {
    fail('only Principal should remain', afterThird.workspaces);
    return;
  }
  if (hasPanel('acc-third-a')) {
    fail('third panel destroyed', panelIds());
    return;
  }
  if (!afterThird.accounts.includes('acc-main-a') || !afterThird.accounts.includes('acc-main-b')) {
    fail('main intact after active delete', afterThird.accounts);
    return;
  }
  console.log('PASS: delete active area switches workspace and removes its windows');

  /* ---- Last remaining area cannot be deleted ---- */
  clearCalls = [];
  const afterLast = await rendererEval(
    'window.multiheiz.deleteWorkspace("ws-main").then(s => ({ accounts: s.accounts.map(a => a.id), workspaces: s.workspaces.map(w => w.id), active: s.activeWorkspaceId }))'
  );
  if (clearCalls.length !== 0) {
    fail('last area delete must not clear sessions', clearCalls);
    return;
  }
  if (!afterLast.workspaces.includes('ws-main') || afterLast.workspaces.length !== 1) {
    fail('last workspace must remain', afterLast.workspaces);
    return;
  }
  if (!afterLast.accounts.includes('acc-main-a') || !afterLast.accounts.includes('acc-main-b')) {
    fail('last area windows untouched', afterLast.accounts);
    return;
  }
  console.log('PASS: last remaining area cannot be deleted');

  /* ---- Persist for phase 2 (no orphans) ---- */
  panels.clearAccountSession = origClear;
  updateState((s) => {
    // Drop localhost URLs so phase 2 does not hit a dead server.
    for (const a of s.accounts) {
      a.startUrl = 'about:blank';
      a.lastUrl = null;
    }
  });
  flushSave();

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('SELFTEST workspace-delete phase1 OK — exiting for restart persistence check');
  app.exit(0);
}

/**
 * Phase 2: same userdata — only Principal + its accounts, no orphan refs.
 */
async function runPhase2Persistence(ctx) {
  const { sleep, waitForLayoutSettle, flushSave, publicState, updateState, emitToRenderer } = ctx;

  // Avoid loading phase-1 localhost URLs.
  updateState((s) => {
    for (const a of s.accounts || []) {
      a.startUrl = 'about:blank';
      a.lastUrl = null;
    }
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();

  const st = publicState();
  const wsIds = (st.workspaces || []).map((w) => w.id);
  const accIds = (st.accounts || []).map((a) => a.id).sort();

  if (wsIds.length !== 1 || wsIds[0] !== 'ws-main') {
    console.log('FAIL: phase2 workspaces', wsIds);
    app.exit(1);
    return;
  }
  if (accIds.join(',') !== 'acc-main-a,acc-main-b') {
    console.log('FAIL: phase2 accounts (orphans?)', accIds);
    app.exit(1);
    return;
  }
  for (const a of st.accounts) {
    if (a.workspaceId !== 'ws-main') {
      console.log('FAIL: phase2 account workspace orphan', a);
      app.exit(1);
      return;
    }
  }
  if (st.freeTiles && st.freeTiles['ws-extra']) {
    console.log('FAIL: phase2 freeTiles orphan ws-extra', st.freeTiles);
    app.exit(1);
    return;
  }
  if (st.activeWorkspaceId !== 'ws-main') {
    console.log('FAIL: phase2 active', st.activeWorkspaceId);
    app.exit(1);
    return;
  }

  // Read raw disk file if present for maximized/page maps.
  try {
    const fs = require('node:fs');
    const userData = app.getPath('userData');
    const statePath = path.join(userData, 'multiheiz-state.json');
    if (fs.existsSync(statePath)) {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (raw.maximizedByWorkspace && raw.maximizedByWorkspace['ws-extra'] != null) {
        console.log('FAIL: disk maximizedByWorkspace orphan', raw.maximizedByWorkspace);
        app.exit(1);
        return;
      }
      if (raw.pageByWorkspace && raw.pageByWorkspace['ws-extra'] != null) {
        console.log('FAIL: disk pageByWorkspace orphan', raw.pageByWorkspace);
        app.exit(1);
        return;
      }
      if ((raw.workspaces || []).some((w) => w.id === 'ws-extra' || w.id === 'ws-third')) {
        console.log('FAIL: disk still has deleted workspaces', raw.workspaces);
        app.exit(1);
        return;
      }
    }
  } catch (err) {
    console.log('FAIL: phase2 disk read', err && err.message ? err.message : err);
    app.exit(1);
    return;
  }

  flushSave();
  console.log('PASS: persistence after restart without orphan workspace/account refs');
  console.log('SELFTEST workspace-delete OK');
  app.exit(0);
}

module.exports = { runWorkspaceDeleteSelftest };
