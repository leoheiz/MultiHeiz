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

  // Unit: default OFF + normalize opt-in
  {
    const def = languagetool.defaultLanguageToolSettings();
    assert(def.enabled === false, 'default languageTool.enabled === false');
    assert(
      languagetool.normalizeLanguageTool({}).enabled === false,
      'normalize missing enabled → false'
    );
    assert(
      languagetool.normalizeLanguageTool({ enabled: true }).enabled === true,
      'normalize enabled:true → true'
    );
    assert(
      languagetool.normalizeLanguageTool({ enabled: false }).enabled === false,
      'normalize enabled:false → false'
    );
    console.log('PASS: languageTool default off');
  }

  // Unit: migração one-shot OFF
  {
    const stateMod = require('./state');
    const migrated = stateMod.migrate({
      version: 1,
      workspaces: [{ id: 'ws-default', name: 'Default' }],
      activeWorkspaceId: 'ws-default',
      accounts: [],
      layout: '1',
      settings: {
        languageTool: { enabled: true, languages: ['pt-BR'], serverUrl: '', disabledOrigins: [] },
        migrations: { keepAlive120: true },
      },
      ui: {},
    });
    assert(
      migrated.settings.languageTool.enabled === false,
      'migration força enabled=false'
    );
    assert(
      migrated.settings.migrations.languageToolDefaultOff131 === true,
      'migration flag languageToolDefaultOff131'
    );
    const again = stateMod.migrate(migrated);
    again.settings.languageTool.enabled = true;
    const kept = stateMod.migrate({
      ...again,
      settings: {
        ...again.settings,
        languageTool: { ...again.settings.languageTool, enabled: true },
        migrations: { ...again.settings.migrations, languageToolDefaultOff131: true },
      },
    });
    assert(
      kept.settings.languageTool.enabled === true,
      'após flag, enabled:true do usuário permanece'
    );
    console.log('PASS: languageTool migration off');
  }

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
    languagetool.isSensitiveField({ tagName: 'INPUT', type: 'text', name: 'senha' }),
    'name senha sensitive'
  );
  assert(
    languagetool.isSensitiveField({ tagName: 'INPUT', type: 'text', name: 'api_token' }),
    'name token sensitive'
  );
  assert(
    languagetool.isSensitiveField({
      tagName: 'INPUT',
      type: 'text',
      placeholder: 'Digite seu CPF',
    }),
    'placeholder cpf sensitive'
  );
  assert(
    languagetool.isSensitiveField({
      tagName: 'INPUT',
      type: 'text',
      ariaLabel: 'Número do cartão',
    }),
    'aria-label cartao sensitive'
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
  // Corretor nativo ON por padrão (LT ligado neste teste, mas disableNativeSpellcheck=false)
  {
    const sessions = panels.getAccountSessions();
    let any = false;
    for (const ses of sessions || []) {
      if (!ses || typeof ses.isSpellCheckerEnabled !== 'function') continue;
      any = true;
      assert(ses.isSpellCheckerEnabled() === true, 'session.isSpellCheckerEnabled() === true');
    }
    assert(any, 'pelo menos uma sessão com isSpellCheckerEnabled');
    console.log('PASS: native spellchecker enabled by default');
  }
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

  // 4) Campos sensíveis NUNCA geram pedido ao fake (type + name/id/placeholder/aria)
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
      await fill('in-senha-name', 'errod nome senha');
      await fill('in-token-id', 'errod token');
      await fill('in-cpf', 'errod cpf');
      await fill('in-cartao', 'errod cartao');
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

  // 4b) Default OFF: com enabled=false (estado fresco via normalize) sem pedidos
  {
    const offBefore = Number((await fetchJson(statsUrl)).requests) || 0;
    updateState((s) => {
      s.settings.languageTool = languagetool.normalizeLanguageTool({
        ...s.settings.languageTool,
        enabled: false,
      });
    });
    flushSave();
    languagetool.onSettingsChanged(getState().settings, panels.getAccountSessions());
    await sleep(300);
    await panelEval(
      'acc-lt',
      `(async function(){
        var el = document.getElementById('ta');
        el.focus();
        el.value = 'errod com default off';
        await window.__mhLt.forceCheck('#ta');
        return window.__mhLt.getDiag();
      })()`
    );
    await sleep(400);
    const offAfter = await fetchJson(statsUrl);
    assert(Number(offAfter.requests) === offBefore, 'default/off: sem pedidos');
    // Religa para o restante do selftest
    updateState((s) => {
      s.settings.languageTool = languagetool.normalizeLanguageTool({
        ...s.settings.languageTool,
        enabled: true,
      });
    });
    flushSave();
    languagetool.onSettingsChanged(getState().settings, panels.getAccountSessions());
    await sleep(300);
    console.log('PASS: enabled=false blocks checks');
  }

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
