'use strict';

/**
 * Selftest: Editar URL inicial navega quando apropriado.
 * MULTIHEIZ_SELFTEST=edit-start-url
 */

const http = require('node:http');
const { validateAndNormalizeStartUrl } = require('./url-policy');

/**
 * @param {object} ctx
 */
async function runEditStartUrlSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForUrl,
    rendererEval,
    getState,
    app,
  } = ctx;

  console.log('SELFTEST edit-start-url');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  assert(validateAndNormalizeStartUrl('www').ok === false, 'www inválido');
  assert(validateAndNormalizeStartUrl('https://www').ok === false, 'https://www inválido');

  const pages = {
    '/old': '<!DOCTYPE html><html><head><meta charset="utf-8"><title>old-page</title></head><body>OLD</body></html>',
    '/new': '<!DOCTYPE html><html><head><meta charset="utf-8"><title>new-page</title></head><body>NEW</body></html>',
    '/other': '<!DOCTYPE html><html><head><meta charset="utf-8"><title>other-page</title></head><body>OTHER</body></html>',
  };

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = String(req.url || '/').split('?')[0];
      const body = pages[u] || pages['/old'];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });

  const base = `http://127.0.0.1:${port}`;
  const urlOld = `${base}/old`;
  const urlNew = `${base}/new`;
  const urlOther = `${base}/other`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-esu', name: 'ESU' }];
    s.activeWorkspaceId = 'ws-esu';
    s.layout = '1';
    s.page = 0;
    s.accounts = [
      {
        id: 'acc-esu',
        name: 'Janela ESU',
        color: '#2bb8a6',
        startUrl: urlOld,
        workspaceId: 'ws-esu',
        muted: false,
        volume: 100,
        lastUrl: null,
        zoomFactor: 1,
      },
    ];
  });
  flushSave();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(300);

  panels.createPanel('acc-esu');
  {
    const [bw, bh] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      {
        accountId: 'acc-esu',
        x: 0,
        y: 80,
        width: Math.max(400, bw - 40),
        height: Math.max(300, bh - 100),
      },
    ]);
  }

  async function editStartUrl(nextUrl) {
    await rendererEval(`window.__multiheizUi.openAccountDialogFor('acc-esu', { focusUrl: true })`);
    await sleep(250);
    assert(
      (await rendererEval('window.__multiheizUi.isAccountDialogOpen()')) === true,
      'dialog open'
    );
    await rendererEval(`(() => {
      const f = document.getElementById('form-account');
      if (f && f.startUrl) f.startUrl.value = ${JSON.stringify(nextUrl)};
      if (f && f.name) f.name.value = 'Janela ESU';
      return true;
    })()`);
    await rendererEval('window.__multiheizUi.submitAccountForm()');
    await sleep(500);
  }

  async function currentPanelUrl() {
    const wc = panels.getPanelCapture('acc-esu');
    assert(wc, 'wc');
    try {
      return wc.getURL();
    } catch {
      return '';
    }
  }

  // --- 1) painel em about:blank → editar → navega ---
  panels.panelNavigate('acc-esu', 'about:blank');
  await sleep(400);
  {
    const u = await currentPanelUrl();
    assert(/about:blank/i.test(u) || !u, 'pré: about:blank got ' + u);
  }
  await editStartUrl(urlNew);
  await waitForUrl('acc-esu', (u) => String(u).includes('/new'), 20000);
  assert(String((getState().accounts || []).find((a) => a.id === 'acc-esu').startUrl).includes('/new'), 'startUrl /new');
  console.log('PASS: about:blank -> editar -> navega');

  // --- 2) painel na URL antiga → editar → navega ---
  updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-esu');
    if (a) a.startUrl = urlOld;
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  panels.panelNavigate('acc-esu', urlOld);
  await waitForUrl('acc-esu', (u) => String(u).includes('/old'), 20000);
  await sleep(200);
  await editStartUrl(urlNew);
  await waitForUrl('acc-esu', (u) => String(u).includes('/new'), 20000);
  assert(String((getState().accounts || []).find((a) => a.id === 'acc-esu').startUrl).includes('/new'), 'startUrl updated to /new');
  console.log('PASS: URL antiga -> editar -> navega');

  // --- 3) painel em outra página → só salva ---
  panels.panelNavigate('acc-esu', urlOther);
  await waitForUrl('acc-esu', (u) => String(u).includes('/other'), 20000);
  await sleep(200);
  // startUrl ainda /new; usuário edita para /old (diferente da página atual)
  await editStartUrl(urlOld);
  await sleep(600);
  {
    const u = await currentPanelUrl();
    assert(String(u).includes('/other'), 'permanece em /other, got ' + u);
  }
  assert(
    String((getState().accounts || []).find((a) => a.id === 'acc-esu').startUrl).includes('/old'),
    'startUrl salva /old'
  );
  const toast = await rendererEval(`(() => {
    const t = document.getElementById('toast');
    if (!t || t.classList.contains('hidden')) return { visible: false, text: '' };
    return { visible: true, text: t.textContent || '' };
  })()`);
  assert(toast && toast.visible, 'toast visível');
  assert(/URL inicial atualizada/i.test(toast.text), 'toast texto: ' + toast.text);
  assert(/Abrir agora/i.test(toast.text), 'toast tem Abrir agora');
  console.log('PASS: outra página -> só salva + toast');

  // --- 4) persistência após reinício (flush + releitura) ---
  flushSave();
  await sleep(200);
  const persisted = (getState().accounts || []).find((a) => a.id === 'acc-esu');
  assert(persisted && String(persisted.startUrl).includes('/old'), 'persistido startUrl /old');
  // Simula “reinício”: limpa lastUrl e recria painel a partir de startUrl
  updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-esu');
    if (a) {
      a.lastUrl = null;
      a.startUrl = urlOld;
    }
  });
  flushSave();
  panels.panelNavigate('acc-esu', urlOld);
  await waitForUrl('acc-esu', (u) => String(u).includes('/old'), 15000);
  assert(String((await currentPanelUrl())).includes('/old'), 'após “reinício” carrega startUrl');
  console.log('PASS: persistência startUrl');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest edit-start-url complete');
  app.exit(0);
}

module.exports = { runEditStartUrlSelftest };
