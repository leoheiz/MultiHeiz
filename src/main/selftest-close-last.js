'use strict';

/**
 * Selftest: close last window in a workspace (MULTIHEIZ_SELFTEST=close-last).
 * Phase 1: each close path → 0 windows + empty page; Phase 2: persists after restart.
 */

const { app } = require('electron');
const { envGet } = require('./config');
const keymap = require('./keymap');
const panelShortcuts = require('./panel-shortcuts');

async function runCloseLastSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    waitForPanels,
    getState,
    rendererEval,
  } = ctx;

  const phase = String(envGet('MULTIHEIZ_SELFTEST_PHASE') || '1');
  console.log('SELFTEST close-last phase=' + phase);

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  async function emptyDom() {
    return rendererEval(`(() => {
      const grid = document.getElementById('grid');
      const slots = grid ? grid.querySelectorAll('.panel-slot').length : -1;
      const start = grid && (grid.querySelector('.mh-start-page') || grid.querySelector('.empty-hint'));
      const r = start && start.getBoundingClientRect();
      return {
        slots,
        hasEmpty: !!start,
        w: r ? r.width : 0,
        h: r ? r.height : 0,
      };
    })()`);
  }

  async function assertEmpty(label) {
    await sleep(400);
    await waitForLayoutSettle();
    const n = (getState().accounts || []).filter((a) => a && a.workspaceId === 'ws-cl').length;
    assert(n === 0, label + ': 0 accounts in workspace', n);
    const dom = await emptyDom();
    assert(dom && dom.slots === 0, label + ': no panel slots', dom);
    assert(dom && dom.hasEmpty && dom.w > 40 && dom.h > 40, label + ': empty page visible', dom);
    console.log('PASS:', label);
  }

  function seedOneAccount(id) {
    updateState((s) => {
      s.workspaces = [{ id: 'ws-cl', name: 'CloseLast' }];
      s.activeWorkspaceId = 'ws-cl';
      s.layout = '2';
      s.page = 0;
      s.maximizedAccountId = null;
      if (!s.settings) s.settings = {};
      s.settings.confirmOnRemove = false;
      s.accounts = [
        {
          id,
          name: 'Única',
          color: '#2bb8a6',
          startUrl: 'about:blank',
          workspaceId: 'ws-cl',
          partitionId: id,
          muted: false,
          volume: 100,
          pauseInBackground: false,
          keepAliveInBackground: false,
          privateHistory: true,
          adblockEnabled: true,
          showUnread: true,
          lastUrl: null,
        },
      ];
    });
    flushSave();
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }

  if (phase === '2') {
    await sleep(500);
    await waitForLayoutSettle();
    const n = (getState().accounts || []).filter((a) => a && a.workspaceId === 'ws-cl').length;
    assert(n === 0, 'phase2: still 0 windows after restart', {
      n,
      total: (getState().accounts || []).length,
    });
    const dom = await emptyDom();
    assert(dom && dom.slots === 0 && dom.hasEmpty, 'phase2: empty page after restart', dom);
    console.log('PASS: empty workspace persists after restart');
    console.log('PASS: selftest:close-last complete');
    app.exit(0);
    return;
  }

  // --- Phase 1 ---
  seedOneAccount('acc-cl-1');
  await sleep(600);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-cl-1'));

  // Path A: panel header ×
  {
    const r = await rendererEval(`window.__multiheizUi.clickPanelClose('acc-cl-1')`);
    assert(r && r.ok, 'panel close click', r);
    await assertEmpty('panel X');
  }

  // Path B: Ctrl+W / keymap closeWindow
  seedOneAccount('acc-cl-2');
  await sleep(500);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-cl-2'));
  if (typeof panels.setFocusedAccount === 'function') {
    panels.setFocusedAccount('acc-cl-2');
  }
  await sleep(100);
  {
    const matched = keymap.matchInput(
      { overrides: {} },
      { type: 'keyDown', key: 'w', control: true, alt: false, meta: false, shift: false },
      { scope: 'panel' }
    );
    assert(matched === 'closeWindow', 'keymap matches Ctrl+W → closeWindow', matched);
    const ok = panelShortcuts.runAction('acc-cl-2', 'closeWindow');
    assert(ok, 'runAction closeWindow');
    await assertEmpty('Ctrl+W / keymap');
  }

  // Path C: ⋮ / context menu Fechar
  seedOneAccount('acc-cl-3');
  await sleep(500);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-cl-3'));
  {
    const menu = await mainWindow.webContents.executeJavaScript(
      `window.multiheiz.popupAccountMenu('acc-cl-3', 200, 200)`,
      true
    );
    assert(menu && menu.ok, 'account menu open', menu);
    const labels = menu.labels || [];
    assert(labels.includes('Fechar'), 'menu has Fechar', labels);
    assert(!labels.includes('Remover janela'), 'menu merged: no Remover janela', labels);
    emitToRenderer({ type: 'ui:confirm-remove-account', accountId: 'acc-cl-3' });
    await assertEmpty('context/⋮ Fechar');
  }

  // Path D: sidebar close
  seedOneAccount('acc-cl-4');
  await sleep(500);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-cl-4'));
  {
    const r = await rendererEval(`window.__multiheizUi.clickSidebarClose('acc-cl-4')`);
    assert(r && r.ok, 'sidebar close click', r);
    await assertEmpty('sidebar close');
  }

  flushSave();
  console.log('PASS: selftest:close-last phase=1');
  app.exit(0);
}

module.exports = { runCloseLastSelftest };
