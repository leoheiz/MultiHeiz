'use strict';

/**
 * Selftest IA experimental — MULTIHEIZ_SELFTEST=ai
 * Fake OpenAI/Gemini (MULTIHEIZ_AI_SERVER) + página local.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, net } = require('electron');
const aiWrite = require('./ai-write');
const contextMenu = require('./context-menu');

/**
 * @param {object} ctx
 */
async function runAiSelftest(ctx) {
  const {
    mainWindow,
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    publicState,
    emitToRenderer,
    getState,
  } = ctx;

  const pageUrl = process.env.MULTIHEIZ_AI_PAGE_URL || '';
  const statsUrl = process.env.MULTIHEIZ_AI_STATS_URL || '';
  const timeoutUrl = process.env.MULTIHEIZ_AI_TIMEOUT_URL || '';
  const testKey = process.env.MULTIHEIZ_AI_TEST_KEY || 'mh-selftest-secret-key-xyz';

  console.log('SELFTEST ai');

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

  assert(pageUrl && pageUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_AI_PAGE_URL local');
  assert(statsUrl && statsUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_AI_STATS_URL local');

  aiWrite.resetSelftestStats();

  // Unit: campos bloqueados
  assert(aiWrite.isAiBlockedField({ type: 'password' }), 'password blocked');
  assert(
    aiWrite.isAiBlockedField({ type: 'text', autocomplete: 'one-time-code' }),
    'otp blocked'
  );
  assert(aiWrite.isAiBlockedField({ type: 'text', autocomplete: 'cc-number' }), 'cc blocked');
  assert(aiWrite.isAiBlockedField({ 'data-mh-no-ai': true }), 'data-mh-no-ai blocked');
  assert(!aiWrite.isAiBlockedField({ tagName: 'TEXTAREA', type: '' }), 'textarea ok');
  console.log('PASS: sensitive field heuristics');

  // 1) Módulo desligado = sem item no menu de contexto
  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-ai');
    s.accounts.push({
      id: 'acc-ai',
      name: 'AiTest',
      workspaceId: 'ws-default',
      color: '#49a',
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
    s.settings.aiWrite = aiWrite.normalizeAiWrite({
      enabled: false,
      provider: 'groq',
      model: 'fake',
      baseUrl: '',
      apiKeyEnc: null,
    });
  });
  flushSave();
  aiWrite.onSettingsChanged(getState().settings);
  if (typeof emitToRenderer === 'function') {
    emitToRenderer({ type: 'state:changed', state: publicState() });
  }
  await sleep(200);

  {
    const tpl = contextMenu.buildContextMenuTemplate(
      { isEditable: true, editFlags: { canCopy: true } },
      { canGoBack: false, canGoForward: false },
      { aiEnabled: false }
    );
    assert(
      !tpl.some((x) => x && x.id === 'ai-write'),
      'sem item IA com módulo desligado'
    );
  }
  console.log('PASS: disabled = sem menu IA');

  // 2) Ligar + salvar chave via safeStorage
  assert(aiWrite.getSelftestStats().encryptionAvailable, 'safeStorage disponível');
  const setKey = aiWrite.setApiKey(testKey);
  assert(setKey.ok, 'setApiKey: ' + (setKey.error || ''));
  updateState((s) => {
    s.settings.aiWrite = aiWrite.normalizeAiWrite({
      ...s.settings.aiWrite,
      enabled: true,
      provider: 'groq',
      model: 'fake-model',
    });
  });
  flushSave();
  aiWrite.onSettingsChanged(getState().settings);
  await sleep(200);

  // Estado em disco não contém a chave em texto puro
  const statePath = path.join(app.getPath('userData'), 'multiheiz-state.json');
  assert(fs.existsSync(statePath), 'state file exists');
  const diskRaw = fs.readFileSync(statePath, 'utf8');
  assert(!diskRaw.includes(testKey), 'chave NÃO está em texto puro no state');
  assert(/apiKeyEnc/.test(diskRaw), 'apiKeyEnc presente (criptografado)');
  const pub = publicState();
  assert(pub.settings.aiWrite && pub.settings.aiWrite.apiKeySaved, 'apiKeySaved público');
  assert(!pub.settings.aiWrite.apiKeyEnc, 'apiKeyEnc não vaza em publicState');
  console.log('PASS: safeStorage + sem chave em texto puro');

  // Menu com módulo ligado
  {
    const tpl = contextMenu.buildContextMenuTemplate(
      { isEditable: true, editFlags: { canCopy: true } },
      {},
      { aiEnabled: true }
    );
    assert(tpl.some((x) => x && x.id === 'ai-write'), 'item IA no menu com módulo ligado');
  }

  panels.createPanel('acc-ai');
  {
    const [bw0, bh0] = mainWindow.getContentSize();
    panels.syncVisiblePanels([
      { accountId: 'acc-ai', x: 0, y: 80, width: bw0, height: Math.max(240, bh0 - 80) },
    ]);
  }
  await sleep(400);
  panels.panelNavigate('acc-ai', pageUrl);
  await waitForUrl('acc-ai', (u) => u.startsWith(pageUrl.replace(/\/$/, '')), 15000);
  await sleep(600);

  const ready = await panelEval(
    'acc-ai',
    `(function(){ return !!(window.__aiPage && window.__aiPage.ready && window.__mhAi); })()`
  );
  assert(ready, '__mhAi bridge ready');

  const diagOffCheck = await panelEval('acc-ai', `window.__mhAi.getDiag()`);
  assert(diagOffCheck && diagOffCheck.enabled, 'painel vê módulo ligado');

  // 3) Campos sensíveis bloqueiam (sem requisição)
  const beforeSens = await fetchJson(statsUrl);
  const reqBeforeSens = Number(beforeSens.requests) || 0;

  await panelEval(
    'acc-ai',
    `(function(){ document.getElementById('in-pass').focus(); return true; })()`
  );
  const openPass = await aiWrite.openFromFocused({
    accountId: 'acc-ai',
    webContents: wcOf('acc-ai'),
  });
  assert(openPass && openPass.skipped === 'sensitive', 'password bloqueado: ' + JSON.stringify(openPass));

  await panelEval(
    'acc-ai',
    `(function(){ document.getElementById('in-otp').focus(); return true; })()`
  );
  const openOtp = await aiWrite.openFromFocused({
    accountId: 'acc-ai',
    webContents: wcOf('acc-ai'),
  });
  assert(openOtp && openOtp.skipped === 'sensitive', 'otp bloqueado');

  await panelEval(
    'acc-ai',
    `(function(){ document.getElementById('ta-no').focus(); return true; })()`
  );
  const openNo = await aiWrite.openFromFocused({
    accountId: 'acc-ai',
    webContents: wcOf('acc-ai'),
  });
  assert(openNo && openNo.skipped === 'sensitive', 'data-mh-no-ai bloqueado');

  const afterSens = await fetchJson(statsUrl);
  assert(
    Number(afterSens.requests) === reqBeforeSens,
    'nenhuma requisição em campos sensíveis'
  );
  console.log('PASS: campos sensíveis bloqueados');

  // 4) Melhorar + Substituir no textarea
  const beforeOk = await fetchJson(statsUrl);
  const reqBefore = Number(beforeOk.requests) || 0;

  await panelEval(
    'acc-ai',
    `(function(){
      var el = document.getElementById('ta');
      el.focus();
      el.value = 'texto original para melhorar';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`
  );

  const opened = await aiWrite.openFromFocused({
    accountId: 'acc-ai',
    webContents: wcOf('acc-ai'),
  });
  assert(opened && opened.ok, 'abrir popover: ' + JSON.stringify(opened));

  const rewritten = await aiWrite.rewriteText({
    action: 'melhorar',
    text: 'texto original para melhorar',
    field: { tagName: 'TEXTAREA', type: '' },
  });
  assert(rewritten && rewritten.ok, 'rewrite ok: ' + JSON.stringify(rewritten));
  assert(
    /\[melhorado\]/.test(String(rewritten.text || '')),
    'resultado melhorado: ' + rewritten.text
  );

  const afterReq = await fetchJson(statsUrl);
  assert(Number(afterReq.requests) > reqBefore, 'fake recebeu pedido');

  // Aplicar via applyTextToActive (simula Substituir)
  // Precisa reabrir para gravar lastAiEl
  await panelEval(
    'acc-ai',
    `(function(){ document.getElementById('ta').focus(); return window.__mhAi.readActive(); })()`
  );
  const applied = await aiWrite.applyTextToActive(wcOf('acc-ai'), rewritten.text);
  assert(applied, 'applyTextToActive');
  const taVal = await panelEval('acc-ai', `document.getElementById('ta').value`);
  assert(/\[melhorado\]/.test(String(taVal)), 'textarea substituído: ' + taVal);
  console.log('PASS: Melhorar → Substituir', taVal);

  // 5) Timeout sem travar
  if (timeoutUrl) {
    await fetchJson(timeoutUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: true }),
    });
    const t0 = Date.now();
    const timed = await aiWrite.rewriteText({
      action: 'corrigir',
      text: 'vai estourar timeout',
      field: { tagName: 'TEXTAREA' },
      timeoutMs: 2500,
    });
    const elapsed = Date.now() - t0;
    assert(timed && !timed.ok, 'timeout retorna erro');
    assert(
      timed.skipped === 'timeout' || /tempo|timeout|esgotado/i.test(String(timed.error || '')),
      'erro de timeout: ' + JSON.stringify(timed)
    );
    assert(elapsed < 15000, 'não travou (elapsed=' + elapsed + ')');
    await fetchJson(timeoutUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: false }),
    });
    console.log('PASS: timeout tratado', elapsed + 'ms');
  }

  // 6) Nenhuma chave nos logs recentes do processo (stdout capturado pelo launcher)
  // Verificação local: mensagens de erro não devem conter a chave
  const bad = await aiWrite.rewriteText({
    action: 'melhorar',
    text: 'x',
    field: { tagName: 'TEXTAREA' },
  });
  void bad;
  const errSample = String(aiWrite.getSelftestStats().lastError || '');
  assert(!errSample.includes(testKey), 'chave não aparece em lastError');

  // Gemini-like path
  updateState((s) => {
    s.settings.aiWrite = aiWrite.normalizeAiWrite({
      ...s.settings.aiWrite,
      provider: 'gemini',
      model: 'gemini-fake',
    });
  });
  flushSave();
  const gem = await aiWrite.rewriteText({
    action: 'mais-curto',
    text: 'frase gemini',
    field: { tagName: 'TEXTAREA' },
  });
  assert(gem && gem.ok, 'gemini fake ok');
  const stGem = await fetchJson(statsUrl);
  assert(Number(stGem.gemini) > 0, 'pedido gemini-like');
  console.log('PASS: provedor Gemini-like');

  // Desligar de novo: open falha
  updateState((s) => {
    s.settings.aiWrite = aiWrite.normalizeAiWrite({
      ...s.settings.aiWrite,
      enabled: false,
    });
  });
  flushSave();
  aiWrite.onSettingsChanged(getState().settings);
  await sleep(200);
  await panelEval('acc-ai', `(function(){ document.getElementById('ta').focus(); })()`);
  const off = await aiWrite.openFromFocused({
    accountId: 'acc-ai',
    webContents: wcOf('acc-ai'),
  });
  assert(off && off.error === 'disabled', 'desligado bloqueia open');
  console.log('PASS: módulo desligado sem atalho/open');

  console.log('PASS: ai selftest complete');
  app.exit(0);
}

module.exports = { runAiSelftest };
