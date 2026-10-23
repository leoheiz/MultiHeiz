'use strict';

/**
 * In-process shortcuts selftest (MULTIHEIZ_SELFTEST=shortcuts).
 * Focused local panel + sendInputEvent; print is mocked (no dialog).
 */

const http = require('node:http');
const keymap = require('./keymap');

/**
 * @param {object} ctx
 */
async function runShortcutsSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    emitToRenderer,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
    app,
    panelShortcuts,
    getState,
    publicState,
  } = ctx;

  console.log('SELFTEST shortcuts');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  // --- Pure keymap unit checks ---
  {
    assert(keymap.normalizeComboString('ctrl+p') === 'Ctrl+P', 'normalize ctrl+p');
    assert(keymap.normalizeComboString('CommandOrControl+Shift+R') === 'Ctrl+Shift+R', 'normalize CmdOrCtrl');
    const def = keymap.resolveShortcut(null, 'print');
    assert(def.combo === 'Ctrl+P' && def.isDefault, 'default print');
    const remapped = keymap.applyOverride(null, 'print', { combo: 'Ctrl+Shift+O' });
    assert(keymap.resolveShortcut(remapped, 'print').combo === 'Ctrl+Shift+O', 'remap print');
    const conflict = keymap.findConflict(remapped, 'Ctrl+Shift+O', 'find');
    assert(conflict && conflict.id === 'print', 'conflict detection');
    const restored = keymap.applyOverride(remapped, 'print', { restore: true });
    assert(keymap.resolveShortcut(restored, 'print').isDefault, 'restore default');
    const disabled = keymap.applyOverride(null, 'print', { disabled: true });
    assert(keymap.resolveShortcut(disabled, 'print').disabled === true, 'disable');
    assert(
      keymap.matchInput(disabled, {
        type: 'keyDown',
        key: 'p',
        control: true,
        alt: false,
        shift: false,
        meta: false,
      }) === null,
      'disabled does not match'
    );
    assert(
      keymap.matchInput(null, {
        type: 'keyDown',
        key: 'p',
        control: true,
        alt: false,
        shift: false,
        meta: false,
      }) === 'print',
      'default matches print'
    );
    console.log('PASS: keymap unit');
  }

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>sc</title></head>
<body style="margin:0;font:16px system-ui;padding:24px">
<h1 id="t">Shortcuts selftest page</h1>
<p>alpha beta gamma alpha beta</p>
<p>unique-find-token-xyz</p>
<a id="link2" href="/page2">page2</a>
</body></html>`;
  const PAGE2 = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>p2</title></head>
<body><h1>page two</h1></body></html>`;

  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = String((req && req.url) || '/');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(u.indexOf('page2') >= 0 ? PAGE2 : PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-sc', name: 'Sc' }];
    s.activeWorkspaceId = 'ws-sc';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.settings = { ...(s.settings || {}), openLastPage: false, homepage: base + '/' };
    s.settings.keyboardShortcuts = keymap.defaultKeyboardShortcuts();
    s.accounts = [
      {
        id: 'acc-sc',
        name: 'Atalhos',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-sc',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
    s.ui = {
      ...(s.ui || {}),
      sidebarCollapsed: false,
      sidebarAutoHide: false,
      layoutLocked: true,
      sidebarWidth: 240,
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(800);
  await waitForLayoutSettle();

  const accId = 'acc-sc';
  await waitForUrl(accId, (u) => u.includes('127.0.0.1'), 30000);
  await waitForLayoutSettle();
  await sleep(200);

  const wc = panels.getPanelCapture(accId);
  assert(wc && !wc.isDestroyed(), 'panel webContents');
  try {
    wc.focus();
  } catch {
    /* ignore */
  }
  panels.setFocusedAccount(accId);
  await sleep(100);

  async function sendKey(keyCode, modifiers) {
    const mods = modifiers || [];
    try {
      wc.focus();
    } catch {
      /* ignore */
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
    await sleep(250);
  }

  panelShortcuts.clearSelftestLogs();

  // Ctrl+P → mocked print
  await sendKey('P', ['control']);
  {
    const log = panelShortcuts.getPrintMockLog();
    assert(log.length >= 1, 'print mock invoked, got ' + log.length);
    assert(log.some((x) => x.accountId === accId), 'print mock for focused panel');
    console.log('PASS: Ctrl+P print mock');
  }

  // Ctrl+F → find bar + matches
  panelShortcuts.clearSelftestLogs();
  await sendKey('F', ['control']);
  await sleep(200);
  assert(panelShortcuts.isFindBarOpen(accId), 'find bar open after Ctrl+F');
  {
    const bodyText = await wc.executeJavaScript('document.body && document.body.innerText || ""');
    assert(
      String(bodyText).includes('unique-find-token-xyz'),
      'page contains find token, got len=' + String(bodyText).length
    );
  }
  /** @type {{ matches: number, active: number }|null} */
  let foundOnce = null;
  const onFound = (_e, result) => {
    if (result && typeof result.matches === 'number') {
      foundOnce = {
        matches: result.matches,
        active: result.activeMatchOrdinal || 0,
      };
    }
  };
  wc.on('found-in-page', onFound);
  panelShortcuts.findQuery(accId, 'unique-find-token-xyz');
  {
    const t0 = Date.now();
    while (!foundOnce && Date.now() - t0 < 5000) {
      await sleep(100);
    }
  }
  try {
    wc.removeListener('found-in-page', onFound);
  } catch {
    /* ignore */
  }
  assert(foundOnce, 'found-in-page event');
  assert(foundOnce.matches >= 1, 'find matches >= 1, got ' + JSON.stringify(foundOnce));
  console.log('PASS: find bar + matches', foundOnce);
  panelShortcuts.closeFindBar(accId);
  await sleep(100);

  // Zoom
  const z0 = panels.panelGetZoom(accId);
  panelShortcuts.clearSelftestLogs();
  await sendKey('=', ['control']);
  await sleep(150);
  const z1 = panels.panelGetZoom(accId);
  assert(z1 > z0, 'zoom in Ctrl+= ' + z0 + ' -> ' + z1);
  await sendKey('0', ['control']);
  await sleep(150);
  const z2 = panels.panelGetZoom(accId);
  assert(Math.abs(z2 - 1) < 0.01, 'zoom reset to 1, got ' + z2);
  console.log('PASS: zoom in/reset');

  // Reload
  panelShortcuts.clearSelftestLogs();
  await sendKey('R', ['control']);
  await sleep(400);
  {
    const actions = panelShortcuts.getActionLog();
    assert(actions.some((a) => a.action === 'reload'), 'reload action');
    console.log('PASS: Ctrl+R reload');
  }
  await waitForUrl(accId, (u) => u.includes('127.0.0.1'), 15000);

  // Back / forward via navigation then Alt+Left/Right
  try {
    await wc.loadURL(base + '/page2');
  } catch {
    /* ignore */
  }
  await waitForUrl(accId, (u) => u.includes('page2'), 15000);
  panelShortcuts.clearSelftestLogs();
  await sendKey('Left', ['alt']);
  await sleep(500);
  {
    let url = '';
    try {
      url = wc.getURL();
    } catch {
      url = '';
    }
    assert(/\/$/.test(url) || url === base || url === base + '/', 'back to page1, got ' + url);
    console.log('PASS: Alt+Left back');
  }
  panelShortcuts.clearSelftestLogs();
  await sendKey('Right', ['alt']);
  await sleep(500);
  {
    let url = '';
    try {
      url = wc.getURL();
    } catch {
      url = '';
    }
    assert(/page2/.test(url), 'forward to page2, got ' + url);
    console.log('PASS: Alt+Right forward');
  }

  // Remap Ctrl+P → Ctrl+Shift+O (Ctrl+Shift+P is PiP default); old combo must not print; new must
  updateState((s) => {
    s.settings.keyboardShortcuts = keymap.applyOverride(
      s.settings.keyboardShortcuts,
      'print',
      { combo: 'Ctrl+Shift+O' }
    );
  });
  flushSave();
  panelShortcuts.onShortcutsChanged();
  panelShortcuts.clearSelftestLogs();
  await sendKey('P', ['control']);
  await sleep(200);
  assert(panelShortcuts.getPrintMockLog().length === 0, 'old Ctrl+P no longer prints after remap');
  await sendKey('O', ['control', 'shift']);
  await sleep(200);
  assert(panelShortcuts.getPrintMockLog().length >= 1, 'new Ctrl+Shift+O prints');
  console.log('PASS: remap print combo');

  // Conflict detection (unit already; also via findConflict with live settings)
  {
    const ks = getState().settings.keyboardShortcuts;
    const c = keymap.findConflict(ks, 'Ctrl+Shift+O', 'find');
    assert(c && c.id === 'print', 'live conflict');
    console.log('PASS: conflict detection live');
  }

  // Restore default
  updateState((s) => {
    s.settings.keyboardShortcuts = keymap.applyOverride(
      s.settings.keyboardShortcuts,
      'print',
      { restore: true }
    );
  });
  flushSave();
  panelShortcuts.onShortcutsChanged();
  panelShortcuts.clearSelftestLogs();
  await sendKey('P', ['control']);
  await sleep(200);
  assert(panelShortcuts.getPrintMockLog().length >= 1, 'restored Ctrl+P prints');
  console.log('PASS: restore default');

  // Disabled shortcut does nothing
  updateState((s) => {
    s.settings.keyboardShortcuts = keymap.applyOverride(
      s.settings.keyboardShortcuts,
      'print',
      { disabled: true }
    );
  });
  flushSave();
  panelShortcuts.onShortcutsChanged();
  panelShortcuts.clearSelftestLogs();
  await sendKey('P', ['control']);
  await sleep(200);
  assert(panelShortcuts.getPrintMockLog().length === 0, 'disabled print does nothing');
  console.log('PASS: disabled shortcut');

  // Context menu includes Imprimir
  {
    const contextMenu = require('./context-menu');
    const t = contextMenu.buildContextMenuTemplate(
      { isEditable: false, selectionText: '', linkURL: '', mediaType: 'none' },
      { canGoBack: true, canGoForward: true }
    );
    assert(t.some((x) => x.id === 'print'), 'context menu has print');
    console.log('PASS: context menu Imprimir');
  }

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest shortcuts complete');
  app.exit(0);
}

module.exports = { runShortcutsSelftest };
