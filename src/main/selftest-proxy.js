'use strict';

/**
 * In-process proxy selftest (MULTIHEIZ_SELFTEST=proxy).
 * Usa eco + proxy HTTP locais (portas via env).
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * @param {object} ctx
 */
async function runProxySelftest(ctx) {
  const {
    panels,
    getState,
    updateState,
    flushSave,
    sleep,
    publicState,
  } = ctx;

  const proxy = require('./proxy');

  console.log('SELFTEST proxy');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const echoUrl = process.env.MULTIHEIZ_PROXY_TEST_URL || '';
  const proxyHost = process.env.MULTIHEIZ_PROXY_HOST || '127.0.0.1';
  const proxyPort = Number(process.env.MULTIHEIZ_PROXY_PORT || 0);
  const proxyUser = process.env.MULTIHEIZ_PROXY_USER || 'mhuser';
  const proxyPass = process.env.MULTIHEIZ_PROXY_PASS || 'mhpass';
  const hitsBefore = Number(process.env.MULTIHEIZ_PROXY_HITS || '0');

  assert(echoUrl && proxyPort, 'env MULTIHEIZ_PROXY_TEST_URL / PORT required');

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-px-a' && a.id !== 'acc-px-b');
    s.accounts.push(
      {
        id: 'acc-px-a',
        name: 'ProxyA',
        workspaceId: 'ws-default',
        color: '#4a9',
        muted: false,
        zoomFactor: 1,
        startUrl: 'about:blank',
        lastUrl: '',
      },
      {
        id: 'acc-px-b',
        name: 'DirectB',
        workspaceId: 'ws-default',
        color: '#a94',
        muted: false,
        zoomFactor: 1,
        startUrl: 'about:blank',
        lastUrl: '',
      }
    );
    s.layout = '2';
    if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
      s.layoutByWorkspace = {};
    }
    s.layoutByWorkspace[s.activeWorkspaceId] = '2';
  });
  flushSave();

  // Janela A: proxy HTTP com auth + <-loopback> para forçar localhost pelo proxy
  const setA = await proxy.setProxyForAccount('acc-px-a', {
    type: 'http',
    host: proxyHost,
    port: proxyPort,
    username: proxyUser,
    password: proxyPass,
    bypass: '<-loopback>',
  });
  assert(setA.ok, 'set proxy A: ' + (setA.error || ''));
  console.log('PASS: proxy set on window A');

  // Senha não aparece em claro no estado público
  const pub = publicState();
  const accAPub = (pub.accounts || []).find((a) => a.id === 'acc-px-a');
  assert(accAPub && accAPub.proxy && accAPub.proxy.passwordSaved === true, 'passwordSaved public');
  assert(!accAPub.proxy.passwordEnc, 'no passwordEnc in publicState');
  assert(!accAPub.proxy.password, 'no password in publicState');
  const raw = JSON.stringify(pub);
  assert(!raw.includes(proxyPass), 'publicState must not contain plaintext password');
  console.log('PASS: password not exposed in publicState');

  // Arquivo de estado: ciphertext ok, plaintext não
  flushSave();
  const stateFile = path.join(app.getPath('userData'), 'multiheiz-state.json');
  const disk = fs.readFileSync(stateFile, 'utf8');
  assert(!disk.includes(proxyPass), 'state file must not contain plaintext password');
  const diskObj = JSON.parse(disk);
  const diskA = (diskObj.accounts || []).find((a) => a.id === 'acc-px-a');
  assert(diskA && diskA.proxy && diskA.proxy.passwordEnc, 'passwordEnc on disk');
  console.log('PASS: password encrypted on disk');

  // sanitize / export
  const diagnostics = require('./diagnostics');
  const sanitized = diagnostics.sanitizeState(getState());
  const sanA = (sanitized.accounts || []).find((a) => a.id === 'acc-px-a');
  assert(!sanA.proxy || !sanA.proxy.passwordEnc, 'sanitize strips passwordEnc');
  assert(!JSON.stringify(sanitized).includes(proxyPass), 'sanitize no plaintext');
  console.log('PASS: diagnostics sanitize strips proxy secrets');

  panels.createPanel('acc-px-a');
  panels.createPanel('acc-px-b');
  await sleep(800);

  // Teste via eco local (A pelo proxy)
  const testA = await proxy.testProxyForAccount('acc-px-a');
  assert(testA.ok, 'test A ok: ' + (testA.error || ''));
  assert(
    /proxy-ok|via-proxy/i.test(String(testA.body || testA.ip || '')),
    'echo marker via proxy: ' + (testA.body || testA.ip)
  );
  console.log('PASS: window A reaches echo via proxy', testA.ip || testA.body);

  // Contador do proxy deve ter subido (lido do arquivo de hits do harness)
  const hitsFile = process.env.MULTIHEIZ_PROXY_HITS_FILE;
  assert(hitsFile, 'HITS_FILE env');
  await sleep(200);
  const hitsAfterA = Number(fs.readFileSync(hitsFile, 'utf8') || '0');
  assert(hitsAfterA > hitsBefore, `proxy hits increased (${hitsBefore} -> ${hitsAfterA})`);
  console.log('PASS: proxy hit counter increased', hitsAfterA);

  // Janela B: direto — não deve incrementar hits do proxy (ou pouco)
  const hitsMid = hitsAfterA;
  const testB = await proxy.testProxyForAccount('acc-px-b');
  assert(testB.ok, 'test B ok: ' + (testB.error || ''));
  assert(
    /direct-ok|no-proxy/i.test(String(testB.body || testB.ip || '')),
    'echo marker direct: ' + (testB.body || testB.ip)
  );
  await sleep(200);
  const hitsAfterB = Number(fs.readFileSync(hitsFile, 'utf8') || '0');
  assert(hitsAfterB === hitsMid, `direct B must not hit proxy (${hitsMid} vs ${hitsAfterB})`);
  console.log('PASS: window B direct does not hit proxy');

  // Auth errada: falha limpa
  const setBad = await proxy.setProxyForAccount('acc-px-a', {
    type: 'http',
    host: proxyHost,
    port: proxyPort,
    username: proxyUser,
    password: 'senha-errada-xyz',
    bypass: '<-loopback>',
  });
  assert(setBad.ok, 'set bad password config');
  const testBad = await proxy.testProxyForAccount('acc-px-a');
  assert(!testBad.ok, 'bad auth must fail test');
  console.log('PASS: bad proxy auth fails cleanly', testBad.error);

  // Auth correta de novo
  const setGood = await proxy.setProxyForAccount('acc-px-a', {
    type: 'http',
    host: proxyHost,
    port: proxyPort,
    username: proxyUser,
    password: proxyPass,
    bypass: '<-loopback>',
  });
  assert(setGood.ok, 'restore good auth');
  const testGood = await proxy.testProxyForAccount('acc-px-a');
  assert(testGood.ok, 'good auth works again: ' + (testGood.error || ''));
  console.log('PASS: correct proxy auth works');

  // Remover → direto
  const rem = await proxy.removeProxyForAccount('acc-px-a');
  assert(rem.ok, 'remove proxy');
  const afterRem = (getState().accounts || []).find((a) => a.id === 'acc-px-a');
  assert(!afterRem.proxy || afterRem.proxy.type === 'none', 'stored type none');
  const testRem = await proxy.testProxyForAccount('acc-px-a');
  assert(testRem.ok, 'after remove still reaches echo');
  assert(
    /direct-ok|no-proxy/i.test(String(testRem.body || testRem.ip || '')),
    'after remove is direct'
  );
  console.log('PASS: remove proxy returns to direct');

  // validate rejects
  const badHost = proxy.validateProxyInput({ type: 'http', host: 'http://x', port: 80 });
  assert(!badHost.ok, 'reject host with scheme');
  const badPort = proxy.validateProxyInput({ type: 'http', host: '127.0.0.1', port: 99999 });
  assert(!badPort.ok, 'reject bad port');
  console.log('PASS: validation rejects bad host/port');

  console.log('PASS: selftest proxy complete');
  app.exit(0);
}

module.exports = { runProxySelftest };
