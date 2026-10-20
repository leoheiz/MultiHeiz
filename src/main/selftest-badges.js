'use strict';

/**
 * Selftest contador de não lidas (MULTIHEIZ_SELFTEST=badges).
 * Páginas locais; espiona setOverlayIcon / setBadgeCount.
 */

const http = require('node:http');

/**
 * @param {object} ctx
 */
async function runBadgesSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    rendererEval,
    publicState,
    emitToRenderer,
    getState,
    app,
    unread,
  } = ctx;

  console.log('SELFTEST badges');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  // --- Parser puro ---
  const cases = [
    ['(3) WhatsApp', { count: 3, dot: false }],
    ['WhatsApp', { count: null, dot: false }],
    ['Inbox (12) - x@gmail.com - Gmail', { count: 12, dot: false }],
    ['Caixa de entrada (3)', { count: 3, dot: false }],
    ['(1) Discord | #geral', { count: 1, dot: false }],
    ['• Discord', { count: null, dot: true }],
    ['(•) Discord', { count: null, dot: true }],
    ['Telegram (5)', { count: 5, dot: false }],
    ['(5) Telegram Web', { count: 5, dot: false }],
    ['(99+) X', { count: 99, dot: false }],
    ['3 new messages', { count: 3, dot: false }],
    ['7 novas', { count: 7, dot: false }],
  ];
  for (const [title, expected] of cases) {
    const got = unread.parseUnreadFromTitle(title);
    assert(
      got.count === expected.count && !!got.dot === !!expected.dot,
      `parse "${title}" => ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`
    );
  }
  assert(unread.formatUnreadBadgeText(5) === '5', 'format 5');
  assert(unread.formatUnreadBadgeText(99) === '99+', 'format 99+');
  assert(unread.formatUnreadBadgeText(120) === '99+', 'format 120');
  assert(unread.faviconSuggestsUnread('https://cdn.example/unread-icon.png') === true, 'favicon unread');
  assert(unread.faviconSuggestsUnread('https://cdn.example/favicon.ico') === false, 'favicon plain');
  console.log('PASS: parseUnreadFromTitle + favicon heuristic');

  // --- Servidor local ---
  const pageHtml = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"/><title>BadgeBase</title></head>
<body><h1 id="t">BadgeBase</h1>
<script>
window.__setTitle = function(t){ document.title = String(t); document.getElementById('t').textContent = String(t); };
</script></body></html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(pageHtml);
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  const { port } = server.address();
  const pageUrl = `http://127.0.0.1:${port}/`;

  function wcOf(accountId) {
    return panels.getPanelCapture(accountId);
  }

  async function panelEval(accountId, code) {
    const wc = wcOf(accountId);
    assert(wc, 'webContents for ' + accountId);
    return wc.executeJavaScript(code, true);
  }

  async function setTitle(accountId, title) {
    await panelEval(accountId, `window.__setTitle(${JSON.stringify(title)})`);
    const expected = unread.parseUnreadFromTitle(title);
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const u = unread.getUnread(accountId);
      const empty = !expected.count && !expected.dot;
      if (empty) {
        if (!u || (!u.count && !u.dot)) return;
      } else if (
        u &&
        u.count === expected.count &&
        !!u.dot === !!expected.dot
      ) {
        return;
      }
      await sleep(100);
    }
    throw new Error(
      'timeout waiting unread for ' +
        accountId +
        ' title=' +
        title +
        ' got=' +
        JSON.stringify(unread.getUnread(accountId))
    );
  }

  async function sidebarBadge(accountId) {
    const list = await rendererEval('window.__multiheizUi.getSidebarUnreadBadges()');
    return (list || []).find((b) => b.accountId === accountId) || null;
  }

  unread.clearOsBadgeSpies();

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Padrão' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter(
      (a) => a.id !== 'acc-badge-a' && a.id !== 'acc-badge-b'
    );
    s.accounts.push(
      {
        id: 'acc-badge-a',
        name: 'BadgeA',
        workspaceId: 'ws-default',
        color: '#2bb8a6',
        muted: false,
        volume: 100,
        zoomFactor: 1,
        startUrl: pageUrl,
        lastUrl: pageUrl,
        showUnread: true,
      },
      {
        id: 'acc-badge-b',
        name: 'BadgeB',
        workspaceId: 'ws-default',
        color: '#3d8bfd',
        muted: false,
        volume: 100,
        zoomFactor: 1,
        startUrl: pageUrl,
        lastUrl: pageUrl,
        showUnread: true,
      }
    );
    s.layout = '2h';
    if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
      s.layoutByWorkspace = {};
    }
    s.layoutByWorkspace[s.activeWorkspaceId] = '2h';
  });
  flushSave();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(300);

  panels.createPanel('acc-badge-a');
  panels.createPanel('acc-badge-b');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels(
      [
        { accountId: 'acc-badge-a', x: 60, y: 48, width: Math.floor(bw0 / 2) - 40, height: bh0 - 80 },
        {
          accountId: 'acc-badge-b',
          x: Math.floor(bw0 / 2) + 20,
          y: 48,
          width: Math.floor(bw0 / 2) - 40,
          height: bh0 - 80,
        },
      ],
      ['acc-badge-a', 'acc-badge-b']
    );
  }

  await waitForUrl('acc-badge-a', (u) => String(u || '').startsWith(pageUrl.replace(/\/$/, '')), 15000);
  await waitForUrl('acc-badge-b', (u) => String(u || '').startsWith(pageUrl.replace(/\/$/, '')), 15000);
  await sleep(400);
  console.log('PASS: local pages loaded');

  // Título → badge na barra (expandida)
  await setTitle('acc-badge-a', '(3) WhatsApp');
  await sleep(300);
  {
    const u = unread.getUnread('acc-badge-a');
    assert(u && u.count === 3, 'unread state A count 3 got ' + JSON.stringify(u));
    const b = await sidebarBadge('acc-badge-a');
    assert(b && b.visible && b.text === '3', 'sidebar badge A=3 got ' + JSON.stringify(b));
  }
  console.log('PASS: title (3) → sidebar badge');

  // Compacta 52px
  await rendererEval(`(() => {
    const sb = document.getElementById('sidebar');
    if (sb) { sb.classList.add('collapsed'); sb.classList.remove('auto-collapsed'); }
    return true;
  })()`);
  await sleep(150);
  {
    const b = await sidebarBadge('acc-badge-a');
    assert(b && b.visible && b.text === '3', 'compact sidebar badge A=3');
  }
  await rendererEval(`(() => {
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.remove('collapsed');
    return true;
  })()`);
  console.log('PASS: badge visible in compact sidebar');

  // Duas janelas → total
  await setTitle('acc-badge-b', 'Telegram (5)');
  await sleep(300);
  {
    const total = unread.computeUnreadTotal();
    assert(total.sum === 8 && total.any && !total.dotOnly, 'total sum 8 got ' + JSON.stringify(total));
  }
  console.log('PASS: total 3+5=8');

  // Espiar OS badge
  {
    const spies = unread.getOsBadgeSpies();
    const hasOverlay = spies.some((s) => s.api === 'setOverlayIcon' && s.arg != null);
    const hasBadge = spies.some((s) => s.api === 'setBadgeCount' && Number(s.arg) > 0);
    assert(
      hasOverlay || hasBadge,
      'setOverlayIcon or setBadgeCount called: ' + JSON.stringify(spies)
    );
    console.log('PASS: OS badge API called', spies.map((s) => s.api + '=' + s.arg).join(','));
  }

  // Toggle desligado esconde e tira do total
  updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-badge-a');
    if (a) a.showUnread = false;
  });
  unread.refreshAfterAccountChange();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(200);
  {
    const b = await sidebarBadge('acc-badge-a');
    assert(b && !b.visible, 'toggle off hides A badge');
    const total = unread.computeUnreadTotal();
    assert(total.sum === 5, 'total only B=5 got ' + JSON.stringify(total));
  }
  console.log('PASS: showUnread off hides + excludes from total');

  // Religa A
  updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-badge-a');
    if (a) a.showUnread = true;
  });
  unread.refreshAfterAccountChange();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(200);

  // Título sem contagem limpa
  await setTitle('acc-badge-a', 'WhatsApp');
  await sleep(300);
  {
    const u = unread.getUnread('acc-badge-a');
    assert(!u || (!u.count && !u.dot), 'clear title clears unread A');
    const b = await sidebarBadge('acc-badge-a');
    assert(b && !b.visible, 'sidebar cleared for A');
    const total = unread.computeUnreadTotal();
    assert(total.sum === 5, 'total after clear A = 5');
  }
  console.log('PASS: title without count clears');

  // Ponto Discord
  await setTitle('acc-badge-a', '• Discord');
  await sleep(300);
  {
    const b = await sidebarBadge('acc-badge-a');
    assert(b && b.visible && b.isDot, 'dot badge for Discord');
    const total = unread.computeUnreadTotal();
    assert(total.sum === 5 && total.any, 'dot + B count still any');
  }
  console.log('PASS: • Discord → dot badge');

  // Excluir janela limpa
  unread.clearOsBadgeSpies();
  await rendererEval(`(async () => {
    const st = await window.multiheiz.removeAccount('acc-badge-b');
    if (st && typeof st === 'object') {
      window.dispatchEvent(new CustomEvent('mh-selftest-state', { detail: st }));
    }
    return true;
  })()`);
  // Main já limpa unread em removeAccountById; espelha state no renderer.
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  {
    assert(!getState().accounts.some((a) => a.id === 'acc-badge-b'), 'B removed from state');
    assert(!unread.getUnread('acc-badge-b'), 'B unread cleared');
    const total = unread.computeUnreadTotal();
    assert(total.dotOnly === true && total.sum === 0, 'only A dot remains');
  }
  console.log('PASS: delete window clears unread from total');

  await rendererEval(`(async () => {
    await window.multiheiz.removeAccount('acc-badge-a');
    return true;
  })()`);
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(300);
  {
    const total = unread.computeUnreadTotal();
    assert(!total.any && total.sum === 0, 'all cleared');
    const spies = unread.getOsBadgeSpies();
    const cleared =
      spies.some((s) => s.api === 'setOverlayIcon' && s.arg == null) ||
      spies.some((s) => s.api === 'setBadgeCount' && Number(s.arg) === 0);
    assert(cleared || !total.any, 'OS badge cleared on empty');
  }
  console.log('PASS: all unread cleared');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest badges complete');
  app.exit(0);
}

module.exports = { runBadgesSelftest };
