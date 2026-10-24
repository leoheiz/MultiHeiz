'use strict';

/**
 * Vivaldi-style application menu (structure + actions).
 * Renderer shows a DOM dropdown; main owns labels, shortcuts and side-effects.
 */

const { app, MenuItem } = require('electron');
const keymap = require('./keymap');

/** @typedef {{ id?: string, label?: string, type?: string, shortcut?: string, shortcutId?: string, icon?: string, checked?: boolean, enabled?: boolean, children?: AppMenuNode[] }} AppMenuNode */

/**
 * @param {object} deps
 * @param {() => object} deps.getState
 * @param {(fn: (s: object) => void) => void} deps.updateState
 * @param {() => object} deps.publicState
 * @param {(payload: object) => void} deps.emitToRenderer
 * @param {typeof import('./panels')} deps.panels
 * @param {object} deps.chromeFullscreen
 * @param {() => import('electron').BrowserWindow|null} deps.getMainWindow
 * @param {(actionId: string) => void} [deps.runPanelAction]
 * @param {(layout: string) => void} [deps.normalizeLayout]
 */
function createAppMenu(deps) {
  const {
    getState,
    updateState,
    publicState,
    emitToRenderer,
    panels,
    chromeFullscreen,
    getMainWindow,
    runPanelAction,
    normalizeLayout,
  } = deps;

  /**
   * @param {string} id
   * @returns {string|undefined}
   */
  function shortcutFor(id) {
    const ks = (getState().settings && getState().settings.keyboardShortcuts) || null;
    const r = keymap.resolveShortcut(ks, id);
    if (r.disabled || !r.combo) return undefined;
    return r.combo;
  }

  /**
   * @returns {AppMenuNode[]}
   */
  function buildStructure() {
    const st = getState();
    const layout = typeof normalizeLayout === 'function' ? normalizeLayout(st.layout) : st.layout;
    /** @type {{ value: string, label: string }[]} */
    const layoutOpts = [
      { value: '1', label: '1' },
      { value: '2', label: '2' },
      { value: '4', label: '4' },
      { value: '6', label: '6' },
      { value: 'auto', label: 'Auto' },
      { value: 'livre', label: 'Livre' },
    ];

    /** @type {AppMenuNode[]} */
    const favChildren = [];
    try {
      const bookmarks = require('./bookmarks');
      const list = bookmarks.list();
      const items = (list && list.items) || [];
      for (const it of items.slice(0, 30)) {
        if (!it || !it.url) continue;
        favChildren.push({
          id: 'favoritos:item:' + String(it.id || it.url),
          label: String(it.name || it.title || it.url).slice(0, 64),
          data: { url: it.url, name: it.name || it.title || 'Favorito' },
        });
      }
    } catch {
      /* ignore */
    }
    if (!favChildren.length) {
      favChildren.push({ id: 'favoritos:empty', label: '(nenhum favorito)', enabled: false });
    }
    favChildren.push({ type: 'separator' });
    favChildren.push({
      id: 'favoritos:gerenciar',
      label: 'Gerenciar favoritos…',
      shortcut: shortcutFor('favorite'),
      shortcutId: 'favorite',
    });

    /** @type {AppMenuNode[]} */
    const root = [
      {
        id: 'arquivo',
        label: 'Arquivo',
        children: [
          {
            id: 'arquivo:nova-janela',
            label: 'Nova janela',
            shortcut: shortcutFor('newWindow'),
            shortcutId: 'newWindow',
          },
          { id: 'arquivo:nova-area', label: 'Nova área' },
          { type: 'separator' },
          { id: 'arquivo:sair', label: 'Sair' },
        ],
      },
      {
        id: 'editar',
        label: 'Editar',
        children: [
          { id: 'editar:desfazer', label: 'Desfazer', shortcut: 'Ctrl+Z' },
          { id: 'editar:refazer', label: 'Refazer', shortcut: 'Ctrl+Y' },
          { type: 'separator' },
          { id: 'editar:recortar', label: 'Recortar', shortcut: 'Ctrl+X' },
          { id: 'editar:copiar', label: 'Copiar', shortcut: 'Ctrl+C' },
          { id: 'editar:colar', label: 'Colar', shortcut: 'Ctrl+V' },
          { id: 'editar:selecionar-tudo', label: 'Selecionar tudo', shortcut: 'Ctrl+A' },
          { type: 'separator' },
          {
            id: 'editar:localizar',
            label: 'Localizar…',
            shortcut: shortcutFor('find'),
            shortcutId: 'find',
          },
        ],
      },
      {
        id: 'exibir',
        label: 'Exibir',
        children: [
          {
            id: 'exibir:tela-cheia',
            label: 'Tela cheia',
            shortcut: shortcutFor('fullscreen') || 'F11',
            shortcutId: 'fullscreen',
          },
          { type: 'separator' },
          {
            id: 'exibir:zoom-in',
            label: 'Aumentar zoom',
            shortcut: shortcutFor('zoomIn'),
            shortcutId: 'zoomIn',
          },
          {
            id: 'exibir:zoom-out',
            label: 'Diminuir zoom',
            shortcut: shortcutFor('zoomOut'),
            shortcutId: 'zoomOut',
          },
          {
            id: 'exibir:zoom-reset',
            label: 'Redefinir zoom',
            shortcut: shortcutFor('zoomReset'),
            shortcutId: 'zoomReset',
          },
          { type: 'separator' },
          {
            id: 'exibir:layout',
            label: 'Layout',
            children: layoutOpts.map((o) => ({
              id: 'layout:' + o.value,
              label: o.label,
              type: 'radio',
              checked: layout === o.value,
            })),
          },
          { id: 'exibir:recarregar-todas', label: 'Recarregar todas' },
          {
            id: 'exibir:som',
            label: 'Som',
            children: [
              { id: 'som:silenciar', label: 'Silenciar todas' },
              { id: 'som:ativar', label: 'Ativar som' },
            ],
          },
        ],
      },
      {
        id: 'favoritos',
        label: 'Favoritos',
        children: favChildren,
      },
      {
        id: 'ferramentas',
        label: 'Ferramentas',
        children: [
          {
            id: 'ferramentas:downloads',
            label: 'Downloads',
            shortcut: shortcutFor('downloads'),
            shortcutId: 'downloads',
          },
          {
            id: 'ferramentas:historico',
            label: 'Histórico',
            shortcut: shortcutFor('history'),
            shortcutId: 'history',
          },
          { id: 'ferramentas:memoria', label: 'Monitor de memória' },
          { id: 'ferramentas:extensoes', label: 'Extensões' },
          { type: 'separator' },
          { id: 'ferramentas:notas', label: 'Notas' },
          { id: 'ferramentas:alarmes', label: 'Alarmes' },
          { id: 'ferramentas:planilha', label: 'Planilha' },
        ],
      },
      {
        id: 'janela',
        label: 'Janela',
        children: [
          {
            id: 'janela:nova-janela',
            label: 'Nova janela',
            shortcut: shortcutFor('newWindow'),
            shortcutId: 'newWindow',
          },
          { id: 'janela:login-navegador', label: 'Abrir login no navegador padrão' },
          { type: 'separator' },
          { id: 'janela:minimizar', label: 'Minimizar' },
          { id: 'janela:fechar', label: 'Fechar' },
        ],
      },
      {
        id: 'ajuda',
        label: 'Ajuda',
        children: [
          { id: 'ajuda:notas-versao', label: 'Notas de versão' },
          { id: 'ajuda:atalhos', label: 'Atalhos' },
          { id: 'ajuda:sobre', label: 'Sobre' },
          { id: 'ajuda:diagnostico', label: 'Diagnóstico' },
        ],
      },
      { type: 'separator' },
      {
        id: 'configuracoes',
        label: 'Configurações',
        shortcut: 'Ctrl+,',
        icon: 'settings',
      },
      { id: 'sair', label: 'Sair' },
    ];

    return root;
  }

  /**
   * Flatten labels for legacy selftests (v18/v19).
   * @param {AppMenuNode[]} nodes
   * @param {string[]} out
   */
  function collectLabels(nodes, out) {
    for (const n of nodes || []) {
      if (!n || n.type === 'separator') continue;
      if (n.label) out.push(String(n.label));
      if (Array.isArray(n.children)) collectLabels(n.children, out);
    }
  }

  /**
   * @returns {{ tree: AppMenuNode[], labels: string[], ids: string[] }}
   */
  function getStructure() {
    const tree = buildStructure();
    const labels = [];
    collectLabels(tree, labels);
    const ids = [];
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (!n || n.type === 'separator') continue;
        if (n.id) ids.push(n.id);
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    return { tree, labels, ids };
  }

  /**
   * @param {string} role
   */
  function runEditRole(role) {
    try {
      const item = new MenuItem({ role });
      const win = getMainWindow && getMainWindow();
      if (typeof item.click === 'function') {
        item.click(item, win || undefined, undefined);
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      const id = panels.getFocusedAccountId && panels.getFocusedAccountId();
      if (id && runPanelAction) {
        /* edit roles aren't panel actions */
      }
      const win = getMainWindow && getMainWindow();
      const wc = win && !win.isDestroyed() ? win.webContents : null;
      if (wc && typeof wc[role] === 'function') wc[role]();
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {string} actionId
   * @param {object} [data]
   * @returns {{ ok: boolean, reason?: string }}
   */
  function runAction(actionId, data) {
    const id = String(actionId || '');
    const st = getState();

    if (id.startsWith('favoritos:item:')) {
      const url = data && data.url;
      if (url) {
        emitToRenderer({
          type: 'ui:create-from-favorite',
          url,
          name: (data && data.name) || 'Favorito',
        });
      }
      return { ok: true };
    }

    switch (id) {
      case 'arquivo:nova-janela':
      case 'janela:nova-janela':
        emitToRenderer({ type: 'ui:new-account' });
        return { ok: true };
      case 'arquivo:nova-area':
        emitToRenderer({ type: 'ui:new-workspace' });
        return { ok: true };
      case 'arquivo:sair':
      case 'sair':
        app.quit();
        return { ok: true };
      case 'editar:desfazer':
        runEditRole('undo');
        return { ok: true };
      case 'editar:refazer':
        runEditRole('redo');
        return { ok: true };
      case 'editar:recortar':
        runEditRole('cut');
        return { ok: true };
      case 'editar:copiar':
        runEditRole('copy');
        return { ok: true };
      case 'editar:colar':
        runEditRole('paste');
        return { ok: true };
      case 'editar:selecionar-tudo':
        runEditRole('selectAll');
        return { ok: true };
      case 'editar:localizar':
        if (runPanelAction) runPanelAction('find');
        return { ok: true };
      case 'exibir:tela-cheia':
        if (chromeFullscreen && typeof chromeFullscreen.toggle === 'function') {
          chromeFullscreen.toggle();
        }
        return { ok: true };
      case 'exibir:zoom-in':
        if (runPanelAction) runPanelAction('zoomIn');
        return { ok: true };
      case 'exibir:zoom-out':
        if (runPanelAction) runPanelAction('zoomOut');
        return { ok: true };
      case 'exibir:zoom-reset':
        if (runPanelAction) runPanelAction('zoomReset');
        return { ok: true };
      case 'exibir:recarregar-todas':
        panels.panelReloadAll(st.activeWorkspaceId);
        return { ok: true };
      case 'som:silenciar':
        panels.panelMuteAll(true, st.activeWorkspaceId);
        emitToRenderer({ type: 'state:changed', state: publicState() });
        return { ok: true };
      case 'som:ativar':
        panels.panelMuteAll(false, st.activeWorkspaceId);
        emitToRenderer({ type: 'state:changed', state: publicState() });
        return { ok: true };
      case 'layout:1':
      case 'layout:2':
      case 'layout:4':
      case 'layout:6':
      case 'layout:auto':
      case 'layout:livre': {
        const layout = id.slice('layout:'.length);
        const normalized =
          typeof normalizeLayout === 'function' ? normalizeLayout(layout) : layout;
        updateState((s) => {
          if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
            s.layoutByWorkspace = {};
          }
          s.layout = normalized;
          s.layoutByWorkspace[s.activeWorkspaceId] = normalized;
          s.page = 0;
          if (!s.pageByWorkspace) s.pageByWorkspace = {};
          s.pageByWorkspace[s.activeWorkspaceId] = 0;
          s.maximizedAccountId = null;
          if (!s.maximizedByWorkspace) s.maximizedByWorkspace = {};
          s.maximizedByWorkspace[s.activeWorkspaceId] = null;
        });
        emitToRenderer({ type: 'state:changed', state: publicState() });
        return { ok: true };
      }
      case 'favoritos:gerenciar':
        emitToRenderer({ type: 'ui:favorite' });
        return { ok: true };
      case 'ferramentas:downloads':
        emitToRenderer({ type: 'ui:downloads' });
        return { ok: true };
      case 'ferramentas:historico':
        emitToRenderer({ type: 'ui:history' });
        return { ok: true };
      case 'ferramentas:memoria':
        emitToRenderer({ type: 'ui:memory-monitor' });
        return { ok: true };
      case 'ferramentas:extensoes':
        emitToRenderer({ type: 'ui:open-settings-section', section: 'extensoes' });
        return { ok: true };
      case 'ferramentas:notas':
        emitToRenderer({ type: 'ui:open-module', moduleId: 'notas' });
        return { ok: true };
      case 'ferramentas:alarmes':
        emitToRenderer({ type: 'ui:open-module', moduleId: 'alarmes' });
        return { ok: true };
      case 'ferramentas:planilha':
        emitToRenderer({ type: 'ui:open-module', moduleId: 'planilha' });
        return { ok: true };
      case 'janela:login-navegador': {
        const focused = panels.getFocusedAccountId && panels.getFocusedAccountId();
        if (focused) {
          const r = panels.openLoginInSystemBrowser(focused);
          if (r && r.ok) {
            emitToRenderer({ type: 'toast', message: 'Abrindo no navegador padrão…' });
          }
        }
        return { ok: true };
      }
      case 'janela:minimizar': {
        const win = getMainWindow && getMainWindow();
        if (win && !win.isDestroyed()) win.minimize();
        return { ok: true };
      }
      case 'janela:fechar': {
        const win = getMainWindow && getMainWindow();
        if (win && !win.isDestroyed()) win.close();
        return { ok: true };
      }
      case 'ajuda:notas-versao':
        emitToRenderer({ type: 'ui:novidades', reason: 'menu', auto: false });
        return { ok: true };
      case 'ajuda:atalhos':
        emitToRenderer({ type: 'ui:help-shortcuts' });
        return { ok: true };
      case 'ajuda:sobre':
        emitToRenderer({ type: 'ui:open-settings-section', section: 'sobre' });
        return { ok: true };
      case 'ajuda:diagnostico':
        emitToRenderer({ type: 'ui:open-settings-section', section: 'diagnosticos' });
        return { ok: true };
      case 'configuracoes':
        emitToRenderer({ type: 'ui:open-settings' });
        return { ok: true };
      default:
        return { ok: false, reason: 'unknown' };
    }
  }

  /**
   * Legacy native popup used by selftests / lag-audit.
   * @param {{ x?: number, y?: number, intercept?: boolean }} opts
   */
  function popupTopMenu(opts) {
    const x = Math.round(Number(opts && opts.x) || 0);
    const y = Math.round(Number(opts && opts.y) || 0);
    const { tree, labels, ids } = getStructure();
    const intercept = !!(opts && opts.intercept);
    if (intercept) {
      return { ok: true, intercepted: true, labels, ids, tree, x, y };
    }
    // Prefer DOM menu in the renderer (Vivaldi-style).
    emitToRenderer({ type: 'ui:app-menu', open: true, x, y, tree });
    return { ok: true, intercepted: false, labels, ids, x, y, dom: true };
  }

  return {
    buildStructure,
    getStructure,
    runAction,
    popupTopMenu,
    collectLabels,
  };
}

module.exports = { createAppMenu };
