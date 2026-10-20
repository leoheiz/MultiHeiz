'use strict';

/**
 * Selftest: layout por área de trabalho (MULTIHEIZ_SELFTEST=layout-workspace).
 *
 * Phase migrate: carrega estado antigo com layout global → todas as áreas recebem cópia.
 * Phase 1: 2 áreas com layouts distintos; troca A↔B; seletor; bounds; nova área; exclusão.
 * Phase 2: mesma USERDATA — cada área manteve o seu layout após reinício.
 *
 * Nova área: cópia do layout da área atual (documentado).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { envGet } = require('./config');
const { migrate, normalizeLayout, STATE_FILE } = require('./state');

/**
 * @param {object} ctx
 */
async function runLayoutWorkspaceSelftest(ctx) {
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
  console.log('SELFTEST layout-workspace phase=' + phase);

  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  function fail(msg, detail) {
    console.log('FAIL:', msg, detail != null ? detail : '');
    app.exit(1);
  }

  function assert(cond, msg, detail) {
    if (!cond) fail(msg, detail);
  }

  if (phase === 'migrate') {
    await runMigratePhase(fail, assert);
    return;
  }

  if (phase === '2') {
    await runPhase2(getState, rendererEval, fail, assert, sleep, waitForLayoutSettle);
    return;
  }

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>lw</title></head>
<body style="margin:0;background:#1a2030;color:#eee;font:16px sans-serif;padding:24px">
<h1 id="t">layout-workspace</h1>
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

  async function setWorkspaceUi(id) {
    return rendererEval(
      `(async () => {
        const st = await window.multiheiz.setWorkspace(${JSON.stringify(id)});
        const apply = window.__mhV16Hooks && window.__mhV16Hooks.applyState;
        if (st && apply) apply(st);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return {
          active: st && st.activeWorkspaceId,
          layout: st && st.layout,
          select: window.__multiheizUi.getLayoutSelectValue(),
          maximized: st && st.maximizedAccountId,
        };
      })()`
    );
  }

  async function setLayoutUi(layout) {
    return rendererEval(
      `(async () => {
        const st = await window.multiheiz.setLayout(${JSON.stringify(layout)});
        const apply = window.__mhV16Hooks && window.__mhV16Hooks.applyState;
        if (st && apply) apply(st);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return {
          layout: st && st.layout,
          select: window.__multiheizUi.getLayoutSelectValue(),
        };
      })()`
    );
  }

  async function setMaximizedUi(accountId) {
    return rendererEval(
      `(async () => {
        const st = await window.multiheiz.setMaximized(${JSON.stringify(accountId)});
        const apply = window.__mhV16Hooks && window.__mhV16Hooks.applyState;
        if (st && apply) apply(st);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return st && st.maximizedAccountId;
      })()`
    );
  }

  async function layoutSelectValue() {
    return rendererEval('window.__multiheizUi.getLayoutSelectValue()');
  }

  function boundsOf(accountId) {
    const info = panels.getPanelDebugInfo();
    const p = (info.panels || []).find((x) => x.accountId === accountId);
    return p ? p.bounds : null;
  }

  /* ---- New profile: Layout select never empty ---- */
  {
    const sel = await layoutSelectValue();
    assert(sel && String(sel).length > 0, 'new profile select empty', sel);
    assert(
      ['1', '2', '4', '6', 'auto', 'livre'].includes(sel),
      'new profile select invalid',
      sel
    );
    console.log('PASS: new profile Layout select has value', sel);
  }

  /* ---- Setup: Principal (A) + Extra (B) with local pages ---- */
  updateState((s) => {
    s.workspaces = [
      { id: 'ws-a', name: 'Área A' },
      { id: 'ws-b', name: 'Área B' },
    ];
    s.activeWorkspaceId = 'ws-a';
    s.layout = 'auto';
    s.layoutByWorkspace = { 'ws-a': 'auto', 'ws-b': 'auto' };
    s.page = 0;
    s.pageByWorkspace = { 'ws-a': 0, 'ws-b': 0 };
    s.maximizedAccountId = null;
    s.maximizedByWorkspace = { 'ws-a': null, 'ws-b': null };
    s.freeTiles = {};
    s.accounts = [
      {
        id: 'acc-a1',
        name: 'A1',
        color: '#2bb8a6',
        startUrl: base + '/?a=1',
        workspaceId: 'ws-a',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-a2',
        name: 'A2',
        color: '#3d8bfd',
        startUrl: base + '/?a=2',
        workspaceId: 'ws-a',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-b1',
        name: 'B1',
        color: '#e8a54b',
        startUrl: base + '/?b=1',
        workspaceId: 'ws-b',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-b2',
        name: 'B2',
        color: '#e83e8c',
        startUrl: base + '/?b=2',
        workspaceId: 'ws-b',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-b3',
        name: 'B3',
        color: '#6f42c1',
        startUrl: base + '/?b=3',
        workspaceId: 'ws-b',
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
  await sleep(500);
  await waitForLayoutSettle();

  /* Area A: layout 2 + maximize acc-a1 */
  await setWorkspaceUi('ws-a');
  await sleep(300);
  let r = await setLayoutUi('2');
  assert(r.layout === '2' && r.select === '2', 'set layout 2 on A', r);
  await waitForUrl('acc-a1', (u) => u.includes('127.0.0.1'), 30000);
  await waitForUrl('acc-a2', (u) => u.includes('127.0.0.1'), 30000);
  await waitForPanels((i) => {
    const vis = (i.panels || []).filter((p) => p.visible && !p.parked);
    return vis.some((p) => p.accountId === 'acc-a1') && vis.some((p) => p.accountId === 'acc-a2');
  });
  await waitForLayoutSettle();

  const splitA1 = boundsOf('acc-a1');
  const splitA2 = boundsOf('acc-a2');
  assert(splitA1 && splitA1.width > 40, 'A1 bounds before max', splitA1);
  assert(splitA2 && splitA2.width > 40, 'A2 bounds before max', splitA2);
  // Two-column: each should be roughly half (not full width)
  assert(
    splitA1.width < splitA1.width + splitA2.width - 20,
    'A1 should not alone fill both',
    { splitA1, splitA2 }
  );

  const maxId = await setMaximizedUi('acc-a1');
  assert(maxId === 'acc-a1', 'maximize A1', maxId);
  await waitForLayoutSettle();
  const maxBounds = boundsOf('acc-a1');
  assert(maxBounds && maxBounds.width > splitA1.width + 40, 'maximized wider than split', {
    maxBounds,
    splitA1,
  });
  console.log('PASS: area A layout=2 + maximized');

  /* Area B: Auto (3 panels → 4-slot grid capacity) */
  await setWorkspaceUi('ws-b');
  await sleep(300);
  r = await setLayoutUi('auto');
  assert(r.layout === 'auto' && r.select === 'auto', 'set auto on B', r);
  await setMaximizedUi(null);
  await waitForUrl('acc-b1', (u) => u.includes('127.0.0.1'), 30000);
  await waitForPanels((i) =>
    (i.panels || []).some((p) => p.accountId === 'acc-b1' && p.visible && !p.parked)
  );
  await waitForLayoutSettle();
  const b1 = boundsOf('acc-b1');
  assert(b1 && b1.width > 40, 'B1 bounds', b1);
  console.log('PASS: area B layout=auto');

  /* Persist maps after configuring both */
  {
    const st = getState();
    assert(st.layoutByWorkspace['ws-a'] === '2', 'saved A layout', st.layoutByWorkspace);
    assert(st.layoutByWorkspace['ws-b'] === 'auto', 'saved B layout', st.layoutByWorkspace);
    assert(st.maximizedByWorkspace['ws-a'] === 'acc-a1', 'saved A maximized', st.maximizedByWorkspace);
    assert(st.layout === 'auto', 'active B mirrors layout', st.layout);
  }

  /* Alternate A ↔ B several times */
  const snaps = [];
  for (let i = 0; i < 3; i++) {
    const onA = await setWorkspaceUi('ws-a');
    await waitForLayoutSettle(800);
    assert(onA.active === 'ws-a', 'switch to A', onA);
    assert(onA.layout === '2' && onA.select === '2', 'A select/layout', onA);
    assert(onA.maximized === 'acc-a1', 'A maximized restored', onA);
    const aBounds = boundsOf('acc-a1');
    assert(aBounds && aBounds.width > 100, 'A maximized bounds', aBounds);
    snaps.push({ ws: 'a', select: onA.select, w: aBounds.width, h: aBounds.height });

    const onB = await setWorkspaceUi('ws-b');
    await waitForLayoutSettle(800);
    assert(onB.active === 'ws-b', 'switch to B', onB);
    assert(onB.layout === 'auto' && onB.select === 'auto', 'B select/layout', onB);
    assert(!onB.maximized, 'B not maximized', onB);
    const bb = boundsOf('acc-b1');
    assert(bb && bb.width > 40, 'B bounds after switch', bb);
    // Maximized A panel should be wider than a cell in Auto grid with 3 panels
    assert(aBounds.width > bb.width + 30 || aBounds.height > bb.height + 30, 'A max vs B cell', {
      aBounds,
      bb,
    });
    snaps.push({ ws: 'b', select: onB.select, w: bb.width, h: bb.height });
  }
  console.log('PASS: A↔B alternation keeps select + bounds', snaps);

  /* New area copies current layout (B is active → Auto) */
  {
    const created = await rendererEval(
      `(async () => {
        const st = await window.multiheiz.createWorkspace('Nova Cópia');
        const apply = window.__mhV16Hooks && window.__mhV16Hooks.applyState;
        if (st && apply) apply(st);
        const neu = st.workspaces.find((w) => w.name === 'Nova Cópia');
        return { id: neu && neu.id, layout: st.layout, workspaces: st.workspaces.map((w) => w.id) };
      })()`
    );
    assert(created.id, 'created workspace id', created);
    const st = getState();
    assert(
      st.layoutByWorkspace[created.id] === 'auto',
      'new area copies current (auto)',
      st.layoutByWorkspace
    );
    // Switch to new area — select must show auto, never empty
    const onNew = await setWorkspaceUi(created.id);
    assert(onNew.select === 'auto' && onNew.layout === 'auto', 'new area select', onNew);

    // Delete new area → layout entry removed
    await rendererEval(
      `(async () => {
        const st = await window.multiheiz.deleteWorkspace(${JSON.stringify(created.id)});
        const apply = window.__mhV16Hooks && window.__mhV16Hooks.applyState;
        if (st && apply) apply(st);
        return st;
      })()`
    );
    await sleep(200);
    const st2 = getState();
    assert(
      !Object.prototype.hasOwnProperty.call(st2.layoutByWorkspace || {}, created.id),
      'deleted area layout gone',
      st2.layoutByWorkspace
    );
    console.log('PASS: new area copies current layout; delete removes layout entry');
  }

  /* Invalid layout heals to Auto in select */
  {
    updateState((s) => {
      s.layout = { cols: 9, rows: 9 };
      if (!s.layoutByWorkspace) s.layoutByWorkspace = {};
      s.layoutByWorkspace[s.activeWorkspaceId] = s.layout;
    });
    emitToRenderer({ type: 'state:changed', state: publicState() });
    await sleep(200);
    const pub = publicState();
    assert(pub.layout === 'auto', 'publicState heals invalid layout', pub.layout);
    await rendererEval(
      `(async () => {
        const apply = window.__mhV16Hooks && window.__mhV16Hooks.applyState;
        if (apply) apply(await window.multiheiz.getState());
      })()`
    );
    const sel = await layoutSelectValue();
    assert(sel === 'auto', 'select heals invalid to auto', sel);
    console.log('PASS: invalid layout → Auto in select (never empty)');
  }

  /* Restore A/B for phase 2 persistence */
  await setWorkspaceUi('ws-a');
  await setLayoutUi('2');
  await setMaximizedUi('acc-a1');
  await setWorkspaceUi('ws-b');
  await setLayoutUi('auto');
  await setMaximizedUi(null);
  flushSave();
  await sleep(400);

  {
    const st = getState();
    assert(st.layoutByWorkspace['ws-a'] === '2', 'pre-restart A', st.layoutByWorkspace);
    assert(st.layoutByWorkspace['ws-b'] === 'auto', 'pre-restart B', st.layoutByWorkspace);
    assert(st.maximizedByWorkspace['ws-a'] === 'acc-a1', 'pre-restart A max', st.maximizedByWorkspace);
  }

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: layout-workspace phase 1 complete');
  app.exit(0);
}

async function runMigratePhase(fail, assert) {
  const { getState } = require('./state');
  const st = getState();
  assert(st.settings.migrations.layoutPerWorkspace130 === true, 'migration marker on load');
  assert(st.layoutByWorkspace && typeof st.layoutByWorkspace === 'object', 'layoutByWorkspace map');
  assert(st.layoutByWorkspace['ws-main'] === '4', 'main got global layout=4', st.layoutByWorkspace);
  assert(st.layoutByWorkspace['ws-extra'] === '4', 'extra got global layout=4', st.layoutByWorkspace);
  assert(normalizeLayout(st.layout) === '4', 'active mirror after migrate', st.layout);

  // Pure function: same rules for fixtures without going through disk
  const next = migrate({
    version: 1,
    workspaces: [
      { id: 'ws-x', name: 'X' },
      { id: 'ws-y', name: 'Y' },
    ],
    activeWorkspaceId: 'ws-x',
    accounts: [],
    layout: '2',
    settings: { migrations: { keepAlive120: true } },
    ui: {},
    appearance: {},
  });
  assert(next.layoutByWorkspace['ws-x'] === '2', 'fixture X', next.layoutByWorkspace);
  assert(next.layoutByWorkspace['ws-y'] === '2', 'fixture Y', next.layoutByWorkspace);
  assert(normalizeLayout({ bad: true }) === 'auto', 'normalize object → auto');
  assert(normalizeLayout('livre') === 'livre', 'normalize livre');
  assert(normalizeLayout('99') === 'auto', 'normalize unknown → auto');

  const userData = app.getPath('userData');
  const statePath = path.join(userData, STATE_FILE);
  assert(fs.existsSync(statePath), 'state file exists after load', statePath);
  // Flush so migration marker + layoutByWorkspace are durable for inspection
  const { flushSave } = require('./state');
  flushSave();
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert(raw.layoutByWorkspace['ws-main'] === '4', 'disk main', raw.layoutByWorkspace);
  assert(raw.layoutByWorkspace['ws-extra'] === '4', 'disk extra', raw.layoutByWorkspace);
  assert(raw.settings.migrations.layoutPerWorkspace130 === true, 'disk marker');

  console.log('PASS: migrate copies global layout to all workspaces');
  app.exit(0);
}

async function runPhase2(getState, rendererEval, fail, assert, sleep, waitForLayoutSettle) {
  const st = getState();
  assert(st.layoutByWorkspace['ws-a'] === '2', 'persist A layout', st.layoutByWorkspace);
  assert(st.layoutByWorkspace['ws-b'] === 'auto', 'persist B layout', st.layoutByWorkspace);
  assert(st.maximizedByWorkspace['ws-a'] === 'acc-a1', 'persist A max', st.maximizedByWorkspace);

  const onA = await rendererEval(
    `(async () => {
      const st = await window.multiheiz.setWorkspace('ws-a');
      const apply = window.__mhV16Hooks && window.__mhV16Hooks.applyState;
      if (st && apply) apply(st);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        layout: st.layout,
        select: window.__multiheizUi.getLayoutSelectValue(),
        maximized: st.maximizedAccountId,
      };
    })()`
  );
  if (typeof waitForLayoutSettle === 'function') await waitForLayoutSettle(800);
  else await sleep(500);
  assert(onA.layout === '2' && onA.select === '2', 'phase2 A select', onA);
  assert(onA.maximized === 'acc-a1', 'phase2 A max', onA);

  const onB = await rendererEval(
    `(async () => {
      const st = await window.multiheiz.setWorkspace('ws-b');
      const apply = window.__mhV16Hooks && window.__mhV16Hooks.applyState;
      if (st && apply) apply(st);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        layout: st.layout,
        select: window.__multiheizUi.getLayoutSelectValue(),
        maximized: st.maximizedAccountId,
      };
    })()`
  );
  if (typeof waitForLayoutSettle === 'function') await waitForLayoutSettle(800);
  else await sleep(500);
  assert(onB.layout === 'auto' && onB.select === 'auto', 'phase2 B select', onB);

  console.log('PASS: layout-workspace persists per area after restart');
  app.exit(0);
}

module.exports = { runLayoutWorkspaceSelftest };
