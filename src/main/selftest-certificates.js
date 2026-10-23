'use strict';

/**
 * In-process certificates selftest (MULTIHEIZ_SELFTEST=certificates).
 */

/**
 * @param {object} ctx
 */
async function runCertificatesSelftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    sleep,
    rendererEval,
    certificates,
    app,
  } = ctx;

  console.log('SELFTEST certificates');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const localUrl = process.env.MULTIHEIZ_CERT_LOCAL_URL || '';
  const publicUrl = process.env.MULTIHEIZ_CERT_PUBLIC_URL || '';
  assert(localUrl.includes('127.0.0.1'), 'MULTIHEIZ_CERT_LOCAL_URL');
  assert(publicUrl.includes('mh-public.example.com'), 'MULTIHEIZ_CERT_PUBLIC_URL');

  assert(certificates.isPrivateOrLocalHost('127.0.0.1'), '127 private');
  assert(certificates.isPrivateOrLocalHost('localhost'), 'localhost private');
  assert(certificates.isPrivateOrLocalHost('192.168.1.1'), '192.168 private');
  assert(certificates.isPrivateOrLocalHost('10.0.0.2'), '10 private');
  assert(certificates.isPrivateOrLocalHost('172.16.5.1'), '172.16 private');
  assert(!certificates.isPrivateOrLocalHost('mh-public.example.com'), 'public name not private');
  assert(!certificates.isPrivateOrLocalHost('8.8.8.8'), '8.8.8.8 not private');
  console.log('PASS: isPrivateOrLocalHost');

  certificates.clearSessionAllowancesForTest();
  certificates.clearHostCertCacheForTest();
  certificates.clearClientCertChoices();

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-cert');
    s.accounts.push({
      id: 'acc-cert',
      name: 'Cert',
      workspaceId: 'ws-default',
      color: '#4a9',
      muted: false,
      zoomFactor: 1,
      startUrl: 'about:blank',
      lastUrl: '',
    });
    s.layout = '1';
    if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
      s.layoutByWorkspace = {};
    }
    s.layoutByWorkspace[s.activeWorkspaceId] = '1';
    s.clientCertChoices = {};
  });
  flushSave();

  panels.createPanel('acc-cert');
  await sleep(500);

  async function panelEval(accountId, code) {
    const wc = panels.getPanelCapture(accountId);
    if (!wc || wc.isDestroyed()) return null;
    return wc.executeJavaScript(code, true);
  }

  // --- Local self-signed: error page + continue allowed ---
  panels.panelNavigate('acc-cert', localUrl);
  await sleep(2000);

  let errPeek = null;
  for (let i = 0; i < 24; i++) {
    errPeek = certificates.selftestPeekCertError('acc-cert');
    if (errPeek) break;
    const page = await panelEval('acc-cert', 'window.__mhCertError || null');
    if (page && page.requestId) {
      errPeek = {
        requestId: page.requestId,
        allowContinue: !!page.allowContinue,
        reason: page.reason,
        error: page.reason,
        host: page.host,
      };
      break;
    }
    await sleep(250);
  }
  assert(errPeek, 'cert error pending for 127.0.0.1');
  assert(errPeek.allowContinue, 'continue allowed for 127.0.0.1');
  assert(errPeek.reason || errPeek.error, 'has reason');
  console.log('PASS: local cert error page (continue allowed)');

  const rid = errPeek.requestId;
  const r1 = certificates.respondCertError(rid, 'continue');
  assert(r1 && r1.ok && r1.trust, 'continue trusts local');
  await sleep(2000);

  const localOk = await panelEval(
    'acc-cert',
    `(function(){ return document.body && /cert-local-ok/.test(document.body.innerText||''); })()`
  );
  assert(localOk, 'local page loaded after continue');
  console.log('PASS: local continue loads page');

  // --- Public-looking host: no continue ---
  certificates.clearSessionAllowancesForTest();
  panels.panelNavigate('acc-cert', publicUrl);
  await sleep(2000);

  let pubPeek = null;
  for (let i = 0; i < 24; i++) {
    pubPeek = certificates.selftestPeekCertError('acc-cert');
    if (pubPeek) break;
    const page = await panelEval('acc-cert', 'window.__mhCertError || null');
    if (page && page.host) {
      pubPeek = {
        requestId: page.requestId,
        allowContinue: !!page.allowContinue,
        host: page.host,
      };
      break;
    }
    await sleep(250);
  }
  assert(pubPeek, 'cert error for public host');
  assert(!pubPeek.allowContinue, 'no continue for mh-public.example.com');
  const hasContinueBtn = await panelEval(
    'acc-cert',
    `!!document.querySelector('[data-role="cert-continue"]')`
  );
  assert(!hasContinueBtn, 'no continue button in DOM');
  console.log('PASS: public host no continue');

  if (pubPeek.requestId) {
    certificates.respondCertError(pubPeek.requestId, 'cancel');
  }

  // --- Client cert picker (synthetic) + remember + forget ---
  const webContents = panels.getPanelCapture('acc-cert');
  assert(webContents, 'webContents for client cert');

  let pickCount = 0;
  certificates.setSelftestClientCertHook(({ list }) => {
    pickCount += 1;
    assert(list && list.length >= 2, 'fake cert list');
    return { action: 'use', fingerprint: list[0].fingerprint, remember: true, index: 0 };
  });

  const origin = 'https://certs.example.local';
  const p1 = await certificates.selftestEmitClientCertPicker(webContents, origin + '/a', [
    { subject: 'e-CPF Teste', issuer: 'AC Test', fingerprint: 'FP-A' },
    { subject: 'e-CNPJ Teste', issuer: 'AC Test', fingerprint: 'FP-B' },
  ]);
  assert(p1 && p1.fingerprint === 'FP-A', 'first pick FP-A');
  assert(pickCount === 1, 'hook called once');

  const choices = certificates.getClientCertChoices();
  assert(choices[origin] === 'FP-A', 'remembered FP-A');

  // Second request: remembered → no hook (auto)
  certificates.setSelftestClientCertHook(() => {
    pickCount += 1;
    return { action: 'cancel' };
  });
  const p2 = await certificates.selftestEmitClientCertPicker(webContents, origin + '/b', [
    { subject: 'e-CPF Teste', issuer: 'AC Test', fingerprint: 'FP-A' },
    { subject: 'e-CNPJ Teste', issuer: 'AC Test', fingerprint: 'FP-B' },
  ]);
  assert(p2 && p2.fingerprint === 'FP-A', 'auto-selected remembered');
  assert(pickCount === 1, 'hook not called for remembered');
  console.log('PASS: client cert remember + auto-select');

  const forget = certificates.clearClientCertChoices();
  assert(forget && forget.cleared >= 1, 'forget remembered');
  assert(Object.keys(certificates.getClientCertChoices()).length === 0, 'choices empty');
  console.log('PASS: forget remembered certs');

  certificates.setSelftestClientCertHook(null);

  // Site info API
  const info = certificates.getSiteSecurityInfo('acc-cert', 'http://127.0.0.1/');
  assert(info && info.http && !info.secure, 'http not secure');
  assert(/não segura/i.test(info.label), 'label não segura');

  void app;
  void rendererEval;
  console.log('PASS: selftest:certificates complete');
  if (typeof app.exit === 'function') app.exit(0);
  else process.exit(0);
}

module.exports = { runCertificatesSelftest };
