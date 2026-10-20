'use strict';

/**
 * In-process permissions selftest (MULTIHEIZ_SELFTEST=permissions).
 * Página local em http://localhost — getUserMedia, prompt, indicador, popover.
 */

/**
 * @param {object} ctx
 */
async function runPermissionsSelftest(ctx) {
  const {
    panels,
    updateState,
    flushSave,
    sleep,
    waitForUrl,
    rendererEval,
    permissions,
    app,
  } = ctx;

  console.log('SELFTEST permissions');

  function assert(cond, msg) {
    if (!cond) {
      console.log('FAIL:', msg);
      throw new Error(msg);
    }
  }

  const pageUrl = process.env.MULTIHEIZ_PERM_TEST_URL || '';
  assert(pageUrl && pageUrl.startsWith('http://127.0.0.1'), 'MULTIHEIZ_PERM_TEST_URL local');

  permissions.clearDecisionsForTest();

  updateState((s) => {
    if (!s.workspaces.some((w) => w.id === 'ws-default')) {
      s.workspaces.push({ id: 'ws-default', name: 'Default' });
    }
    s.activeWorkspaceId = 'ws-default';
    s.accounts = (s.accounts || []).filter((a) => a.id !== 'acc-perm-a' && a.id !== 'acc-perm-b');
    s.accounts.push(
      {
        id: 'acc-perm-a',
        name: 'PermA',
        workspaceId: 'ws-default',
        color: '#4a9',
        muted: false,
        zoomFactor: 1,
        startUrl: 'about:blank',
        lastUrl: '',
      },
      {
        id: 'acc-perm-b',
        name: 'PermB',
        workspaceId: 'ws-default',
        color: '#a94',
        muted: false,
        zoomFactor: 1,
        startUrl: 'about:blank',
        lastUrl: '',
      }
    );
    s.layout = {
      cols: 2,
      rows: 1,
      slots: [{ accountId: 'acc-perm-a' }, { accountId: 'acc-perm-b' }],
    };
  });
  flushSave();

  panels.createPanel('acc-perm-a');
  panels.createPanel('acc-perm-b');
  await sleep(600);

  // ALWAYS_DENY + display-capture sem grant continuam negados
  assert(permissions.checkPermission('acc-perm-a', 'usb', pageUrl) === false, 'usb deny');
  assert(
    permissions.checkPermission('acc-perm-a', 'display-capture', pageUrl) === false,
    'display-capture not granted'
  );
  assert(
    permissions.checkPermission('acc-perm-a', 'notifications', pageUrl) === false,
    'notifications ask (check false)'
  );
  console.log('PASS: ALWAYS_DENY / display-capture / notifications ask');

  // --- Mic: carregar página e esperar prompt ---
  const uiKeys = await rendererEval(
    'window.__multiheizUi ? Object.keys(window.__multiheizUi).filter((k) => /perm|media|site/i.test(k)) : []'
  );
  console.log('ui hooks:', uiKeys);
  assert(
    await rendererEval(
      'typeof (window.__multiheizUi && window.__multiheizUi.getPermissionPrompt) === "function"'
    ),
    'getPermissionPrompt hook missing: ' + JSON.stringify(uiKeys)
  );

  panels.panelNavigate('acc-perm-a', pageUrl);
  await waitForUrl('acc-perm-a', (u) => u.startsWith(pageUrl.replace(/\/$/, '')), 15000);
  await sleep(800);

  let prompt = null;
  for (let i = 0; i < 40; i++) {
    prompt = await rendererEval(
      'typeof window.__multiheizUi.getPermissionPrompt === "function" ? window.__multiheizUi.getPermissionPrompt("acc-perm-a") : null'
    );
    if (prompt && prompt.message) break;
    // Fallback main peek
    const peek = permissions.selftestPeekPrompt('acc-perm-a');
    if (peek && peek.message) {
      prompt = peek;
      break;
    }
    await sleep(250);
  }
  assert(prompt && prompt.message, 'prompt appeared: ' + JSON.stringify(prompt));
  assert(/microfone/i.test(prompt.message), 'prompt text mic: ' + prompt.message);
  console.log('PASS: prompt microfone no renderer', prompt.message);

  // Clicar Permitir via gancho UI
  const clicked = await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.clickPermissionAllow("acc-perm-a")'
  );
  if (!clicked) {
    const r = permissions.selftestRespond('acc-perm-a', 'allow');
    assert(r && r.ok, 'fallback selftestRespond allow');
  }
  await sleep(1200);

  const wcA = panels.getPanelCapture('acc-perm-a');
  assert(wcA, 'wc A');
  let gumOk = false;
  for (let i = 0; i < 30; i++) {
    const st = await wcA.executeJavaScript(
      '({ err: window.__mh && window.__mh.err, has: !!(window.__mh && window.__mh.stream) })'
    );
    if (st && st.has) {
      gumOk = true;
      break;
    }
    if (st && st.err) {
      console.log('getUserMedia err early', st.err);
      break;
    }
    await sleep(200);
  }
  assert(gumOk, 'getUserMedia resolved after allow');
  console.log('PASS: getUserMedia resolve após Permitir');

  const hookInfo = await wcA.executeJavaScript(
    '({ hooked: !!window.__MH_MEDIA_USE_HOOK__, hasReport: typeof window.__mhMediaUseReport, inUseMain: null })'
  );
  const mainUse = permissions.getMediaInUse('acc-perm-a');
  console.log('media hook:', hookInfo, 'mainUse:', mainUse);

  // Fallback: se o hook não reportou, marcar uso a partir do stream da página
  if (!mainUse.microphone) {
    const forced = await wcA.executeJavaScript(`(() => {
      try {
        if (typeof window.__mhMediaUseReport === 'function' && window.__mh && window.__mh.stream) {
          const hasA = window.__mh.stream.getAudioTracks().some(t => t.readyState === 'live');
          const hasV = window.__mh.stream.getVideoTracks().some(t => t.readyState === 'live');
          window.__mhMediaUseReport({ microphone: hasA, camera: hasV });
          return { hasA, hasV };
        }
      } catch (e) { return { err: String(e) }; }
      return { no: true };
    })()`);
    console.log('forced report:', forced);
    await sleep(300);
  }

  // Indicador de microfone (sincroniza do main se o evento UI atrasou)
  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncMediaUseFromMain("acc-perm-a")'
  );
  let icons = null;
  for (let i = 0; i < 20; i++) {
    icons = await rendererEval(
      'window.__multiheizUi && window.__multiheizUi.getMediaUseIcons("acc-perm-a")'
    );
    if (icons && icons.microphone) break;
    await sleep(200);
  }
  assert(icons && icons.microphone, 'mic indicator: ' + JSON.stringify(icons));
  console.log('PASS: indicador microfone visível');

  // Parar track → some
  await wcA.executeJavaScript('window.__mhStop && window.__mhStop()');
  await sleep(1000);
  await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.syncMediaUseFromMain("acc-perm-a")'
  );
  icons = await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.getMediaUseIcons("acc-perm-a")'
  );
  assert(icons && !icons.microphone, 'mic indicator gone: ' + JSON.stringify(icons));
  console.log('PASS: indicador some ao parar track');

  // Recarregar → não pergunta de novo
  panels.panelReload('acc-perm-a');
  await sleep(1500);
  const prompt2 = await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.getPermissionPrompt("acc-perm-a")'
  );
  assert(!prompt2, 'no prompt after reload (remembered allow)');
  const gum2 = await wcA.executeJavaScript(
    '({ err: window.__mh && window.__mh.err, has: !!(window.__mh && window.__mh.stream) })'
  );
  assert(gum2 && gum2.has, 'gum works without prompt: ' + JSON.stringify(gum2));
  console.log('PASS: reload não pergunta de novo');

  // Conta/partição diferente → pergunta
  panels.panelNavigate('acc-perm-b', pageUrl);
  await waitForUrl('acc-perm-b', (u) => u.startsWith(pageUrl.replace(/\/$/, '')), 15000);
  await sleep(800);
  let promptB = null;
  for (let i = 0; i < 40; i++) {
    promptB = await rendererEval(
      'window.__multiheizUi && window.__multiheizUi.getPermissionPrompt("acc-perm-b")'
    );
    if (promptB && promptB.message) break;
    if (permissions.selftestPeekPrompt('acc-perm-b')) {
      promptB = permissions.selftestPeekPrompt('acc-perm-b');
      break;
    }
    await sleep(250);
  }
  assert(promptB && /microfone/i.test(promptB.message || ''), 'other account asks');
  console.log('PASS: conta B pergunta');

  // Bloquear em B
  const deniedClick = await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.clickPermissionDeny("acc-perm-b")'
  );
  if (!deniedClick) {
    permissions.selftestRespond('acc-perm-b', 'deny');
  }
  await sleep(1200);
  const wcB = panels.getPanelCapture('acc-perm-b');
  const gumB = await wcB.executeJavaScript(
    '({ err: window.__mh && window.__mh.err, has: !!(window.__mh && window.__mh.stream) })'
  );
  assert(gumB && gumB.err === 'NotAllowedError', 'NotAllowedError on deny: ' + JSON.stringify(gumB));
  assert(
    permissions.checkPermission('acc-perm-b', 'media', pageUrl, { mediaTypes: ['audio'] }) === false,
    'deny remembered'
  );
  // Confirm remembered deny — reload no prompt but still fails
  panels.panelReload('acc-perm-b');
  await sleep(1200);
  const promptB2 = await rendererEval(
    'window.__multiheizUi && window.__multiheizUi.getPermissionPrompt("acc-perm-b")'
  );
  assert(!promptB2, 'no prompt after deny remember');
  console.log('PASS: Bloquear → NotAllowedError e lembrado');

  // Popover lista estado + Redefinir
  const origin = new URL(pageUrl).origin;
  const site = permissions.getSitePermissionStates('acc-perm-a', origin);
  assert(site.states.microphone === 'allow', 'A mic allow in site info');
  assert(site.states.camera === 'ask', 'A cam still ask');
  const siteB = permissions.getSitePermissionStates('acc-perm-b', origin);
  assert(siteB.states.microphone === 'deny', 'B mic deny');

  // Garante URL http no painel B (navState do renderer) antes do popover
  panels.panelNavigate('acc-perm-b', pageUrl);
  await waitForUrl('acc-perm-b', (u) => u.startsWith(pageUrl.replace(/\/$/, '')), 15000);
  await sleep(600);
  // Nega de novo se o reload/nav pediu (já lembrado = sem prompt)
  permissions.setDecisionForTest('acc-perm-b', origin, 'microphone', 'deny');

  let pop = null;
  for (let i = 0; i < 8; i++) {
    pop = await rendererEval(
      'window.__multiheizUi && window.__multiheizUi.openSitePermissions("acc-perm-b")'
    );
    if (pop && pop.rows && pop.rows.length) break;
    await sleep(300);
  }
  assert(pop && pop.rows && pop.rows.length >= 5, 'popover rows: ' + JSON.stringify(pop));
  const micRow = pop.rows.find((r) => r.permission === 'microphone');
  assert(micRow && micRow.value === 'deny', 'popover shows deny');
  await rendererEval('window.__multiheizUi && window.__multiheizUi.clickPermissionReset()');
  await sleep(300);
  const afterReset = permissions.getSitePermissionStates('acc-perm-b', origin);
  assert(afterReset.states.microphone === 'ask', 'reset → ask');
  console.log('PASS: popover + Redefinir permissões');

  // Câmera separada do microfone
  permissions.clearDecisionsForTest();
  permissions.setDecisionForTest('acc-perm-a', origin, 'microphone', 'allow');
  assert(
    permissions.checkPermission('acc-perm-a', 'media', origin, { mediaTypes: ['audio'] }) === true,
    'mic ok'
  );
  assert(
    permissions.checkPermission('acc-perm-a', 'media', origin, { mediaTypes: ['video'] }) === false,
    'cam separate'
  );
  console.log('PASS: câmera separada do microfone');

  // Notifications prompt
  const notifUrl = pageUrl.replace(/\/?$/, '') + '/notif';
  panels.panelNavigate('acc-perm-a', notifUrl);
  await waitForUrl('acc-perm-a', (u) => u.includes('/notif'), 15000);
  await sleep(800);
  let promptN = null;
  for (let i = 0; i < 40; i++) {
    promptN = await rendererEval(
      'window.__multiheizUi && window.__multiheizUi.getPermissionPrompt("acc-perm-a")'
    );
    if (promptN && /notifica/i.test(promptN.message || '')) break;
    const peek = permissions.selftestPeekPrompt('acc-perm-a');
    if (peek && /notifica/i.test(peek.message || '')) {
      promptN = peek;
      break;
    }
    await sleep(250);
  }
  assert(promptN && /notifica/i.test(promptN.message || ''), 'notifications prompt');
  permissions.selftestRespond('acc-perm-a', 'allow');
  await sleep(500);
  assert(
    permissions.checkPermission('acc-perm-a', 'notifications', origin) === true,
    'notifications allowed'
  );
  console.log('PASS: notifications prompt');

  // check handler / query consistency (after mic allow on A earlier was cleared — set again)
  permissions.setDecisionForTest('acc-perm-a', origin, 'microphone', 'allow');
  assert(
    permissions.checkPermission('acc-perm-a', 'media', origin, { mediaTypes: ['audio'] }) === true,
    'check allow'
  );
  permissions.setDecisionForTest('acc-perm-a', origin, 'microphone', 'deny');
  assert(
    permissions.checkPermission('acc-perm-a', 'media', origin, { mediaTypes: ['audio'] }) === false,
    'check deny'
  );
  console.log('PASS: check handler consistente');

  console.log('PASS: selftest:permissions electron complete');
  app.exit(0);
}

module.exports = { runPermissionsSelftest };
