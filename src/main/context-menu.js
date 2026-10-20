'use strict';

/**
 * Menu de contexto nativo (botão direito) dos painéis.
 *
 * Extensões (chrome.contextMenus): não integrado — a API de extensões
 * atual não expõe um gancho trivial para mesclar itens no Menu nativo;
 * fica de fora desta versão.
 */

const { classifyScheme, isNavigableUrl } = require('./url-policy');

function electronApi() {
  return require('electron');
}

const SEARCH_SNIPPET_MAX = 30;

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function truncateForLabel(text, max = SEARCH_SNIPPET_MAX) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Remove separadores duplicados / iniciais / finais.
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
function compactSeparators(items) {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (it.type === 'separator') {
      if (!out.length) continue;
      if (out[out.length - 1].type === 'separator') continue;
      out.push({ type: 'separator' });
      continue;
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isOpenableHttpUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  return classifyScheme(u) === 'web' && isNavigableUrl(u);
}

/**
 * Gera o template do menu a partir dos params do evento context-menu e do
 * estado de navegação. Puro / testável (sem Menu.popup).
 *
 * @param {object} params  Electron ContextMenuParams (ou equivalente)
 * @param {{ canGoBack?: boolean, canGoForward?: boolean }} [nav]
 * @returns {Array<{
 *   id?: string,
 *   type?: string,
 *   label?: string,
 *   enabled?: boolean,
 *   url?: string,
 *   searchText?: string,
 *   suggestion?: string,
 * }>}
 */
function buildContextMenuTemplate(params, nav = {}) {
  const p = params || {};
  const editFlags = p.editFlags || {};
  const items = [];

  const misspelled = String(p.misspelledWord || '');
  if (misspelled) {
    const suggestions = Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions : [];
    for (const s of suggestions) {
      const label = String(s || '');
      if (!label) continue;
      items.push({
        id: 'spell-replace',
        label,
        enabled: true,
        suggestion: label,
      });
    }
    items.push({
      id: 'spell-add',
      label: 'Adicionar ao dicionário',
      enabled: true,
    });
    items.push({ type: 'separator' });
  }

  // Sempre no topo (após corretor): Voltar / Avançar / Recarregar
  items.push(
    {
      id: 'back',
      label: 'Voltar',
      enabled: !!nav.canGoBack,
    },
    {
      id: 'forward',
      label: 'Avançar',
      enabled: !!nav.canGoForward,
    },
    {
      id: 'reload',
      label: 'Recarregar',
      enabled: true,
    }
  );

  if (p.isEditable) {
    items.push({ type: 'separator' });
    items.push(
      {
        id: 'undo',
        label: 'Desfazer',
        enabled: !!editFlags.canUndo,
      },
      {
        id: 'redo',
        label: 'Refazer',
        enabled: !!editFlags.canRedo,
      },
      {
        id: 'cut',
        label: 'Recortar',
        enabled: !!editFlags.canCut,
      },
      {
        id: 'copy',
        label: 'Copiar',
        enabled: !!editFlags.canCopy,
      },
      {
        id: 'paste',
        label: 'Colar',
        enabled: !!editFlags.canPaste,
      },
      {
        id: 'pasteAndMatchStyle',
        label: 'Colar sem formatação',
        enabled: !!editFlags.canPasteAndMatchStyle,
      },
      {
        id: 'selectAll',
        label: 'Selecionar tudo',
        enabled: editFlags.canSelectAll !== false,
      }
    );
  }

  const selection = String(p.selectionText || '').trim();
  if (selection) {
    if (!p.isEditable) {
      items.push({ type: 'separator' });
      items.push({
        id: 'copy',
        label: 'Copiar',
        enabled: true,
      });
    }
    const snippet = truncateForLabel(selection);
    items.push({
      id: 'search-google',
      label: `Pesquisar "${snippet}" no Google`,
      enabled: true,
      searchText: selection,
    });
  }

  const linkURL = String(p.linkURL || '');
  if (linkURL) {
    items.push({ type: 'separator' });
    items.push({
      id: 'open-link',
      label: 'Abrir link em nova janela',
      enabled: isOpenableHttpUrl(linkURL),
      url: linkURL,
    });
    items.push({
      id: 'copy-link',
      label: 'Copiar endereço do link',
      enabled: true,
      url: linkURL,
    });
  }

  if (p.mediaType === 'image') {
    const srcURL = String(p.srcURL || '');
    items.push({ type: 'separator' });
    items.push({
      id: 'open-image',
      label: 'Abrir imagem em nova janela',
      enabled: isOpenableHttpUrl(srcURL),
      url: srcURL,
    });
    items.push({
      id: 'save-image',
      label: 'Salvar imagem como…',
      enabled: !!srcURL,
      url: srcURL,
    });
    items.push({
      id: 'copy-image',
      label: 'Copiar imagem',
      enabled: true,
    });
    items.push({
      id: 'copy-image-url',
      label: 'Copiar endereço da imagem',
      enabled: !!srcURL,
      url: srcURL,
    });
  }

  items.push({ type: 'separator' });
  items.push({
    id: 'inspect',
    label: 'Inspecionar elemento',
    enabled: true,
  });

  return compactSeparators(items);
}

/**
 * @param {import('electron').WebContents} wc
 * @returns {{ canGoBack: boolean, canGoForward: boolean }}
 */
function readNavState(wc) {
  let canGoBack = false;
  let canGoForward = false;
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
      canGoBack = !!wc.navigationHistory.canGoBack();
    } else if (typeof wc.canGoBack === 'function') {
      canGoBack = !!wc.canGoBack();
    }
  } catch {
    canGoBack = false;
  }
  try {
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoForward === 'function') {
      canGoForward = !!wc.navigationHistory.canGoForward();
    } else if (typeof wc.canGoForward === 'function') {
      canGoForward = !!wc.canGoForward();
    }
  } catch {
    canGoForward = false;
  }
  return { canGoBack, canGoForward };
}

/**
 * Converte descritores puros em template Electron com click handlers.
 * @param {ReturnType<typeof buildContextMenuTemplate>} descriptors
 * @param {import('electron').WebContents} wc
 * @param {object} params
 * @param {{
 *   openInNewWindow?: (url: string) => void,
 *   getWindow?: () => import('electron').BrowserWindow | null,
 * }} actions
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function descriptorsToElectronTemplate(descriptors, wc, params, actions) {
  const openInNewWindow =
    typeof actions.openInNewWindow === 'function' ? actions.openInNewWindow : null;

  return descriptors.map((d) => {
    if (d.type === 'separator') return { type: 'separator' };

    /** @type {Electron.MenuItemConstructorOptions} */
    const item = {
      label: d.label,
      enabled: d.enabled !== false,
    };

    item.click = () => {
      try {
        runContextAction(d, wc, params, openInNewWindow);
      } catch (err) {
        console.warn('[context-menu]', err && err.message ? err.message : err);
      }
    };
    return item;
  });
}

/**
 * @param {object} d
 * @param {import('electron').WebContents} wc
 * @param {object} params
 * @param {((url: string) => void)|null} openInNewWindow
 */
function runContextAction(d, wc, params, openInNewWindow) {
  if (!wc || wc.isDestroyed()) return;
  const id = d.id;
  const x = Number(params && params.x) || 0;
  const y = Number(params && params.y) || 0;

  switch (id) {
    case 'back':
      if (wc.navigationHistory && typeof wc.navigationHistory.goBack === 'function') {
        wc.navigationHistory.goBack();
      } else if (typeof wc.goBack === 'function') {
        wc.goBack();
      }
      break;
    case 'forward':
      if (wc.navigationHistory && typeof wc.navigationHistory.goForward === 'function') {
        wc.navigationHistory.goForward();
      } else if (typeof wc.goForward === 'function') {
        wc.goForward();
      }
      break;
    case 'reload':
      wc.reload();
      break;
    case 'undo':
      wc.undo();
      break;
    case 'redo':
      wc.redo();
      break;
    case 'cut':
      wc.cut();
      break;
    case 'copy':
      wc.copy();
      break;
    case 'paste':
      wc.paste();
      break;
    case 'pasteAndMatchStyle':
      if (typeof wc.pasteAndMatchStyle === 'function') wc.pasteAndMatchStyle();
      else wc.paste();
      break;
    case 'selectAll':
      wc.selectAll();
      break;
    case 'search-google': {
      const q = encodeURIComponent(String(d.searchText || ''));
      const url = `https://www.google.com/search?q=${q}`;
      if (openInNewWindow) openInNewWindow(url);
      break;
    }
    case 'open-link':
    case 'open-image': {
      const url = String(d.url || '');
      if (!isOpenableHttpUrl(url)) return;
      if (openInNewWindow) openInNewWindow(url);
      break;
    }
    case 'copy-link':
    case 'copy-image-url':
      electronApi().clipboard.writeText(String(d.url || ''));
      break;
    case 'save-image': {
      const url = String(d.url || '');
      if (!url) return;
      try {
        wc.downloadURL(url);
      } catch {
        /* ignore */
      }
      break;
    }
    case 'copy-image':
      if (typeof wc.copyImageAt === 'function') wc.copyImageAt(x, y);
      break;
    case 'spell-replace':
      if (d.suggestion && typeof wc.replaceMisspelling === 'function') {
        wc.replaceMisspelling(String(d.suggestion));
      }
      break;
    case 'spell-add': {
      const word = String((params && params.misspelledWord) || '');
      if (word && wc.session && typeof wc.session.addWordToSpellCheckerDictionary === 'function') {
        wc.session.addWordToSpellCheckerDictionary(word);
      }
      break;
    }
    case 'inspect':
      wc.inspectElement(x, y);
      break;
    default:
      break;
  }
}

/**
 * Liga o menu de contexto ao webContents.
 * Em MULTIHEIZ_SELFTEST não chama menu.popup (nada visível na tela).
 *
 * @param {import('electron').WebContents} webContents
 * @param {{
 *   openInNewWindow?: (url: string) => void,
 *   getWindow?: () => import('electron').BrowserWindow | null,
 *   onTemplate?: (template: ReturnType<typeof buildContextMenuTemplate>, params: object) => void,
 * }} [options]
 * @returns {() => void} detach
 */
function attachContextMenu(webContents, options = {}) {
  if (!webContents || typeof webContents.on !== 'function') {
    return () => {};
  }

  const onContextMenu = (_event, params) => {
    const nav = readNavState(webContents);
    const descriptors = buildContextMenuTemplate(params || {}, nav);
    if (typeof options.onTemplate === 'function') {
      try {
        options.onTemplate(descriptors, params || {});
      } catch {
        /* ignore */
      }
    }

    // Selftest: nunca popup / diálogo visível
    if (process.env.MULTIHEIZ_SELFTEST) {
      return;
    }

    const electronTemplate = descriptorsToElectronTemplate(
      descriptors,
      webContents,
      params || {},
      {
        openInNewWindow: options.openInNewWindow,
        getWindow: options.getWindow,
      }
    );
    const { Menu } = electronApi();
    const menu = Menu.buildFromTemplate(electronTemplate);
    const win = typeof options.getWindow === 'function' ? options.getWindow() : null;
    const popupOpts = {
      x: Math.round(Number(params && params.x) || 0),
      y: Math.round(Number(params && params.y) || 0),
    };
    if (win && !win.isDestroyed()) {
      popupOpts.window = win;
    }
    menu.popup(popupOpts);
  };

  webContents.on('context-menu', onContextMenu);
  return () => {
    try {
      if (!webContents.isDestroyed()) {
        webContents.removeListener('context-menu', onContextMenu);
      }
    } catch {
      /* ignore */
    }
  };
}

module.exports = {
  buildContextMenuTemplate,
  attachContextMenu,
  truncateForLabel,
  compactSeparators,
  isOpenableHttpUrl,
  readNavState,
};
