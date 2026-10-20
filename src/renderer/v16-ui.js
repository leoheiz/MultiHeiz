'use strict';

/**
 * MultiHeiz v1.6 UI: managers (favorites/history/downloads), modules, settings helpers.
 * Depends on hooks provided by app.js via window.__mhV16Hooks.
 */
(function () {
  /** @type {any} */
  const api = (window.MultiHeizV16 = {});

  let activeManager = null;
  let activeModule = null;
  let pendingOpenUrl = null;
  let pendingFavEdit = null;
  let pendingSnoozeId = null;
  let pendingPickReminderId = null;
  let alarmesView = 'hoje';
  let downloadsActive = 0;
  let saveIndicatorTimer = null;

  const ICO = {
    star: 'M12 3l2.5 6.5L21 10l-5 4.2L17.5 21 12 17.3 6.5 21 8 14.2 3 10l6.5-.5L12 3z',
    back: 'M15 6l-6 6 6 6',
    // Lucide ISC — table / bell / sticky-note
    table: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9',
    bellClapper: 'M10.3 21a1.94 1.94 0 0 0 3.4 0',
    sticky: 'M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z',
    stickyFold: 'M15 3v6h6',
  };

  function moduleIcon(id) {
    if (id === 'planilha') {
      return h('span', { className: 'mod-ico', html: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICO.table}"/></svg>` });
    }
    if (id === 'alarmes') {
      return h('span', {
        className: 'mod-ico',
        html: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICO.bell}"/><path d="${ICO.bellClapper}"/></svg>`,
      });
    }
    if (id === 'notas') {
      return h('span', {
        className: 'mod-ico',
        html: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICO.sticky}"/><path d="${ICO.stickyFold}"/></svg>`,
      });
    }
    return null;
  }

  function hooks() {
    return window.__mhV16Hooks || {};
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === false || v == null) continue;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function pushOverlay(id) {
    const hk = hooks();
    if (hk.pushOverlay) hk.pushOverlay(id);
  }

  function popOverlay(id) {
    const hk = hooks();
    if (hk.popOverlay) hk.popOverlay(id);
  }

  function getState() {
    return (hooks().getState && hooks().getState()) || { accounts: [], settings: {} };
  }

  function applyState(st, opts) {
    if (hooks().applyState) hooks().applyState(st, opts);
  }

  /**
   * @param {unknown} a
   * @param {unknown} b
   */
  function settingsJsonEqual(a, b) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  /**
   * Only keys that differ from current settings (avoids full adblock rebuild on every toggle).
   * @param {object} prev
   * @param {object} next
   */
  function diffSettingsPartial(prev, next) {
    const p = prev && typeof prev === 'object' ? prev : {};
    const n = next && typeof next === 'object' ? next : {};
    const out = {};
    for (const key of Object.keys(n)) {
      if (key === 'adblock' || key === 'doh' || key === 'modules' || key === 'extensions') {
        if (!settingsJsonEqual(p[key], n[key])) out[key] = n[key];
        continue;
      }
      if (!settingsJsonEqual(p[key], n[key])) out[key] = n[key];
    }
    return out;
  }

  function toast(msg) {
    if (hooks().toast) hooks().toast(msg);
  }

  function showSaved() {
    const el = document.getElementById('settings-saved');
    if (!el) return;
    el.classList.remove('error');
    el.textContent = 'Salvo';
    el.classList.remove('hidden');
    if (saveIndicatorTimer) clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = setTimeout(() => el.classList.add('hidden'), 1200);
  }

  function showSaveError(reason) {
    const el = document.getElementById('settings-saved');
    if (!el) return;
    const short = String(reason || 'falha desconhecida').replace(/\s+/g, ' ').trim().slice(0, 80);
    el.classList.add('error');
    el.textContent = short ? `Erro ao salvar: ${short}` : 'Erro ao salvar';
    el.classList.remove('hidden');
    if (saveIndicatorTimer) clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  let historyClearResolver = null;

  function openHistoryClearDialog(hasWindowFilter) {
    const dlg = document.getElementById('dlg-history-clear');
    const form = document.getElementById('form-history-clear');
    const select = document.getElementById('history-clear-range');
    const hint = document.getElementById('history-clear-hint');
    const winOpt = select && select.querySelector('option[value="window"]');
    if (!dlg || !form || !select) return Promise.resolve(null);
    if (winOpt) winOpt.disabled = !hasWindowFilter;
    if (hint) hint.classList.toggle('hidden', !!hasWindowFilter);
    if (!hasWindowFilter && select.value === 'window') select.value = 'hour';
    return new Promise((resolve) => {
      historyClearResolver = resolve;
      pushOverlay('dlg-history-clear');
      dlg.showModal();
    });
  }

  function finishHistoryClearDialog(value) {
    const resolve = historyClearResolver;
    historyClearResolver = null;
    const dlg = document.getElementById('dlg-history-clear');
    if (dlg && dlg.open) dlg.close();
    if (resolve) resolve(value);
  }

  /* ---------- Managers ---------- */

  function openManager(kind) {
    closeModule();
    const host = document.getElementById('manager-host');
    const grid = document.getElementById('grid');
    if (!host) return;
    activeManager = kind;
    host.classList.remove('hidden');
    if (grid) grid.classList.add('dimmed-behind');
    pushOverlay('manager-view');
    renderManager();
  }

  function closeManager() {
    const host = document.getElementById('manager-host');
    const grid = document.getElementById('grid');
    if (host) {
      host.classList.add('hidden');
      host.innerHTML = '';
    }
    if (grid) grid.classList.remove('dimmed-behind');
    if (activeManager) popOverlay('manager-view');
    activeManager = null;
  }

  async function renderManager() {
    const host = document.getElementById('manager-host');
    if (!host || !activeManager) return;
    host.innerHTML = '';
    const head = h('div', { className: 'manager-head' },
      h('button', {
        type: 'button',
        className: 'btn icon ghost',
        title: 'Voltar',
        onClick: () => closeManager(),
      }, (() => {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('class', 'ico');
        s.setAttribute('viewBox', '0 0 24 24');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', ICO.back);
        s.appendChild(p);
        return s;
      })()),
      h('h2', { text: activeManager === 'favorites' ? 'Favoritos' : activeManager === 'history' ? 'Histórico' : 'Downloads' })
    );
    host.appendChild(head);
    const body = h('div', { className: 'manager-body' });
    host.appendChild(body);
    if (activeManager === 'favorites') await renderFavorites(body);
    else if (activeManager === 'history') await renderHistory(body);
    else if (activeManager === 'downloads') await renderDownloads(body);
  }

  async function renderFavorites(body) {
    const data = await window.multiheiz.bookmarksList();
    const search = h('input', { type: 'search', placeholder: 'Buscar favoritos…', className: 'mgr-search' });
    const toolbar = h('div', { className: 'mgr-toolbar' },
      search,
      h('button', {
        type: 'button', className: 'btn ghost', text: 'Nova pasta',
        onClick: async () => {
          const name = prompt('Nome da pasta');
          if (!name) return;
          await window.multiheiz.bookmarksFolderCreate(name);
          renderManager();
        },
      }),
      h('button', {
        type: 'button', className: 'btn ghost', text: 'Exportar',
        onClick: async () => {
          const json = await window.multiheiz.bookmarksExport();
          await navigator.clipboard.writeText(json);
          toast('JSON copiado');
        },
      }),
      h('button', {
        type: 'button', className: 'btn ghost', text: 'Importar',
        onClick: async () => {
          const raw = prompt('Cole o JSON de favoritos');
          if (!raw) return;
          const res = await window.multiheiz.bookmarksImport(raw);
          if (!res || !res.ok) {
            toast((res && res.message) || 'Importação rejeitada');
            return;
          }
          toast(`Importados ${res.count || 0} favoritos`);
          renderManager();
        },
      })
    );
    body.appendChild(toolbar);
    const list = h('div', { className: 'mgr-list' });
    body.appendChild(list);

    function paint(q) {
      list.innerHTML = '';
      const folders = data.folders || [];
      for (const folder of folders) {
        const items = (data.items || []).filter((it) => it.folderId === folder.id);
        const filtered = q
          ? items.filter((it) =>
              (it.name || '').toLowerCase().includes(q) ||
              (it.url || '').toLowerCase().includes(q)
            )
          : items;
        if (q && !filtered.length && !folder.name.toLowerCase().includes(q)) continue;
        list.appendChild(h('div', { className: 'mgr-folder-title', text: folder.name }));
        for (const it of filtered) {
          const row = h('div', { className: 'mgr-row' },
            h('button', {
              type: 'button', className: 'mgr-row-main',
              onClick: () => openWithTarget(it.url, it.defaultWindowId),
            },
              h('strong', { text: it.name || it.url }),
              h('span', { className: 'muted-note', text: it.url })
            ),
            h('button', {
              type: 'button', className: 'btn ghost', text: 'Editar',
              onClick: () => openFavoriteDialog(it),
            }),
            h('button', {
              type: 'button', className: 'btn ghost', text: 'Remover',
              onClick: async () => {
                await window.multiheiz.bookmarksRemove(it.id);
                renderManager();
              },
            })
          );
          list.appendChild(row);
        }
      }
    }
    search.addEventListener('input', () => paint(search.value.trim().toLowerCase()));
    paint('');
  }

  async function renderHistory(body) {
    const accounts = getState().accounts || [];
    const filter = h('select', { className: 'mgr-filter' },
      h('option', { value: '', text: 'Todas as janelas' }),
      ...accounts.map((a) => h('option', { value: a.id, text: a.name }))
    );
    const search = h('input', { type: 'search', placeholder: 'Buscar…', className: 'mgr-search' });
    const toolbar = h('div', { className: 'mgr-toolbar' },
      search, filter,
      h('button', {
        type: 'button', className: 'btn ghost', text: 'Limpar…',
        onClick: async () => {
          const choice = await openHistoryClearDialog(!!filter.value);
          if (!choice) return;
          if (choice === 'window') {
            if (!filter.value) {
              toast('Selecione uma janela no filtro');
              return;
            }
            await window.multiheiz.historyClear({ windowId: filter.value });
          } else {
            await window.multiheiz.historyClear({ range: choice });
          }
          renderManager();
        },
      })
    );
    body.appendChild(toolbar);
    const list = h('div', { className: 'mgr-list' });
    body.appendChild(list);

    async function paint() {
      const entries = await window.multiheiz.historyQuery({
        search: search.value.trim(),
        windowId: filter.value || undefined,
        limit: 500,
      });
      list.innerHTML = '';
      /** @type {Map<string, any[]>} */
      const byDay = new Map();
      for (const e of entries) {
        const d = new Date(e.time || 0);
        const key = d.toLocaleDateString('pt-BR');
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(e);
      }
      for (const [day, items] of byDay) {
        list.appendChild(h('div', { className: 'mgr-folder-title', text: day }));
        for (const e of items) {
          const time = new Date(e.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
          list.appendChild(h('div', { className: 'mgr-row' },
            h('button', {
              type: 'button', className: 'mgr-row-main',
              onClick: () => openWithTarget(e.url, e.windowId),
            },
              h('strong', { text: `${time} · ${e.title || e.url}` }),
              h('span', { className: 'muted-note', text: `${e.windowName || ''} · ${e.url}` })
            ),
            h('button', {
              type: 'button', className: 'btn ghost', text: 'Excluir',
              onClick: async () => {
                await window.multiheiz.historyDelete(e.id);
                paint();
              },
            })
          ));
        }
      }
    }
    search.addEventListener('input', () => paint());
    filter.addEventListener('change', () => paint());
    await paint();
  }

  async function renderDownloads(body) {
    const data = await window.multiheiz.downloadsList();
    downloadsActive = data.activeCount || 0;
    updateDownloadsBadge();
    const list = h('div', { className: 'mgr-list' });
    body.appendChild(list);
    for (const it of data.items || []) {
      const pct =
        it.totalBytes > 0 ? Math.min(100, Math.round((it.receivedBytes / it.totalBytes) * 100)) : 0;
      const stateLabel = {
        progressing: 'Em andamento',
        paused: 'Pausado',
        completed: 'Concluído',
        cancelled: 'Cancelado',
        failed: 'Falhou',
        interrupted: 'Interrompido',
      }[it.state] || it.state;
      const bar = h('div', { className: 'dl-progress' },
        h('div', { className: 'dl-progress-bar', style: `width:${pct}%` })
      );
      const actions = h('div', { className: 'mgr-row-actions' });
      if (it.state === 'progressing') {
        actions.appendChild(h('button', { type: 'button', className: 'btn ghost', text: 'Pausar', onClick: async () => { await window.multiheiz.downloadsPause(it.id); renderManager(); } }));
        actions.appendChild(h('button', { type: 'button', className: 'btn ghost', text: 'Cancelar', onClick: async () => { await window.multiheiz.downloadsCancel(it.id); renderManager(); } }));
      }
      if (it.state === 'paused') {
        actions.appendChild(h('button', { type: 'button', className: 'btn ghost', text: 'Retomar', onClick: async () => { await window.multiheiz.downloadsResume(it.id); renderManager(); } }));
        actions.appendChild(h('button', { type: 'button', className: 'btn ghost', text: 'Cancelar', onClick: async () => { await window.multiheiz.downloadsCancel(it.id); renderManager(); } }));
      }
      if (it.state === 'completed') {
        actions.appendChild(h('button', { type: 'button', className: 'btn ghost', text: 'Abrir', onClick: () => window.multiheiz.downloadsOpen(it.id) }));
        actions.appendChild(h('button', { type: 'button', className: 'btn ghost', text: 'Pasta', onClick: () => window.multiheiz.downloadsShow(it.id) }));
      }
      actions.appendChild(h('button', { type: 'button', className: 'btn ghost', text: 'Remover', onClick: async () => { await window.multiheiz.downloadsRemove(it.id); renderManager(); } }));

      list.appendChild(h('div', { className: 'mgr-row dl-row' },
        h('div', { className: 'mgr-row-main' },
          h('strong', { text: it.filename }),
          h('span', { className: 'muted-note', text: `${stateLabel} · ${it.windowName || ''} · ${formatBytes(it.receivedBytes)}/${formatBytes(it.totalBytes)} · ${formatSpeed(it.speed)}` }),
          bar
        ),
        actions
      ));
    }
    if (!(data.items || []).length) {
      list.appendChild(h('p', { className: 'muted-note', text: 'Nenhum download ainda.' }));
    }
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatSpeed(n) {
    if (!n) return '—';
    return `${formatBytes(n)}/s`;
  }

  function updateDownloadsBadge() {
    const badge = document.getElementById('downloads-badge');
    if (!badge) return;
    if (downloadsActive > 0) {
      badge.textContent = String(downloadsActive);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  /* ---------- Open target ---------- */

  function openWithTarget(url, defaultWindowId) {
    pendingOpenUrl = url;
    const dlg = document.getElementById('dlg-open-target');
    const sel = document.getElementById('open-target-window');
    sel.innerHTML = '';
    for (const a of getState().accounts || []) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name;
      if (defaultWindowId && a.id === defaultWindowId) opt.selected = true;
      sel.appendChild(opt);
    }
    pushOverlay('dlg-open-target');
    dlg.showModal();
    if (defaultWindowId) {
      // auto-select path: user still sees dialog, but specific is preselected
    }
  }

  async function doOpen(mode, windowId) {
    if (!pendingOpenUrl) return;
    const res = await window.multiheiz.bookmarksOpen({
      url: pendingOpenUrl,
      mode,
      windowId: windowId || null,
    });
    if (res && res.state) applyState(res.state);
    pendingOpenUrl = null;
    const dlg = document.getElementById('dlg-open-target');
    if (dlg.open) dlg.close();
    closeManager();
  }

  /* ---------- Favorite dialog / star ---------- */

  async function openFavoriteDialog(existing) {
    pendingFavEdit = existing || null;
    const form = document.getElementById('form-favorite');
    const folders = (await window.multiheiz.bookmarksList()).folders || [];
    const folderSel = document.getElementById('fav-folder-select');
    folderSel.innerHTML = '';
    for (const f of folders) {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name;
      folderSel.appendChild(opt);
    }
    const winSel = document.getElementById('fav-window-select');
    winSel.innerHTML = '<option value="">Nenhuma</option>';
    for (const a of getState().accounts || []) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name;
      winSel.appendChild(opt);
    }
    if (existing) {
      form.name.value = existing.name || '';
      form.url.value = existing.url || '';
      folderSel.value = existing.folderId || '';
      winSel.value = existing.defaultWindowId || '';
    }
    pushOverlay('dlg-favorite');
    document.getElementById('dlg-favorite').showModal();
  }

  async function favoriteCurrentUrl() {
    const hk = hooks();
    const info = hk.getFocusedNav && hk.getFocusedNav();
    if (!info || !info.url) {
      toast('Nenhuma página para favoritar');
      return;
    }
    const existing = await window.multiheiz.bookmarksFindUrl(info.url);
    await openFavoriteDialog(
      existing || {
        url: info.url,
        name: info.title || info.url,
        title: info.title || '',
        folderId: null,
        defaultWindowId: info.accountId || null,
      }
    );
  }

  /* ---------- Modules ---------- */

  function modulesEnabled() {
    const m = (getState().settings && getState().settings.modules) || {};
    return {
      planilha: m.planilha !== false,
      alarmes: m.alarmes !== false,
      notas: m.notas !== false,
    };
  }

  function renderSidebarModules() {
    const list = document.getElementById('sidebar-modules-list');
    const wrap = document.getElementById('sidebar-modules');
    if (!list || !wrap) return;
    list.innerHTML = '';
    const en = modulesEnabled();
    const items = [
      { id: 'planilha', label: 'Planilha', on: en.planilha },
      { id: 'alarmes', label: 'Alarmes', on: en.alarmes },
      { id: 'notas', label: 'Notas', on: en.notas },
    ].filter((x) => x.on);
    if (!items.length) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    for (const it of items) {
      const ico = moduleIcon(it.id);
      const label = h('span', { className: 'mod-label', text: it.label });
      const btn = h(
        'button',
        {
          type: 'button',
          className: 'sidebar-module-btn' + (activeModule === it.id ? ' active' : ''),
          title: it.label,
          'aria-label': it.label,
          'data-label': it.label,
          onClick: () => openModule(it.id),
        },
        ico,
        label
      );
      list.appendChild(btn);
    }
  }

  function openModule(id) {
    closeManager();
    const host = document.getElementById('module-host');
    const grid = document.getElementById('grid');
    if (!host) return;
    activeModule = id;
    host.classList.remove('hidden');
    if (grid) grid.classList.add('hidden');
    pushOverlay('module-view');
    renderModule();
    renderSidebarModules();
  }

  function closeModule() {
    const host = document.getElementById('module-host');
    const grid = document.getElementById('grid');
    if (host) {
      host.classList.add('hidden');
      host.innerHTML = '';
    }
    if (grid) grid.classList.remove('hidden');
    if (activeModule) popOverlay('module-view');
    activeModule = null;
    renderSidebarModules();
    if (hooks().scheduleSync) hooks().scheduleSync();
  }

  async function renderModule() {
    const host = document.getElementById('module-host');
    if (!host || !activeModule) return;
    host.innerHTML = '';
    const head = h('div', { className: 'module-head' },
      h('button', {
        type: 'button', className: 'btn ghost', text: '← Janelas',
        onClick: () => closeModule(),
      }),
      h('h2', {
        text:
          activeModule === 'planilha'
            ? 'Planilha'
            : activeModule === 'alarmes'
              ? 'Alarmes e lembretes'
              : 'Notas',
      })
    );
    host.appendChild(head);
    const body = h('div', { className: 'module-body' });
    host.appendChild(body);
    if (activeModule === 'planilha') await renderPlanilha(body);
    else if (activeModule === 'alarmes') await renderAlarmes(body);
    else if (activeModule === 'notas') await renderNotas(body);
  }

  /* ---- Planilha UI ---- */
  let planilhaWb = null;
  /** @type {{ editingRef: string|null, formulaMode: boolean, anchor: {c:number,r:number}|null, sel: {c0:number,r0:number,c1:number,r1:number}|null, skipBlur: boolean }} */
  let planilhaSel = {
    editingRef: null,
    formulaMode: false,
    anchor: null,
    sel: null,
    skipBlur: false,
    dragging: false,
  };
  /** @type {(() => void) | null} */
  let planilhaPaintSelection = null;
  /** @type {((ref: string) => boolean) | null} */
  let planilhaInsertRef = null;

  function colLetters(c) {
    return String.fromCharCode(65 + c);
  }

  function cellRefAt(c, r) {
    return `${colLetters(c)}${r + 1}`;
  }

  function formatRangeRefUi(c0, r0, c1, r1) {
    const ca = Math.min(c0, c1);
    const cb = Math.max(c0, c1);
    const ra = Math.min(r0, r1);
    const rb = Math.max(r0, r1);
    if (ca === cb && ra === rb) return cellRefAt(ca, ra);
    return `${cellRefAt(ca, ra)}:${cellRefAt(cb, rb)}`;
  }

  function formatColumnRefUi(c) {
    const L = colLetters(c);
    return `${L}:${L}`;
  }

  function showV16ContextMenu(x, y, items) {
    document.querySelectorAll('.context-menu.mh-v16-menu').forEach((n) => n.remove());
    const menu = h('div', { className: 'context-menu mh-v16-menu' });
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    for (const it of items) {
      menu.appendChild(
        h('button', {
          type: 'button',
          text: it.label,
          onClick: async () => {
            menu.remove();
            popOverlay('context-menu');
            await it.onClick();
          },
        })
      );
    }
    document.body.appendChild(menu);
    pushOverlay('context-menu');
    const onDoc = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        popOverlay('context-menu');
        document.removeEventListener('mousedown', onDoc, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  }

  async function renderPlanilha(body) {
    const list = await window.multiheiz.planilhaList();
    const side = h('div', { className: 'planilha-side' });
    const main = h('div', { className: 'planilha-main' });
    body.append(side, main);
    side.appendChild(h('button', {
      type: 'button', className: 'btn primary', text: 'Nova pasta',
      onClick: async () => {
        planilhaWb = await window.multiheiz.planilhaCreate('Pasta de trabalho');
        renderModule();
      },
    }));
    side.appendChild(h('button', {
      type: 'button', className: 'btn ghost', text: 'Importar .xlsx',
      onClick: async () => {
        const r = await window.multiheiz.planilhaImport();
        if (r && r.workbook) {
          planilhaWb = r.workbook;
          renderModule();
        }
      },
    }));

    async function renameWorkbookUi(wb) {
      const next = window.prompt('Renomear pasta de trabalho:', wb.name || '');
      if (next == null) return;
      const name = String(next).trim();
      if (!name || name === wb.name) return;
      const updated = await window.multiheiz.planilhaRename(wb.id, name);
      if (updated) planilhaWb = updated;
      else if (planilhaWb && planilhaWb.id === wb.id) {
        planilhaWb = await window.multiheiz.planilhaGet(wb.id);
      }
      renderModule();
    }

    async function deleteWorkbookUi(wb) {
      if (!window.confirm(`Excluir a pasta de trabalho "${wb.name}"? Esta ação não pode ser desfeita.`)) {
        return;
      }
      await window.multiheiz.planilhaDelete(wb.id);
      if (planilhaWb && planilhaWb.id === wb.id) planilhaWb = null;
      renderModule();
    }

    for (const wb of list) {
      const row = h('div', {
        className: 'planilha-wb-row',
        style: 'display:flex;align-items:center;gap:2px',
      });
      const openMenu = (x, y) => {
        showV16ContextMenu(x, y, [
          { label: 'Renomear', onClick: () => renameWorkbookUi(wb) },
          { label: 'Excluir', onClick: () => deleteWorkbookUi(wb) },
        ]);
      };
      const btn = h('button', {
        type: 'button',
        className: 'planilha-wb-btn' + (planilhaWb && planilhaWb.id === wb.id ? ' active' : ''),
        text: wb.name,
        style: 'flex:1;min-width:0',
        onClick: async () => {
          planilhaWb = await window.multiheiz.planilhaGet(wb.id);
          renderModule();
        },
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      });
      const more = h('button', {
        type: 'button',
        className: 'btn ghost tiny',
        text: '⋯',
        title: 'Mais opções',
        onClick: (e) => {
          e.stopPropagation();
          const r = more.getBoundingClientRect();
          openMenu(r.left, r.bottom + 2);
        },
      });
      row.append(btn, more);
      side.appendChild(row);
    }
    if (!planilhaWb && list[0]) {
      planilhaWb = await window.multiheiz.planilhaGet(list[0].id);
    }
    if (!planilhaWb) {
      main.appendChild(h('p', { className: 'muted-note', text: 'Crie ou importe uma planilha.' }));
      return;
    }
    const sheet =
      (planilhaWb.sheets || []).find((s) => s.id === planilhaWb.activeSheetId) ||
      (planilhaWb.sheets || [])[0];
    const tabs = h('div', { className: 'planilha-tabs' });

    async function renameSheetUi(sh) {
      const next = window.prompt('Renomear aba:', sh.name || '');
      if (next == null) return;
      const name = String(next).trim();
      if (!name || name === sh.name) return;
      planilhaWb = await window.multiheiz.planilhaRenameSheet({
        workbookId: planilhaWb.id,
        sheetId: sh.id,
        name,
      });
      renderModule();
    }

    async function deleteSheetUi(sh) {
      const sheets = planilhaWb.sheets || [];
      if (sheets.length <= 1) {
        if (
          window.confirm(
            `Não é possível excluir a última aba. Excluir a pasta de trabalho "${planilhaWb.name}"?`
          )
        ) {
          await window.multiheiz.planilhaDelete(planilhaWb.id);
          planilhaWb = null;
          renderModule();
        }
        return;
      }
      if (!window.confirm(`Excluir a aba "${sh.name}"? Esta ação não pode ser desfeita.`)) return;
      planilhaWb = await window.multiheiz.planilhaDeleteSheet({
        workbookId: planilhaWb.id,
        sheetId: sh.id,
      });
      renderModule();
    }

    for (const sh of planilhaWb.sheets || []) {
      const wrap = h('div', {
        className: 'planilha-tab-wrap',
        style: 'display:inline-flex;align-items:center;gap:0',
      });
      const openSheetMenu = (x, y) => {
        showV16ContextMenu(x, y, [
          { label: 'Renomear', onClick: () => renameSheetUi(sh) },
          { label: 'Excluir', onClick: () => deleteSheetUi(sh) },
        ]);
      };
      const tabBtn = h('button', {
        type: 'button',
        className: 'btn ghost' + (sh.id === sheet.id ? ' active' : ''),
        text: sh.name,
        onClick: async () => {
          planilhaWb = await window.multiheiz.planilhaSetActiveSheet({
            workbookId: planilhaWb.id,
            sheetId: sh.id,
          });
          renderModule();
        },
      });
      tabBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openSheetMenu(e.clientX, e.clientY);
      });
      const more = h('button', {
        type: 'button',
        className: 'btn ghost tiny',
        text: '⋯',
        title: 'Mais opções da aba',
        onClick: (e) => {
          e.stopPropagation();
          const r = more.getBoundingClientRect();
          openSheetMenu(r.left, r.bottom + 2);
        },
      });
      wrap.append(tabBtn, more);
      tabs.appendChild(wrap);
    }
    tabs.appendChild(h('button', {
      type: 'button', className: 'btn ghost', text: '+',
      onClick: async () => {
        planilhaWb = await window.multiheiz.planilhaAddSheet({ workbookId: planilhaWb.id });
        renderModule();
      },
    }));
    tabs.appendChild(h('button', {
      type: 'button', className: 'btn ghost', text: 'Exportar',
      onClick: () => window.multiheiz.planilhaExport(planilhaWb.id),
    }));
    main.appendChild(tabs);

    const rows = 20;
    const cols = 10;
    const formulaBar = h('div', { className: 'sheet-formula-bar' });
    const formulaLabel = h('span', { className: 'muted-note', text: 'fx' });
    const formulaInput = h('input', {
      type: 'text',
      placeholder: 'Fórmula ou valor',
      'data-role': 'formula-bar',
    });
    formulaBar.append(formulaLabel, formulaInput);
    main.appendChild(formulaBar);

    const grid = h('div', { className: 'sheet-grid', tabIndex: 0 });
    /** @type {Map<string, HTMLInputElement>} */
    const cellInputs = new Map();
    /** @type {HTMLElement[]} */
    const colHeaders = [];

    function paintSelection() {
      for (const [ref, el] of cellInputs) {
        el.classList.remove('selected');
        const m = /^([A-Z]+)(\d+)$/.exec(ref);
        if (!m || !planilhaSel.sel) continue;
        const c = m[1].charCodeAt(0) - 65;
        const r = Number(m[2]) - 1;
        const { c0, r0, c1, r1 } = planilhaSel.sel;
        if (c >= Math.min(c0, c1) && c <= Math.max(c0, c1) && r >= Math.min(r0, r1) && r <= Math.max(r0, r1)) {
          el.classList.add('selected');
        }
      }
      for (let c = 0; c < colHeaders.length; c++) {
        colHeaders[c].classList.toggle(
          'col-selected',
          !!(
            planilhaSel.sel &&
            planilhaSel.sel.r0 === 0 &&
            planilhaSel.sel.r1 === rows - 1 &&
            c >= Math.min(planilhaSel.sel.c0, planilhaSel.sel.c1) &&
            c <= Math.max(planilhaSel.sel.c0, planilhaSel.sel.c1)
          )
        );
      }
    }

    function getEditingInput() {
      return planilhaSel.editingRef ? cellInputs.get(planilhaSel.editingRef) : null;
    }

    function insertRefIntoFormula(refText) {
      const input = getEditingInput();
      if (!input || !planilhaSel.formulaMode) return false;
      planilhaSel.skipBlur = true;
      const start = input.selectionStart != null ? input.selectionStart : input.value.length;
      const end = input.selectionEnd != null ? input.selectionEnd : start;
      const before = input.value.slice(0, start);
      const after = input.value.slice(end);
      input.value = before + refText + after;
      const caret = before.length + refText.length;
      input.setSelectionRange(caret, caret);
      formulaInput.value = input.value;
      input.focus();
      setTimeout(() => {
        planilhaSel.skipBlur = false;
      }, 0);
      return true;
    }

    function beginEdit(ref, input, raw) {
      planilhaSel.editingRef = ref;
      planilhaSel.formulaMode = String(raw || input.value || '').startsWith('=');
      input.value = raw || '';
      formulaInput.value = input.value;
    }

    async function commitEdit(ref, input) {
      if (planilhaSel.skipBlur) return;
      const newRaw = input.value;
      planilhaSel.editingRef = null;
      planilhaSel.formulaMode = false;
      planilhaWb = await window.multiheiz.planilhaSetCell({
        workbookId: planilhaWb.id,
        sheetId: sheet.id,
        ref,
        raw: newRaw,
      });
      renderModule();
    }

    const headerRow = h('div', { className: 'sheet-row header' });
    headerRow.appendChild(h('div', { className: 'sheet-cell corner', text: '' }));
    for (let c = 0; c < cols; c++) {
      const head = h('div', {
        className: 'sheet-cell head',
        text: colLetters(c),
        'data-col': String(c),
      });
      head.addEventListener('mousedown', (e) => {
        e.preventDefault();
        planilhaSel.sel = { c0: c, r0: 0, c1: c, r1: rows - 1 };
        planilhaSel.anchor = { c, r: 0 };
        paintSelection();
        if (planilhaSel.formulaMode && planilhaSel.editingRef) {
          insertRefIntoFormula(formatColumnRefUi(c));
        }
      });
      colHeaders.push(head);
      headerRow.appendChild(head);
    }
    grid.appendChild(headerRow);

    planilhaPaintSelection = paintSelection;
    planilhaInsertRef = insertRefIntoFormula;

    for (let r = 0; r < rows; r++) {
      const row = h('div', { className: 'sheet-row' });
      row.appendChild(h('div', { className: 'sheet-cell head', text: String(r + 1) }));
      for (let c = 0; c < cols; c++) {
        const ref = cellRefAt(c, r);
        const disp = (sheet.display && sheet.display[ref]) || {};
        const raw = disp.raw || (sheet.cells && sheet.cells[ref] && sheet.cells[ref].raw) || '';
        const val = disp.value != null ? disp.value : raw;
        const input = h('input', {
          className: 'sheet-cell',
          value: String(val === 0 && !raw ? '' : val ?? ''),
          title: raw,
          'data-ref': ref,
          'data-c': String(c),
          'data-r': String(r),
        });
        cellInputs.set(ref, input);

        input.addEventListener('focus', () => {
          beginEdit(ref, input, raw);
        });
        input.addEventListener('input', () => {
          planilhaSel.formulaMode = input.value.startsWith('=');
          formulaInput.value = input.value;
        });
        input.addEventListener('blur', async () => {
          await commitEdit(ref, input);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
            // Inside cell editor: select text (default) — do not select all sheet cells
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
          }
        });
        input.addEventListener('mousedown', (e) => {
          if (planilhaSel.formulaMode && planilhaSel.editingRef && planilhaSel.editingRef !== ref) {
            e.preventDefault();
            if (e.shiftKey && planilhaSel.anchor) {
              const range = formatRangeRefUi(planilhaSel.anchor.c, planilhaSel.anchor.r, c, r);
              planilhaSel.sel = {
                c0: planilhaSel.anchor.c,
                r0: planilhaSel.anchor.r,
                c1: c,
                r1: r,
              };
              insertRefIntoFormula(range);
            } else {
              planilhaSel.anchor = { c, r };
              planilhaSel.sel = { c0: c, r0: r, c1: c, r1: r };
              insertRefIntoFormula(ref);
            }
            paintSelection();
            return;
          }
          if (e.shiftKey && planilhaSel.anchor) {
            e.preventDefault();
            planilhaSel.sel = {
              c0: planilhaSel.anchor.c,
              r0: planilhaSel.anchor.r,
              c1: c,
              r1: r,
            };
            paintSelection();
            return;
          }
          planilhaSel.anchor = { c, r };
          planilhaSel.sel = { c0: c, r0: r, c1: c, r1: r };
          planilhaSel.dragging = true;
          paintSelection();
        });
        input.addEventListener('mouseenter', () => {
          if (!planilhaSel.dragging) return;
          if (!planilhaSel.anchor) return;
          planilhaSel.sel = {
            c0: planilhaSel.anchor.c,
            r0: planilhaSel.anchor.r,
            c1: c,
            r1: r,
          };
          paintSelection();
        });
        row.appendChild(input);
      }
      grid.appendChild(row);
    }

    grid.addEventListener('keydown', (e) => {
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        const active = document.activeElement;
        if (active && active.tagName === 'INPUT' && active.classList.contains('sheet-cell')) {
          // editor: select text only
          return;
        }
        e.preventDefault();
        planilhaSel.sel = { c0: 0, r0: 0, c1: cols - 1, r1: rows - 1 };
        planilhaSel.anchor = { c: 0, r: 0 };
        paintSelection();
      }
    });

    formulaInput.addEventListener('focus', () => {
      if (!planilhaSel.editingRef && planilhaSel.sel) {
        const ref = cellRefAt(planilhaSel.sel.c0, planilhaSel.sel.r0);
        const input = cellInputs.get(ref);
        if (input) {
          input.focus();
        }
      }
    });
    formulaInput.addEventListener('input', () => {
      const input = getEditingInput();
      if (input) {
        input.value = formulaInput.value;
        planilhaSel.formulaMode = formulaInput.value.startsWith('=');
      }
    });

    main.appendChild(grid);
    paintSelection();

    // Expose helpers for selftest
    api._planilhaTest = {
      formatRangeRef: formatRangeRefUi,
      formatColumnRef: formatColumnRefUi,
      cellRefAt,
      getSel: () => ({ ...planilhaSel }),
      insertRefIntoFormula,
      setFormulaMode: (on) => {
        planilhaSel.formulaMode = !!on;
      },
      setEditing: (ref) => {
        const input = cellInputs.get(ref);
        if (!input) return;
        input.focus();
        planilhaSel.editingRef = ref;
        planilhaSel.formulaMode = true;
        input.value = '=';
        formulaInput.value = '=';
      },
      getCellValue: (ref) => {
        const input = cellInputs.get(ref);
        return input ? input.value : null;
      },
      selectAll: () => {
        planilhaSel.sel = { c0: 0, r0: 0, c1: cols - 1, r1: rows - 1 };
        paintSelection();
        return planilhaSel.sel;
      },
      clickCell: (c, r, opts) => {
        const ref = cellRefAt(c, r);
        const input = cellInputs.get(ref);
        if (!input) return null;
        const ev = new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          shiftKey: !!(opts && opts.shift),
        });
        input.dispatchEvent(ev);
        return { ref, value: getEditingInput() && getEditingInput().value, sel: planilhaSel.sel };
      },
      clickColHeader: (c) => {
        const head = colHeaders[c];
        if (!head) return null;
        head.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        return { ref: formatColumnRefUi(c), value: getEditingInput() && getEditingInput().value };
      },
    };
  }

  /* ---- Alarmes UI ---- */
  async function goToReminderWindow(reminder) {
    if (!reminder) return { ok: false, reason: 'no-reminder' };
    // Prefer live main state (renderer cache can lag after selftest / IPC updates)
    let st = getState();
    try {
      const fresh = await window.multiheiz.getState();
      if (fresh) {
        applyState(fresh);
        st = fresh;
      }
    } catch {
      /* keep local */
    }
    const wid = reminder.windowId;
    if (!wid || !(st.accounts || []).some((a) => a.id === wid)) {
      openPickWindowDialog(reminder);
      return { ok: false, reason: 'missing-window' };
    }
    const hk = hooks();
    if (hk.focusAccount) {
      const r = await hk.focusAccount(wid);
      return r || { ok: true, reloaded: false };
    }
    return { ok: false, reason: 'no-hook' };
  }

  function openPickWindowDialog(reminder) {
    pendingPickReminderId = reminder && reminder.id;
    const dlg = document.getElementById('dlg-pick-window');
    const sel = document.getElementById('pick-window-select');
    const msg = document.getElementById('pick-window-message');
    if (!dlg || !sel) return;
    const st = getState();
    sel.innerHTML = '';
    for (const a of st.accounts || []) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name || a.id;
      sel.appendChild(opt);
    }
    if (msg) {
      msg.textContent = sel.options.length
        ? 'A janela vinculada foi removida. Escolha outra:'
        : 'Nenhuma janela disponível. Crie uma janela primeiro.';
    }
    pushOverlay('dlg-pick-window');
    dlg.showModal();
  }

  async function renderAlarmes(body) {
    const data = await window.multiheiz.alarmesList();
    const views = h('div', { className: 'alarmes-views' });
    const viewDefs = [
      { id: 'hoje', label: 'Hoje' },
      { id: 'proximos', label: 'Próximos' },
      { id: 'recorrentes', label: 'Recorrentes' },
      { id: 'concluidos', label: 'Concluídos' },
    ];
    for (const v of viewDefs) {
      views.appendChild(h('button', {
        type: 'button',
        className: 'btn ghost' + (alarmesView === v.id ? ' active' : ''),
        text: v.label,
        onClick: () => {
          alarmesView = v.id;
          renderModule();
        },
      }));
    }
    body.appendChild(views);

    const col = h('div', { className: 'alarmes-cols' });
    const remCol = h('div', { className: 'alarmes-col' }, h('h3', { text: 'Lembretes' }));
    const tmrCol = h('div', { className: 'alarmes-col' }, h('h3', { text: 'Timers' }));
    col.append(remCol, tmrCol);
    body.appendChild(col);

    remCol.appendChild(h('button', {
      type: 'button', className: 'btn primary', text: 'Novo lembrete (+1 min)',
      onClick: async () => {
        const focused = hooks().getFocusedNav && hooks().getFocusedNav();
        await window.multiheiz.alarmesAddReminder({
          title: 'Lembrete',
          kind: 'one-off',
          at: Date.now() + 60000,
          priority: 'normal',
          windowId: focused && focused.accountId ? focused.accountId : null,
        });
        renderModule();
      },
    }));

    const filtered = await window.multiheiz.alarmesFilter(alarmesView);
    for (const r of filtered || []) {
      const pri = r.priority || 'normal';
      const next = r.snoozeUntil || r.nextAt || r.at;
      remCol.appendChild(h('div', {
        className: `mgr-row alarmes-row-pri-${pri}`,
      },
        h('div', { className: 'mgr-row-main' },
          h('div', {},
            h('span', { className: `alarmes-priority ${pri}`, title: pri }),
            h('strong', { text: r.title })
          ),
          h('span', {
            className: 'muted-note',
            text: `${r.kind}${r.snoozeUntil ? ' · adiado' : ''} · ${pri} · ${next ? new Date(next).toLocaleString('pt-BR') : '—'}`,
          })
        ),
        h('button', {
          type: 'button', className: 'btn ghost', text: 'Ir até a janela',
          onClick: () => goToReminderWindow(r),
        }),
        alarmesView !== 'concluidos'
          ? h('button', {
            type: 'button', className: 'btn ghost', text: 'Concluir',
            onClick: async () => {
              await window.multiheiz.alarmesCompleteReminder(r.id);
              renderModule();
            },
          })
          : null,
        h('button', {
          type: 'button', className: 'btn ghost', text: 'Remover',
          onClick: async () => {
            if (!window.confirm(`Remover o lembrete "${r.title}"?`)) return;
            await window.multiheiz.alarmesRemoveReminder(r.id);
            renderModule();
          },
        })
      ));
    }
    if (!(filtered || []).length) {
      remCol.appendChild(h('p', { className: 'muted-note', text: 'Nenhum lembrete nesta vista.' }));
    }

    tmrCol.appendChild(h('button', {
      type: 'button', className: 'btn primary', text: 'Timer 1 min',
      onClick: async () => {
        const t = await window.multiheiz.alarmesAddTimer({ title: 'Timer', durationMs: 60000 });
        await window.multiheiz.alarmesStartTimer(t.id);
        renderModule();
      },
    }));
    for (const t of data.timers || []) {
      const left = t.running
        ? Math.max(0, (t.endsAt || 0) - Date.now())
        : t.remainingMs || t.durationMs;
      tmrCol.appendChild(h('div', { className: 'mgr-row' },
        h('div', { className: 'mgr-row-main' },
          h('strong', { text: t.title }),
          h('span', { className: 'muted-note', text: `${Math.ceil(left / 1000)}s · ${t.running ? 'rodando' : 'pausado'}` })
        ),
        h('button', {
          type: 'button', className: 'btn ghost', text: t.running ? 'Pausar' : 'Iniciar',
          onClick: async () => {
            if (t.running) await window.multiheiz.alarmesPauseTimer(t.id);
            else await window.multiheiz.alarmesStartTimer(t.id);
            renderModule();
          },
        }),
        h('button', {
          type: 'button', className: 'btn ghost', text: 'Reset',
          onClick: async () => {
            await window.multiheiz.alarmesResetTimer(t.id);
            renderModule();
          },
        }),
        h('button', {
          type: 'button', className: 'btn ghost', text: 'Remover',
          onClick: async () => {
            if (!window.confirm(`Remover o timer "${t.title}"?`)) return;
            await window.multiheiz.alarmesRemoveTimer(t.id);
            renderModule();
          },
        })
      ));
    }

    api._alarmesTest = {
      goToReminderWindow,
      getView: () => alarmesView,
      setView: (v) => {
        alarmesView = v;
      },
    };
  }

  /* ---- Notas UI (estilo Keep) ---- */
  let notasCurrent = null;
  let notasPreview = false;
  let notasSaveTimer = null;
  let notasSearchQ = '';
  const NOTA_COLORS = [
    { id: 'padrao', label: 'Padrão' },
    { id: 'vermelho', label: 'Vermelho' },
    { id: 'laranja', label: 'Laranja' },
    { id: 'amarelo', label: 'Amarelo' },
    { id: 'verde', label: 'Verde' },
    { id: 'petroleo', label: 'Azul-petróleo' },
    { id: 'azul', label: 'Azul' },
    { id: 'roxo', label: 'Roxo' },
    { id: 'rosa', label: 'Rosa' },
  ];

  async function renderNotas(body) {
    body.classList.add('notas-body-keep');
    const notes = await window.multiheiz.notasList();
    const wrap = h('div', { className: 'notas-keep' });
    const editorPane = h('div', { className: 'notas-editor-pane' });
    body.append(wrap, editorPane);

    const toolbar = h('div', { className: 'notas-keep-toolbar' });
    const search = h('input', {
      type: 'search',
      placeholder: 'Buscar notas…',
      className: 'mgr-search notas-keep-search',
      value: notasSearchQ || '',
    });
    toolbar.appendChild(
      h('button', {
        type: 'button',
        className: 'btn primary',
        text: 'Nova nota',
        onClick: async () => {
          notasCurrent = await window.multiheiz.notasCreate('Nova nota');
          notasPreview = false;
          renderModule();
        },
      })
    );
    toolbar.appendChild(search);
    wrap.appendChild(toolbar);

    async function autosave(fields) {
      if (!notasCurrent) return;
      if (notasSaveTimer) clearTimeout(notasSaveTimer);
      notasSaveTimer = setTimeout(async () => {
        notasCurrent = await window.multiheiz.notasUpdate({ id: notasCurrent.id, ...fields });
        // Refresh card titles without full remount when possible
        const card = wrap.querySelector(`.nota-card[data-id="${notasCurrent.id}"]`);
        if (card && fields.title != null) {
          const t = card.querySelector('.nota-card-title');
          if (t && document.activeElement !== t) t.value = notasCurrent.title || '';
        }
      }, 350);
    }

    async function renameNoteUi(note) {
      const next = window.prompt('Renomear nota:', note.title || '');
      if (next == null) return;
      const title = String(next).trim();
      if (!title) return;
      await window.multiheiz.notasUpdate({ id: note.id, title });
      if (notasCurrent && notasCurrent.id === note.id) {
        notasCurrent = await window.multiheiz.notasGet(note.id);
      }
      renderModule();
    }

    async function setColorUi(note, colorId) {
      await window.multiheiz.notasUpdate({ id: note.id, color: colorId });
      if (notasCurrent && notasCurrent.id === note.id) {
        notasCurrent = await window.multiheiz.notasGet(note.id);
      }
      renderModule();
    }

    async function togglePinUi(note) {
      await window.multiheiz.notasUpdate({ id: note.id, pinned: !note.pinned });
      if (notasCurrent && notasCurrent.id === note.id) {
        notasCurrent = await window.multiheiz.notasGet(note.id);
      }
      renderModule();
    }

    function openNoteMenu(note, x, y) {
      const items = [
        { label: 'Renomear', onClick: () => renameNoteUi(note) },
        {
          label: note.pinned ? 'Desafixar' : 'Fixar',
          onClick: () => togglePinUi(note),
        },
        ...NOTA_COLORS.map((c) => ({
          label: (note.color === c.id ? '● ' : '○ ') + 'Cor: ' + c.label,
          onClick: () => setColorUi(note, c.id),
        })),
        {
          label: 'Excluir',
          onClick: async () => {
            const title = note.title || 'Sem título';
            if (!window.confirm(`Excluir a nota "${title}"? Esta ação não pode ser desfeita.`)) return;
            await window.multiheiz.notasRemove(note.id);
            if (notasCurrent && notasCurrent.id === note.id) notasCurrent = null;
            renderModule();
          },
        },
      ];
      showV16ContextMenu(x, y, items);
    }

    function makeCard(note) {
      const color = note.color || 'padrao';
      const card = h('div', {
        className:
          'nota-card nota-color-' +
          color +
          (notasCurrent && notasCurrent.id === note.id ? ' active' : '') +
          (note.pinned ? ' pinned' : ''),
        'data-id': note.id,
        'data-color': color,
        'data-pinned': note.pinned ? '1' : '0',
      });
      const head = h('div', { className: 'nota-card-head' });
      const titleInput = h('input', {
        className: 'nota-card-title',
        value: note.title || 'Sem título',
        title: 'Título',
        'data-role': 'nota-title',
      });
      titleInput.addEventListener('click', (e) => e.stopPropagation());
      titleInput.addEventListener('input', () => {
        if (notasCurrent && notasCurrent.id === note.id) {
          autosave({ title: titleInput.value });
        } else {
          window.multiheiz.notasUpdate({ id: note.id, title: titleInput.value });
        }
      });
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          titleInput.blur();
        }
      });
      const menuBtn = h('button', {
        type: 'button',
        className: 'btn ghost tiny nota-card-menu',
        text: '⋯',
        title: 'Opções da nota',
        onClick: (e) => {
          e.stopPropagation();
          const r = menuBtn.getBoundingClientRect();
          openNoteMenu(note, r.left, r.bottom + 2);
        },
      });
      if (note.pinned) {
        head.appendChild(h('span', { className: 'nota-pin-badge', text: 'Fixada', title: 'Fixada' }));
      }
      head.append(titleInput, menuBtn);
      const previewText = String(note.body || '')
        .split(/\r?\n/)
        .slice(0, 6)
        .join('\n');
      const bodyEl = h('div', { className: 'nota-card-body', text: previewText || ' ' });
      card.append(head, bodyEl);
      card.addEventListener('click', async () => {
        notasCurrent = await window.multiheiz.notasGet(note.id);
        notasPreview = false;
        renderModule();
      });
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openNoteMenu(note, e.clientX, e.clientY);
      });
      return card;
    }

    function filterNotes(list) {
      const q = (notasSearchQ || '').trim().toLowerCase();
      if (!q) return list;
      return list.filter(
        (n) =>
          (n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q)
      );
    }

    const filtered = filterNotes(notes);
    const pinned = filtered.filter((n) => n.pinned);
    const others = filtered.filter((n) => !n.pinned);

    function appendSection(title, items) {
      if (!items.length) return;
      const sec = h('div', { className: 'notas-section' });
      sec.appendChild(h('h3', { className: 'notas-section-title', text: title }));
      const grid = h('div', { className: 'notas-grid' });
      for (const n of items) grid.appendChild(makeCard(n));
      sec.appendChild(grid);
      wrap.appendChild(sec);
    }

    if (!filtered.length) {
      wrap.appendChild(
        h('p', {
          className: 'muted-note notas-empty',
          text: notes.length ? 'Nenhuma nota corresponde à busca.' : 'Nenhuma nota. Crie a primeira!',
        })
      );
    } else {
      if (pinned.length) appendSection('Fixadas', pinned);
      appendSection(pinned.length ? 'Outras' : 'Notas', others.length ? others : []);
      if (pinned.length && !others.length) {
        /* only pinned — ok */
      } else if (!pinned.length && others.length) {
        /* already appended as Notas */
      }
    }

    search.addEventListener('input', () => {
      notasSearchQ = search.value;
      renderModule();
    });

    // Editor pane
    if (!notasCurrent && filtered[0]) notasCurrent = filtered[0];
    if (!notasCurrent) {
      editorPane.appendChild(h('p', { className: 'muted-note', text: 'Selecione ou crie uma nota.' }));
    } else {
      const color = notasCurrent.color || 'padrao';
      editorPane.className = 'notas-editor-pane nota-color-' + color;
      editorPane.dataset.color = color;
      const title = h('input', {
        className: 'notas-title',
        value: notasCurrent.title || '',
        'data-role': 'nota-editor-title',
      });
      const tools = h('div', { className: 'notas-toolbar' });
      tools.appendChild(
        h('button', {
          type: 'button',
          className: 'btn ghost',
          text: notasCurrent.pinned ? 'Desafixar' : 'Fixar',
          onClick: () => togglePinUi(notasCurrent),
        })
      );
      const colorWrap = h('div', { className: 'notas-color-palette', 'data-role': 'nota-palette' });
      for (const c of NOTA_COLORS) {
        colorWrap.appendChild(
          h('button', {
            type: 'button',
            className:
              'nota-swatch nota-color-' + c.id + (notasCurrent.color === c.id ? ' active' : ''),
            title: c.label,
            'data-color': c.id,
            'aria-label': c.label,
            onClick: () => setColorUi(notasCurrent, c.id),
          })
        );
      }
      tools.appendChild(colorWrap);
      tools.appendChild(
        h('button', {
          type: 'button',
          className: 'btn ghost',
          text: 'Renomear',
          onClick: () => renameNoteUi(notasCurrent),
        })
      );
      tools.appendChild(
        h('button', {
          type: 'button',
          className: 'btn ghost',
          text: notasPreview ? 'Editar' : 'Pré-visualizar',
          onClick: () => {
            notasPreview = !notasPreview;
            renderModule();
          },
        })
      );
      tools.appendChild(
        h('button', {
          type: 'button',
          className: 'btn ghost',
          text: 'Excluir',
          onClick: async () => {
            const t = notasCurrent.title || 'Sem título';
            if (!window.confirm(`Excluir a nota "${t}"? Esta ação não pode ser desfeita.`)) return;
            await window.multiheiz.notasRemove(notasCurrent.id);
            notasCurrent = null;
            renderModule();
          },
        })
      );
      editorPane.append(title, tools);
      title.addEventListener('input', () => autosave({ title: title.value }));

      if (notasPreview) {
        const html = await window.multiheiz.notasPreview(notasCurrent.body || '');
        const preview = h('div', { className: 'notas-preview' });
        preview.innerHTML = html;
        editorPane.appendChild(preview);
      } else {
        const ta = h('textarea', { className: 'notas-editor', 'data-role': 'nota-editor-body' });
        ta.value = notasCurrent.body || '';
        ta.addEventListener('input', () => autosave({ body: ta.value }));
        editorPane.appendChild(ta);
      }
    }

    api._notasTest = {
      getCurrent: () => (notasCurrent ? { ...notasCurrent } : null),
      setSearch: (q) => {
        notasSearchQ = String(q || '');
      },
      rename: renameNoteUi,
      setColor: setColorUi,
      togglePin: togglePinUi,
      colors: NOTA_COLORS.slice(),
    };
  }

  /* ---------- Novidades / changelog (v1.8 B9) ---------- */

  let novidadesPendingMark = false;

  function tagClass(tag) {
    const t = String(tag || '');
    if (t === 'Novo') return 'tag-novo';
    if (t === 'Melhoria') return 'tag-melhoria';
    if (t === 'Correção') return 'tag-correcao';
    return 'tag-melhoria';
  }

  /**
   * @param {{ auto?: boolean, markSeen?: boolean }} [opts]
   */
  async function openNovidades(opts) {
    const markSeen = !!(opts && opts.markSeen);
    novidadesPendingMark = markSeen;
    const dlg = document.getElementById('dlg-novidades');
    const list = document.getElementById('novidades-list');
    const intro = document.getElementById('novidades-intro');
    if (!dlg || !list) return { ok: false, reason: 'missing-ui' };

    let data = null;
    let version = hooks().getAppVersion ? hooks().getAppVersion() : '';
    try {
      const r = await window.multiheiz.changelogGet();
      if (r && r.ok) {
        data = r.data;
        if (r.version) version = r.version;
      }
    } catch {
      /* ignore */
    }
    if (intro) {
      intro.textContent = version
        ? `Log de atualizações · versão atual ${version}`
        : 'Log de atualizações do MultiHeiz';
    }
    list.replaceChildren();
    const versions = (data && data.versions) || [];
    for (const ver of versions) {
      const block = document.createElement('section');
      block.className = 'novidades-version';
      block.dataset.version = String(ver.version || '');
      const h = document.createElement('h3');
      const titleBit = ver.title ? ` — ${ver.title}` : '';
      h.textContent = ver.date
        ? `${ver.version}${titleBit} · ${ver.date}`
        : `${ver.version || ''}${titleBit}`;
      block.appendChild(h);
      const ul = document.createElement('ul');
      for (const entry of ver.entries || []) {
        const li = document.createElement('li');
        const tag = document.createElement('span');
        tag.className = tagClass(entry.tag);
        tag.textContent = String(entry.tag || '');
        const text = document.createElement('span');
        text.textContent = String(entry.text || '');
        li.appendChild(tag);
        li.appendChild(text);
        ul.appendChild(li);
      }
      block.appendChild(ul);
      list.appendChild(block);
    }

    if (!dlg.open) {
      if (hooks().pushOverlay) hooks().pushOverlay('dlg-novidades');
      dlg.showModal();
    }
    return { ok: true, count: versions.length, version };
  }

  function closeNovidadesAndMaybeMark() {
    const dlg = document.getElementById('dlg-novidades');
    if (dlg && dlg.open) dlg.close();
  }

  /* ---------- Atualizações (electron-updater) ---------- */

  /**
   * Mirror of main computeUpdateActionButtons (renderer cannot require updater.js).
   * Baixar only when available; Cancelar only while downloading; Reiniciar only when ready.
   * Manual-only channels: all three hidden + disabled.
   */
  function computeUpdateActionButtons(st) {
    const s = st || {};
    const channel = s.channel || 'unknown';
    const manual =
      !!s.manualDownload ||
      s.status === 'available-manual' ||
      channel === 'deb' ||
      channel === 'unknown';
    const downloading = s.status === 'downloading';
    const ready = s.status === 'ready' || !!s.canInstall;
    const available =
      !ready && !downloading && (s.status === 'available' || !!s.canDownload);
    if (manual) {
      return {
        download: { visible: false, enabled: false },
        cancel: { visible: false, enabled: false },
        install: { visible: false, enabled: false },
      };
    }
    return {
      download: { visible: available, enabled: available },
      cancel: { visible: downloading, enabled: downloading },
      install: { visible: ready, enabled: ready },
    };
  }

  function applyUpdateButton(btn, state) {
    if (!btn || !state) return;
    btn.classList.toggle('hidden', !state.visible);
    btn.disabled = !state.enabled;
  }

  function applyUpdatesStatus(st) {
    if (!st) return;
    const el = document.getElementById('updates-status');
    if (el) {
      // Mensagens do main; se começa com "Erro", manter como veio
      el.textContent = st.message || '';
    }
    const chEl = document.getElementById('settings-update-channel');
    if (chEl && (st.channelLabel || st.channel)) {
      chEl.textContent = st.channelLabel || st.channel || '—';
    }
    const lastEl = document.getElementById('settings-update-last-check');
    if (lastEl) {
      lastEl.textContent = st.lastCheckAt
        ? new Date(st.lastCheckAt).toLocaleString('pt-BR')
        : '—';
    }
    const buttons = st.buttons || computeUpdateActionButtons(st);
    applyUpdateButton(document.getElementById('btn-download-update'), buttons.download);
    applyUpdateButton(document.getElementById('btn-cancel-update'), buttons.cancel);
    applyUpdateButton(document.getElementById('btn-install-update'), buttons.install);
    const btnFolder = document.getElementById('btn-open-download-folder');
    // Portable download folder is Windows-only; never show on Linux.
    // notWritable: pasta do exe sem permissão (salvo em Downloads) ou caminho portátil desconhecido.
    const showFolder =
      typeof navigator !== 'undefined' &&
      /Win/i.test(navigator.platform || '') &&
      !!(st.notWritable || (st.status === 'error' && st.downloadPath));
    if (btnFolder) btnFolder.classList.toggle('hidden', !showFolder);
    // btn-open-releases permanece sempre visível
  }

  async function refreshUpdatesPane() {
    const v = document.getElementById('settings-version');
    if (v) v.textContent = (hooks().getAppVersion && hooks().getAppVersion()) || '—';
    try {
      const auto = await window.multiheiz.updatesGetAutoCheck();
      const chk = document.getElementById('chk-auto-check-updates');
      if (chk && auto) chk.checked = auto.enabled !== false;
    } catch {
      /* ignore */
    }
    try {
      if (window.multiheiz.updatesGetChannel) {
        const ch = await window.multiheiz.updatesGetChannel();
        const chEl = document.getElementById('settings-update-channel');
        if (chEl && ch) chEl.textContent = ch.channelLabel || ch.channel || '—';
      }
    } catch {
      /* ignore */
    }
    try {
      const st = await window.multiheiz.updatesStatus();
      if (st && st.ok !== false) applyUpdatesStatus(st);
    } catch {
      /* ignore */
    }
  }

  function wireUpdatesUi() {
    const checkUp = document.getElementById('btn-check-updates');
    if (checkUp) {
      checkUp.addEventListener('click', async () => {
        checkUp.disabled = true;
        try {
          const r = await window.multiheiz.updatesCheck();
          applyUpdatesStatus(r);
        } finally {
          checkUp.disabled = false;
        }
      });
    }
    const btnDl = document.getElementById('btn-download-update');
    if (btnDl) {
      btnDl.addEventListener('click', async () => {
        btnDl.disabled = true;
        try {
          const r = window.multiheiz.updatesDownload
            ? await window.multiheiz.updatesDownload()
            : await window.multiheiz.updatesCheck();
          applyUpdatesStatus(r);
        } catch {
          /* applyUpdatesStatus below if we have no r — leave disabled until refresh */
        }
      });
    }
    const btnCancel = document.getElementById('btn-cancel-update');
    if (btnCancel) {
      btnCancel.addEventListener('click', async () => {
        btnCancel.disabled = true;
        try {
          if (window.multiheiz.updatesCancel) {
            const r = await window.multiheiz.updatesCancel();
            applyUpdatesStatus(r);
          }
        } catch {
          /* keep disabled until next status */
        }
      });
    }
    const btnInst = document.getElementById('btn-install-update');
    if (btnInst) {
      btnInst.addEventListener('click', async () => {
        await window.multiheiz.updatesInstall();
      });
    }
    const btnFolder = document.getElementById('btn-open-download-folder');
    if (btnFolder) {
      btnFolder.addEventListener('click', () => {
        if (window.multiheiz.updatesOpenDownload) window.multiheiz.updatesOpenDownload();
      });
    }
    const btnRel = document.getElementById('btn-open-releases');
    if (btnRel) {
      btnRel.addEventListener('click', () => window.multiheiz.updatesOpenReleases());
    }
    const chk = document.getElementById('chk-auto-check-updates');
    if (chk) {
      chk.addEventListener('change', async () => {
        await window.multiheiz.updatesSetAutoCheck(!!chk.checked);
        showSaved();
      });
    }
  }

  /* ---------- Settings redesign ---------- */

  function wireSettings() {
    const nav = document.querySelectorAll('.settings-nav-btn');
    nav.forEach((btn) => {
      btn.addEventListener('click', () => {
        nav.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const section = btn.getAttribute('data-section');
        document.querySelectorAll('.settings-pane').forEach((p) => {
          p.classList.toggle('active', p.getAttribute('data-pane') === section);
        });
        if (section === 'diagnosticos') refreshDiagnostics();
        if (section === 'sobre') refreshAbout();
        if (section === 'adblock') refreshAdblockUi();
        if (section === 'extensoes') refreshExtensionsUi();
        if (section === 'atualizacoes') {
          refreshUpdatesPane();
        }
      });
    });

    const form = document.getElementById('form-settings');
    if (!form) return;

    form.addEventListener('change', (e) => {
      const t = e.target;
      if (t && (t.name === 'dohMode' || t.name === 'dohProvider')) {
        syncDohFormVisibility();
      }
      autosaveSettings();
    });
    form.addEventListener('input', (e) => {
      const t = e.target;
      if (
        t &&
        (t.name === 'homepage' ||
          t.name === 'searchTemplate' ||
          t.name === 'suspendDelayMs' ||
          t.name === 'memoryLimitMb' ||
          t.name === 'panelMemoryLimitMb' ||
          t.name === 'dohCustomUrl')
      ) {
        autosaveSettings();
      }
    });

    const pick = document.getElementById('btn-pick-download-folder');
    if (pick) {
      pick.addEventListener('click', async () => {
        const s = await window.multiheiz.downloadsPickFolder();
        const inp = document.getElementById('download-folder');
        if (inp) inp.value = s.defaultFolder || '';
        showSaved();
      });
    }

    const btnUp = document.getElementById('btn-adblock-update');
    if (btnUp) {
      btnUp.addEventListener('click', async () => {
        btnUp.disabled = true;
        try {
          await window.multiheiz.adblockUpdateLists();
          await refreshAdblockUi();
          showSaved();
        } finally {
          btnUp.disabled = false;
        }
      });
    }
    const btnAllow = document.getElementById('btn-adblock-allow-add');
    if (btnAllow) {
      btnAllow.addEventListener('click', async () => {
        const inp = document.getElementById('adblock-allow-input');
        const d = inp && inp.value.trim();
        if (!d) return;
        const r = await window.multiheiz.adblockAllowlistAdd(d);
        if (r && r.state) applyState(r.state);
        if (inp) inp.value = '';
        await refreshAdblockUi();
        showSaved();
      });
    }
    const btnCustom = document.getElementById('btn-adblock-custom-add');
    if (btnCustom) {
      btnCustom.addEventListener('click', async () => {
        const inp = document.getElementById('adblock-custom-url');
        const url = inp && inp.value.trim();
        if (!url) return;
        btnCustom.disabled = true;
        try {
          const r = await window.multiheiz.adblockCustomListAdd(url);
          if (!r || !r.ok) {
            toast((r && r.error) || 'Falha ao adicionar lista');
            return;
          }
          if (inp) inp.value = '';
          await refreshAdblockUi();
          showSaved();
        } finally {
          btnCustom.disabled = false;
        }
      });
    }
    const btnRules = document.getElementById('btn-adblock-user-rules');
    if (btnRules) {
      btnRules.addEventListener('click', async () => {
        const ta = document.getElementById('adblock-user-rules');
        btnRules.disabled = true;
        try {
          const r = await window.multiheiz.adblockSetUserRules(ta ? ta.value : '');
          if (r && r.state) applyState(r.state);
          await refreshAdblockUi();
          showSaved();
        } finally {
          btnRules.disabled = false;
        }
      });
    }

    wireExtensionsUi();

    wireUpdatesUi();
    const openNov = document.getElementById('btn-open-novidades');
    if (openNov) {
      openNov.addEventListener('click', () => openNovidades({ auto: false, markSeen: false }));
    }
    const aboutNov = document.getElementById('btn-about-novidades');
    if (aboutNov) {
      aboutNov.addEventListener('click', () => openNovidades({ auto: false, markSeen: false }));
    }
    const closeNov = document.getElementById('btn-novidades-close');
    if (closeNov) {
      closeNov.addEventListener('click', () => {
        closeNovidadesAndMaybeMark();
      });
    }
    const dlgNov = document.getElementById('dlg-novidades');
    if (dlgNov) {
      dlgNov.addEventListener('close', () => {
        if (novidadesPendingMark) {
          novidadesPendingMark = false;
          window.multiheiz.changelogMarkSeen().then((r) => {
            if (r && r.state) applyState(r.state);
          }).catch(() => {});
        }
      });
    }

    const openData = document.getElementById('btn-open-data');
    if (openData) openData.addEventListener('click', () => window.multiheiz.openDataFolder());

    const exportDiag = document.getElementById('btn-export-diag');
    if (exportDiag) {
      exportDiag.addEventListener('click', async () => {
        const r = await window.multiheiz.diagnosticsExport();
        if (r && r.ok) toast('Diagnóstico exportado');
      });
    }

    const openKofi = async () => {
      const about = await window.multiheiz.getAbout();
      if (about && about.kofiUrl) window.multiheiz.openExternal(about.kofiUrl);
    };
    const kofi = document.getElementById('btn-kofi');
    if (kofi) kofi.addEventListener('click', openKofi);
    const kofiStatus = document.getElementById('btn-kofi-status');
    if (kofiStatus) kofiStatus.addEventListener('click', openKofi);
  }

  function syncDohFormVisibility() {
    const form = document.getElementById('form-settings');
    if (!form) return;
    const mode = (form.dohMode && form.dohMode.value) || 'off';
    const provider = (form.dohProvider && form.dohProvider.value) || 'cloudflare';
    const providerWrap = document.getElementById('doh-provider-wrap');
    const customWrap = document.getElementById('doh-custom-wrap');
    if (providerWrap) providerWrap.hidden = mode === 'off';
    if (customWrap) customWrap.hidden = mode === 'off' || provider !== 'custom';
  }

  let settingsSaveTimer = null;
  function autosaveSettings() {
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(async () => {
      const form = document.getElementById('form-settings');
      if (!form) return;
      try {
        const partial = {
          openLastPage: !!form.openLastPage.checked,
          persistSessions: !!(form.persistSessions && form.persistSessions.checked),
          confirmOnRemove: !!form.confirmOnRemove.checked,
          keepBackgroundRunning: !!form.keepBackgroundRunning.checked,
          suspendHidden: !!form.suspendHidden.checked,
          suspendDelayMs: Number(form.suspendDelayMs.value) || 0,
          homepage: form.homepage.value || 'https://www.google.com',
          uaIdentity: (form.uaIdentity && form.uaIdentity.value) || 'chrome',
          windowsPasskeys: !(form.windowsPasskeys && form.windowsPasskeys.checked === false),
          blankLinkMode: (form.blankLinkMode && form.blankLinkMode.value) || 'same',
          searchEngine: form.searchEngine.value || 'google',
          searchTemplate: form.searchTemplate.value || '',
          memoryLimitMb: Number(form.memoryLimitMb.value) || 0,
          panelMemoryLimitMb: Number(form.panelMemoryLimitMb.value) || 0,
          hardMemoryLimit: !!form.hardMemoryLimit.checked,
          backgroundThrottling: !!form.backgroundThrottling.checked,
          backgroundFps: Number(form.backgroundFps.value) || 5,
          backgroundPreset: (form.backgroundPreset && form.backgroundPreset.value) || 'balanced',
          lightMode: !!(form.lightMode && form.lightMode.checked),
          sidebarAlwaysActive: !!(form.sidebarAlwaysActive && form.sidebarAlwaysActive.checked),
          doh: {
            mode: (form.dohMode && form.dohMode.value) || 'off',
            provider: (form.dohProvider && form.dohProvider.value) || 'cloudflare',
            customUrl: (form.dohCustomUrl && form.dohCustomUrl.value) || '',
          },
          frameCapHidden: Number(form.frameCapHidden && form.frameCapHidden.value) || 30,
          frameCapAll: Number(form.frameCapAll && form.frameCapAll.value) || 0,
          preferHighPerfGpu: !!(form.preferHighPerfGpu && form.preferHighPerfGpu.checked),
          modules: {
            planilha: !!form.modPlanilha.checked,
            alarmes: !!form.modAlarmes.checked,
            notas: !!form.modNotas.checked,
          },
          adblock: {
            enabled: !!form.adblockEnabled.checked,
            antiTracking: !!form.adblockAntiTracking.checked,
            cosmetic: !!form.adblockCosmetic.checked,
            youtubeExperimental: !!form.adblockYoutube.checked,
            updateIntervalHours: Number(form.adblockUpdateInterval && form.adblockUpdateInterval.value) || 24,
            lists: collectAdblockListFlags(),
          },
          extensions: {
            abuCompat: !(form.extAbuCompat && form.extAbuCompat.checked === false),
          },
        };
        const cur = getState();
        const prevSettings = (cur && cur.settings) || {};
        const prevSidebarAlways = !!prevSettings.sidebarAlwaysActive;
        const changed = diffSettingsPartial(prevSettings, partial);
        let st = cur;
        if (Object.keys(changed).length > 0) {
          st = await window.multiheiz.updateSettings(changed);
        }
        if (st && st.dohError) {
          const errEl = document.getElementById('doh-error');
          if (errEl) {
            errEl.hidden = false;
            errEl.textContent = st.dohError;
          }
          toast(st.dohError);
          // Keep previous DoH in state; refresh form from returned state snapshot.
          if (st.state) applyState(st.state, { soft: true });
          fillSettingsForm().catch(() => {});
          return;
        }
        const errClear = document.getElementById('doh-error');
        if (errClear) {
          errClear.hidden = true;
          errClear.textContent = '';
        }
        if (st && st.settings) {
          applyState(st, { soft: true });
        }
        if (
          Object.prototype.hasOwnProperty.call(changed, 'sidebarAlwaysActive') &&
          prevSidebarAlways !== !!partial.sidebarAlwaysActive
        ) {
          if (hooks().syncSidebarAfterLegacyChange) {
            await hooks().syncSidebarAfterLegacyChange();
          }
        }
        syncDohFormVisibility();
        const ask = !!form.askWhereToSave.checked;
        const prevAsk = !!(cur && cur.downloads && cur.downloads.askWhereToSave);
        if (ask !== prevAsk || (cur && cur.downloads == null)) {
          await window.multiheiz.downloadsSettings({ askWhereToSave: ask });
        }
        if (hooks().readAppearanceFromForm && hooks().updateAppearanceLive) {
          const appearance = hooks().readAppearanceFromForm();
          const prevAp = (cur && cur.appearance) || {};
          if (!settingsJsonEqual(prevAp, appearance)) {
            const st2 = await window.multiheiz.updateAppearance(appearance);
            applyState(st2, { soft: true });
            hooks().updateAppearanceLive(appearance);
          }
        }
        showSaved();
        if (changed.modules) renderSidebarModules();
        if (changed.adblock) refreshAdblockUi();
      } catch (err) {
        const msg = err && err.message ? err.message : String(err || '');
        showSaveError(msg);
      }
    }, 280);
  }

  function collectAdblockListFlags() {
    const flags = {};
    const root = document.getElementById('adblock-catalog');
    if (!root) return flags;
    root.querySelectorAll('input[data-list-id]').forEach((inp) => {
      flags[inp.getAttribute('data-list-id')] = !!inp.checked;
    });
    return flags;
  }

  async function refreshAdblockUi() {
    const status = await window.multiheiz.adblockStatus();
    const last = document.getElementById('adblock-last-update');
    if (last) {
      last.textContent = status.lastUpdateAt
        ? new Date(status.lastUpdateAt).toLocaleString('pt-BR')
        : 'nunca';
    }
    const total = document.getElementById('adblock-total-rules');
    if (total) {
      total.textContent = status.ready
        ? `${status.totalFilterCount || 0} (${status.networkFilterCount || 0} rede + ${status.cosmeticFilterCount || 0} cosmético)`
        : '—';
    }
    const msg = document.getElementById('adblock-status-msg');
    if (msg) {
      msg.textContent =
        status.statusMessage ||
        (status.ready ? `Pronto · fonte ${status.engineSource || '?'}` : 'Carregando…');
    }
    const prog = document.getElementById('adblock-progress');
    if (prog) {
      prog.textContent = status.rebuilding ? status.progress || 'Recompilando…' : '';
    }
    const interval = document.getElementById('adblock-update-interval');
    if (interval && status.updateIntervalHours) {
      interval.value = String(status.updateIntervalHours);
    }
    const ta = document.getElementById('adblock-user-rules');
    if (ta && typeof status.userRules === 'string' && document.activeElement !== ta) {
      ta.value = status.userRules;
    }

    const catalog = document.getElementById('adblock-catalog');
    if (catalog) {
      const byGroup = {};
      for (const item of status.catalog || []) {
        const g = item.group || 'ads';
        if (!byGroup[g]) byGroup[g] = [];
        byGroup[g].push(item);
      }
      const order = ['ads', 'privacy', 'malware', 'regional', 'fixes'];
      catalog.innerHTML = '';
      for (const g of order) {
        const items = byGroup[g];
        if (!items || !items.length) continue;
        const box = document.createElement('div');
        box.className = 'adblock-group';
        const h = document.createElement('h4');
        h.textContent = (status.groupLabels && status.groupLabels[g]) || g;
        box.appendChild(h);
        for (const item of items) {
          const label = document.createElement('label');
          label.className = 'check';
          const inp = document.createElement('input');
          inp.type = 'checkbox';
          inp.setAttribute('data-list-id', item.id);
          inp.checked = item.enabled !== false;
          label.appendChild(inp);
          const nameSpan = document.createElement('span');
          nameSpan.className = 'adblock-list-name';
          nameSpan.appendChild(document.createTextNode(item.name));
          if (item.vendor) {
            const badge = document.createElement('span');
            badge.className = 'badge-vendor';
            badge.textContent = item.vendor;
            nameSpan.appendChild(document.createTextNode(' '));
            nameSpan.appendChild(badge);
          }
          label.appendChild(nameSpan);
          box.appendChild(label);
          if (item.license || item.note) {
            const lic = document.createElement('div');
            lic.className = 'meta adblock-list-license';
            const parts = [];
            if (item.license) parts.push(item.license);
            if (item.note) parts.push(item.note);
            lic.textContent = parts.join(' · ');
            box.appendChild(lic);
          }
          const meta = document.createElement('div');
          meta.className = 'meta';
          if (item.enabled === false) {
            meta.textContent = 'desativada';
          } else {
            const when = item.lastUpdateAt
              ? new Date(item.lastUpdateAt).toLocaleString('pt-BR')
              : '—';
            meta.textContent = `${item.ruleCount || 0} regras · ${item.status || '—'} · ${when}${
              item.error ? ' · ' + item.error : ''
            }`;
          }
          box.appendChild(meta);
        }
        catalog.appendChild(box);
      }
    }

    const customUl = document.getElementById('adblock-custom-lists');
    if (customUl) {
      customUl.innerHTML = '';
      for (const c of status.customLists || []) {
        const li = document.createElement('li');
        const meta = (status.listMeta && status.listMeta[c.id]) || {};
        li.textContent = `${c.name || c.url} (${meta.ruleCount || 0} regras) `;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn ghost tiny';
        rm.textContent = 'Remover';
        rm.addEventListener('click', async () => {
          const r = await window.multiheiz.adblockCustomListRemove(c.id);
          if (r && r.state) applyState(r.state);
          await refreshAdblockUi();
          showSaved();
        });
        li.appendChild(rm);
        customUl.appendChild(li);
      }
    }

    const allowUl = document.getElementById('adblock-allowlist');
    if (allowUl) {
      allowUl.innerHTML = '';
      for (const d of status.allowlist || []) {
        const li = document.createElement('li');
        li.textContent = d + ' ';
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn ghost tiny';
        rm.textContent = 'Remover';
        rm.addEventListener('click', async () => {
          const r = await window.multiheiz.adblockAllowlistRemove(d);
          if (r && r.state) applyState(r.state);
          await refreshAdblockUi();
          showSaved();
        });
        li.appendChild(rm);
        allowUl.appendChild(li);
      }
    }
  }

  async function fillSettingsForm() {
    const form = document.getElementById('form-settings');
    if (!form) return;
    const s = getState().settings || {};
    form.openLastPage.checked = !!s.openLastPage;
    if (form.persistSessions) form.persistSessions.checked = s.persistSessions !== false;
    form.confirmOnRemove.checked = s.confirmOnRemove !== false;
    form.keepBackgroundRunning.checked = !!s.keepBackgroundRunning;
    form.suspendHidden.checked = !!s.suspendHidden;
    form.suspendDelayMs.value = Number(s.suspendDelayMs) || 0;
    form.homepage.value = s.homepage || 'https://www.google.com';
    if (form.uaIdentity) form.uaIdentity.value = s.uaIdentity || 'chrome';
    if (form.windowsPasskeys) form.windowsPasskeys.checked = s.windowsPasskeys !== false;
    if (form.blankLinkMode) form.blankLinkMode.value = s.blankLinkMode || 'same';
    form.searchEngine.value = s.searchEngine || 'google';
    form.searchTemplate.value = s.searchTemplate || '';
    form.memoryLimitMb.value = Number(s.memoryLimitMb) || 0;
    form.panelMemoryLimitMb.value = Number(s.panelMemoryLimitMb) || 0;
    form.hardMemoryLimit.checked = !!s.hardMemoryLimit;
    form.backgroundThrottling.checked = !!s.backgroundThrottling;
    form.backgroundFps.value = String(Number(s.backgroundFps) || 5);
    if (form.backgroundPreset) form.backgroundPreset.value = s.backgroundPreset || 'balanced';
    if (form.lightMode) form.lightMode.checked = !!s.lightMode;
    if (form.sidebarAlwaysActive) form.sidebarAlwaysActive.checked = !!s.sidebarAlwaysActive;
    const doh = s.doh || {};
    if (form.dohMode) form.dohMode.value = doh.mode || 'off';
    if (form.dohProvider) form.dohProvider.value = doh.provider || 'cloudflare';
    if (form.dohCustomUrl) form.dohCustomUrl.value = doh.customUrl || '';
    syncDohFormVisibility();
    if (form.frameCapHidden) form.frameCapHidden.value = String(Number(s.frameCapHidden) || 30);
    if (form.frameCapAll) form.frameCapAll.value = String(Number(s.frameCapAll) || 0);
    if (form.preferHighPerfGpu) form.preferHighPerfGpu.checked = !!s.preferHighPerfGpu;
    form.modPlanilha.checked = !s.modules || s.modules.planilha !== false;
    form.modAlarmes.checked = !s.modules || s.modules.alarmes !== false;
    form.modNotas.checked = !s.modules || s.modules.notas !== false;
    const ab = s.adblock || {};
    if (form.adblockEnabled) form.adblockEnabled.checked = ab.enabled !== false;
    if (form.adblockAntiTracking) form.adblockAntiTracking.checked = ab.antiTracking !== false;
    if (form.adblockCosmetic) form.adblockCosmetic.checked = ab.cosmetic !== false;
    if (form.adblockYoutube) form.adblockYoutube.checked = !!ab.youtubeExperimental;
    if (form.adblockUpdateInterval) {
      form.adblockUpdateInterval.value = String(ab.updateIntervalHours || 24);
    }
    const extSettings = s.extensions || {};
    if (form.extAbuCompat) {
      form.extAbuCompat.checked = extSettings.abuCompat !== false;
    }
    const dl = await window.multiheiz.downloadsList();
    form.downloadFolder.value = (dl.settings && dl.settings.defaultFolder) || '';
    form.askWhereToSave.checked = !!(dl.settings && dl.settings.askWhereToSave);
    if (hooks().fillAppearanceForm) hooks().fillAppearanceForm();
    const ver = document.getElementById('settings-version');
    if (ver) ver.textContent = (hooks().getAppVersion && hooks().getAppVersion()) || '—';
    await refreshAdblockUi();
    await refreshExtensionsUi();
  }

  function setExtStatus(msg, isError) {
    for (const id of ['ext-status']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.textContent = msg || '';
      el.style.color = isError ? '#c96b6b' : '';
    }
  }

  function extSourceLabel(source) {
    if (source === 'chrome-web-store') return 'Chrome Web Store';
    if (source === 'edge-addons') return 'Edge';
    if (source === 'crx') return '.crx';
    if (source === 'unpacked') return 'pasta';
    return source || 'pasta';
  }

  function openSettingsSection(section) {
    const btn = document.querySelector(`.settings-nav-btn[data-section="${section}"]`);
    if (btn) btn.click();
  }

  function wireExtensionsUi() {
    const openStore = async (which) => {
      if (!window.multiheiz.extensionsOpenWebstore) return;
      setExtStatus(which === 'edge' ? 'Abrindo loja do Edge…' : 'Abrindo Chrome Web Store…');
      const r = await window.multiheiz.extensionsOpenWebstore(which);
      if (!r || !r.ok) {
        setExtStatus((r && (r.error || r.reason)) || 'Falha ao abrir a loja', true);
        return;
      }
      setExtStatus('');
      // Fechar configurações para ver a nova janela
      const dlg = document.getElementById('dlg-settings');
      if (dlg && dlg.open) dlg.close();
      if (r.state && hooks().applyState) hooks().applyState(r.state);
    };
    const btnCws = document.getElementById('btn-ext-open-cws');
    if (btnCws) btnCws.addEventListener('click', () => openStore('chrome'));
    const btnEdge = document.getElementById('btn-ext-open-edge');
    if (btnEdge) btnEdge.addEventListener('click', () => openStore('edge'));

    const btnUnp = document.getElementById('btn-ext-unpacked');
    if (btnUnp) {
      btnUnp.addEventListener('click', async () => {
        setExtStatus('Instalando…');
        const r = await window.multiheiz.extensionsInstallUnpacked();
        if (r && r.cancelled) {
          setExtStatus('');
          return;
        }
        if (!r || !r.ok) {
          setExtStatus((r && r.error) || 'Falha ao instalar', true);
          return;
        }
        setExtStatus('Instalada: ' + (r.extension && r.extension.name));
        await refreshExtensionsUi();
        showSaved();
      });
    }
    const btnCrx = document.getElementById('btn-ext-crx');
    if (btnCrx) {
      btnCrx.addEventListener('click', async () => {
        setExtStatus('Instalando .crx…');
        const r = await window.multiheiz.extensionsInstallCrx();
        if (r && r.cancelled) {
          setExtStatus('');
          return;
        }
        if (!r || !r.ok) {
          setExtStatus((r && r.error) || 'Falha ao instalar CRX', true);
          return;
        }
        setExtStatus('Instalada: ' + (r.extension && r.extension.name));
        await refreshExtensionsUi();
        showSaved();
      });
    }
    const btnStore = document.getElementById('btn-ext-store');
    if (btnStore) {
      btnStore.addEventListener('click', async () => {
        const inp = document.getElementById('ext-store-input');
        const v = inp && inp.value ? inp.value.trim() : '';
        if (!v) {
          setExtStatus('Informe URL ou ID', true);
          return;
        }
        btnStore.disabled = true;
        setExtStatus('Baixando da loja…');
        try {
          const r = await window.multiheiz.extensionsInstallStore(v);
          if (!r || !r.ok) {
            setExtStatus((r && r.error) || 'Falha ao instalar da loja', true);
            return;
          }
          setExtStatus('Instalada: ' + (r.extension && r.extension.name));
          if (inp) inp.value = '';
          await refreshExtensionsUi();
          showSaved();
        } finally {
          btnStore.disabled = false;
        }
      });
    }
  }

  async function refreshCoexistenceHints() {
    const hint =
      window.multiheiz.extensionsCoexistence &&
      (await window.multiheiz.extensionsCoexistence());
    const msg = hint && hint.suggest ? hint.message : '';
    for (const id of ['adblock-coexistence-hint', 'ext-coexistence-hint']) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (msg) {
        el.hidden = false;
        el.textContent = msg;
      } else {
        el.hidden = true;
        el.textContent = '';
      }
    }
    const form = document.getElementById('form-settings');
    if (hint && hint.suggest && form && form.adblockEnabled && form.adblockEnabled.checked) {
      // Soft prompt once per settings fill — do not auto-uncheck
      const abHint = document.getElementById('adblock-coexistence-hint');
      if (abHint && !abHint.dataset.offered) {
        abHint.dataset.offered = '1';
        const turnOff = window.confirm(
          msg + '\n\nDesligar o bloqueador embutido agora?'
        );
        if (turnOff) {
          form.adblockEnabled.checked = false;
          autosaveSettings();
        }
      }
    }
  }

  async function refreshExtensionsUi() {
    const host = document.getElementById('ext-list');
    if (!host || !window.multiheiz.extensionsList) return;
    const list = await window.multiheiz.extensionsList();
    const accounts = (getState().accounts || []).slice();
    host.replaceChildren();
    await refreshCoexistenceHints();
    if (!list.length) {
      host.appendChild(
        h('p', {
          className: 'muted-note ext-empty',
          text:
            'Nenhuma extensão instalada. Abra a Chrome Web Store ou a loja do Edge e use “Instalar no MultiHeiz”, ou use a seção avançada (arquivo / pasta).',
        })
      );
      return;
    }
    for (const ext of list) {
      const isAll = ext.applyTo === 'all' || ext.applyTo == null;
      const selectedIds = new Set(
        isAll
          ? []
          : Array.isArray(ext.applyTo)
            ? ext.applyTo
            : []
      );

      const icon = ext.iconDataUrl
        ? h('img', { className: 'ext-icon', alt: '', src: ext.iconDataUrl })
        : h('div', { className: 'ext-icon placeholder', text: 'ext' });

      const body = h('div', { className: 'ext-card-body' },
        h('div', { className: 'ext-name', text: ext.name || ext.id }),
        h('div', {
          className: 'ext-sub',
          text: `v${ext.version || '—'} · ${extSourceLabel(ext.source)}`,
        }),
        ext.description
          ? h('div', {
            className: 'ext-desc',
            text: String(ext.description).slice(0, 160),
          })
          : null,
        ext.warnings && ext.warnings.length
          ? h('div', {
            className: 'ext-warn',
            text: ext.warnings.slice(0, 3).join(' · '),
          })
          : null
      );

      const swLabel = h('label', { className: 'panel-ext-switch', title: 'Ativar / desativar' });
      const sw = h('input', { type: 'checkbox' });
      sw.checked = !!ext.enabled;
      sw.addEventListener('change', async () => {
        await window.multiheiz.extensionsSetEnabled(ext.id, sw.checked);
        await refreshExtensionsUi();
        showSaved();
      });
      swLabel.append(sw, document.createTextNode(' Ativa'));

      const applyBox = h('div', { className: 'ext-apply-box' });
      applyBox.appendChild(h('span', { text: 'Aplicar em:' }));
      const radioAllId = `ext-apply-all-${ext.id}`;
      const radioChooseId = `ext-apply-choose-${ext.id}`;
      const radAllLabel = h('label', { className: 'check' });
      const radAll = h('input', {
        type: 'radio',
        name: `ext-apply-${ext.id}`,
        id: radioAllId,
        value: 'all',
      });
      radAll.checked = isAll;
      radAllLabel.append(radAll, document.createTextNode(' Todas as janelas'));
      const radChooseLabel = h('label', { className: 'check' });
      const radChoose = h('input', {
        type: 'radio',
        name: `ext-apply-${ext.id}`,
        id: radioChooseId,
        value: 'choose',
      });
      radChoose.checked = !isAll;
      radChooseLabel.append(radChoose, document.createTextNode(' Escolher janelas'));
      applyBox.append(radAllLabel, radChooseLabel);

      const checks = h('div', {
        className: 'ext-panel-checks',
        style: isAll ? 'display:none' : '',
      });
      for (const acc of accounts) {
        const lab = h('label', { className: 'check' });
        const cb = h('input', { type: 'checkbox', value: acc.id });
        cb.checked = selectedIds.has(acc.id);
        cb.addEventListener('change', async () => {
          const ids = [];
          checks.querySelectorAll('input[type="checkbox"]').forEach((c) => {
            if (c.checked) ids.push(c.value);
          });
          await window.multiheiz.extensionsSetApplyTo(ext.id, ids);
          await refreshExtensionsUi();
          showSaved();
        });
        lab.append(cb, document.createTextNode(' ' + (acc.name || acc.id)));
        checks.appendChild(lab);
      }
      if (!accounts.length) {
        checks.appendChild(
          h('span', { className: 'muted-note', text: 'Nenhuma janela criada.' })
        );
      }
      applyBox.appendChild(checks);

      radAll.addEventListener('change', async () => {
        if (!radAll.checked) return;
        checks.style.display = 'none';
        await window.multiheiz.extensionsSetApplyTo(ext.id, 'all');
        await refreshExtensionsUi();
        showSaved();
      });
      radChoose.addEventListener('change', async () => {
        if (!radChoose.checked) return;
        checks.style.display = '';
        const ids = accounts.map((a) => a.id);
        const current = Array.isArray(ext.applyTo) && ext.applyTo.length
          ? ext.applyTo
          : ids;
        await window.multiheiz.extensionsSetApplyTo(ext.id, current);
        await refreshExtensionsUi();
        showSaved();
      });

      const btnOpt = h('button', {
        type: 'button',
        className: 'btn ghost',
        text: 'Opções',
        disabled: !ext.optionsPage,
        onClick: async () => {
          if (!ext.optionsPage) return;
          const focus =
            (hooks().getFocusedNav && hooks().getFocusedNav() && hooks().getFocusedNav().accountId) ||
            (accounts[0] && accounts[0].id);
          const r = await window.multiheiz.extensionsOpenOptions(ext.id, focus);
          if (r && !r.ok) setExtStatus(r.error || 'Falha ao abrir opções', true);
        },
      });
      if (!ext.optionsPage) btnOpt.disabled = true;

      const btnRm = h('button', {
        type: 'button',
        className: 'btn ghost',
        text: 'Remover',
        onClick: async () => {
          const nome = ext.name || ext.id;
          if (!window.confirm(`Remover ${nome}? Esta ação não pode ser desfeita.`)) return;
          await window.multiheiz.extensionsRemove(ext.id);
          await refreshExtensionsUi();
          showSaved();
        },
      });

      const actions = h('div', { className: 'ext-card-actions' },
        swLabel,
        applyBox,
        btnOpt,
        btnRm
      );

      const card = h('div', { className: 'ext-card', 'data-ext-id': ext.id },
        icon,
        body,
        actions
      );
      host.appendChild(card);
    }
  }

  async function refreshDiagnostics() {
    const info = await window.multiheiz.diagnosticsProcessInfo();
    const logs = await window.multiheiz.diagnosticsLogs();
    const abDiag = await window.multiheiz.adblockDiagnostics();
    const focusedNav = hooks().getFocusedNav && hooks().getFocusedNav();
    const focusId =
      (focusedNav && focusedNav.accountId) ||
      (getState().accounts && getState().accounts[0] && getState().accounts[0].id) ||
      null;
    const focusUrl = (focusedNav && focusedNav.url) || '';
    const focusDiag = await window.multiheiz.adblockFocusedDiagnostics(focusId, focusUrl);
    const box = document.getElementById('diag-process');
    const logBox = document.getElementById('diag-logs');
    const abBox = document.getElementById('diag-adblock');
    const focusBox = document.getElementById('diag-adblock-focus');
    if (box) {
      box.textContent = JSON.stringify(
        {
          pid: info.pid,
          memoryUsage: info.memoryUsage,
          totalMb: info.metrics && info.metrics.totalMb,
        },
        null,
        2
      );
    }
    if (focusBox) {
      focusBox.textContent = JSON.stringify(
        {
          accountId: focusDiag.accountId,
          hostname: focusDiag.hostname,
          scriptletsInjetados: focusDiag.scriptletsInjected ? 'sim' : 'não',
          scriptletCount: focusDiag.scriptletCount,
          earlyCss: focusDiag.earlyCss ? 'sim' : 'não',
          earlySyncMs: focusDiag.earlySyncMs,
          earlyInjectMs: focusDiag.earlyInjectMs,
          earlyVia: focusDiag.earlyVia,
          regrasAplicadas: focusDiag.rulesApplied,
          bloqueadosNaPagina: focusDiag.pageBlocked,
          engineSource: focusDiag.engineSource,
          resourcesLoaded: focusDiag.resourcesLoaded,
          preloadUnpacked: focusDiag.preloadUnpacked,
        },
        null,
        2
      );
    }
    if (abBox) {
      abBox.textContent = JSON.stringify(
        {
          engineSource: abDiag.engineSource,
          ready: abDiag.ready,
          enabled: abDiag.enabled,
          youtubeAds: abDiag.youtubeExperimental
            ? 'ligado — Experimental'
            : 'desligado',
          networkFilterCount: abDiag.networkFilterCount,
          cosmeticFilterCount: abDiag.cosmeticFilterCount,
          resourcesLoaded: abDiag.resourcesLoaded,
          lastUpdateAt: abDiag.lastUpdateAt,
          lastBuildMs: abDiag.lastBuildMs,
          lastBuildRssMb: abDiag.lastBuildRssMb,
          attachedSessions: abDiag.attachedSessions,
          preloadPath: abDiag.preloadPath,
          preloadExists: abDiag.preloadExists,
          preloadUnpacked: abDiag.preloadUnpacked,
          statusMessage: abDiag.statusMessage,
          listStatus: abDiag.listStatus,
        },
        null,
        2
      );
    }
    if (logBox) logBox.textContent = (logs || []).join('\n');
  }

  function applyKofiVisibility(kofiUrl) {
    const show = !!kofiUrl;
    const section = document.getElementById('kofi-support-section');
    if (section) section.classList.toggle('hidden', !show);
    for (const id of ['btn-kofi', 'btn-kofi-status']) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', !show);
    }
  }

  async function refreshKofiVisibility() {
    const about = await window.multiheiz.getAbout();
    applyKofiVisibility(about && about.kofiUrl);
    return !!(about && about.kofiUrl);
  }

  async function refreshAbout() {
    const about = await window.multiheiz.getAbout();
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v || '';
    };
    set('about-version', about.version);
    set('about-electron', about.electron);
    set('about-chrome', about.chrome);
    applyKofiVisibility(about && about.kofiUrl);
  }

  function showMissedReminders(missed) {
    if (!missed || !missed.length) return;
    const count = missed.length;
    const title =
      count === 1
        ? missed[0].title || 'Lembrete perdido'
        : `${count} lembretes perdidos`;
    toast(title);
    const dlg = document.getElementById('dlg-missed');
    const titleEl = document.getElementById('missed-title');
    const listEl = document.getElementById('missed-list');
    if (!dlg || !listEl) return;
    if (titleEl) titleEl.textContent = title;
    listEl.innerHTML = '';
    for (const m of missed) {
      const li = document.createElement('li');
      li.textContent = m.title || 'Lembrete';
      if (m.missedAt || m.at) {
        const when = new Date(m.missedAt || m.at).toLocaleString('pt-BR');
        li.textContent += ` — ${when}`;
      }
      listEl.appendChild(li);
    }
    pushOverlay('dlg-missed');
    dlg.showModal();
  }

  function showSnooze(reminder) {
    pendingSnoozeId = reminder && reminder.id;
    const dlg = document.getElementById('dlg-snooze');
    const msg = document.getElementById('snooze-message');
    if (msg) msg.textContent = (reminder && reminder.title) || 'Lembrete';
    pushOverlay('dlg-snooze');
    dlg.showModal();
  }

  /* ---------- Init ---------- */

  function init() {
    wireSettings();

    document.addEventListener('mouseup', () => {
      if (!planilhaSel.dragging) return;
      planilhaSel.dragging = false;
      if (
        planilhaSel.formulaMode &&
        planilhaSel.editingRef &&
        planilhaSel.sel &&
        planilhaInsertRef &&
        (planilhaSel.sel.c0 !== planilhaSel.sel.c1 || planilhaSel.sel.r0 !== planilhaSel.sel.r1)
      ) {
        planilhaInsertRef(
          formatRangeRefUi(
            planilhaSel.sel.c0,
            planilhaSel.sel.r0,
            planilhaSel.sel.c1,
            planilhaSel.sel.r1
          )
        );
      }
    });

    document.getElementById('btn-favorites')?.addEventListener('click', () => openManager('favorites'));
    document.getElementById('btn-history')?.addEventListener('click', () => openManager('history'));
    document.getElementById('btn-downloads')?.addEventListener('click', () => openManager('downloads'));

    document.getElementById('form-history-clear')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const select = document.getElementById('history-clear-range');
      const value = select && select.value ? select.value : '';
      finishHistoryClearDialog(value || null);
    });
    document.getElementById('history-clear-cancel')?.addEventListener('click', () => {
      finishHistoryClearDialog(null);
    });
    document.getElementById('dlg-history-clear')?.addEventListener('cancel', (e) => {
      e.preventDefault();
      finishHistoryClearDialog(null);
    });
    document.getElementById('dlg-history-clear')?.addEventListener('close', () => {
      popOverlay('dlg-history-clear');
      if (historyClearResolver) {
        const resolve = historyClearResolver;
        historyClearResolver = null;
        resolve(null);
      }
    });

    document.getElementById('btn-fav-cancel')?.addEventListener('click', () => {
      document.getElementById('dlg-favorite')?.close();
    });
    document.getElementById('dlg-favorite')?.addEventListener('close', () => popOverlay('dlg-favorite'));

    document.getElementById('form-favorite')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const payload = {
        name: form.name.value,
        url: form.url.value,
        folderId: form.folderId.value,
        defaultWindowId: form.defaultWindowId.value || null,
        title: form.name.value,
      };
      if (pendingFavEdit && pendingFavEdit.id) {
        await window.multiheiz.bookmarksUpdate({ id: pendingFavEdit.id, ...payload });
      } else {
        await window.multiheiz.bookmarksAdd(payload);
      }
      pendingFavEdit = null;
      form.closest('dialog').close();
      if (activeManager === 'favorites') renderManager();
      if (hooks().renderGrid) hooks().renderGrid();
    });

    document.getElementById('form-open-target')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await doOpen('current');
    });
    document.getElementById('btn-open-new')?.addEventListener('click', () => doOpen('new'));
    document.getElementById('btn-open-specific')?.addEventListener('click', () => {
      const id = document.getElementById('open-target-window').value;
      doOpen('specific', id);
    });
    document.getElementById('btn-open-cancel')?.addEventListener('click', () => {
      document.getElementById('dlg-open-target')?.close();
    });
    document.getElementById('dlg-open-target')?.addEventListener('close', () => popOverlay('dlg-open-target'));

    document.getElementById('form-snooze')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-min]');
      if (btn && pendingSnoozeId) {
        await window.multiheiz.alarmesSnooze(pendingSnoozeId, Number(btn.getAttribute('data-min')));
        document.getElementById('dlg-snooze')?.close();
      }
    });
    document.getElementById('btn-snooze-close')?.addEventListener('click', () => {
      document.getElementById('dlg-snooze')?.close();
    });
    document.getElementById('dlg-snooze')?.addEventListener('close', () => popOverlay('dlg-snooze'));

    document.getElementById('btn-missed-close')?.addEventListener('click', () => {
      document.getElementById('dlg-missed')?.close();
    });
    document.getElementById('dlg-missed')?.addEventListener('close', () => popOverlay('dlg-missed'));

    document.getElementById('form-pick-window')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sel = document.getElementById('pick-window-select');
      const id = sel && sel.value;
      if (pendingPickReminderId && id) {
        await window.multiheiz.alarmesUpdateReminder({
          id: pendingPickReminderId,
          windowId: id,
        });
        const rem = { id: pendingPickReminderId, windowId: id };
        document.getElementById('dlg-pick-window')?.close();
        pendingPickReminderId = null;
        await goToReminderWindow(rem);
        if (activeModule === 'alarmes') renderModule();
      }
    });
    document.getElementById('btn-pick-window-cancel')?.addEventListener('click', () => {
      document.getElementById('dlg-pick-window')?.close();
    });
    document.getElementById('dlg-pick-window')?.addEventListener('close', () => {
      popOverlay('dlg-pick-window');
      pendingPickReminderId = null;
    });

    window.multiheiz.onEvent((payload) => {
      if (!payload || !payload.type) return;
      if (payload.type === 'downloads:changed') {
        downloadsActive = payload.activeCount || 0;
        updateDownloadsBadge();
        if (activeManager === 'downloads') renderManager();
      }
      if (payload.type === 'alarmes:missed') showMissedReminders(payload.missed);
      if (payload.type === 'alarmes:notification-click') {
        showSnooze({ id: payload.reminderId, title: 'Lembrete' });
        if (payload.windowId && hooks().focusAccount) hooks().focusAccount(payload.windowId);
      }
      if (payload.type === 'alarmes:fired') {
        showSnooze(payload.reminder);
      }
      if (payload.type === 'ui:favorite') favoriteCurrentUrl();
      if (payload.type === 'ui:history') openManager('history');
      if (payload.type === 'ui:downloads') openManager('downloads');
      if (payload.type === 'bookmarks:changed' && activeManager === 'favorites') renderManager();
      if (payload.type === 'history:changed' && activeManager === 'history') renderManager();
      if (payload.type === 'alarmes:changed' && activeModule === 'alarmes') renderModule();
      if (payload.type === 'updates:status') {
        applyUpdatesStatus(payload);
        if (payload.status === 'ready' && hooks().toast) {
          hooks().toast(payload.message || 'Atualização pronta — reinicie para atualizar');
        }
      }
    });

    renderSidebarModules();
    refreshKofiVisibility();
    window.multiheiz.downloadsList().then((d) => {
      downloadsActive = d.activeCount || 0;
      updateDownloadsBadge();
    });
  }

  api.init = init;
  api.openManager = openManager;
  api.closeManager = closeManager;
  api.openModule = openModule;
  api.closeModule = closeModule;
  api.favoriteCurrentUrl = favoriteCurrentUrl;
  api.openFavoriteDialog = openFavoriteDialog;
  api.fillSettingsForm = fillSettingsForm;
  api.renderSidebarModules = renderSidebarModules;
  api.autosaveSettings = autosaveSettings;
  api.refreshKofiVisibility = refreshKofiVisibility;
  api.openNovidades = openNovidades;
  api.closeNovidadesAndMaybeMark = closeNovidadesAndMaybeMark;
  api.openSettingsSection = openSettingsSection;
  api.refreshExtensionsUi = refreshExtensionsUi;
  api._refreshExtensionsUi = refreshExtensionsUi;
  api.applyUpdatesStatus = applyUpdatesStatus;
  api.getActiveModule = () => activeModule;
  api.getActiveManager = () => activeManager;
  api.isStarredUrl = async (url) => !!(await window.multiheiz.bookmarksFindUrl(url));
  api.goToReminderWindow = goToReminderWindow;
  api.showMissedReminders = showMissedReminders;
})();
