'use strict';

/**
 * Selftest DNS over HTTPS (DoH) — MULTIHEIZ_SELFTEST=doh.
 * Phase 1: configureHostResolver spy, IPC set, invalid custom URL, persist for restart.
 * Phase 2: same MULTIHEIZ_USERDATA — DoH settings still applied after restart.
 */

const { app } = require('electron');
const { envGet } = require('./config');

/**
 * @param {object} ctx
 */
async function runDohSelftest(ctx) {
  const {
    getState,
    updateState,
    flushSave,
    publicState,
    sleep,
    doh,
  } = ctx;

  const phase = String(envGet('MULTIHEIZ_SELFTEST_PHASE') || '1');
  console.log('SELFTEST doh phase=' + phase);

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  if (phase === '2') {
    await runPhase2(ctx, assert);
    return;
  }

  // Startup should have applied default off (before this selftest body runs).
  const bootCalls = doh.getSelftestCalls();
  assert(bootCalls.length >= 1, 'expected configureHostResolver on boot');
  const boot = bootCalls[bootCalls.length - 1];
  assert(boot.secureDnsMode === 'off', 'boot mode off: ' + JSON.stringify(boot));
  assert(Array.isArray(boot.secureDnsServers) && boot.secureDnsServers.length === 0, 'boot servers empty');
  console.log('PASS: boot configureHostResolver off');

  doh.clearSelftestCalls();

  // Set Cloudflare secure via setDohSettings
  const setCf = doh.setDohSettings(
    { mode: 'secure', provider: 'cloudflare', customUrl: '' },
    { getState, updateState }
  );
  assert(setCf.ok, 'set cloudflare: ' + (setCf.error || ''));
  assert(setCf.applied && setCf.applied.secureDnsMode === 'secure', 'applied secure');
  assert(
    setCf.applied.secureDnsServers[0] === 'https://cloudflare-dns.com/dns-query',
    'cloudflare server'
  );
  const afterCf = doh.getSelftestCalls();
  assert(afterCf.length === 1, 'one call after cloudflare set');
  assert(
    afterCf[0].secureDnsMode === 'secure' &&
      afterCf[0].secureDnsServers[0] === 'https://cloudflare-dns.com/dns-query',
    'spy cloudflare call'
  );
  const st1 = publicState();
  assert(st1.settings.doh.mode === 'secure', 'state mode secure');
  assert(st1.settings.doh.provider === 'cloudflare', 'state provider cloudflare');
  console.log('PASS: secure + Cloudflare via setDohSettings');

  doh.clearSelftestCalls();

  // Automatic + Google
  const setGo = doh.setDohSettings(
    { mode: 'automatic', provider: 'google' },
    { getState, updateState }
  );
  assert(setGo.ok, 'set google');
  assert(setGo.applied.secureDnsMode === 'automatic', 'auto mode');
  assert(setGo.applied.secureDnsServers[0] === 'https://dns.google/dns-query', 'google url');
  console.log('PASS: automatic + Google');

  doh.clearSelftestCalls();

  // Custom valid URL
  const customOk = 'https://dns.example.test/dns-query';
  const setCustom = doh.setDohSettings(
    { mode: 'secure', provider: 'custom', customUrl: customOk },
    { getState, updateState }
  );
  assert(setCustom.ok, 'set custom valid');
  assert(setCustom.applied.secureDnsServers[0] === customOk, 'custom server applied');
  console.log('PASS: custom https URL accepted');

  // Invalid custom URLs rejected (state unchanged)
  const beforeBad = JSON.stringify(getState().settings.doh);
  const badCases = [
    { customUrl: 'http://insecure.example/dns-query', label: 'http' },
    { customUrl: 'file:///etc/passwd', label: 'file' },
    { customUrl: 'not-a-url', label: 'garbage' },
    { customUrl: '', label: 'empty' },
    { customUrl: 'ftp://dns.example/dns-query', label: 'ftp' },
  ];
  for (const c of badCases) {
    doh.clearSelftestCalls();
    const bad = doh.setDohSettings(
      { mode: 'secure', provider: 'custom', customUrl: c.customUrl },
      { getState, updateState }
    );
    assert(!bad.ok, 'should reject ' + c.label);
    assert(bad.error && String(bad.error).length > 0, 'error message for ' + c.label);
    assert(JSON.stringify(getState().settings.doh) === beforeBad, 'state unchanged after ' + c.label);
    assert(doh.getSelftestCalls().length === 0, 'no configure call on reject ' + c.label);
  }
  console.log('PASS: invalid custom URLs rejected');

  // Quad9 + AdGuard presets
  for (const [provider, url] of [
    ['quad9', 'https://dns.quad9.net/dns-query'],
    ['adguard', 'https://dns.adguard-dns.com/dns-query'],
  ]) {
    const r = doh.setDohSettings({ mode: 'secure', provider, customUrl: '' }, { getState, updateState });
    assert(r.ok && r.applied.secureDnsServers[0] === url, provider);
  }
  console.log('PASS: Quad9 + AdGuard providers');

  // Persist secure Cloudflare for phase 2
  doh.clearSelftestCalls();
  const persist = doh.setDohSettings(
    { mode: 'secure', provider: 'cloudflare', customUrl: '' },
    { getState, updateState }
  );
  assert(persist.ok, 'persist set');
  flushSave();
  const statePath = require('node:path').join(app.getPath('userData'), 'multiheiz-state.json');
  const raw = require('node:fs').readFileSync(statePath, 'utf8');
  const disk = JSON.parse(raw);
  assert(disk.settings && disk.settings.doh && disk.settings.doh.mode === 'secure', 'disk mode');
  assert(disk.settings.doh.provider === 'cloudflare', 'disk provider');
  console.log('PASS: DoH persisted to disk');

  console.log('SELFTEST doh phase1 OK — exiting for restart persistence check');
  app.exit(0);
}

/**
 * @param {object} ctx
 * @param {(cond: any, msg: string) => void} assert
 */
async function runPhase2(ctx, assert) {
  const { publicState, sleep, doh } = ctx;
  await sleep(200);

  const st = publicState();
  assert(st.settings && st.settings.doh, 'phase2 has doh settings');
  assert(st.settings.doh.mode === 'secure', 'phase2 mode secure: ' + JSON.stringify(st.settings.doh));
  assert(st.settings.doh.provider === 'cloudflare', 'phase2 provider');

  const calls = doh.getSelftestCalls();
  assert(calls.length >= 1, 'phase2 expected configureHostResolver on boot');
  const last = calls[calls.length - 1];
  assert(last.secureDnsMode === 'secure', 'phase2 applied mode');
  assert(
    last.secureDnsServers[0] === 'https://cloudflare-dns.com/dns-query',
    'phase2 applied server: ' + JSON.stringify(last)
  );
  console.log('PASS: persistence after restart (DoH secure + Cloudflare)');
  console.log('SELFTEST doh OK');
  app.exit(0);
}

module.exports = { runDohSelftest };
