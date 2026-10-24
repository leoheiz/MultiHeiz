'use strict';

/**
 * Empty-workspace start page (omnibox, favorites bar, most-visited + custom tiles).
 * Attaches window.MultiHeizStartPage. pt-BR UI. No network favicon fetches.
 */
(function () {
  /** @type {object|null} */
  let lastData = null;
  /** @type {HTMLElement|null} */
  let rootEl = null;
  /** @type {object|null} */
  let pageApi = null;
  /** @type {string} */
  let dragTileId = '';

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

  function makeIcon(url, title, favicon) {
    const wrap = document.createElement('span');
    wrap.className = 'mh-start-tile-icon';
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

  /**
   * @param {object} api
   * @param {() => object} api.getState
   * @param {(st: object) => void} api.applyState
   * @param {(url: string, title?: string) => Promise<void>} api.openUrl
   * @param {() => void} api.openNewWindow
   * @param {(msg: string) => void} [api.toast]
   */
  function build(api) {
    const page = document.createElement('div');
    page.className = 'mh-start-page empty-hint';
    page.setAttribute('role', 'main');
    page.setAttribute('aria-label', 'Página inicial da área');

    const toolbar = document.createElement('div');
    toolbar.className = 'mh-start-toolbar';
    const btnNew = document.createElement('button');
    btnNew.type = 'button';
    btnNew.className = 'btn ghost mh-start-new';
    btnNew.textContent = '+ Nova janela';
    btnNew.title = 'Nova janela';
    btnNew.addEventListener('click', (e) => {
      e.stopPropagation();
      api.openNewWindow();
    });
    const btnGear = document.createElement('button');
    btnGear.type = 'button';
    btnGear.className = 'btn icon ghost mh-start-gear';
    btnGear.title = 'Opções da página inicial';
    btnGear.setAttribute('aria-label', 'Opções da página inicial');
    btnGear.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.1.6.6 1.1 1.5 1.2H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
    btnGear.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOptions(page, api);
    });
    toolbar.append(btnNew, btnGear);

    const favBar = document.createElement('div');
    favBar.className = 'mh-start-favbar';
    favBar.hidden = true;

    const center = document.createElement('div');
    center.className = 'mh-start-center';

    const omniboxWrap = document.createElement('div');
    omniboxWrap.className = 'mh-start-omnibox-wrap';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'mh-start-omnibox';
    input.placeholder = 'Pesquisar ou digitar endereço';
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', 'Pesquisar ou digitar endereço');
    const suggest = document.createElement('ul');
    suggest.className = 'omnibox-suggest mh-start-suggest';
    suggest.hidden = true;
    suggest.setAttribute('role', 'listbox');
    omniboxWrap.append(input, suggest);

    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'mh-start-section-title';
    sectionTitle.textContent = 'Mais acessados';

    const grid = document.createElement('div');
    grid.className = 'mh-start-grid';

    center.append(omniboxWrap, sectionTitle, grid);
    page.append(toolbar, favBar, center);
    rootEl = page;
    pageApi = api;

    wireOmnibox(input, suggest, () => pageApi || api);
    void refresh(page);
    return page;
  }

  function activeApi(fallback) {
    return pageApi || fallback || null;
  }

  async function refresh(page) {
    if (!window.multiheiz || !window.multiheiz.startPageGet) return;
    const root = page || rootEl || document.querySelector('.mh-start-page');
    if (!root || !root.isConnected) return;
    const api = activeApi();
    if (!api) return;
    const favBar = root.querySelector('.mh-start-favbar');
    const grid = root.querySelector('.mh-start-grid');
    const sectionTitle = root.querySelector('.mh-start-section-title');
    if (!favBar || !grid || !sectionTitle) return;
    const st = api.getState();
    const data = await window.multiheiz.startPageGet(st.activeWorkspaceId);
    if (!root.isConnected) return;
    lastData = data;
    renderFavBar(favBar, data, api);
    renderGrid(grid, data, api, sectionTitle);
  }

  function renderFavBar(favBar, data, api) {
    favBar.replaceChildren();
    const show = data && data.opts && data.opts.showFavoritesBar !== false;
    favBar.hidden = !show;
    if (!show) return;
    const items = (data.favoritesBar && data.favoritesBar.items) || [];
    const folders = (data.favoritesBar && data.favoritesBar.folders) || [];
    if (!items.length && !folders.length) {
      const empty = document.createElement('span');
      empty.className = 'mh-start-favbar-empty';
      empty.textContent = 'Nenhum favorito na barra';
      favBar.appendChild(empty);
      return;
    }
    for (const it of items) {
      favBar.appendChild(favChip(it, api));
    }
    for (const folder of folders) {
      favBar.appendChild(folderDropdown(folder, api));
    }
  }

  function favChip(it, api) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mh-start-fav';
    btn.title = it.url || it.title || '';
    btn.dataset.url = it.url || '';
    btn.append(makeIcon(it.url, it.title, it.favicon));
    const lab = document.createElement('span');
    lab.textContent = it.title || it.url || 'Favorito';
    btn.appendChild(lab);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void api.openUrl(it.url, it.title);
    });
    return btn;
  }

  function folderDropdown(folder, api) {
    const wrap = document.createElement('div');
    wrap.className = 'mh-start-fav-folder';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mh-start-fav is-folder';
    btn.textContent = (folder.name || 'Pasta') + ' ▾';
    const menu = document.createElement('div');
    menu.className = 'mh-start-fav-menu';
    menu.hidden = true;
    for (const it of folder.items || []) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'mh-start-fav-menu-item';
      row.textContent = it.title || it.url || 'Favorito';
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = true;
        void api.openUrl(it.url, it.title);
      });
      menu.appendChild(row);
    }
    if (!(folder.items || []).length) {
      const empty = document.createElement('div');
      empty.className = 'mh-start-fav-menu-empty';
      empty.textContent = 'Pasta vazia';
      menu.appendChild(empty);
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    wrap.append(btn, menu);
    return wrap;
  }

  function renderGrid(grid, data, api, sectionTitle) {
    grid.replaceChildren();
    const showMv = data && data.opts && data.opts.showMostVisited !== false;
    sectionTitle.hidden = !showMv;
    if (showMv) {
      for (const t of data.mostVisited || []) {
        grid.appendChild(tileEl(t, api, false));
      }
    }
    for (const t of data.customTiles || []) {
      grid.appendChild(tileEl({ ...t, kind: 'custom' }, api, true));
    }
    const addTileBtn = document.createElement('button');
    addTileBtn.type = 'button';
    addTileBtn.className = 'mh-start-tile mh-start-tile-add';
    addTileBtn.innerHTML =
      '<span class="mh-start-tile-icon is-letter">+</span><span class="mh-start-tile-label">Adicionar</span>';
    addTileBtn.title = 'Adicionar atalho';
    addTileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void promptCustomTile(api, null);
    });
    grid.appendChild(addTileBtn);
  }

  function tileEl(t, api, custom) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mh-start-tile' + (custom ? ' is-custom' : '');
    btn.dataset.url = t.url || '';
    btn.dataset.tileId = t.id || '';
    btn.dataset.kind = t.kind || 'suggested';
    if (custom) {
      btn.draggable = true;
      btn.addEventListener('dragstart', (e) => {
        dragTileId = t.id;
        try {
          e.dataTransfer.setData('text/plain', t.id);
          e.dataTransfer.effectAllowed = 'move';
        } catch {
          /* ignore */
        }
      });
      btn.addEventListener('dragover', (e) => {
        e.preventDefault();
        btn.classList.add('drag-over');
      });
      btn.addEventListener('dragleave', () => btn.classList.remove('drag-over'));
      btn.addEventListener('drop', (e) => {
        e.preventDefault();
        btn.classList.remove('drag-over');
        const from = dragTileId || e.dataTransfer.getData('text/plain');
        const to = t.id;
        if (from && to && from !== to) void reorderCustom(api, from, to);
      });
    }
    btn.append(makeIcon(t.url, t.title, t.favicon));
    const lab = document.createElement('span');
    lab.className = 'mh-start-tile-label';
    lab.textContent = t.title || hostOf(t.url) || 'Site';
    btn.appendChild(lab);
    if (custom) {
      const edit = document.createElement('span');
      edit.className = 'mh-start-tile-edit';
      edit.title = 'Editar';
      edit.textContent = '✎';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        void promptCustomTile(api, t);
      });
      btn.appendChild(edit);
    } else {
      const hide = document.createElement('span');
      hide.className = 'mh-start-tile-edit';
      hide.title = 'Ocultar sugestão';
      hide.textContent = '×';
      hide.addEventListener('click', (e) => {
        e.stopPropagation();
        void hideSuggested(api, t.url);
      });
      btn.appendChild(hide);
    }
    btn.addEventListener('click', (e) => {
      if (e.target && e.target.closest && e.target.closest('.mh-start-tile-edit')) return;
      e.stopPropagation();
      void api.openUrl(t.url, t.title);
    });
    btn.addEventListener('contextmenu', (e) => {
      if (custom) {
        e.preventDefault();
        e.stopPropagation();
        void promptCustomTile(api, t);
      }
    });
    return btn;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return '';
    }
  }

  function wireOmnibox(input, list, apiOrFn) {
    const apiOf = () => (typeof apiOrFn === 'function' ? apiOrFn() : apiOrFn);
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
        const kind = document.createElement('span');
        kind.className = 'omnibox-suggest-kind';
        kind.textContent = kindLabel(item.kind);
        const title = document.createElement('span');
        title.className = 'omnibox-suggest-title';
        title.textContent = item.title || item.url || '';
        const url = document.createElement('span');
        url.className = 'omnibox-suggest-url';
        url.textContent = item.kind === 'search' ? '' : item.subtitle || item.url || '';
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
      const api = apiOf();
      if (!api || !api.openUrl) return;
      if (item.kind === 'search' || item.kind === 'remote') {
        await api.openUrl(item.query || item.title || input.value);
        return;
      }
      if (item.url) await api.openUrl(item.url, item.title);
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
        const api = apiOf();
        if (v && api && api.openUrl) void api.openUrl(v);
      }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  function toggleOptions(page, api) {
    let panel = page.querySelector('.mh-start-options');
    if (panel) {
      panel.remove();
      return;
    }
    const data = lastData || { opts: {} };
    const opts = data.opts || {};
    panel = document.createElement('div');
    panel.className = 'mh-start-options';
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.innerHTML = `
      <div class="mh-start-options-title">Opções da página inicial</div>
      <label class="mh-start-opt"><input type="checkbox" data-k="showFavoritesBar" ${
        opts.showFavoritesBar !== false ? 'checked' : ''
      }/> Mostrar barra de favoritos</label>
      <label class="mh-start-opt"><input type="checkbox" data-k="showMostVisited" ${
        opts.showMostVisited !== false ? 'checked' : ''
      }/> Mostrar mais acessados</label>
      <label class="mh-start-opt">Linhas de sugestões
        <select data-k="mostVisitedRows">
          ${[1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(opts.mostVisitedRows) === n ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </label>
    `;
    page.appendChild(panel);
    panel.querySelectorAll('input[data-k], select[data-k]').forEach((el) => {
      el.addEventListener('change', async () => {
        const st = api.getState();
        const key = el.getAttribute('data-k');
        /** @type {Record<string, unknown>} */
        const patch = { workspaceId: st.activeWorkspaceId };
        if (el.type === 'checkbox') patch[key] = !!el.checked;
        else patch[key] = Number(el.value);
        const res = await window.multiheiz.startPageSet(patch);
        if (res && res.state) api.applyState(res.state);
        lastData = res && res.data;
        void refresh(page);
      });
    });
  }

  async function promptCustomTile(api, existing) {
    const title = window.prompt(
      existing ? 'Nome do atalho:' : 'Nome do novo atalho:',
      existing ? existing.title || '' : ''
    );
    if (title == null) return;
    const url = window.prompt(
      existing ? 'Endereço (URL):' : 'Endereço (URL) do atalho:',
      existing ? existing.url || '' : 'https://'
    );
    if (url == null || !String(url).trim()) {
      if (existing && window.confirm('Remover este atalho?')) {
        await removeCustom(api, existing.id);
      }
      return;
    }
    const st = api.getState();
    const cur = (lastData && lastData.customTiles) || [];
    let next;
    if (existing) {
      next = cur.map((t) =>
        t.id === existing.id
          ? { ...t, title: String(title).trim(), url: String(url).trim() }
          : t
      );
    } else {
      next = [
        ...cur,
        {
          id: 'ct-' + Date.now().toString(36),
          title: String(title).trim(),
          url: String(url).trim(),
          order: cur.length,
        },
      ];
    }
    const res = await window.multiheiz.startPageSet({
      workspaceId: st.activeWorkspaceId,
      customTiles: next,
    });
    if (res && res.state) api.applyState(res.state);
    lastData = res && res.data;
    await refresh(rootEl);
  }

  async function removeCustom(api, id) {
    const st = api.getState();
    const cur = (lastData && lastData.customTiles) || [];
    const next = cur.filter((t) => t.id !== id);
    const res = await window.multiheiz.startPageSet({
      workspaceId: st.activeWorkspaceId,
      customTiles: next,
    });
    if (res && res.state) api.applyState(res.state);
    lastData = res && res.data;
    await refresh(rootEl);
  }

  async function reorderCustom(api, fromId, toId) {
    const st = api.getState();
    const cur = [...((lastData && lastData.customTiles) || [])];
    const fromIdx = cur.findIndex((t) => t.id === fromId);
    const toIdx = cur.findIndex((t) => t.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = cur.splice(fromIdx, 1);
    cur.splice(toIdx, 0, moved);
    const next = cur.map((t, i) => ({ ...t, order: i }));
    const res = await window.multiheiz.startPageSet({
      workspaceId: st.activeWorkspaceId,
      customTiles: next,
    });
    if (res && res.state) api.applyState(res.state);
    lastData = res && res.data;
    await refresh(rootEl);
  }

  async function hideSuggested(api, url) {
    const st = api.getState();
    const hidden = [...((lastData && lastData.opts && lastData.opts.hiddenSuggested) || [])];
    if (!hidden.includes(url)) hidden.push(url);
    const res = await window.multiheiz.startPageSet({
      workspaceId: st.activeWorkspaceId,
      hiddenSuggested: hidden,
    });
    if (res && res.state) api.applyState(res.state);
    lastData = res && res.data;
    await refresh(rootEl);
  }

  /** Selftest helpers */
  function getRoot() {
    return document.querySelector('.mh-start-page') || rootEl;
  }

  window.MultiHeizStartPage = {
    build,
    refresh: async (api) => {
      rootEl = getRoot();
      if (api && typeof api.openUrl === 'function') pageApi = api;
      await refresh(rootEl);
    },
    getRoot,
    getLastData: () => lastData,
  };
})();
