'use strict';

/**
 * Selftest: site personalizado — foco na URL, teclas não vão à busca, URL validada.
 * MULTIHEIZ_SELFTEST=custom-site (host-resolver: exemplo.test → 127.0.0.1)
 */

const http = require('node:http');
const { validateAndNormalizeStartUrl } = require('./url-policy');

/**
 * @param {object} ctx
 */
async function runCustomSiteSelftest(ctx) {
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
    app,
  } = ctx;

  console.log('SELFTEST custom-site');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  // --- Validação pura (espelha o formulário) ---
  {
    const ok1 = validateAndNormalizeStartUrl('exemplo.test/abc');
    assert(ok1.ok && ok1.url === 'https://exemplo.test/abc', 'exemplo.test/abc normaliza');
    const ok2 = validateAndNormalizeStartUrl('www.exemplo.com/x');
    assert(ok2.ok && ok2.url === 'https://www.exemplo.com/x', 'www.exemplo.com/x');
    const ok3 = validateAndNormalizeStartUrl('https://exemplo.com/path');
    assert(ok3.ok && ok3.url === 'https://exemplo.com/path', 'https explícito');
    const ok4 = validateAndNormalizeStartUrl('http://127.0.0.1:9/');
    assert(ok4.ok, 'localhost/IP http');
    for (const bad of ['www', 'https://www', 'a b', '', '   ']) {
      const r = validateAndNormalizeStartUrl(bad);
      assert(!r.ok && r.error === 'Endereço inválido', 'rejeita: ' + JSON.stringify(bad));
    }
    console.log('PASS: validateAndNormalizeStartUrl');
  }

  const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>custom-site-ok</title></head>
<body>custom-site-probe</body></html>`;

  let server = null;
  let port = 0;
  await new Promise((resolve, reject) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
    server.on('error', reject);
  });

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Padrão' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = [];
    s.layout = '1';
    s.page = 0;
  });
  flushSave();
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(300);

  async function typeIntoFocused(text) {
    const wc = mainWindow.webContents;
    for (const ch of String(text)) {
      // char a char via sendInputEvent (sem Oem_* — inválido no Electron Windows)
      if (/^[a-zA-Z0-9]$/.test(ch)) {
        const keyCode = ch.toUpperCase();
        wc.sendInputEvent({ type: 'keyDown', keyCode });
        wc.sendInputEvent({ type: 'char', keyCode: ch });
        wc.sendInputEvent({ type: 'keyUp', keyCode });
      } else {
        wc.sendInputEvent({ type: 'char', keyCode: ch });
      }
      await sleep(16);
    }
  }

  // Abrir seletor → Site personalizado
  await rendererEval('window.__multiheizUi.openCatalogPicker()');
  await sleep(300);
  assert((await rendererEval('window.__multiheizUi.isCatalogOpen()')) === true, 'catalog open');
  await rendererEval('window.__multiheizUi.pickCatalogById("custom")');
  await sleep(400);
  assert(
    (await rendererEval('window.__multiheizUi.isAccountDialogOpen()')) === true,
    'account dialog open'
  );
  assert(
    (await rendererEval('window.__multiheizUi.isCatalogOpen()')) === false,
    'catalog closed after custom'
  );

  const active = await rendererEval('window.__multiheizUi.getActiveElementInfo()');
  assert(
    active && (active.name === 'startUrl' || active.id === 'account-start-url'),
    'foco no campo URL: ' + JSON.stringify(active)
  );
  console.log('PASS: foco no campo URL');

  // Digitar exemplo.test:PORT/abc caractere a caractere
  const typed = `exemplo.test:${port}/abc`;
  await typeIntoFocused(typed);
  await sleep(80);

  const fieldVal = await rendererEval('window.__multiheizUi.getAccountStartUrlValue()');
  assert(
    String(fieldVal) === typed || String(fieldVal).includes(`exemplo.test:${port}`),
    'campo tem URL digitada: ' + fieldVal
  );
  const searchVal = await rendererEval('window.__multiheizUi.getCatalogSearchValue()');
  assert(String(searchVal) === '', 'busca do seletor permanece vazia, got: ' + JSON.stringify(searchVal));
  console.log('PASS: digitação no URL; busca vazia');

  // Nome mínimo para o form (sem roubar o valor da URL já digitada)
  await rendererEval(`(() => {
    const f = document.getElementById('form-account');
    if (f && f.name) f.name.value = 'Site Teste';
    return true;
  })()`);

  const beforeCount = (publicState().accounts || []).length;
  await rendererEval('window.__multiheizUi.submitAccountForm()');
  await sleep(800);

  let st = publicState();
  assert((st.accounts || []).length === beforeCount + 1, 'janela criada');
  const acc = st.accounts[st.accounts.length - 1];
  assert(acc, 'account exists');
  assert(
    /exemplo\.test/i.test(acc.startUrl) && String(acc.startUrl).includes(String(port)) && /\/abc/.test(acc.startUrl),
    'URL completa salva: ' + acc.startUrl
  );
  console.log('PASS: URL completa salva', acc.startUrl);

  // Garante painel e navegação
  if (!panels.isPanelActive(acc.id)) {
    panels.createPanel(acc.id);
  }
  {
    const [bw, bh] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: acc.id, x: 0, y: 80, width: Math.max(400, bw - 40), height: Math.max(300, bh - 100) },
    ]);
  }
  await waitForUrl(
    acc.id,
    (u) => /exemplo\.test/i.test(u) && String(u).includes('/abc'),
    20000
  );
  const wc = panels.getPanelCapture(acc.id);
  assert(wc, 'panel webContents');
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('did-finish-load timeout')), 20000);
    const done = () => {
      clearTimeout(t);
      resolve();
    };
    try {
      if (!wc.isLoading()) {
        done();
        return;
      }
    } catch {
      /* fall through */
    }
    wc.once('did-finish-load', done);
  });
  const title = await wc.executeJavaScript('document.title', true);
  assert(String(title).includes('custom-site-ok'), 'página local carregou: ' + title);
  console.log('PASS: navegou e did-finish-load');

  // Entradas inválidas: erro e não cria janela
  async function expectInvalid(raw) {
    await rendererEval('window.__multiheizUi.openCatalogPicker()');
    await sleep(200);
    await rendererEval('window.__multiheizUi.pickCatalogById("custom")');
    await sleep(300);
    await rendererEval(`(() => {
      const f = document.getElementById('form-account');
      if (f && f.name) f.name.value = 'X';
      if (f && f.startUrl) f.startUrl.value = ${JSON.stringify(raw)};
      return true;
    })()`);
    const n0 = (publicState().accounts || []).length;
    await rendererEval('window.__multiheizUi.submitAccountForm()');
    await sleep(250);
    const err = await rendererEval('window.__multiheizUi.getAccountUrlErrorVisible()');
    assert(err === true, 'erro visível para ' + JSON.stringify(raw));
    assert((publicState().accounts || []).length === n0, 'não criou janela para ' + JSON.stringify(raw));
    await rendererEval('window.__multiheizUi.closeAccountDialog()');
    await sleep(100);
  }

  await expectInvalid('www');
  await expectInvalid('https://www');
  await expectInvalid('a b');
  console.log('PASS: entradas inválidas mostram erro e não criam janela');

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest custom-site complete');
  app.exit(0);
}

module.exports = { runCustomSiteSelftest };
