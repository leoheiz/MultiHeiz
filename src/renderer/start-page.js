'use strict';

/**
 * Start page: omnibox, favorites bar, Apps (built-in catalog + custom sites), most visited.
 * Attaches window.MultiHeizStartPage. pt-BR UI. No network favicon fetches.
 *
 * Two modes (api.mode):
 *  - 'workspace': empty area (no windows) — choosing something creates a new window;
 *  - 'panel': a pending "Nova janela" — choosing something navigates THAT window
 *    (api.commitChoice / api.openUrl get api.accountId through the host).
 *
 * Several pages can be mounted at once (empty area + pending windows), so all state
 * is per instance.
 */
(function () {
  /** @type {Set<object>} */
  const instances = new Set();
  /** Which page had the gear panel open (survives full grid re-renders). */
  let optionsOpenKey = '';

  function letterFor(url, title) {
    const t = String(title || '').trim();
    if (t) return t.charAt(0).toUpperCase();
    try {
      const h = new URL(url).hostname.replace(/^www\./i, '');
      return (h.charAt(0) || '?').toUpperCase();
    } catch {
      return '?';
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return '';
    }
  }

  function makeIcon(url, title, favicon, big) {
    const wrap = document.createElement('span');
    wrap.className = 'mh-start-tile-icon' + (big ? ' is-big' : '');
    const local = String(favicon || '');
    if (local && (local.startsWith('data:') || local.startsWith('file:') || local.startsWith('blob:'))) {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.src = local;
      img.addEventListener('error', () => {
        wrap.replaceChildren();
        wrap.textContent = letterFor(url, title);
        wrap.classList.add('is-letter');
      });
      wrap.appendChild(img);
    } else {
      wrap.textContent = letterFor(url, title);
      wrap.classList.add('is-letter');
    }
    return wrap;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** Client-side check for custom sites (main normalizes again). */
  function normalizeUrlClient(raw) {
    let s = String(raw || '').trim();
    if (!s || /\s/.test(s)) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[^/]*:\d+(\/|$)/.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      if (!u.hostname) return '';
      return u.toString();
    } catch {
      return '';
    }
  }

  const GEAR_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.1.6.6 1.1 1.5 1.2H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

  /**
   * @param {object} api
   * @param {'workspace'|'panel'} [api.mode]
   * @param {string} [api.accountId] pending window id (panel mode)
   * @param {boolean} [api.autofocus]
   * @param {() => object} api.getState
   * @param {(st: object) => void} api.applyState
   * @param {(url: string, title?: string, extra?: object) => Promise<void>} api.openUrl
   * @param {(choice: {type: string, url: string, title?: string, catalogId?: string}) => Promise<void>} [api.commitChoice]
   * @param {() => void} [api.openNewWindow]
   * @param {(accountId?: string) => void} [api.openAdvancedOptions]
   * @param {(msg: string) => void} [api.toast]
   */
  function build(api) {
    const mode = api.mode === 'panel' ? 'panel' : 'workspace';
    const inst = {
      api,
      mode,
      accountId: mode === 'panel' ? String(api.accountId || '') : '',
      key: mode === 'panel' ? 'panel:' + String(api.accountId || '') : 'workspace',
      data: null,
      seq: 0,
      created: Date.now(),
      dragId: '',
      root: /** @type {HTMLElement|null} */ (null),
    };

    const page = el('div', 'mh-start-page' + (mode === 'workspace' ? ' empty-hint' : ''));
    page.classList.add(mode === 'panel' ? 'is-panel' : 'is-workspace');
    page.dataset.mode = mode;
    if (inst.accountId) page.dataset.accountId = inst.accountId;
    page.setAttribute('role', 'main');
    page.setAttribute('aria-label', mode === 'panel' ? 'Página inicial da nova janela' : 'Página inicial da área');
    inst.root = page;

    // --- toolbar (gear top-right) ---
    const toolbar = el('div', 'mh-start-toolbar');
    if (mode === 'workspace' && typeof api.openNewWindow === 'function') {
      const btnNew = el('button', 'btn ghost mh-start-new', '+ Nova janela');
      btnNew.type = 'button';
      btnNew.title = 'Nova janela';
      btnNew.addEventListener('click', (e) => {
        e.stopPropagation();
        api.openNewWindow();
      });
      toolbar.appendChild(btnNew);
    }
    const btnGear = el('button', 'btn icon ghost mh-start-gear');
    btnGear.type = 'button';
    btnGear.title = 'Opções da página inicial';
    btnGear.setAttribute('aria-label', 'Opções da página inicial');
    btnGear.innerHTML = GEAR_SVG;
    btnGear.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOptions(inst);
    });
    toolbar.appendChild(btnGear);

    // --- centered column ---
    const column = el('div', 'mh-start-column');

    const omniboxWrap = el('div', 'mh-start-omnibox-wrap');
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'mh-start-omnibox';
    input.placeholder = 'Pesquisar ou digitar endereço';
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', 'Pesquisar ou digitar endereço');
    const suggest = el('ul', 'omnibox-suggest mh-start-suggest');
    suggest.hidden = true;
    suggest.setAttribute('role', 'listbox');
    omniboxWrap.append(input, suggest);

    const favBar = el('div', 'mh-start-favbar');
    favBar.hidden = true;

    const appsSection = el('section', 'mh-start-section mh-start-apps');
    appsSection.hidden = true;
    const appsTitle = el('h2', 'mh-start-section-title mh-start-apps-title', 'Apps');
    const appsGrid = el('div', 'mh-start-apps-grid');
    appsSection.append(appsTitle, appsGrid);

    const mvSection = el('section', 'mh-start-section mh-start-mv');
    mvSection.hidden = true;
    const mvTitle = el('h2', 'mh-start-section-title mh-start-mv-title', 'Mais acessados');
    const grid = el('div', 'mh-start-grid');
    mvSection.append(mvTitle, grid);

    const footer = el('div', 'mh-start-footer');
    const advanced = el('button', 'mh-start-advanced', 'Opções avançadas');
    advanced.type = 'button';
    advanced.title =
      mode === 'panel'
        ? 'Nome, cor, categoria e comportamento desta janela'
        : 'Criar janela com nome, cor, categoria e comportamento';
    advanced.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof api.openAdvancedOptions === 'function') {
        api.openAdvancedOptions(inst.accountId || undefined);
      }
    });
    if (typeof api.openAdvancedOptions === 'function') footer.appendChild(advanced);

    column.append(omniboxWrap, favBar, appsSection, mvSection, footer);
    page.append(toolbar, column);

    // Outside click closes menus / suggestions (not the gear panel — it has its own toggle).
    page.addEventListener('click', () => {
      closeMenus(inst);
      closeFavMenus(page);
    });

    inst.parts = { toolbar, favBar, appsSection, appsGrid, mvSection, grid, column, input, suggest };
    instances.add(inst);

    wireOmnibox(input, suggest, inst);
    if (optionsOpenKey === inst.key) toggleOptions(inst, true);
    void refreshInst(inst);
    if (api.autofocus) {
      requestAnimationFrame(() => {
        try {
          input.focus();
        } catch {
          /* ignore */
        }
      });
    }
    return page;
  }

  function liveInstances() {
    for (const inst of [...instances]) {
      if (!inst.root || !inst.root.isConnected) {
        // Not yet attached (build() returns before the host appends it) stays briefly;
        // pages that were attached and later replaced (grid re-render) are dropped.
        if (inst.attachedOnce || Date.now() - inst.created > 10000) instances.delete(inst);
      } else {
        inst.attachedOnce = true;
      }
    }
    return [...instances];
  }

  async function refreshInst(inst) {
    if (!window.multiheiz || !window.multiheiz.startPageGet) return;
    const root = inst.root;
    if (!root) return;
    const my = ++inst.seq;
    const st = inst.api.getState();
    const data = await window.multiheiz.startPageGet(st.activeWorkspaceId);
    if (my !== inst.seq) return;
    if (!root.isConnected) return;
    inst.attachedOnce = true;
    inst.data = data;
    render(inst);
  }

  async function refreshAll() {
    await Promise.all(
      liveInstances()
        .filter((i) => i.root && i.root.isConnected)
        .map((i) => refreshInst(i))
    );
  }

  /** Persist a patch (area opts + global Apps) and repaint every mounted page. */
  async function patchOpts(inst, patch) {
    const st = inst.api.getState();
    const res = await window.multiheiz.startPageSet({
      workspaceId: st.activeWorkspaceId,
      ...patch,
    });
    if (res && res.data) inst.data = res.data;
    if (res && res.state) inst.api.applyState(res.state);
    await refreshAll();
    return res;
  }

  function choose(inst, choice) {
    const api = inst.api;
    if (typeof api.commitChoice === 'function') return api.commitChoice(choice);
    return api.openUrl(choice.url, choice.title, choice);
  }

  // ---------------------------------------------------------------- render

  function render(inst) {
    const root = inst.root;
    const data = inst.data;
    if (!root || !data) return;
    const { favBar, appsSection, appsGrid, mvSection, grid } = inst.parts;
    const opts = data.opts || {};
    closeMenus(inst);
    renderFavBar(inst, favBar, data);
    renderApps(inst, appsSection, appsGrid, data, opts.showApps !== false);
    renderMostVisited(inst, mvSection, grid, data, opts.showMostVisited !== false);
    renderOptions(inst);
    root.dataset.ready = '1';
  }

  function renderFavBar(inst, favBar, data) {
    favBar.replaceChildren();
    const show = data.opts && data.opts.showFavoritesBar !== false;
    const items = (data.favoritesBar && data.favoritesBar.items) || [];
    const folders = (data.favoritesBar && data.favoritesBar.folders) || [];
    // Nothing to show → hide the bar (no empty strip).
    favBar.hidden = !show || (!items.length && !folders.length);
    if (favBar.hidden) return;
    for (const it of items) favBar.appendChild(favChip(inst, it));
    for (const folder of folders) favBar.appendChild(folderDropdown(inst, folder));
  }

  function favChip(inst, it) {
    const btn = el('button', 'mh-start-fav');
    btn.type = 'button';
    btn.title = it.url || it.title || '';
    btn.dataset.url = it.url || '';
    btn.append(makeIcon(it.url, it.title, it.favicon));
    btn.appendChild(el('span', '', it.title || it.url || 'Favorito'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void choose(inst, { type: 'favorite', url: it.url, title: it.title });
    });
    return btn;
  }

  function closeFavMenus(root) {
    root.querySelectorAll('.mh-start-fav-menu').forEach((m) => {
      m.hidden = true;
    });
  }

  function folderDropdown(inst, folder) {
    const wrap = el('div', 'mh-start-fav-folder');
    const btn = el('button', 'mh-start-fav is-folder', (folder.name || 'Pasta') + ' ▾');
    btn.type = 'button';
    const menu = el('div', 'mh-start-fav-menu');
    menu.hidden = true;
    for (const it of folder.items || []) {
      const row = el('button', 'mh-start-fav-menu-item', it.title || it.url || 'Favorito');
      row.type = 'button';
      row.dataset.url = it.url || '';
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = true;
        void choose(inst, { type: 'favorite', url: it.url, title: it.title });
      });
      menu.appendChild(row);
    }
    if (!(folder.items || []).length) {
      menu.appendChild(el('div', 'mh-start-fav-menu-empty', 'Pasta vazia'));
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = menu.hidden;
      closeFavMenus(inst.root);
      menu.hidden = !wasHidden;
    });
    wrap.append(btn, menu);
    return wrap;
  }

  // ------------------------------------------------------------------ Apps

  function renderApps(inst, section, appsGrid, data, show) {
    appsGrid.replaceChildren();
    section.hidden = !show;
    if (!show) return;
    for (const app of data.apps || []) {
      appsGrid.appendChild(appTile(inst, app));
    }
    const add = el('div', 'mh-start-tile mh-start-tile-add');
    add.setAttribute('role', 'button');
    add.tabIndex = 0;
    add.dataset.section = 'apps';
    add.title = 'Adicionar site personalizado';
    const plus = el('span', 'mh-start-tile-icon is-big is-letter', '+');
    add.append(plus, el('span', 'mh-start-tile-label', 'Site personalizado…'));
    const act = (e) => {
      e.stopPropagation();
      openAppDialog(inst, null);
    };
    add.addEventListener('click', act);
    add.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        act(e);
      }
    });
    appsGrid.appendChild(add);
  }

  function appTile(inst, app) {
    const custom = app.kind === 'custom';
    const tile = el('div', 'mh-start-tile mh-start-app' + (custom ? ' is-custom' : ' is-catalog'));
    tile.setAttribute('role', 'button');
    tile.tabIndex = 0;
    tile.dataset.url = app.url || '';
    tile.dataset.tileId = app.id || '';
    tile.dataset.kind = custom ? 'custom' : 'catalog';
    tile.dataset.section = 'apps';
    if (app.catalogId) tile.dataset.catalogId = app.catalogId;
    tile.title = app.title || app.url || '';
    tile.appendChild(makeIcon(app.url, app.title, app.favicon, true));
    tile.appendChild(el('span', 'mh-start-tile-label', app.title || hostOf(app.url) || 'Site'));

    if (custom) {
      tile.draggable = true;
      tile.addEventListener('dragstart', (e) => {
        inst.dragId = app.id;
        try {
          e.dataTransfer.setData('text/plain', app.id);
          e.dataTransfer.effectAllowed = 'move';
        } catch {
          /* ignore */
        }
      });
      tile.addEventListener('dragover', (e) => {
        e.preventDefault();
        tile.classList.add('drag-over');
      });
      tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
      tile.addEventListener('drop', (e) => {
        e.preventDefault();
        tile.classList.remove('drag-over');
        let from = inst.dragId;
        try {
          from = from || e.dataTransfer.getData('text/plain');
        } catch {
          /* ignore */
        }
        if (from && app.id && from !== app.id) void reorderCustom(inst, from, app.id);
      });
    }

    const more = el('span', 'mh-start-tile-more', '⋮');
    more.title = 'Mais opções';
    more.setAttribute('role', 'button');
    more.setAttribute('aria-label', 'Mais opções de ' + (app.title || 'app'));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openTileMenu(inst, tile, app, 'apps');
    });
    tile.appendChild(more);

    const open = () =>
      void choose(inst, {
        type: custom ? 'custom' : 'catalog',
        url: app.url,
        title: app.title,
        catalogId: app.catalogId || '',
      });
    tile.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.mh-start-tile-more, .mh-start-menu')) return;
      e.stopPropagation();
      open();
    });
    tile.addEventListener('keydown', (e) => {
      if (e.target !== tile) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTileMenu(inst, tile, app, 'apps');
    });
    return tile;
  }

  function closeMenus(inst) {
    if (!inst.root) return;
    inst.root.querySelectorAll('.mh-start-menu').forEach((m) => m.remove());
  }

  /**
   * Small inline menu on a tile.
   * custom app → Editar / Remover (inline confirm); built-in app → Ocultar;
   * most visited → Ocultar sugestão.
   */
  function openTileMenu(inst, tile, item, section) {
    const had = tile.querySelector('.mh-start-menu');
    closeMenus(inst);
    if (had) return;
    const menu = el('div', 'mh-start-menu');
    menu.setAttribute('role', 'menu');
    menu.addEventListener('click', (e) => e.stopPropagation());
    const addItem = (label, fn, cls) => {
      const b = el('button', 'mh-start-menu-item' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      menu.appendChild(b);
      return b;
    };
    if (section === 'apps' && item.kind === 'custom') {
      addItem('Editar', () => {
        closeMenus(inst);
        openAppDialog(inst, item);
      });
      addItem(
        'Remover',
        () => {
          // Inline confirm (no native confirm dialog).
          menu.replaceChildren();
          menu.appendChild(el('div', 'mh-start-menu-ask', 'Remover este site?'));
          const row = el('div', 'mh-start-menu-row');
          const yes = el('button', 'mh-start-menu-item is-danger', 'Remover');
          yes.type = 'button';
          yes.dataset.role = 'confirm-remove';
          yes.addEventListener('click', (e) => {
            e.stopPropagation();
            void removeCustom(inst, item.id);
          });
          const no = el('button', 'mh-start-menu-item', 'Cancelar');
          no.type = 'button';
          no.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenus(inst);
          });
          row.append(yes, no);
          menu.appendChild(row);
        },
        'is-danger'
      );
    } else if (section === 'apps') {
      addItem('Ocultar', () => {
        closeMenus(inst);
        void patchOpts(inst, { hideCatalogApp: item.catalogId });
      });
    } else {
      addItem('Ocultar sugestão', () => {
        closeMenus(inst);
        void hideSuggested(inst, item.url);
      });
    }
    tile.appendChild(menu);
  }

  // ------------------------------------------------------ add/edit custom site

  function openAppDialog(inst, existing) {
    const root = inst.root;
    if (!root) return;
    root.querySelectorAll('.mh-start-dialog-backdrop').forEach((n) => n.remove());
    closeMenus(inst);
    const backdrop = el('div', 'mh-start-dialog-backdrop');
    const form = el('form', 'mh-start-dialog');
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-label', existing ? 'Editar site' : 'Site personalizado');
    form.appendChild(el('div', 'mh-start-dialog-title', existing ? 'Editar site' : 'Site personalizado'));
    const lblName = el('label', 'mh-start-dialog-field');
    lblName.append('Nome');
    const inName = document.createElement('input');
    inName.type = 'text';
    inName.name = 'title';
    inName.maxLength = 80;
    inName.value = existing ? existing.title || '' : '';
    inName.placeholder = 'Meu site';
    lblName.appendChild(inName);
    const lblUrl = el('label', 'mh-start-dialog-field');
    lblUrl.append('Endereço');
    const inUrl = document.createElement('input');
    inUrl.type = 'text';
    inUrl.name = 'url';
    inUrl.maxLength = 2048;
    inUrl.setAttribute('spellcheck', 'false');
    inUrl.setAttribute('autocomplete', 'off');
    inUrl.value = existing ? existing.url || '' : '';
    inUrl.placeholder = 'exemplo.com ou https://…';
    lblUrl.appendChild(inUrl);
    const err = el('div', 'mh-start-dialog-error', 'Endereço inválido');
    err.hidden = true;
    err.setAttribute('role', 'alert');
    const row = el('div', 'mh-start-dialog-actions');
    const cancel = el('button', 'btn ghost', 'Cancelar');
    cancel.type = 'button';
    const save = el('button', 'btn primary', 'Salvar');
    save.type = 'submit';
    row.append(cancel, save);
    form.append(lblName, lblUrl, err, row);
    backdrop.appendChild(form);
    root.appendChild(backdrop);
    const close = () => backdrop.remove();
    cancel.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
      e.stopPropagation();
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = normalizeUrlClient(inUrl.value);
      if (!url) {
        err.hidden = false;
        try {
          inUrl.focus();
        } catch {
          /* ignore */
        }
        return;
      }
      const title = String(inName.value || '').trim() || hostOf(url) || 'Site';
      const cur = ((inst.data && inst.data.customTiles) || []).map((t) => ({ ...t }));
      let next;
      if (existing) {
        next = cur.map((t) => (t.id === existing.id ? { ...t, title, url } : t));
      } else {
        next = [
          ...cur,
          { id: 'ca-' + Date.now().toString(36), title, url, order: cur.length },
        ];
      }
      close();
      await patchOpts(inst, { customStartApps: next });
    });
    requestAnimationFrame(() => {
      try {
        (existing ? inName : inUrl).focus();
      } catch {
        /* ignore */
      }
    });
  }

  async function removeCustom(inst, id) {
    const cur = (inst.data && inst.data.customTiles) || [];
    const next = cur.filter((t) => t.id !== id).map((t, i) => ({ ...t, order: i }));
    await patchOpts(inst, { customStartApps: next });
  }

  async function reorderCustom(inst, fromId, toId) {
    const cur = [...((inst.data && inst.data.customTiles) || [])];
    const fromIdx = cur.findIndex((t) => t.id === fromId);
    const toIdx = cur.findIndex((t) => t.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = cur.splice(fromIdx, 1);
    cur.splice(toIdx, 0, moved);
    await patchOpts(inst, {
      customStartApps: cur.map((t, i) => ({ ...t, order: i })),
    });
  }

  async function hideSuggested(inst, url) {
    const hidden = [...((inst.data && inst.data.opts && inst.data.opts.hiddenSuggested) || [])];
    if (!hidden.includes(url)) hidden.push(url);
    await patchOpts(inst, { hiddenSuggested: hidden });
  }

  // ----------------------------------------------------------- most visited

  function renderMostVisited(inst, section, grid, data, show) {
    grid.replaceChildren();
    const list = show ? data.mostVisited || [] : [];
    section.hidden = !show || !list.length; // never a heading without tiles
    if (section.hidden) return;
    for (const t of list) grid.appendChild(mvTile(inst, t));
  }

  function mvTile(inst, t) {
    const tile = el('div', 'mh-start-tile mh-start-mv-tile');
    tile.setAttribute('role', 'button');
    tile.tabIndex = 0;
    tile.dataset.url = t.url || '';
    tile.dataset.tileId = t.id || '';
    tile.dataset.kind = t.kind || 'suggested';
    tile.dataset.section = 'mv';
    if (t.catalogId) tile.dataset.catalogId = t.catalogId;
    tile.title = t.url || t.title || '';
    tile.appendChild(makeIcon(t.url, t.title, t.favicon));
    tile.appendChild(el('span', 'mh-start-tile-label', t.title || hostOf(t.url) || 'Site'));
    const more = el('span', 'mh-start-tile-more', '⋮');
    more.title = 'Mais opções';
    more.setAttribute('role', 'button');
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openTileMenu(inst, tile, t, 'mv');
    });
    tile.appendChild(more);
    const open = () =>
      void choose(inst, {
        type: t.kind === 'catalog-fallback' ? 'catalog' : 'suggested',
        url: t.url,
        title: t.title,
        catalogId: t.catalogId || '',
      });
    tile.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.mh-start-tile-more, .mh-start-menu')) return;
      e.stopPropagation();
      open();
    });
    tile.addEventListener('keydown', (e) => {
      if (e.target !== tile) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTileMenu(inst, tile, t, 'mv');
    });
    return tile;
  }

  // ---------------------------------------------------------------- omnibox

  function wireOmnibox(input, list, inst) {
    /** @type {Array<object>} */
    let items = [];
    let activeIdx = -1;
    let timer = 0;
    let seq = 0;

    function kindLabel(kind) {
      if (kind === 'history') return 'Histórico';
      if (kind === 'favorite') return 'Favorito';
      if (kind === 'search') return 'Pesquisar';
      if (kind === 'remote') return 'Sugestão';
      return '';
    }

    function renderList() {
      list.replaceChildren();
      if (!items.length) {
        list.hidden = true;
        return;
      }
      list.hidden = false;
      items.forEach((item, idx) => {
        const li = document.createElement('li');
        li.className = 'omnibox-suggest-item' + (idx === activeIdx ? ' active' : '');
        li.setAttribute('role', 'option');
        const kind = el('span', 'omnibox-suggest-kind', kindLabel(item.kind));
        const title = el('span', 'omnibox-suggest-title', item.title || item.url || '');
        const url = el(
          'span',
          'omnibox-suggest-url',
          item.kind === 'search' ? '' : item.subtitle || item.url || ''
        );
        li.append(kind, title, url);
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          void activate(item);
        });
        list.appendChild(li);
      });
    }

    async function activate(item) {
      list.hidden = true;
      if (!item) return;
      if (item.kind === 'search' || item.kind === 'remote') {
        await choose(inst, {
          type: 'search',
          url: item.query || item.title || input.value,
          title: '',
        });
        return;
      }
      if (item.url) {
        await choose(inst, {
          type: item.kind === 'favorite' ? 'favorite' : 'history',
          url: item.url,
          title: item.title,
        });
      }
    }

    async function refresh() {
      const my = ++seq;
      const q = input.value;
      if (!window.multiheiz.omniboxSuggest) {
        items = [];
        renderList();
        return;
      }
      try {
        const res = await window.multiheiz.omniboxSuggest({ query: q });
        if (my !== seq) return;
        items = (res && res.items) || [];
        if (activeIdx >= items.length) activeIdx = items.length - 1;
        renderList();
      } catch {
        if (my !== seq) return;
        items = [];
        renderList();
      }
    }

    input.addEventListener('input', () => {
      activeIdx = -1;
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void refresh();
      }, 60);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        if (!items.length) return;
        e.preventDefault();
        activeIdx = (activeIdx + 1) % items.length;
        renderList();
        return;
      }
      if (e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        activeIdx = activeIdx <= 0 ? items.length - 1 : activeIdx - 1;
        renderList();
        return;
      }
      if (e.key === 'Escape') {
        list.hidden = true;
        items = [];
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (activeIdx >= 0 && items[activeIdx]) {
          void activate(items[activeIdx]);
          return;
        }
        const v = String(input.value || '').trim();
        if (v) void choose(inst, { type: 'url', url: v, title: '' });
      }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // ------------------------------------------------------------ gear options

  function toggleOptions(inst, forceOpen) {
    const page = inst.root;
    if (!page) return;
    let panel = page.querySelector('.mh-start-options');
    if (panel && !forceOpen) {
      panel.remove();
      if (optionsOpenKey === inst.key) optionsOpenKey = '';
      return;
    }
    if (panel) panel.remove();
    panel = el('div', 'mh-start-options');
    panel.addEventListener('click', (e) => e.stopPropagation());
    page.appendChild(panel);
    optionsOpenKey = inst.key;
    renderOptions(inst);
  }

  function renderOptions(inst) {
    const page = inst.root;
    const panel = page && page.querySelector('.mh-start-options');
    if (!panel) return;
    const data = inst.data || { opts: {} };
    const opts = data.opts || {};
    panel.replaceChildren();
    panel.appendChild(el('div', 'mh-start-options-title', 'Opções da página inicial'));

    const checkbox = (key, label) => {
      const lab = el('label', 'mh-start-opt');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.k = key;
      cb.checked = opts[key] !== false;
      cb.addEventListener('change', () => void patchOpts(inst, { [key]: !!cb.checked }));
      lab.append(cb, ' ' + label);
      return lab;
    };
    panel.appendChild(checkbox('showFavoritesBar', 'Mostrar barra de favoritos'));
    panel.appendChild(checkbox('showApps', 'Mostrar apps'));
    panel.appendChild(checkbox('showMostVisited', 'Mostrar mais acessados'));

    const rowsLab = el('label', 'mh-start-opt');
    rowsLab.append('Linhas de sugestões');
    const sel = document.createElement('select');
    sel.dataset.k = 'mostVisitedRows';
    for (const n of [1, 2, 3, 4]) {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = String(n);
      if (Number(opts.mostVisitedRows) === n) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => void patchOpts(inst, { mostVisitedRows: Number(sel.value) }));
    rowsLab.appendChild(sel);
    panel.appendChild(rowsLab);

    const hidden = data.hiddenCatalogApps || [];
    if (hidden.length) {
      panel.appendChild(el('div', 'mh-start-options-sub', 'Apps ocultos'));
      for (const h of hidden) {
        const row = el('div', 'mh-start-hidden-row');
        row.appendChild(el('span', 'mh-start-hidden-name', h.name || h.id));
        const btn = el('button', 'btn ghost mh-start-restore', 'Restaurar');
        btn.type = 'button';
        btn.dataset.catalogId = h.id;
        btn.addEventListener('click', () => void patchOpts(inst, { restoreCatalogApp: h.id }));
        row.appendChild(btn);
        panel.appendChild(row);
      }
      if (hidden.length > 1) {
        const all = el('button', 'btn ghost mh-start-restore-all', 'Restaurar todos');
        all.type = 'button';
        all.addEventListener('click', () => void patchOpts(inst, { restoreCatalogApp: 'all' }));
        panel.appendChild(all);
      }
    }
  }

  // ------------------------------------------------------- selftest helpers

  function firstLive() {
    return liveInstances().find((i) => i.root && i.root.isConnected) || null;
  }

  function getRoot() {
    const live = firstLive();
    return (live && live.root) || document.querySelector('.mh-start-page');
  }

  /** Section headings visible with no content under them (must always be empty list). */
  function emptyHeadings(root) {
    const out = [];
    if (!root) return out;
    for (const sec of root.querySelectorAll('.mh-start-section')) {
      if (sec.hidden) continue;
      const title = sec.querySelector('.mh-start-section-title');
      const body = sec.querySelector('.mh-start-apps-grid, .mh-start-grid');
      const hasBody = body && body.children.length > 0;
      if (title && !title.hidden && !hasBody) out.push(title.textContent || '');
    }
    return out;
  }

  window.MultiHeizStartPage = {
    build,
    /**
     * Refresh every mounted start page (area + pending windows).
     * @param {object} [_api] ignored (kept for older callers)
     */
    refresh: async () => {
      await refreshAll();
    },
    getRoot,
    getLastData: (accountId) => {
      const live = liveInstances();
      if (accountId) {
        const hit = live.find((i) => i.accountId === accountId);
        return hit ? hit.data : null;
      }
      const first = live.find((i) => i.root && i.root.isConnected) || live[0];
      return first ? first.data : null;
    },
    emptyHeadings: (root) => emptyHeadings(root || getRoot()),
    normalizeUrlClient,
  };
})();
