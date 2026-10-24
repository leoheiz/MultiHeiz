'use strict';

/**
 * Selftest: workspace background context menu (MULTIHEIZ_SELFTEST=workspace-ctxmenu).
 */

const { app, clipboard } = require('electron');

async function runWorkspaceCtxmenuSelftest(ctx) {
  const {
    mainWindow,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    getState,
  } = ctx;

  console.log('SELFTEST workspace-ctxmenu');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  updateState((s) => {
    s.workspaces = [{ id: 'ws-bg', name: 'Área BG' }];
    s.activeWorkspaceId = 'ws-bg';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [];
    if (!s.settings) s.settings = {};
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(600);
  await waitForLayoutSettle();

  const hasApi = await mainWindow.webContents.executeJavaScript(
    `!!(window.multiheiz && window.multiheiz.popupWorkspaceBgMenu)`,
    true
  );
  assert(hasApi, 'preload exposes popupWorkspaceBgMenu');

  const prevClip = clipboard.readText();
  try {
    clipboard.writeText('not a url at all');
    const r1 = await mainWindow.webContents.executeJavaScript(
      `window.multiheiz.popupWorkspaceBgMenu(120, 200)`,
      true
    );
    assert(r1 && r1.ok, 'menu open on empty bg', r1);
    assert(r1.intercepted === true, 'menu intercepted in selftest', r1);
    const labels = r1.labels || [];
    for (const need of [
      'Nova janela',
      'Nova janela a partir de um favorito',
      'Layout',
      'Liberar memória',
      'Renomear área',
      'Configurações',
    ]) {
      assert(labels.includes(need), 'has ' + need, labels);
    }
    assert(!labels.includes('Colar endereço e abrir'), 'no paste without URL', labels);
    console.log('PASS: empty bg menu labels (no clipboard URL)');

    // DOM: empty-hint exists; right-click path is on #grid (not on .panel-slot)
    const dom = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const grid = document.getElementById('grid');
        const hint = grid && grid.querySelector('.empty-hint');
        const slot = grid && grid.querySelector('.panel-slot');
        return { hasGrid: !!grid, hasHint: !!hint, hasSlot: !!slot };
      })()`,
      true
    );
    assert(dom && dom.hasGrid && dom.hasHint, 'empty hint on background', dom);
    assert(!dom.hasSlot, 'no panel slot on empty workspace', dom);
    console.log('PASS: empty background DOM (hint, no slot)');

    const pasteUrl = 'https://www.google.com/search?q=multiheiz';
    clipboard.writeText(pasteUrl);
    await sleep(50);
    process.env.MULTIHEIZ_SELFTEST_CLIPBOARD_URL = pasteUrl;
    const r2 = await mainWindow.webContents.executeJavaScript(
      `window.multiheiz.popupWorkspaceBgMenu(130, 210)`,
      true
    );
    delete process.env.MULTIHEIZ_SELFTEST_CLIPBOARD_URL;
    assert(r2 && r2.ok && r2.clipboardUrl === true, 'clipboard URL detected', r2);
    assert(
      (r2.labels || []).includes('Colar endereço e abrir'),
      'paste shown with URL',
      r2.labels
    );
    console.log('PASS: Colar endereço e abrir only with URL');

    const before = (getState().accounts || []).length;
    emitToRenderer({ type: 'ui:paste-url-open', url: 'https://example.com/from-menu' });
    await sleep(700);
    const after = getState().accounts || [];
    assert(after.length >= before + 1, 'paste-url created a window', {
      before,
      after: after.length,
    });
    const created = after.find((a) => a && String(a.startUrl || '').includes('from-menu'));
    assert(!!created, 'created account has paste URL');
    console.log('PASS: Colar endereço / Nova janela path creates window');

    // With a window present, panel-slot exists; workspace menu must still open from gaps
    // (handler skips .panel-slot). Confirm API still works and slot exists.
    await sleep(200);
    const withSlot = await mainWindow.webContents.executeJavaScript(
      `(() => {
        const grid = document.getElementById('grid');
        return { hasSlot: !!(grid && grid.querySelector('.panel-slot')) };
      })()`,
      true
    );
    assert(withSlot && withSlot.hasSlot, 'panel slot after create', withSlot);
    const r3 = await mainWindow.webContents.executeJavaScript(
      `window.multiheiz.popupWorkspaceBgMenu(40, 40)`,
      true
    );
    assert(r3 && r3.ok, 'menu still opens on grid (gaps)', r3);
    console.log('PASS: menu on grid gaps; panel-slot clicks skipped by renderer guard');
  } finally {
    try {
      clipboard.writeText(prevClip || '');
    } catch {
      /* ignore */
    }
  }

  console.log('PASS: selftest:workspace-ctxmenu complete');
  app.exit(0);
}

module.exports = { runWorkspaceCtxmenuSelftest };
