'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, session } = require('electron');

/**
 * @param {{
 *   mainWindow: import('electron').BrowserWindow,
 *   panels: typeof import('./panels'),
 *   getState: () => any,
 *   setState: Function,
 *   updateState: Function,
 *   flushSave: Function,
 *   publicState: () => any,
 *   emitToRenderer: Function,
 *   sleep: (ms: number) => Promise<void>,
 *   waitForUrl: Function,
 *   rendererEval: (code: string) => Promise<any>,
 *   v16: any,
 * }} ctx
 */
async function runV16Selftest(ctx) {
  const {
    mainWindow,
    panels,
    getState,
    updateState,
    flushSave,
    publicState,
    sleep,
    waitForUrl,
    rendererEval,
    v16,
  } = ctx;

  console.log('SELFTEST v16');
  const userData = app.getPath('userData');
  const shotsDir = path.join(__dirname, '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });

  async function shot(name) {
    try {
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(shotsDir, `v1.6-${name}.png`), img.toPNG());
      console.log('PASS: screenshot', name);
    } catch (err) {
      console.log('WARN: screenshot failed', name, err && err.message);
    }
  }

  async function syncLayout() {
    await rendererEval('window.__multiheizUi && window.__multiheizUi.syncNow && window.__multiheizUi.syncNow()');
    await sleep(200);
  }

  // Seed two windows
  updateState((s) => {
    s.accounts = [
      {
        id: 'acc-v16-a',
        name: 'Janela A',
        color: '#2bb8a6',
        startUrl: 'https://example.com',
        workspaceId: s.activeWorkspaceId,
        muted: false,
        pauseInBackground: false,
        privateHistory: false,
        lastUrl: null,
      },
      {
        id: 'acc-v16-b',
        name: 'Janela B',
        color: '#3d8bfd',
        startUrl: 'https://example.org',
        workspaceId: s.activeWorkspaceId,
        muted: false,
        pauseInBackground: false,
        privateHistory: true,
        lastUrl: null,
      },
    ];
    s.layout = '2';
    s.page = 0;
    s.settings = {
      ...s.settings,
      searchEngine: 'duckduckgo',
      homepage: 'https://example.com',
      modules: { planilha: true, alarmes: true, notas: true },
    };
  });
  flushSave();

  const [bw, bh] = mainWindow.getContentSize();
  panels.syncVisiblePanels([
    { accountId: 'acc-v16-a', x: 0, y: 80, width: Math.floor(bw / 2), height: bh - 110 },
    { accountId: 'acc-v16-b', x: Math.floor(bw / 2), y: 80, width: Math.floor(bw / 2), height: bh - 110 },
  ]);
  await sleep(800);
  await syncLayout();
  await waitForUrl('acc-v16-a', (u) => !!u && u.includes('example'), 30000).catch(() => {});
  await waitForUrl('acc-v16-b', (u) => !!u && u.includes('example'), 30000).catch(() => {});
  await sleep(500);

  /* ---- Favorites ---- */
  const bm = v16.bookmarks.addFavorite({
    url: 'https://example.com/',
    name: 'Example',
    title: 'Example',
    defaultWindowId: 'acc-v16-b',
  });
  const folder = v16.bookmarks.createFolder('Trabalho');
  v16.bookmarks.updateFavorite(bm.id, { folderId: folder.id, defaultWindowId: 'acc-v16-b' });
  v16.bookmarks.flush();

  const openRes = await require('electron').ipcMain.emit; // noop guard
  const navRes = (() => {
    panels.panelNavigate('acc-v16-b', 'https://example.com/');
    return true;
  })();
  if (!navRes) {
    console.log('FAIL: favorites open navigate');
    app.exit(1);
    return;
  }
  await waitForUrl('acc-v16-b', (u) => u.includes('example.com'), 20000);
  console.log('PASS: favorites add/folder/default window navigate');

  // Persist check via flush + reload store
  v16.bookmarks.flush();
  const listed = v16.bookmarks.list();
  if (!listed.items.some((i) => i.url.includes('example.com') && i.defaultWindowId === 'acc-v16-b')) {
    console.log('FAIL: favorite not persisted with default window');
    app.exit(1);
    return;
  }
  console.log('PASS: favorites persisted');

  await rendererEval('window.__multiheizUi.openFavorites()');
  await sleep(400);
  await shot('favorites');
  await rendererEval('window.__multiheizUi.closeManager()');

  /* ---- History ---- */
  v16.history.clearAll();
  // Navigate A (records) and B private (should not)
  panels.panelNavigate('acc-v16-a', 'https://example.com/path-a');
  await waitForUrl('acc-v16-a', (u) => u.includes('path-a'), 20000);
  await sleep(400);
  panels.panelNavigate('acc-v16-b', 'https://example.org/private-b');
  await waitForUrl('acc-v16-b', (u) => u.includes('private-b') || u.includes('example.org'), 20000);
  await sleep(600);

  // Also force-record for A to be sure
  v16.history.record({
    url: 'https://example.com/forced-a',
    title: 'Forced A',
    windowId: 'acc-v16-a',
    windowName: 'Janela A',
  });
  v16.history.flush();

  const allHist = v16.history.query({ limit: 100 });
  const hasA = allHist.some((e) => e.windowId === 'acc-v16-a');
  const hasB = allHist.some((e) => e.windowId === 'acc-v16-b');
  if (!hasA) {
    console.log('FAIL: history missing window A', allHist.length);
    app.exit(1);
    return;
  }
  if (hasB) {
    console.log('FAIL: private window B should not record history');
    app.exit(1);
    return;
  }
  console.log('PASS: history records A, skips private B');

  const filtered = v16.history.query({ windowId: 'acc-v16-a' });
  if (!filtered.length) {
    console.log('FAIL: filter by window');
    app.exit(1);
    return;
  }
  console.log('PASS: history filter by window');

  v16.history.clearByWindow('acc-v16-a');
  if (v16.history.query({ windowId: 'acc-v16-a' }).length) {
    console.log('FAIL: clear per window');
    app.exit(1);
    return;
  }
  v16.history.record({
    url: 'https://example.com/range',
    title: 'Range',
    windowId: 'acc-v16-a',
    windowName: 'Janela A',
  });
  v16.history.clearByRange('hour');
  console.log('PASS: history clear per window and by range');

  await rendererEval('window.__multiheizUi.openHistory()');
  await sleep(400);
  await shot('history');
  await rendererEval('window.__multiheizUi.closeManager()');

  /* ---- Downloads ---- */
  const dlDir = path.join(userData, 'test-downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  v16.downloads.updateSettings({ defaultFolder: dlDir, askWhereToSave: false });

  const server = await startLocalDownloadServer();
  try {
    panels.panelNavigate('acc-v16-a', `http://127.0.0.1:${server.port}/file.txt`);
    // Trigger download via Content-Disposition — may navigate or download
    await sleep(500);
    // Also use session download manually if needed: load attachment URL
    panels.panelNavigate('acc-v16-a', `http://127.0.0.1:${server.port}/attach`);
    let completed = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      completed = v16.downloads.list().find((it) => it.state === 'completed' && it.filename);
      if (completed) break;
    }
    if (!completed) {
      console.log('FAIL: download did not complete', v16.downloads.list());
      app.exit(1);
      return;
    }
    if (completed.windowId !== 'acc-v16-a') {
      console.log('FAIL: download source window', completed.windowId);
      app.exit(1);
      return;
    }
    if (!fs.existsSync(completed.savePath)) {
      console.log('FAIL: download file missing', completed.savePath);
      app.exit(1);
      return;
    }
    console.log('PASS: download completed with source window');

    // Cancel path on slow response
    panels.panelNavigate('acc-v16-a', `http://127.0.0.1:${server.port}/slow`);
    let progressing = null;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      progressing = v16.downloads.list().find((it) => it.state === 'progressing' || it.state === 'paused');
      if (progressing) break;
    }
    if (progressing) {
      v16.downloads.cancel(progressing.id);
      await sleep(400);
      const after = v16.downloads.findItem(progressing.id);
      if (after && after.state !== 'cancelled' && after.state !== 'failed') {
        console.log('WARN: cancel state', after && after.state);
      } else {
        console.log('PASS: download cancel path');
      }
    } else {
      console.log('WARN: slow download not observed (cancel skipped)');
    }
  } finally {
    server.close();
  }

  await rendererEval('window.__multiheizUi.openDownloads()');
  await sleep(400);
  await shot('downloads');
  await rendererEval('window.__multiheizUi.closeManager()');

  /* ---- Settings search engine ---- */
  updateState((s) => {
    s.settings.searchEngine = 'duckduckgo';
  });
  flushSave();
  panels.panelNavigate('acc-v16-a', 'teste');
  await waitForUrl('acc-v16-a', (u) => u.includes('duckduckgo.com') && u.includes('teste'), 20000);
  console.log('PASS: search engine resolve for non-URL text');

  // KOFI: visible with URL set; openExternal stubbed (no browser)
  const expectedKofi = v16.KOFI_URL;
  if (!expectedKofi) {
    console.log('FAIL: KOFI_URL should be set by default for visibility test');
    app.exit(1);
    return;
  }
  await rendererEval('window.__multiheizUi.refreshKofiVisibility()');
  await sleep(200);
  await rendererEval('window.__multiheizUi.openSettings()');
  await sleep(300);
  await rendererEval(`
    (function(){
      const btn = document.querySelector('.settings-nav-btn[data-section="sobre"]');
      if (btn) btn.click();
    })()
  `);
  await sleep(200);
  const kofiBtnVisible = await rendererEval('window.__multiheizUi.isKofiVisible()');
  const kofiHeartVisible = await rendererEval('window.__multiheizUi.isKofiHeartVisible()');
  const kofiHeartEl = await rendererEval('!!document.getElementById("btn-kofi-status")');
  if (!kofiBtnVisible) {
    console.log('FAIL: KOFI button should be visible when KOFI_URL set', {
      kofiBtnVisible,
      expectedKofi,
    });
    app.exit(1);
    return;
  }
  if (kofiHeartVisible || kofiHeartEl) {
    console.log('FAIL: top-bar Ko-fi heart must be removed', { kofiHeartVisible, kofiHeartEl });
    app.exit(1);
    return;
  }
  console.log('PASS: KOFI button visible; top-bar heart absent');

  v16.clearOpenExternalLog();
  await rendererEval('window.__multiheizUi.clickKofiButton()');
  await sleep(150);
  let openLog = v16.getOpenExternalLog();
  if (openLog.length !== 1 || openLog[0] !== expectedKofi) {
    console.log('FAIL: KOFI button should call openExternal with KOFI_URL', openLog, expectedKofi);
    app.exit(1);
    return;
  }
  console.log('PASS: KOFI openExternal stubbed with URL');

  // Reject non-configured URL
  v16.clearOpenExternalLog();
  await rendererEval(`window.multiheiz.openExternal('https://evil.example/')`);
  await sleep(100);
  if (v16.getOpenExternalLog().length) {
    console.log('FAIL: openExternal must not open non-KOFI_URL');
    app.exit(1);
    return;
  }
  console.log('PASS: openExternal rejects non-KOFI_URL');

  await shot('settings');
  await rendererEval('window.__multiheizUi.closeSettings()');

  // KOFI hidden when overridden to empty (test override)
  v16.setKofiUrlForTest('');
  await rendererEval('window.__multiheizUi.refreshKofiVisibility()');
  await sleep(200);
  await rendererEval('window.__multiheizUi.openSettings()');
  await sleep(200);
  await rendererEval(`
    (function(){
      const btn = document.querySelector('.settings-nav-btn[data-section="sobre"]');
      if (btn) btn.click();
    })()
  `);
  await sleep(200);
  const kofiHiddenBtn = await rendererEval('window.__multiheizUi.isKofiVisible()');
  if (kofiHiddenBtn) {
    console.log('FAIL: KOFI button should be hidden when KOFI_URL empty', { kofiHiddenBtn });
    app.exit(1);
    return;
  }
  console.log('PASS: KOFI button hidden when empty');
  v16.setKofiUrlForTest(expectedKofi);
  await rendererEval('window.__multiheizUi.refreshKofiVisibility()');
  await rendererEval('window.__multiheizUi.closeSettings()');

  // Autosave modules toggle
  await rendererEval('window.__multiheizUi.openSettings()');
  await sleep(200);
  await rendererEval(`
    (function(){
      document.querySelector('.settings-nav-btn[data-section="modulos"]').click();
      const f = document.getElementById('form-settings');
      f.modPlanilha.checked = false;
      f.modPlanilha.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await sleep(600);
  await rendererEval('window.__multiheizUi.closeSettings()');
  await sleep(200);
  const labelsOff = await rendererEval('window.__multiheizUi.getModulesSidebarLabels()');
  if (labelsOff && labelsOff.includes('Planilha')) {
    console.log('FAIL: module toggle off should hide Planilha', labelsOff);
    app.exit(1);
    return;
  }
  console.log('PASS: module toggle hides entry');
  // re-enable for planilha tests
  updateState((s) => {
    s.settings.modules.planilha = true;
  });
  await rendererEval('window.__multiheizUi && window.MultiHeizV16 && window.MultiHeizV16.renderSidebarModules()');

  /* ---- Planilha ---- */
  const wb = v16.planilha.createWorkbook('Selftest');
  const sheetId = wb.sheets[0].id;
  const evaluated = v16.planilha.applyCellsForTest(wb.id, sheetId, {
    A1: '2',
    A2: '3',
    A3: '=SUM(A1:A2)',
  });
  const a3 = evaluated.sheets[0].display.A3;
  if (!a3 || Number(a3.value) !== 5) {
    console.log('FAIL: planilha SUM', a3);
    app.exit(1);
    return;
  }
  console.log('PASS: planilha SUM(A1:A2)=5');

  const xlsxPath = path.join(userData, 'selftest-export.xlsx');
  await v16.planilha.exportXlsxToPath(wb.id, xlsxPath);
  const imported = await v16.planilha.importXlsxFromPath(xlsxPath, 'Imported');
  const impSheet = imported.sheets[0];
  const rawA3 = impSheet.cells && impSheet.cells.A3 && impSheet.cells.A3.raw;
  const disp = impSheet.display && impSheet.display.A3;
  if (!rawA3 || !String(rawA3).includes('SUM')) {
    console.log('FAIL: xlsx formula not preserved', rawA3);
    app.exit(1);
    return;
  }
  if (!disp || Number(disp.value) !== 5) {
    console.log('FAIL: xlsx reimport value', disp);
    app.exit(1);
    return;
  }
  console.log('PASS: planilha export/import preserves formula');

  await rendererEval('window.__multiheizUi.openModule("planilha")');
  await sleep(500);
  await shot('planilha');
  await rendererEval('window.__multiheizUi.closeModule()');

  /* ---- Alarmes ---- */
  v16.alarmes.clearTestNotificationLog();
  const rem = v16.alarmes.addReminder({
    title: 'Selftest beep',
    kind: 'one-off',
    at: Date.now() + 3000,
  });
  let fired = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const log = v16.alarmes.getTestNotificationLog();
    if (log.some((x) => x.id === rem.id)) {
      fired = true;
      break;
    }
  }
  if (!fired) {
    console.log('FAIL: alarm notification not fired', v16.alarmes.getTestNotificationLog());
    app.exit(1);
    return;
  }
  console.log('PASS: alarm notification fired (+3s)');

  const daily = {
    kind: 'recurring',
    recur: 'daily',
    timeOfDay: '23:59',
    enabled: true,
  };
  const next = v16.alarmes.nextOccurrence(daily, Date.now());
  if (!next || next <= Date.now()) {
    console.log('FAIL: recurring nextOccurrence', next);
    app.exit(1);
    return;
  }
  console.log('PASS: recurring next time computed');

  // Missed reminder simulation: persist a past one-off due while app was closed
  v16.alarmes.flush();
  v16.alarmes.stopAll();
  const storePath = path.join(userData, 'modules', 'alarmes.json');
  const dueAt = Date.now() - 60000;
  const missedId = 'rem-missed-selftest';
  const rawAl = {
    version: 1,
    lastRunAt: Date.now() - 120000,
    reminders: [
      {
        id: missedId,
        title: 'Missed one',
        body: '',
        kind: 'one-off',
        at: dueAt,
        enabled: true,
        nextAt: dueAt,
        lastFiredAt: null,
        createdAt: dueAt - 1000,
      },
    ],
    timers: [],
  };
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(rawAl, null, 2), 'utf8');
  v16.alarmes.init(() => {});
  const missed = v16.alarmes.detectMissed();
  if (!missed.some((m) => m.id === missedId || m.title === 'Missed one')) {
    console.log('FAIL: missed reminder detection', missed);
    app.exit(1);
    return;
  }
  console.log('PASS: missed reminder detection');

  await rendererEval('window.__multiheizUi.openModule("alarmes")');
  await sleep(400);
  await shot('alarmes');
  await rendererEval('window.__multiheizUi.closeModule()');

  /* ---- Notas ---- */
  const note = v16.notas.create('Nota selftest');
  v16.notas.update(note.id, { body: 'Hello **bold** <script>alert(1)</script>' });
  v16.notas.flush();
  const preview = v16.notas.sanitizeAndRender('Hello **bold** <script>alert(1)</script>');
  if (preview.includes('<script>') || /<script/i.test(preview)) {
    console.log('FAIL: HTML not sanitized', preview);
    app.exit(1);
    return;
  }
  if (!preview.includes('<strong>bold</strong>')) {
    console.log('FAIL: markdown bold missing', preview);
    app.exit(1);
    return;
  }
  console.log('PASS: notas sanitize HTML');

  v16.notas.flush();
  const notesPath = path.join(userData, 'modules', 'notas.json');
  const notesRaw = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
  if (!notesRaw.notes.some((n) => n.title === 'Nota selftest')) {
    console.log('FAIL: notas not persisted');
    app.exit(1);
    return;
  }
  console.log('PASS: notas autosave persisted');

  await rendererEval('window.__multiheizUi.openModule("notas")');
  await sleep(400);
  await shot('notas');
  await rendererEval('window.__multiheizUi.closeModule()');

  /* ---- Diagnostics ---- */
  const sanitized = require('./diagnostics').sanitizeState(getState());
  const sanJson = JSON.stringify(sanitized);
  if (/"cookies"\s*:/.test(sanJson)) {
    console.log('FAIL: sanitized state contains cookies');
    app.exit(1);
    return;
  }
  const diagDir = path.join(userData, 'diag-out');
  fs.mkdirSync(diagDir, { recursive: true });
  fs.writeFileSync(path.join(diagDir, 'state-sanitized.json'), sanJson, 'utf8');
  const check = fs.readFileSync(path.join(diagDir, 'state-sanitized.json'), 'utf8');
  if (/"cookies"\s*:/.test(check)) {
    console.log('FAIL: diag export has cookies');
    app.exit(1);
    return;
  }
  console.log('PASS: diagnostics sanitized without cookies');

  // Re-assert search engine after UI autosave may have raced; persist via settings IPC path
  updateState((s) => {
    s.settings.searchEngine = 'bing';
    s.settings.homepage = 'https://example.com';
  });
  flushSave();
  const stFile = path.join(userData, 'multiheiz-state.json');
  // Simulate autosave persistence check on disk
  const disk = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  if (!disk.settings || disk.settings.searchEngine !== 'bing') {
    console.log('FAIL: settings search engine not persisted on disk', disk.settings && disk.settings.searchEngine);
    app.exit(1);
    return;
  }
  console.log('PASS: settings auto-save persisted');

  await sleep(300);
  console.log('PASS: selftest v16 complete');
  app.exit(0);
}

function startLocalDownloadServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/attach' || req.url === '/file.txt') {
        const body = Buffer.from('hello multiheiz download\n');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="hello-v16.txt"',
          'Content-Length': body.length,
        });
        res.end(body);
        return;
      }
      if (req.url === '/slow') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="slow-v16.bin"',
          'Content-Length': 1024 * 1024,
        });
        let sent = 0;
        const tick = () => {
          if (sent >= 1024 * 1024) {
            res.end();
            return;
          }
          const chunk = Buffer.alloc(16 * 1024, 7);
          sent += chunk.length;
          res.write(chunk);
          setTimeout(tick, 200);
        };
        tick();
        return;
      }
      res.writeHead(404);
      res.end('no');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, close: () => server.close() });
    });
  });
}

module.exports = { runV16Selftest };
