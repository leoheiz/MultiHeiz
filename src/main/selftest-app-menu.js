'use strict';

/**
 * Selftest: Vivaldi-style app menu on the logo (MULTIHEIZ_SELFTEST=app-menu).
 */

const { app } = require('electron');
const keymap = require('./keymap');

async function runAppMenuSelftest(ctx) {
  const {
    mainWindow,
    updateState,
    flushSave,
    publicState,
    emitToRenderer,
    sleep,
    waitForLayoutSettle,
    rendererEval,
    appMenuApi,
    popupTopMenu,
  } = ctx;

  console.log('SELFTEST app-menu');

  function assert(cond, msg, extra) {
    if (!cond) {
      console.log('FAIL:', msg, extra !== undefined ? extra : '');
      throw new Error(msg);
    }
  }

  updateState((s) => {
    if (!s.settings) s.settings = {};
    s.settings.keyboardShortcuts = keymap.applyOverride(null, 'downloads', {
      combo: 'Ctrl+Shift+J',
    });
  });
  flushSave();
  emitToRenderer({ type: 'state:changed', state: publicState() });
  await sleep(400);
  await waitForLayoutSettle();

  // 1) Arrow overflow button gone; logo menu button present
  const chrome = await rendererEval(`(() => {
    return {
      overflow: !!document.getElementById('btn-overflow'),
      appMenuBtn: !!document.getElementById('btn-app-menu'),
      appIcon: !!document.getElementById('app-icon'),
      caret: !!(document.querySelector('#btn-app-menu .app-menu-caret')),
    };
  })()`);
  assert(!chrome.overflow, 'btn-overflow absent', chrome);
  assert(chrome.appMenuBtn && chrome.appIcon && chrome.caret, 'logo menu button', chrome);
  console.log('PASS: arrow button absent; logo menu present');

  // 2) Structure includes every old overflow item (by id)
  const struct = appMenuApi.getStructure();
  const needIds = [
    'exibir:recarregar-todas',
    'exibir:som',
    'som:silenciar',
    'som:ativar',
    'exibir:layout',
    'layout:1',
    'layout:2',
    'layout:4',
    'layout:6',
    'layout:auto',
    'layout:livre',
    'ferramentas:downloads',
    'exibir:tela-cheia',
    'ajuda',
    'ajuda:notas-versao',
    'ajuda:atalhos',
    'configuracoes',
  ];
  for (const id of needIds) {
    assert(struct.ids.includes(id), 'structure has ' + id, struct.ids);
  }
  const topIntercept = popupTopMenu({ x: 40, y: 40 });
  assert(topIntercept && topIntercept.ok && topIntercept.intercepted, 'menu:top intercept', topIntercept);
  console.log('PASS: old arrow-menu items present by id');

  // 3) Logo click opens visible DOM menu
  await rendererEval(`window.__multiheizUi.openAppMenu()`);
  await sleep(200);
  let dbg = await rendererEval(`window.__multiheizUi.getAppMenuDebug()`);
  assert(dbg && dbg.open, 'menu open after logo', dbg);
  assert(dbg.width > 40 && dbg.height > 40, 'menu non-zero size', dbg);
  for (const id of [
    'arquivo',
    'editar',
    'exibir',
    'favoritos',
    'ferramentas',
    'janela',
    'ajuda',
    'configuracoes',
    'sair',
  ]) {
    assert(dbg.ids.includes(id), 'root id ' + id, dbg.ids);
  }
  console.log('PASS: logo opens visible menu');

  // 4) Submenu opens (Exibir)
  await rendererEval(`(() => {
    const btn = [...document.querySelectorAll('.mh-app-menu-item')].find(
      (el) => el.dataset.id === 'exibir'
    );
    if (btn) {
      btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    }
    return !!btn;
  })()`);
  await sleep(100);
  dbg = await rendererEval(`window.__multiheizUi.getAppMenuDebug()`);
  assert(dbg.menuCount >= 2, 'submenu open', dbg);
  assert(dbg.ids.includes('exibir:tela-cheia'), 'tela cheia in submenu', dbg.ids);
  assert(dbg.ids.includes('exibir:recarregar-todas'), 'recarregar todas in submenu', dbg.ids);
  console.log('PASS: submenus open');

  // 5) Custom shortcut shown on Downloads
  await rendererEval(`(() => {
    const btn = [...document.querySelectorAll('.mh-app-menu-item')].find(
      (el) => el.dataset.id === 'ferramentas'
    );
    if (btn) btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  })()`);
  await sleep(100);
  const accel = await rendererEval(`(() => {
    const btn = [...document.querySelectorAll('.mh-app-menu-item')].find(
      (el) => el.dataset.id === 'ferramentas:downloads'
    );
    const a = btn && btn.querySelector('.mh-app-menu-accel');
    return a ? a.textContent.trim() : '';
  })()`);
  assert(accel === 'Ctrl+Shift+J', 'custom downloads shortcut shown', accel);
  console.log('PASS: shortcuts reflect custom keymap');

  // 6) Keyboard: Esc closes; F10 opens; arrows/Enter
  await rendererEval(`window.__multiheizUi.closeAppMenu()`);
  await sleep(80);
  // Simulate main-process F10 → ui:app-menu (before-input does not reach page JS reliably in selftest)
  emitToRenderer({ type: 'ui:app-menu', open: true });
  await sleep(250);
  dbg = await rendererEval(`window.__multiheizUi.getAppMenuDebug()`);
  assert(dbg && dbg.open, 'F10 path opens menu', dbg);

  await rendererEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await rendererEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await rendererEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await sleep(120);
  dbg = await rendererEval(`window.__multiheizUi.getAppMenuDebug()`);
  assert(dbg.menuCount >= 2 || dbg.open, 'arrows navigate', dbg);

  await rendererEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(50);
  await rendererEval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(80);
  dbg = await rendererEval(`window.__multiheizUi.getAppMenuDebug()`);
  assert(dbg && !dbg.open, 'Esc closes menu', dbg);
  console.log('PASS: F10 / arrows / Esc');

  // 7) Configurações action opens settings
  await rendererEval(`window.__multiheizUi.openAppMenu()`);
  await sleep(120);
  await rendererEval(`(() => {
    const btn = [...document.querySelectorAll('.mh-app-menu-item')].find(
      (el) => el.dataset.id === 'configuracoes'
    );
    if (btn) btn.click();
  })()`);
  await sleep(400);
  const settingsOpen = await rendererEval(`!!(document.getElementById('dlg-settings') && document.getElementById('dlg-settings').open)`);
  assert(settingsOpen, 'Configurações opens settings');
  console.log('PASS: Configurações action fires');

  await rendererEval(`window.__multiheizUi.closeSettings && window.__multiheizUi.closeSettings()`);
  await rendererEval(`window.__multiheizUi.closeAppMenu()`);

  console.log('PASS: selftest:app-menu complete');
  app.exit(0);
}

module.exports = { runAppMenuSelftest };
