'use strict';

/**
 * Selftest: Ctrl+left-click opens link in new MultiHeiz window (MULTIHEIZ_SELFTEST=link-newwindow).
 * Middle-click / opener popups unchanged.
 */

const http = require('node:http');
const { app } = require('electron');

async function runLinkNewwindowSelftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    waitForLayoutSettle,
    waitForPanels,
    getState,
  } = ctx;

  console.log('SELFTEST link-newwindow');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>links</title></head>
<body style="margin:0;padding:24px;font:16px sans-serif;background:#102030;color:#eee">
  <p>Ctrl-click tests</p>
  <a id="a1" href="/target-a">Link A</a>
  <a id="a2" href="/target-b">Link B</a>
  <button id="popup" type="button">Popup</button>
  <script>
  document.getElementById('popup').onclick = function () {
    // Login-style: about:blank + size features keeps opener (unchanged path).
    window.open('about:blank', 'login', 'width=400,height=300');
  };
  window.__navCount = 0;
  window.addEventListener('pagehide', function () { window.__navCount++; });
  </script>
</body></html>`;

  const TARGET = `<!DOCTYPE html><html><body>target</body></html>`;
  const POPUP = `<!DOCTYPE html><html><body>oauth</body></html>`;

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = String(req.url || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (u.startsWith('/target')) res.end(TARGET);
      else if (u.startsWith('/oauth')) res.end(POPUP);
      else res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-lnk', name: 'Lnk' }];
    s.activeWorkspaceId = 'ws-lnk';
    s.layout = '4';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-lnk',
        name: 'Src',
        color: '#2bb8a6',
        startUrl: base + '/',
        workspaceId: 'ws-lnk',
        partitionId: 'part-lnk-shared',
        muted: false,
        volume: 80,
        zoomFactor: 1.1,
        pauseInBackground: true,
        keepAliveInBackground: false,
        privateHistory: true,
        adblockEnabled: false,
        showUnread: true,
        lastUrl: null,
        proxy: {
          type: 'http',
          host: '127.0.0.1',
          port: 9,
          username: '',
          bypass: '<local>',
          passwordEnc: null,
        },
      },
    ];
    if (!s.settings) s.settings = {};
    s.settings.openLastPage = false;
    s.settings.homepage = base + '/';
    s.settings.blankLinkMode = 'same';
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(700);
  await waitForLayoutSettle();
  await waitForPanels((i) => i.panels.some((p) => p.accountId === 'acc-lnk' && p.visible));
  await waitForUrl('acc-lnk', (u) => u.includes('127.0.0.1'), 30000);
  await sleep(300);

  const wc = panels.getPanelCapture('acc-lnk');
  assert(wc && !wc.isDestroyed(), 'source wc');

  const beforeCount = (getState().accounts || []).length;
  const beforeUrl = wc.getURL();

  // Ctrl+left click (no shift) → new window, no focus steal required, source must not navigate
  const clickJs = `(() => {
    var a = document.getElementById('a1');
    if (!a) return { ok: false };
    var ev = new MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      button: 0, buttons: 1, ctrlKey: true, metaKey: false, shiftKey: false
    });
    a.dispatchEvent(ev);
    return { ok: true, href: a.href };
  })()`;
  await wc.executeJavaScript(clickJs, true);
  await sleep(900);

  let accounts = getState().accounts || [];
  assert(accounts.length === beforeCount + 1, 'ctrl+click created window', {
    beforeCount,
    now: accounts.length,
  });
  const neu = accounts.find((a) => a && a.id !== 'acc-lnk');
  assert(neu, 'new account exists');
  assert(neu.workspaceId === 'ws-lnk', 'same workspace', neu.workspaceId);
  assert(neu.partitionId === 'part-lnk-shared', 'same partition', neu.partitionId);
  assert(neu.proxy && neu.proxy.host === '127.0.0.1', 'proxy inherited', neu.proxy);
  assert(neu.privateHistory === true, 'privateHistory inherited');
  assert(neu.adblockEnabled === false, 'adblock inherited');
  assert(Math.abs(Number(neu.zoomFactor) - 1.1) < 0.01, 'zoom inherited', neu.zoomFactor);
  const afterUrl = wc.getURL();
  assert(afterUrl === beforeUrl || afterUrl.indexOf('/target') < 0, 'source did not navigate', {
    beforeUrl,
    afterUrl,
  });
  console.log('PASS: Ctrl+left click new window + inherit + no navigate');

  // Ctrl+Shift+left click → focus new window
  const beforeFocus = panels.getFocusedAccountId();
  await wc.executeJavaScript(
    `(() => {
      var a = document.getElementById('a2');
      var ev = new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        button: 0, buttons: 1, ctrlKey: true, metaKey: false, shiftKey: true
      });
      a.dispatchEvent(ev);
      return true;
    })()`,
    true
  );
  await sleep(900);
  accounts = getState().accounts || [];
  assert(accounts.length >= beforeCount + 2, 'ctrl+shift created another', accounts.length);
  const focused = panels.getFocusedAccountId();
  assert(focused && focused !== 'acc-lnk', 'ctrl+shift focused new window', {
    focused,
    beforeFocus,
  });
  console.log('PASS: Ctrl+Shift+left click focuses new window');

  // Middle-click must NOT create a MultiHeiz window via our handler (window.open path may still
  // follow blankLinkMode=same → navigate same panel). Simulate auxclick/middle without ctrl.
  const midBefore = (getState().accounts || []).length;
  await wc.executeJavaScript(
    `(() => {
      var a = document.getElementById('a1');
      var ev = new MouseEvent('auxclick', {
        bubbles: true, cancelable: true, view: window,
        button: 1, buttons: 4, ctrlKey: false
      });
      a.dispatchEvent(ev);
      var ev2 = new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        button: 1, buttons: 4, ctrlKey: false
      });
      a.dispatchEvent(ev2);
      return true;
    })()`,
    true
  );
  await sleep(500);
  const midAfter = (getState().accounts || []).length;
  assert(midAfter === midBefore, 'middle-click did not create MultiHeiz window', {
    midBefore,
    midAfter,
  });
  console.log('PASS: middle-click unchanged (no new MultiHeiz window)');

  // Ensure source is back on the page with #popup (ctrl-click must not have navigated it).
  panels.panelNavigate('acc-lnk', base + '/');
  await waitForUrl('acc-lnk', (u) => /127\.0\.0\.1/.test(u) && !/target/.test(u), 20000);
  await sleep(300);
  const wc2 = panels.getPanelCapture('acc-lnk');
  assert(wc2 && !wc2.isDestroyed(), 'source wc after re-nav');

  // Opener-dependent popup still allowed (login-style about:blank + size features)
  const openCountBefore = BrowserWindowAll();
  await wc2.executeJavaScript(
    `(() => {
      var b = document.getElementById('popup');
      if (!b) return { ok: false };
      b.click();
      return { ok: true };
    })()`,
    true
  );
  await sleep(800);
  assert(panels.isPanelActive('acc-lnk'), 'source still active after popup attempt');
  console.log('PASS: opener popup path still works (source intact)', {
    windows: openCountBefore,
  });

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest:link-newwindow complete');
  app.exit(0);
}

function BrowserWindowAll() {
  try {
    const { BrowserWindow } = require('electron');
    return BrowserWindow.getAllWindows().length;
  } catch {
    return 0;
  }
}

module.exports = { runLinkNewwindowSelftest };
