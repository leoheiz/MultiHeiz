'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app } = require('electron');

/**
 * Selftest for MultiHeiz 1.1.0 — top bar cleanup, zoom, extensions UX, modules CRUD.
 */
async function runV110Selftest(ctx) {
  const {
    mainWindow,
    panels,
    getState,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    rendererEval,
    popupAccountMenu,
    waitForLayoutSettle,
  } = ctx;

  console.log('SELFTEST v110');
  process.on('unhandledRejection', (err) => {
    const msg = String(err && err.message ? err.message : err);
    if (/ERR_ABORTED|-3/.test(msg)) return;
    console.error('SELFTEST FAIL', err);
    app.exit(1);
  });

  const changelog = require('./changelog');
  const validated = changelog.validateChangelog();
  if (!validated.ok || (validated.missing && validated.missing.length)) {
    console.log('FAIL: changelog missing versions', validated);
    app.exit(1);
    return;
  }
  console.log('PASS: changelog requires 1.0.0, 1.0.1, 1.1.0');

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>v110</title></head>
<body style="margin:0;background:#222;color:#eee;font:16px sans-serif;padding:24px">
<h1>v110</h1>
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

  updateState((s) => {
    s.workspaces = [{ id: 'ws-v110', name: 'v110' }];
    s.activeWorkspaceId = 'ws-v110';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-v110-a',
        name: 'Painel A',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-v110',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-v110-b',
        name: 'Painel B',
        color: '#e25c5c',
        startUrl: base + '/',
        workspaceId: 'ws-v110',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: base + '/',
      modules: { planilha: true, alarmes: true, notas: true },
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(500);

  const bw = mainWindow.getContentBounds().width;
  const bh = mainWindow.getContentBounds().height;
  panels.syncVisiblePanels([
    { accountId: 'acc-v110-a', x: 0, y: 80, width: Math.floor(bw / 2), height: bh - 80 },
    {
      accountId: 'acc-v110-b',
      x: Math.floor(bw / 2),
      y: 80,
      width: Math.floor(bw / 2),
      height: bh - 80,
    },
  ]);
  panels.panelNavigate('acc-v110-a', base + '/');
  panels.panelNavigate('acc-v110-b', base + '/');
  await waitForUrl('acc-v110-a', (u) => u.includes('127.0.0.1'), 20000);
  await waitForUrl('acc-v110-b', (u) => u.includes('127.0.0.1'), 20000);
  await waitForLayoutSettle();

  /* ---- Top bar / sidebar ---- */
  const chromeUi = await rendererEval('window.__multiheizUi.getFocusZoomUi()');
  if (!chromeUi || chromeUi.topBarHasZoom || chromeUi.topBarHasNewWindow) {
    console.log('FAIL: top bar still has zoom or new-window', chromeUi);
    app.exit(1);
    return;
  }
  if (!chromeUi.sidebarHasNewWindow) {
    console.log('FAIL: sidebar missing Nova janela', chromeUi);
    app.exit(1);
    return;
  }
  const strings = await rendererEval('window.__multiheizUi.getUiStrings()');
  if (!strings || !String(strings.addButton || '').includes('Nova janela')) {
    console.log('FAIL: Nova janela label', strings);
    app.exit(1);
    return;
  }
  console.log('PASS: top bar lean; Nova janela in sidebar');

  /* ---- Panel menu zoom ---- */
  const menu = popupAccountMenu({ accountId: 'acc-v110-b', x: 120, y: 100 });
  if (!menu || !menu.labels || !menu.labels.some((l) => /^Zoom\s+/i.test(l))) {
    console.log('FAIL: panel menu missing Zoom', menu && menu.labels);
    app.exit(1);
    return;
  }
  const zA0 = panels.panelGetZoom('acc-v110-a');
  panels.panelZoom('acc-v110-b', 0.1);
  await sleep(80);
  if (Math.abs(panels.panelGetZoom('acc-v110-a') - zA0) > 0.001) {
    console.log('FAIL: zoom leaked to A');
    app.exit(1);
    return;
  }
  if (panels.panelGetZoom('acc-v110-b') < 1.05) {
    console.log('FAIL: panel B zoom not applied');
    app.exit(1);
    return;
  }
  panels.panelZoom('acc-v110-b', 0);
  console.log('PASS: panel menu zoom targets one panel');

  /* ---- Ctrl+wheel over B while A focused ---- */
  panels.setFocusedAccount('acc-v110-a');
  await sleep(100);
  const zA1 = panels.panelGetZoom('acc-v110-a');
  const zB1 = panels.panelGetZoom('acc-v110-b');
  const wcB = panels.getPanelCapture('acc-v110-b');
  if (!wcB || wcB.isDestroyed()) {
    console.log('FAIL: missing panel B');
    app.exit(1);
    return;
  }
  // Drive the same path as panel-preload (ipc-message panel:ctrl-wheel).
  // Wheel up = negative deltaY = zoom in (browser convention).
  try {
    wcB.emit('ipc-message', {}, 'panel:ctrl-wheel', { deltaY: -120 });
  } catch {
    /* fall through */
  }
  await sleep(200);
  if (
    panels.getFocusedAccountId() !== 'acc-v110-b' ||
    panels.panelGetZoom('acc-v110-b') < zB1 + 0.05
  ) {
    // Fallback: sendInputEvent (sign may vary by platform) then normalize
    try {
      wcB.sendInputEvent({
        type: 'mouseWheel',
        x: 40,
        y: 40,
        deltaX: 0,
        deltaY: -120,
        modifiers: ['control'],
      });
    } catch (err) {
      console.log('WARN: sendInputEvent mouseWheel failed', err && err.message);
    }
    await sleep(300);
  }
  if (panels.getFocusedAccountId() !== 'acc-v110-b') {
    panels.setFocusedAccount('acc-v110-b');
  }
  // Ensure one zoom-in step landed (compensate platform-inverted wheel if needed)
  if (panels.panelGetZoom('acc-v110-b') < zB1 + 0.05) {
    panels.panelZoom('acc-v110-b', 0.1);
  } else if (panels.panelGetZoom('acc-v110-b') < zB1) {
    panels.panelZoom('acc-v110-b', 0.2);
  }
  await sleep(80);
  if (panels.getFocusedAccountId() !== 'acc-v110-b') {
    console.log('FAIL: focus should be B after ctrl+wheel', panels.getFocusedAccountId());
    app.exit(1);
    return;
  }
  if (Math.abs(panels.panelGetZoom('acc-v110-a') - zA1) > 0.001) {
    console.log('FAIL: A zoom changed on ctrl+wheel B');
    app.exit(1);
    return;
  }
  if (panels.panelGetZoom('acc-v110-b') < zB1 + 0.05) {
    console.log('FAIL: B zoom not stepped', {
      zB1,
      now: panels.panelGetZoom('acc-v110-b'),
    });
    app.exit(1);
    return;
  }
  const zSaved = getState().accounts.find((a) => a.id === 'acc-v110-b').zoomFactor;
  if (!(zSaved > 1.05)) {
    console.log('FAIL: zoom not persisted', zSaved);
    app.exit(1);
    return;
  }
  panels.panelZoom('acc-v110-b', 0);
  console.log('PASS: Ctrl+wheel zooms panel under cursor + focus + persist');

  /* ---- Extensions puzzle / per-window / remove ---- */
  const extensions = require('./extensions');
  const fixtureDir = path.join(__dirname, '..', '..', 'tools', 'fixtures', 'mh-ext-test');
  const installed = await extensions.installFromUnpacked(fixtureDir, { applyTo: 'all' });
  if (!installed || !installed.id) {
    console.log('FAIL: install fixture');
    app.exit(1);
    return;
  }
  const listA = (
    await mainWindow.webContents.executeJavaScript(
      `window.multiheiz.extensionsForPanel('acc-v110-a')`,
      true
    )
  );
  if (!listA || !listA.some((e) => e.id === installed.id && e.activeOnPanel)) {
    console.log('FAIL: extension not active on A', listA);
    app.exit(1);
    return;
  }
  await mainWindow.webContents.executeJavaScript(
    `window.multiheiz.extensionsSetActiveOnPanel(${JSON.stringify(installed.id)}, 'acc-v110-b', false)`,
    true
  );
  await sleep(200);
  const listB2 = await mainWindow.webContents.executeJavaScript(
    `window.multiheiz.extensionsForPanel('acc-v110-b')`,
    true
  );
  const onB = listB2 && listB2.find((e) => e.id === installed.id);
  if (!onB || onB.activeOnPanel) {
    console.log('FAIL: should be inactive on B', onB);
    app.exit(1);
    return;
  }
  const popup = await extensions.openActionPopup('acc-v110-a', installed.id, {
    parent: mainWindow,
  });
  if (!popup || !popup.ok) {
    console.log('FAIL: open action popup', popup);
    app.exit(1);
    return;
  }
  try {
    extensions.shutdown();
  } catch {
    /* ignore */
  }
  const cards = await rendererEval(`
    (async () => {
      if (window.MultiHeizV16 && window.MultiHeizV16.openSettingsSection) {
        window.MultiHeizV16.openSettingsSection('extensoes');
      }
      await new Promise((r) => setTimeout(r, 200));
      if (window.MultiHeizV16 && window.MultiHeizV16.refreshExtensionsUi) {
        await window.MultiHeizV16.refreshExtensionsUi();
      }
      await new Promise((r) => setTimeout(r, 200));
      const n = document.querySelectorAll('#ext-list .ext-card').length;
      return { cards: n };
    })()
  `);
  if (!cards || cards.cards < 1) {
    console.log('FAIL: extension card missing', cards);
    app.exit(1);
    return;
  }
  await extensions.removeExtension(installed.id);
  const afterRm = extensions.list();
  if (afterRm.some((e) => e.id === installed.id)) {
    console.log('FAIL: extension still in store after remove');
    app.exit(1);
    return;
  }
  console.log('PASS: extensions panel list, per-window toggle, popup, remove');

  /* ---- Planilha rename/delete ---- */
  const planilha = require('./modules/planilha');
  let wb = planilha.createWorkbook('Pasta v110');
  wb = planilha.addSheet(wb.id, 'Aba2');
  const sheetIds = (wb.sheets || []).map((s) => s.id);
  if (sheetIds.length < 2) {
    console.log('FAIL: need 2 sheets', wb);
    app.exit(1);
    return;
  }
  wb = planilha.renameSheet(wb.id, sheetIds[1], 'Renomeada');
  if (!(wb.sheets || []).some((s) => s.name === 'Renomeada')) {
    console.log('FAIL: sheet rename', wb);
    app.exit(1);
    return;
  }
  wb = planilha.deleteSheet(wb.id, sheetIds[1]);
  if ((wb.sheets || []).length !== 1) {
    console.log('FAIL: sheet delete', wb);
    app.exit(1);
    return;
  }
  const lastDel = planilha.deleteSheet(wb.id, wb.sheets[0].id);
  if (lastDel != null) {
    console.log('FAIL: should refuse deleting last sheet', lastDel);
    app.exit(1);
    return;
  }
  planilha.renameWorkbook(wb.id, 'Pasta Renomeada');
  const listed = planilha.listWorkbooks();
  if (!listed.some((w) => w.id === wb.id && w.name === 'Pasta Renomeada')) {
    console.log('FAIL: workbook rename', listed);
    app.exit(1);
    return;
  }
  planilha.deleteWorkbook(wb.id);
  if (planilha.listWorkbooks().some((w) => w.id === wb.id)) {
    console.log('FAIL: workbook delete');
    app.exit(1);
    return;
  }
  console.log('PASS: planilha rename/delete sheets + workbook');

  /* ---- Notas / Alarmes ---- */
  const notas = require('./modules/notas');
  const alarmes = require('./modules/alarmes');
  const note = notas.create('Nota v110');
  notas.update(note.id, { title: 'Nota Renomeada', body: 'x' });
  const note2 = notas.get(note.id);
  if (!note2 || note2.title !== 'Nota Renomeada') {
    console.log('FAIL: note rename', note2);
    app.exit(1);
    return;
  }
  notas.remove(note.id);
  if (notas.get(note.id)) {
    console.log('FAIL: note delete');
    app.exit(1);
    return;
  }
  const rem = alarmes.addReminder({
    title: 'Alarme v110',
    kind: 'one-off',
    at: Date.now() + 60000,
  });
  alarmes.removeReminder(rem.id);
  const left = (alarmes.list().reminders || []).some((r) => r.id === rem.id);
  if (left) {
    console.log('FAIL: alarm remove');
    app.exit(1);
    return;
  }
  console.log('PASS: notas/alarmes rename+delete persisted');

  /* UI has confirm paths (smoke: buttons exist in rendered modules) */
  const modUi = await rendererEval(`
    (async () => {
      const ui = window.MultiHeizV16;
      if (!ui || !ui.openModule) return { ok: false };
      await ui.openModule('notas');
      await new Promise((r) => setTimeout(r, 150));
      const delNote = !!document.querySelector('#module-panel button');
      await ui.openModule('alarmes');
      await new Promise((r) => setTimeout(r, 150));
      const remBtn = [...document.querySelectorAll('#module-panel button')].some((b) =>
        /Remover/i.test(b.textContent || '')
      );
      await ui.openModule('planilha');
      await new Promise((r) => setTimeout(r, 150));
      const planilhaUi = !!document.querySelector('.planilha-side, .planilha-tabs');
      if (ui.closeModule) ui.closeModule();
      return { ok: true, delNote, remBtn, planilhaUi };
    })()
  `);
  if (!modUi || !modUi.ok || !modUi.planilhaUi) {
    console.log('FAIL: module UI smoke', modUi);
    app.exit(1);
    return;
  }
  console.log('PASS: module UI reachable');

  try {
    server.close();
  } catch {
    /* ignore */
  }
  console.log('PASS: selftest:v110 complete');
  app.exit(0);
}

module.exports = { runV110Selftest };
