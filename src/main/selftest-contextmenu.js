'use strict';

/**
 * In-process context-menu selftest (MULTIHEIZ_SELFTEST=contextmenu).
 * Valida que o listener está ligado nos painéis; nunca chama Menu.popup.
 */

/**
 * @param {object} ctx
 */
async function runContextMenuSelftest(ctx) {
  const { mainWindow, panels, updateState, flushSave, sleep, app } = ctx;

  console.log('SELFTEST contextmenu');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-ctx-a');
    s.accounts.push({
      id: 'acc-ctx-a',
      name: 'Ctx',
      workspaceId: 'ws-default',
      color: '#4a9',
      muted: false,
      zoomFactor: 1,
      startUrl:
        'data:text/html;charset=utf-8,' +
        encodeURIComponent('<html><body>ctx-menu</body></html>'),
      lastUrl: '',
    });
    s.layout = { cols: 1, rows: 1, slots: [{ accountId: 'acc-ctx-a' }] };
  });
  flushSave();
  panels.createPanel('acc-ctx-a');
  await sleep(700);

  const wc = panels.getPanelCapture('acc-ctx-a');
  assert(wc && !wc.isDestroyed(), 'panel webContents');

  let count = 0;
  try {
    count = typeof wc.listenerCount === 'function' ? wc.listenerCount('context-menu') : 0;
  } catch {
    count = 0;
  }
  assert(count >= 1, 'context-menu listenerCount >= 1, got ' + count);
  console.log('PASS: context-menu listener attached', count);

  // Dispara o evento sem popup (SELFTEST set) — só garante que não explode
  let saw = false;
  const once = () => {
    saw = true;
  };
  wc.once('context-menu', once);
  try {
    wc.emit('context-menu', {}, {
      x: 10,
      y: 10,
      linkURL: '',
      srcURL: '',
      selectionText: '',
      isEditable: false,
      mediaType: 'none',
      misspelledWord: '',
      dictionarySuggestions: [],
      editFlags: {},
    });
  } catch (err) {
    assert(false, 'emit context-menu threw: ' + (err && err.message));
  }
  await sleep(50);
  assert(saw, 'context-menu handler ran');
  console.log('PASS: context-menu handler runs without popup');

  console.log('PASS: selftest contextmenu complete');
  require('electron').app.exit(0);
}

module.exports = { runContextMenuSelftest };
