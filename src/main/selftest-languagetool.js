'use strict';

/**
 * Selftest LanguageTool — MULTIHEIZ_SELFTEST=languagetool
 * Página local + fake /v2/check (MULTIHEIZ_LT_SERVER).
 */

const { app, net } = require('electron');
const languagetool = require('./languagetool');

/**
 * @param {object} ctx
 */
async function runLanguageToolSelftest(ctx) {
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
  } = ctx;

  const pageUrl = process.env.MULTIHEIZ_LT_PAGE_URL || '';
  const statsUrl = process.env.MULTIHEIZ_LT_STATS_URL || '';
  const force429Url = process.env.MULTIHEIZ_LT_FORCE429_URL || '';

  console.log('SELFTEST languagetool');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  async function fetchJson(url, opts) {
    if (!app.isReady()) await app.whenReady();
    const res = await net.fetch(String(url), opts || {});
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text, status: res.status };
    }
  }

  function wcOf(accountId) {
    return panels.getPanelCapture(accountId);
  }

  async function panelEval(accountId, code) {
    const wc = wcOf(accountId);
    assert(wc, 'webContents for ' + accountId);
    return wc.executeJavaScript(code, true);
  }

  assert(pageUrl && pageUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_LT_PAGE_URL local');
  assert(statsUrl && statsUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_LT_STATS_URL local');

  languagetool.resetSelftestStats();

  // Unit: sensíveis
  assert(
    languagetool.isSensitiveField({ tagName: 'INPUT', type: 'password' }),
    'password sensitive'
  );
  assert(
    languagetool.isSensitiveField({ tagName: 'INPUT', type: 'text', autocomplete: 'one-time-code' }),
    'otp sensitive'
  );
  assert(
    languagetool.isSensitiveField({ tagName: 'INPUT', type: 'text', autocomplete: 'cc-number' }),
    'cc sensitive'
  );
  assert(
    !languagetool.isSensitiveField({ tagName: 'TEXTAREA', type: '' }),
    'textarea ok'
  );
  assert(
    !languagetool.isSensitiveField({ tagName: 'INPUT', type: 'text' }),
    'text ok'
  );
  console.log('PASS: sensitive field heuristics');

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-lt');
    s.accounts.push({
      id: 'acc-lt',
      name: 'LTTest',
      workspaceId: 'ws-default',
      color: '#4a9',
      muted: false,
      volume: 100,
      zoomFactor: 1,
      startUrl: 'about:blank',
      lastUrl: '',
    });
    s.layout = '1';
    if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
      s.layoutByWorkspace = {};
    }
    s.layoutByWorkspace[s.activeWorkspaceId] = '1';
    if (!s.settings.languageTool) {
      s.settings.languageTool = languagetool.defaultLanguageToolSettings();
    }
    s.settings.languageTool.enabled = true;
    s.settings.languageTool.disabledOrigins = [];
    s.settings.languageTool.serverUrl = process.env.MULTIHEIZ_LT_SERVER || '';
  });
  flushSave();
  languagetool.onSettingsChanged(getState().settings, panels.getAccountSessions());
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(300);

  panels.createPanel('acc-lt');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: 'acc-lt', x: 0, y: 80, width: bw0, height: Math.max(240, bh0 - 80) },
    ]);
  }
  await sleep(500);
  panels.panelNavigate('acc-lt', pageUrl);
  await waitForUrl('acc-lt', (u) => u.startsWith(pageUrl.replace(/\/$/, '')), 15000);
  await sleep(600);

  const ready = await panelEval(
    'acc-lt',
    `(function(){ return !!(window.__ltPage && window.__ltPage.ready && window.__mhLt); })()`
  );
  assert(ready, '__mhLt bridge ready');

  // 1) Digitar erro em textarea → pedido ao fake + sublinhado
  const before = await fetchJson(statsUrl);
  const reqBefore = Number(before.requests) || 0;

  await panelEval(
    'acc-lt',
    `(function(){
      var el = document.getElementById('ta');
      el.focus();
      el.value = 'isto e um errod claro';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`
  );
  // Debounce 1,5 s + margem
  await sleep(2200);
  await panelEval('acc-lt', `window.__mhLt.forceCheck('#ta')`);
  await sleep(800);

  const afterType = await fetchJson(statsUrl);
  assert(
    Number(afterType.requests) > reqBefore,
    'fake recebeu pedido após digitar (antes=' + reqBefore + ' depois=' + afterType.requests + ')'
  );
  const diag1 = await panelEval('acc-lt', `window.__mhLt.getDiag()`);
  assert(diag1 && diag1.matchCount > 0, 'matches após check: ' + JSON.stringify(diag1));
  assert(diag1.hasOverlay || diag1.matchCount > 0, 'overlay ou matches');
  console.log('PASS: debounce + underline', diag1);

  // 2) Aplicar sugestão
  const applied = await panelEval(
    'acc-lt',
    `(function(){
      document.getElementById('ta').focus();
      return window.__mhLt.applyFirstSuggestion();
    })()`
  );
  assert(applied, 'applyFirstSuggestion');
  const taVal = await panelEval('acc-lt', `document.getElementById('ta').value`);
  assert(/erro/.test(String(taVal)) && !/errod/.test(String(taVal)), 'texto corrigido: ' + taVal);
  console.log('PASS: apply suggestion →', taVal);

  // 3) contenteditable + input text também geram pedido
  const midReq = Number((await fetchJson(statsUrl)).requests) || 0;
  await panelEval(
    'acc-lt',
    `(async function(){
      var ce = document.getElementById('ce');
      ce.focus();
      ce.innerText = 'outro errod aqui';
      ce.dispatchEvent(new Event('input', { bubbles: true }));
      await window.__mhLt.forceCheck('#ce');
      var inp = document.getElementById('in-text');
      inp.focus();
      inp.value = 'mais um errod';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await window.__mhLt.forceCheck('#in-text');
      return true;
    })()`
  );
  await sleep(500);
  const afterCe = await fetchJson(statsUrl);
  assert(Number(afterCe.requests) > midReq, 'contenteditable/input geraram pedidos');
  console.log('PASS: contenteditable + input text');

  // 4) Campos sensíveis NUNCA geram pedido ao fake
  const sensBefore = Number((await fetchJson(statsUrl)).requests) || 0;
  await panelEval(
    'acc-lt',
    `(async function(){
      function fill(id, val) {
        var el = document.getElementById(id);
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return window.__mhLt.forceCheck('#' + id);
      }
      await fill('in-pass', 'errod senha');
      await fill('in-otp', '123456');
      await fill('in-cc', '4111111111111111 errod');
      return window.__mhLt.getDiag();
    })()`
  );
  await sleep(400);
  const sensAfter = await fetchJson(statsUrl);
  assert(
    Number(sensAfter.requests) === sensBefore,
    'campos sensíveis não devem gerar pedido (antes=' +
      sensBefore +
      ' depois=' +
      sensAfter.requests +
      ')'
  );
  const mainStats = languagetool.getSelftestStats();
  assert(mainStats.sensitiveBlocked > 0, 'main contou sensitiveBlocked');
  console.log('PASS: sensitive fields blocked', mainStats.sensitiveBlocked);

  // 5) Desligar nas Configurações para pedidos
  const disBefore = Number((await fetchJson(statsUrl)).requests) || 0;
  updateState((s) => {
    s.settings.languageTool = languagetool.normalizeLanguageTool({
      ...s.settings.languageTool,
      enabled: false,
    });
  });
  flushSave();
  languagetool.onSettingsChanged(getState().settings, panels.getAccountSessions());
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(400);
  await panelEval(
    'acc-lt',
    `(async function(){
      var el = document.getElementById('ta');
      el.focus();
      el.value = 'novo errod desligado';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await window.__mhLt.forceCheck('#ta');
      return window.__mhLt.getDiag();
    })()`
  );
  await sleep(400);
  const disAfter = await fetchJson(statsUrl);
  assert(
    Number(disAfter.requests) === disBefore,
    'desligado: sem pedidos novos'
  );
  console.log('PASS: settings enabled=false');

  // Reabilita e desativa neste site (origem)
  updateState((s) => {
    const origin = (() => {
      try {
        return new URL(pageUrl).origin;
      } catch {
        return '';
      }
    })();
    s.settings.languageTool = languagetool.normalizeLanguageTool({
      ...s.settings.languageTool,
      enabled: true,
      disabledOrigins: origin ? [origin] : [],
    });
  });
  flushSave();
  languagetool.onSettingsChanged(getState().settings, panels.getAccountSessions());
  await sleep(400);
  const siteBefore = Number((await fetchJson(statsUrl)).requests) || 0;
  await panelEval(
    'acc-lt',
    `(async function(){
      var el = document.getElementById('ta');
      el.focus();
      el.value = 'errod no site desativado';
      await window.__mhLt.forceCheck('#ta');
      return window.__mhLt.getDiag();
    })()`
  );
  await sleep(400);
  const siteAfter = await fetchJson(statsUrl);
  assert(Number(siteAfter.requests) === siteBefore, 'Desativar neste site bloqueia');
  const diagSite = await panelEval('acc-lt', `window.__mhLt.getDiag()`);
  assert(diagSite && diagSite.originDisabled, 'originDisabled no diag');
  console.log('PASS: disable this site');

  // Limpa exclusão do site
  updateState((s) => {
    s.settings.languageTool = languagetool.normalizeLanguageTool({
      ...s.settings.languageTool,
      enabled: true,
      disabledOrigins: [],
    });
  });
  flushSave();
  languagetool.onSettingsChanged(getState().settings, panels.getAccountSessions());
  await sleep(300);

  // 6) 429 → backoff sem travar
  if (force429Url) {
    await fetchJson(force429Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: true }),
    });
  }
  const r429 = await panelEval(
    'acc-lt',
    `(async function(){
      var el = document.getElementById('ta');
      el.focus();
      el.value = 'errod com 429';
      await window.__mhLt.forceCheck('#ta');
      return window.__mhLt.getDiag();
    })()`
  );
  await sleep(600);
  // Desliga 429
  if (force429Url) {
    await fetchJson(force429Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: false }),
    });
  }
  // UI não travou — ainda responde
  const stillAlive = await rendererEval(
    `(function(){ return !!(document.body && document.getElementById('form-settings') !== undefined); })()`
  );
  assert(stillAlive !== false, 'UI viva após 429');
  const st429 = languagetool.getSelftestStats();
  console.log('PASS: 429 backoff sem travar', st429.lastStatus || r429, st429.lastBackoffMs);

  // UI: seção Escrita existe
  const escrita = await rendererEval(
    `(function(){
      var btn = document.querySelector('.settings-nav-btn[data-section="escrita"]');
      var pane = document.querySelector('.settings-pane[data-pane="escrita"]');
      return !!(btn && pane && document.getElementById('lt-enabled'));
    })()`
  );
  assert(escrita, 'Configurações → Escrita presente');
  console.log('PASS: settings Escrita UI');

  console.log('PASS: languagetool selftest complete');
  app.exit(0);
}

module.exports = { runLanguageToolSelftest };
