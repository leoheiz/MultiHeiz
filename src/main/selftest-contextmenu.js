'use strict';

/**
 * In-process context-menu selftest (MULTIHEIZ_SELFTEST=contextmenu).
 * Dois painéis: clique direito real no painel direito (sendInputEvent),
 * espia coordenadas de popup (sem Menu.popup nativo) e itens de edição.
 */

const http = require('node:http');
const contextMenu = require('./context-menu');

/**
 * @param {object} ctx
 */
async function runContextMenuSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
  } = ctx;

  console.log('SELFTEST contextmenu');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  // --- Pure coord math (also covered in tools node checks) ---
  {
    const pt = contextMenu.computeContextMenuPopupPoint(
      { x: 700, y: 80, width: 600, height: 700 },
      { x: 40, y: 50 },
      1
    );
    assert(pt.x === 740 && pt.y === 130, 'popup = viewBounds + params, got ' + JSON.stringify(pt));
    const zoomIgnored = contextMenu.computeContextMenuPopupPoint(
      { x: 100, y: 20 },
      { x: 10, y: 10 },
      2
    );
    // API multiplica se zoom!=1; produção passa 1 (params já em DIP do view).
    assert(zoomIgnored.x === 120 && zoomIgnored.y === 40, 'zoom opt-in multiply');
    console.log('PASS: computeContextMenuPopupPoint');
  }

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ctx</title></head>
<body style="margin:0;font:16px system-ui">
<p id="plain">hello selectable text here</p>
<textarea id="ta" rows="4" cols="40">edit me</textarea>
<input id="inp" type="text" value="field" />
<div id="ce" contenteditable="true" style="border:1px solid #ccc;padding:8px;min-height:40px">ce text</div>
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
    s.workspaces = [{ id: 'ws-ctx', name: 'Ctx' }];
    s.activeWorkspaceId = 'ws-ctx';
    s.layout = '2';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-ctx-left',
        name: 'Esquerda',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-ctx',
        muted: false,
        lastUrl: null,
        zoomFactor: 1,
      },
      {
        id: 'acc-ctx-right',
        name: 'Direita',
        color: '#3d8bfd',
        startUrl: base + '/',
        workspaceId: 'ws-ctx',
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
    s.settings = { ...s.settings, openLastPage: false, homepage: base + '/' };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(800);
  await waitForLayoutSettle();
  await waitForUrl('acc-ctx-left', (u) => u.includes('127.0.0.1'), 30000);
  await waitForUrl('acc-ctx-right', (u) => u.includes('127.0.0.1'), 30000);
  await waitForLayoutSettle();

  const wcLeft = panels.getPanelCapture('acc-ctx-left');
  const wcRight = panels.getPanelCapture('acc-ctx-right');
  assert(wcLeft && !wcLeft.isDestroyed(), 'left panel');
  assert(wcRight && !wcRight.isDestroyed(), 'right panel');

  let count = 0;
  try {
    count = typeof wcRight.listenerCount === 'function' ? wcRight.listenerCount('context-menu') : 0;
  } catch {
    count = 0;
  }
  assert(count >= 1, 'context-menu listenerCount >= 1, got ' + count);
  console.log('PASS: context-menu listener attached', count);

  const info = panels.getPanelDebugInfo();
  const rightPanel = (info.panels || []).find(
    (p) => (p.accountId || p.id) === 'acc-ctx-right' && p.bounds
  );
  assert(rightPanel && rightPanel.bounds, 'right panel bounds');
  const rb = rightPanel.bounds;
  assert(rb.x > 400, 'right panel should be on the right, x=' + rb.x);

  /** @type {object|null} */
  let lastPopup = null;
  contextMenu.setSelftestHooks({
    onPopup: (info) => {
      lastPopup = info;
    },
  });

  // Clique direito real no painel direito (centro do view)
  lastPopup = null;
  const clickX = Math.round(rb.width / 2);
  const clickY = Math.round(Math.min(80, rb.height / 4));
  try {
    wcRight.sendInputEvent({
      type: 'mouseDown',
      x: clickX,
      y: clickY,
      button: 'right',
      clickCount: 1,
    });
    wcRight.sendInputEvent({
      type: 'mouseUp',
      x: clickX,
      y: clickY,
      button: 'right',
      clickCount: 1,
    });
  } catch (err) {
    assert(false, 'sendInputEvent: ' + (err && err.message));
  }
  await sleep(400);

  assert(lastPopup, 'onPopup spy saw popup after right-click');
  assert(lastPopup.webContents === wcRight, 'popup webContents is right panel');
  assert(
    lastPopup.window === mainWindow || (lastPopup.window && lastPopup.window === mainWindow),
    'popup window is mainWindow'
  );
  assert(
    lastPopup.x >= rb.x && lastPopup.x <= rb.x + rb.width,
    'popup x inside right panel: ' + lastPopup.x + ' vs bounds ' + JSON.stringify(rb)
  );
  assert(
    lastPopup.y >= rb.y && lastPopup.y <= rb.y + rb.height,
    'popup y inside right panel: ' + lastPopup.y + ' vs bounds ' + JSON.stringify(rb)
  );
  // Sem o offset, x seria só params.x (~clickX) e cairia no painel esquerdo
  assert(
    lastPopup.x > rb.x + 10,
    'popup x must include view offset (not bare params.x), got ' + lastPopup.x
  );
  console.log('PASS: right-panel popup coords inside clicked view', {
    popup: { x: lastPopup.x, y: lastPopup.y },
    bounds: rb,
    params: { x: lastPopup.params && lastPopup.params.x, y: lastPopup.params && lastPopup.params.y },
  });

  // Emit sintético no textarea: isEditable + editFlags
  lastPopup = null;
  wcRight.emit('context-menu', {}, {
    x: 30,
    y: 40,
    isEditable: true,
    formControlType: 'text-area',
    selectionText: '',
    linkURL: '',
    mediaType: 'none',
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canPasteAndMatchStyle: true,
      canSelectAll: true,
    },
  });
  await sleep(50);
  assert(lastPopup, 'editable emit produced popup info');
  const editIds = (lastPopup.descriptors || [])
    .filter((d) => d.type !== 'separator')
    .map((d) => d.id);
  for (const id of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
    assert(editIds.includes(id), 'editable menu missing ' + id + ' got ' + editIds.join(','));
  }
  console.log('PASS: editable textarea items present');

  // formControlType alone (isEditable false) still shows edit items
  lastPopup = null;
  wcRight.emit('context-menu', {}, {
    x: 30,
    y: 40,
    isEditable: false,
    formControlType: 'text-area',
    selectionText: '',
    editFlags: { canPaste: true, canSelectAll: true },
  });
  await sleep(50);
  assert(lastPopup, 'formControlType emit');
  const ids2 = (lastPopup.descriptors || []).filter((d) => d.type !== 'separator').map((d) => d.id);
  assert(ids2.includes('paste') && ids2.includes('selectAll'), 'formControlType text-area → edit');
  console.log('PASS: formControlType text-area yields edit items');

  // Seleção em página
  lastPopup = null;
  wcRight.emit('context-menu', {}, {
    x: 20,
    y: 20,
    isEditable: false,
    selectionText: 'hello world',
    editFlags: {},
  });
  await sleep(50);
  const ids3 = (lastPopup.descriptors || []).filter((d) => d.type !== 'separator').map((d) => d.id);
  assert(ids3.includes('copy'), 'selection copy');
  assert(ids3.includes('search-google'), 'selection search');
  console.log('PASS: selection copy + search');

  // Clique direito real focado no textarea (params reais do Chromium)
  lastPopup = null;
  try {
    await wcRight.executeJavaScript(`
      (function(){
        const ta = document.getElementById('ta');
        ta.focus();
        ta.select();
        const r = ta.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()
    `);
  } catch {
    /* ignore */
  }
  const taPt = await wcRight.executeJavaScript(`
    (function(){
      const ta = document.getElementById('ta');
      ta.focus();
      const r = ta.getBoundingClientRect();
      return { x: Math.round(r.left + 20), y: Math.round(r.top + 10) };
    })()
  `);
  assert(taPt && typeof taPt.x === 'number', 'textarea point');
  wcRight.sendInputEvent({
    type: 'mouseDown',
    x: taPt.x,
    y: taPt.y,
    button: 'right',
    clickCount: 1,
  });
  wcRight.sendInputEvent({
    type: 'mouseUp',
    x: taPt.x,
    y: taPt.y,
    button: 'right',
    clickCount: 1,
  });
  await sleep(500);
  assert(lastPopup, 'real right-click on textarea');
  const realIds = (lastPopup.descriptors || [])
    .filter((d) => d.type !== 'separator')
    .map((d) => d.id);
  const hasEdit =
    realIds.includes('paste') ||
    realIds.includes('selectAll') ||
    realIds.includes('cut') ||
    realIds.includes('undo');
  assert(
    hasEdit || lastPopup.params.isEditable || lastPopup.params.formControlType,
    'textarea real context should be editable; ids=' +
      realIds.join(',') +
      ' params=' +
      JSON.stringify({
        isEditable: lastPopup.params.isEditable,
        formControlType: lastPopup.params.formControlType,
      })
  );
  if (hasEdit) {
    console.log('PASS: real textarea context includes edit items', realIds);
  } else {
    // Chromium may still set isEditable; template uses that
    const rebuilt = contextMenu.buildContextMenuTemplate(lastPopup.params, {});
    const rids = rebuilt.filter((d) => d.type !== 'separator').map((d) => d.id);
    assert(
      rids.includes('paste') || rids.includes('selectAll'),
      'rebuild from real params must include edit; params=' +
        JSON.stringify(lastPopup.params) +
        ' ids=' +
        rids.join(',')
    );
    console.log('PASS: real textarea params rebuild to edit items', {
      params: {
        isEditable: lastPopup.params.isEditable,
        formControlType: lastPopup.params.formControlType,
      },
      rids,
    });
  }

  contextMenu.setSelftestHooks(null);
  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest contextmenu complete');
  require('electron').app.exit(0);
}

module.exports = { runContextMenuSelftest };
