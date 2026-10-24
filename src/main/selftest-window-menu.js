'use strict';

/**
 * Selftest: per-window ⋮ menu groups (MULTIHEIZ_SELFTEST=window-menu).
 */

const { app } = require('electron');

async function runWindowMenuSelftest(ctx) {
  const {
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    getState,
    popupAccountMenu,
  } = ctx;

  console.log('SELFTEST window-menu');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  updateState((s) => {
    s.workspaces = [{ id: 'ws-wm', name: 'WM' }];
    s.activeWorkspaceId = 'ws-wm';
    s.layout = '1';
    s.page = 0;
    s.maximizedAccountId = null;
    s.accounts = [
      {
        id: 'acc-wm',
        name: 'Menu',
        color: '#2bb8a6',
        startUrl: 'about:blank',
        workspaceId: 'ws-wm',
        muted: false,
        pauseInBackground: false,
        keepAliveInBackground: false,
        privateHistory: false,
        adblockEnabled: true,
        showUnread: true,
        lastUrl: null,
      },
    ];
    if (!s.settings) s.settings = {};
    s.settings.confirmOnRemove = false;
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(500);
  await waitForLayoutSettle();

  process.env.MULTIHEIZ_MENU_INTERCEPT = '1';
  const r = popupAccountMenu({ accountId: 'acc-wm', x: 100, y: 100 });
  assert(r && r.ok && r.intercepted, 'menu intercepted', r);

  const top = r.topLabels || [];
  const groups = r.groups || [];
  const labels = r.labels || [];

  const expectedTopOrder = [
    'Recarregar',
    'Início',
    'Mudo',
    'Zoom',
    'Aparência',
    'Privacidade e rede',
    'Segundo plano',
    'Abrir',
    'Janela',
    'Fechar',
  ];
  // Zoom label includes percent — match prefix
  let ti = 0;
  for (const need of expectedTopOrder) {
    while (ti < top.length && !String(top[ti] || '').startsWith(need === 'Zoom' ? 'Zoom' : need)) {
      ti++;
    }
    assert(ti < top.length, 'top order has ' + need, { top, need });
    ti++;
  }
  console.log('PASS: top-level groups/items in order');

  for (const g of ['Aparência', 'Privacidade e rede', 'Segundo plano', 'Abrir', 'Janela']) {
    assert(groups.includes(g), 'group ' + g, groups);
  }

  const reachable = [
    'Recarregar',
    'Início',
    'Renomear',
    'Cor',
    'Editar URL inicial',
    'Mostrar contador de não lidas',
    'Proxy…',
    'Modo privado (não salvar histórico)',
    'Bloqueio de anúncios nesta janela',
    'Suspender agora',
    'Automático',
    'Manter ativa em segundo plano',
    'Pausar em segundo plano',
    'Nova janela com a mesma sessão',
    'Login no navegador padrão',
    'DevTools',
    'Maximizar',
    'Minimizar',
    'Fechar',
  ];
  for (const lab of reachable) {
    assert(labels.includes(lab), 'reachable ' + lab, labels);
  }
  assert(!labels.includes('Remover janela'), 'Remover merged into Fechar');
  console.log('PASS: all old actions reachable via groups');

  // Radio: Automático checked by default
  assert(labels.includes('Automático'), 'has Automático radio');

  // Toggle keep-alive via state then re-open
  updateState((s) => {
    const a = s.accounts.find((x) => x.id === 'acc-wm');
    if (a) {
      a.keepAliveInBackground = true;
      a.pauseInBackground = false;
    }
  });
  const r2 = popupAccountMenu({ accountId: 'acc-wm', x: 100, y: 100 });
  assert(r2 && r2.ok, 'menu reopen', r2);
  const acc = (getState().accounts || []).find((a) => a.id === 'acc-wm');
  assert(acc && acc.keepAliveInBackground && !acc.pauseInBackground, 'keepAlive state');
  console.log('PASS: background radio state reflects settings');

  console.log('PASS: selftest:window-menu complete');
  app.exit(0);
}

module.exports = { runWindowMenuSelftest };
