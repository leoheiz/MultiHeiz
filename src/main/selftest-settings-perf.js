'use strict';

/**
 * Selftest: settings apply latency (MULTIHEIZ_SELFTEST=settings-perf).
 * 3 painéis; mede IPC + atraso do event loop; DoH off→automatic < margem.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, ipcMain } = require('electron');
const { envGet } = require('./config');
const doh = require('./doh');
const settingsApply = require('./settings-apply');

const CI_BUDGET_MS = Number(envGet('MULTIHEIZ_SETTINGS_PERF_BUDGET_MS')) || 300;

/**
 * @param {object} ctx
 */
async function runSettingsPerfSelftest(ctx) {
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
    getState,
  } = ctx;

  console.log('SELFTEST settings-perf budgetMs=' + CI_BUDGET_MS);

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const logDir = path.join(__dirname, '..', '..', '_local');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'settings-apply-profile.log');

  let server = null;
  let port = 0;
  const PAGE = `<!DOCTYPE html><html><body style="background:#234;color:#fff;font:20px sans-serif;padding:24px">perf</body></html>`;
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
  const base = `http://127.0.0.1:${port}`;

  updateState((s) => {
    s.workspaces = [{ id: 'ws-perf', name: 'Perf' }];
    s.activeWorkspaceId = 'ws-perf';
    s.layout = 'auto';
    s.page = 0;
    s.accounts = [1, 2, 3].map((i) => ({
      id: 'acc-perf-' + i,
      name: 'P' + i,
      color: '#2bb8a6',
      startUrl: base + '/',
      workspaceId: 'ws-perf',
      muted: false,
      lastUrl: null,
      zoomFactor: 1,
    }));
    s.ui = { ...(s.ui || {}), sidebarCollapsed: false, sidebarAutoHide: false, layoutLocked: true };
    s.settings = {
      ...s.settings,
      openLastPage: false,
      homepage: base + '/',
      doh: { mode: 'off', provider: 'cloudflare', customUrl: '' },
      lightMode: false,
    };
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(900);
  await waitForLayoutSettle();
  for (const i of [1, 2, 3]) {
    await waitForUrl('acc-perf-' + i, (u) => u.includes('127.0.0.1'), 30000);
  }
  await waitForLayoutSettle();
  assert(panels.getPanelDebugInfo().panels.filter((p) => p.visible).length >= 3, 'need 3 panels');

  // Event-loop lag monitor (10ms tick)
  const lags = [];
  let lastTick = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - 10;
    lags.push(lag > 0 ? lag : 0);
    lastTick = now;
  }, 10);

  async function invokeSettings(partial) {
    const t0 = performance.now();
    // Call handler logic via the same module path used by IPC (direct for timing).
    const handlers = ipcMain._invokeHandlers || null;
    let result;
    if (mainWindow && !mainWindow.isDestroyed()) {
      result = await mainWindow.webContents.executeJavaScript(
        `window.multiheiz.updateSettings(${JSON.stringify(partial)})`,
        true
      );
    } else {
      throw new Error('no window');
    }
    const ipcMs = performance.now() - t0;
    return { result, ipcMs };
  }

  // --- BEFORE: simulate old hot path (full form + await adblock + sync panels) ---
  const beforeLines = [];
  beforeLines.push('=== BEFORE (caminho antigo simulado: adblock.apply + syncVisiblePanels) ===');
  {
    const adblock = require('./adblock');
    const ab = (getState().settings && getState().settings.adblock) || adblock.defaultAdblockSettings();
    const t0 = performance.now();
    const loopBefore = lags.length;
    await adblock.applySettings({
      ...ab,
      lists: { ...(ab.lists || {}) },
      enabled: ab.enabled !== false,
    });
    const info = panels.getPanelDebugInfo();
    if (info.lastSlots && info.lastSlots.length) {
      panels.syncVisiblePanels(info.lastSlots);
    } else {
      panels.applyThrottling();
    }
    // busy-wait a turn so lag samples catch the block
    await sleep(50);
    const beforeMs = performance.now() - t0;
    const lagSlice = lags.slice(loopBefore);
    const maxLag = lagSlice.length ? Math.max(...lagSlice) : 0;
    beforeLines.push(
      `legacyHotPathMs=${beforeMs.toFixed(1)} maxEventLoopLagMs=${maxLag.toFixed(1)} panels=3`
    );
    console.log('PROFILE BEFORE', beforeLines[beforeLines.length - 1]);
  }

  // Drain lag buffer a bit
  await sleep(100);
  lags.length = 0;
  lastTick = performance.now();

  // --- AFTER: simple appearance-like toggle (lightMode) ---
  const afterLines = [];
  afterLines.push('=== AFTER (só o que mudou, assíncrono) ===');
  {
    const cur = !!(getState().settings && getState().settings.lightMode);
    const loopBefore = lags.length;
    const { result, ipcMs } = await invokeSettings({ lightMode: !cur });
    await sleep(40);
    const lagSlice = lags.slice(loopBefore);
    const maxLag = lagSlice.length ? Math.max(...lagSlice) : 0;
    const prof = result && result._settingsProfile;
    afterLines.push(
      `simpleToggle ipcMs=${ipcMs.toFixed(1)} maxEventLoopLagMs=${maxLag.toFixed(1)} profile=${JSON.stringify(prof || {})}`
    );
    console.log('PROFILE AFTER simple', afterLines[afterLines.length - 1]);
    assert(ipcMs < CI_BUDGET_MS, `simple toggle ipc ${ipcMs}ms >= budget ${CI_BUDGET_MS}`);
    assert(maxLag < CI_BUDGET_MS, `simple toggle lag ${maxLag}ms >= budget ${CI_BUDGET_MS}`);
  }

  await sleep(80);
  lags.length = 0;
  lastTick = performance.now();

  // --- AFTER: DoH off → automatic ---
  {
    doh.clearSelftestCalls();
    updateState((s) => {
      s.settings = {
        ...s.settings,
        doh: { mode: 'off', provider: 'cloudflare', customUrl: '' },
      };
    });
    doh.applyDohSettings(getState().settings.doh, { force: true });
    doh.clearSelftestCalls();

    const loopBefore = lags.length;
    const { result, ipcMs } = await invokeSettings({
      doh: { mode: 'automatic', provider: 'cloudflare', customUrl: '' },
    });
    await sleep(40);
    const lagSlice = lags.slice(loopBefore);
    const maxLag = lagSlice.length ? Math.max(...lagSlice) : 0;
    const prof = result && result._settingsProfile;
    afterLines.push(
      `dohOffToAutomatic ipcMs=${ipcMs.toFixed(1)} maxEventLoopLagMs=${maxLag.toFixed(1)} profile=${JSON.stringify(prof || {})}`
    );
    console.log('PROFILE AFTER doh', afterLines[afterLines.length - 1]);

    const st = getState();
    assert(st.settings.doh.mode === 'automatic', 'doh mode automatic in state');
    const calls = doh.getSelftestCalls();
    assert(calls.length >= 1, 'configureHostResolver called for DoH change');
    assert(calls[calls.length - 1].secureDnsMode === 'automatic', 'resolver automatic');

    // Second identical apply must not re-configure
    doh.clearSelftestCalls();
    const again = await invokeSettings({
      doh: { mode: 'automatic', provider: 'cloudflare', customUrl: '' },
    });
    assert(
      !again.result ||
        (again.result._settingsProfile &&
          Array.isArray(again.result._settingsProfile.changedKeys) &&
          again.result._settingsProfile.changedKeys.length === 0) ||
        doh.getSelftestCalls().length === 0,
      'unchanged DoH must not reconfigure'
    );

    assert(ipcMs < CI_BUDGET_MS, `doh ipc ${ipcMs}ms >= budget ${CI_BUDGET_MS}`);
    assert(maxLag < CI_BUDGET_MS, `doh lag ${maxLag}ms >= budget ${CI_BUDGET_MS}`);
  }

  clearInterval(lagTimer);

  // Diff helper unit check
  {
    const prev = { lightMode: false, doh: { mode: 'off', provider: 'cloudflare', customUrl: '' } };
    const full = {
      lightMode: true,
      doh: { mode: 'off', provider: 'cloudflare', customUrl: '' },
      adblock: { enabled: true, lists: { a: true } },
    };
    const d = settingsApply.diffSettingsPartial(prev, full);
    assert(d.lightMode === true, 'diff lightMode');
    assert(!d.doh, 'unchanged doh omitted');
    assert(d.adblock, 'new adblock included');
    console.log('PASS: diffSettingsPartial');
  }

  // Adblock deep-diff: enable-only must not look like lists/cosmetic change
  {
    const prevAb = {
      enabled: true,
      cosmetic: true,
      antiTracking: true,
      lists: { easylist: true, easyprivacy: true },
      userRules: '',
    };
    const nextAb = { ...prevAb, enabled: false, lists: { ...prevAb.lists } };
    const dAb = settingsApply.diffAdblockPartial(prevAb, nextAb);
    assert(dAb.enabled === false, 'diffAdblock enabled');
    assert(!dAb.lists, 'enable-only must omit lists');
    assert(!dAb.cosmetic, 'enable-only must omit cosmetic');
    assert(!settingsApply.adblockPartialNeedsRebuild(dAb), 'enable-only no rebuild');
    const listsFlip = settingsApply.diffAdblockPartial(prevAb, {
      ...prevAb,
      lists: { ...prevAb.lists, easylist: false },
    });
    assert(listsFlip.lists && listsFlip.lists.easylist === false, 'lists deep diff');
    assert(settingsApply.adblockPartialNeedsRebuild(listsFlip), 'lists need rebuild');
    console.log('PASS: diffAdblockPartial enable-only');
  }

  const logBody =
    beforeLines.join('\n') +
    '\n' +
    afterLines.join('\n') +
    '\n' +
    `budgetMs=${CI_BUDGET_MS}\nat=${new Date().toISOString()}\n`;
  fs.writeFileSync(logPath, logBody, 'utf8');
  console.log('Wrote', logPath);

  try {
    server.close();
  } catch {
    /* ignore */
  }

  console.log('PASS: selftest settings-perf');
  app.exit(0);
}

module.exports = { runSettingsPerfSelftest };
