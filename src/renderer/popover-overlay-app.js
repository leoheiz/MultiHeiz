(function () {
  const root = document.getElementById('root');
  let current = null;
  /** @type {ResizeObserver | null} */
  let resizeObserver = null;

  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    const r = document.documentElement;
    for (const [k, v] of Object.entries(theme)) {
      if (v == null || v === '') continue;
      const name = k.startsWith('--') ? k : '--' + k;
      r.style.setProperty(name, String(v));
    }
  }

  /**
   * Measure intrinsic content size. Prefer scrollWidth/Height so a short
   * WebContentsView viewport + max-height:70vh cannot collapse the reported
   * size (memory monitor "title+X only" feedback loop).
   */
  function reportMeasure() {
    const el = root.firstElementChild || root;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.max(
      Math.ceil(el.scrollWidth || 0),
      Math.ceil(r.width || 0),
      Math.ceil(root.scrollWidth || 0),
      40
    );
    let h = Math.max(
      Math.ceil(el.scrollHeight || 0),
      Math.ceil(r.height || 0),
      Math.ceil(root.scrollHeight || 0),
      24
    );
    // Memory monitor: report viewport height (capped), not full content
    // scrollHeight — otherwise the WebContentsView clips the inner scrollbar.
    if (current && current.kind === 'mem') {
      const rows = (current.data && current.data.rows && current.data.rows.length) || 0;
      const listH = Math.min(rows, 5) * 52;
      const minH = Math.max(200, 160 + listH);
      const maxCss = getComputedStyle(document.documentElement).getPropertyValue(
        '--mh-popover-max-h'
      );
      const maxH = Math.max(200, parseInt(maxCss, 10) || 520);
      // Prefer the shell's client height once laid out; else a sensible floor.
      const shell = root.querySelector('.mem-popover-box');
      const shellH = shell ? Math.ceil(shell.getBoundingClientRect().height || 0) : 0;
      h = Math.min(maxH, Math.max(minH, shellH || minH));
    }
    // Favorites: never open as chrome-only (title/search/actions, empty tree).
    if (current && current.kind === 'favorites') {
      const folders =
        (current.data && current.data.folders && current.data.folders.length) || 0;
      const items =
        (current.data && current.data.items && current.data.items.length) || 0;
      const minH = Math.max(160, 96 + folders * 28 + items * 36);
      h = Math.max(h, Math.min(minH, 420));
    }
    if (current && current.kind === 'history') {
      const entries =
        (current.data && current.data.entries && current.data.entries.length) || 0;
      const minH = Math.max(180, 120 + Math.min(entries, 8) * 36);
      h = Math.max(h, Math.min(minH, 420));
    }
    if (window.mhPopover && window.mhPopover.measure) {
      window.mhPopover.measure({ width: w, height: h });
    }
  }

  function scheduleMeasure() {
    requestAnimationFrame(() => {
      reportMeasure();
      requestAnimationFrame(() => {
        reportMeasure();
        // After first paint + metrics, measure once more (list may settle late).
        setTimeout(reportMeasure, 50);
      });
    });
  }

  function ensureResizeObserver() {
    if (resizeObserver || typeof ResizeObserver !== 'function') return;
    resizeObserver = new ResizeObserver(() => {
      scheduleMeasure();
    });
    try {
      resizeObserver.observe(root);
    } catch {
      /* ignore */
    }
  }

  function svgSpeaker(muted) {
    if (muted) {
      return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16.5 12a4.5 4.5 0 0 0-2.5-4V5l-5 5H5v4h4l5 5v-3a4.5 4.5 0 0 0 2.5-4zM19.07 4.93l-1.41 1.41A7.97 7.97 0 0 1 20 12a7.97 7.97 0 0 1-2.34 5.66l1.41 1.41A9.97 9.97 0 0 0 22 12a9.97 9.97 0 0 0-2.93-7.07zM3.27 2L2 3.27 6.73 8H5v8h4l5 5v-6.73l4.25 4.25.48-.48L3.27 2z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06A7.97 7.97 0 0 1 20 12a7.97 7.97 0 0 1-6 6.71v2.06A9.97 9.97 0 0 0 22 12a9.97 9.97 0 0 0-8-8.77z"/></svg>';
  }

  function clampVol(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 100;
    return Math.max(0, Math.min(200, Math.round(n)));
  }

  function renderVolume(data) {
    const pct = clampVol(data && data.percent);
    const muted = !!(data && data.muted);
    const accountId = (data && data.accountId) || '';
    const pop = document.createElement('div');
    pop.className = 'volume-popover';
    pop.dataset.role = 'volume-popover';
    pop.dataset.accountId = accountId;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Volume da janela');

    const head = document.createElement('div');
    head.className = 'volume-popover-head';
    const title = document.createElement('span');
    title.className = 'volume-popover-title';
    title.textContent = 'Volume';
    const valueEl = document.createElement('span');
    valueEl.className = 'volume-popover-value' + (!muted && pct > 100 ? ' is-boost' : '');
    valueEl.dataset.role = 'volume-value';
    valueEl.textContent = muted ? 'Mudo' : pct + '%';
    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'volume-popover-mute';
    muteBtn.dataset.role = 'volume-mute';
    muteBtn.title = muted ? 'Ativar som' : 'Mudo';
    muteBtn.innerHTML = svgSpeaker(muted);
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.mhPopover.action({ type: 'volume-mute', accountId, muted: !muted });
    });
    head.append(title, valueEl, muteBtn);

    const track = document.createElement('div');
    track.className = 'volume-popover-track';
    const trackBg = document.createElement('div');
    trackBg.className = 'volume-popover-track-bg';
    const mark = document.createElement('div');
    mark.className = 'volume-popover-track-mark';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '200';
    slider.step = '1';
    slider.value = String(pct);
    slider.className = 'volume-popover-slider' + (pct > 100 ? ' is-boost' : '');
    slider.dataset.role = 'volume-slider';
    slider.setAttribute('aria-label', 'Volume 0 a 200 por cento');
    slider.addEventListener('input', () => {
      const v = clampVol(slider.value);
      valueEl.textContent = v + '%';
      valueEl.classList.toggle('is-boost', v > 100);
      slider.classList.toggle('is-boost', v > 100);
      window.mhPopover.action({ type: 'volume-input', accountId, percent: v });
    });
    slider.addEventListener('change', () => {
      window.mhPopover.action({ type: 'volume-set', accountId, percent: clampVol(slider.value) });
    });
    slider.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      slider.value = '100';
      window.mhPopover.action({ type: 'volume-set', accountId, percent: 100 });
    });
    track.append(trackBg, mark, slider);

    const labels = document.createElement('div');
    labels.className = 'volume-popover-labels';
    labels.innerHTML = '<span>0%</span><span>100%</span><span class="boost-label">Reforço 200%</span>';

    const boostNote = document.createElement('div');
    boostNote.className = 'volume-popover-boost-note';
    boostNote.dataset.role = 'volume-boost-note';
    boostNote.textContent = 'Este site não permite passar de 100%.';
    if (data && data.boostUnavailable) boostNote.classList.add('is-visible');

    pop.append(head, track, labels, boostNote);
    pop.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 5 : 1;
      const cur = clampVol(slider.value);
      const next = clampVol(cur + (e.deltaY < 0 ? step : -step));
      slider.value = String(next);
      window.mhPopover.action({ type: 'volume-set', accountId, percent: next });
    }, { passive: false });

    return pop;
  }

  function updateVolume(data) {
    const pop = root.querySelector('.volume-popover');
    if (!pop) return;
    const pct = clampVol(data && data.percent != null ? data.percent : 100);
    const muted = !!(data && data.muted);
    const valueEl = pop.querySelector('[data-role="volume-value"]');
    const slider = pop.querySelector('[data-role="volume-slider"]');
    const muteBtn = pop.querySelector('[data-role="volume-mute"]');
    const boostNote = pop.querySelector('[data-role="volume-boost-note"]');
    if (valueEl) {
      valueEl.textContent = muted ? 'Mudo' : pct + '%';
      valueEl.classList.toggle('is-boost', !muted && pct > 100);
    }
    if (slider) {
      slider.value = String(pct);
      slider.classList.toggle('is-boost', pct > 100);
    }
    if (muteBtn) {
      muteBtn.innerHTML = svgSpeaker(muted);
      muteBtn.title = muted ? 'Ativar som' : 'Mudo';
    }
    if (boostNote) {
      boostNote.classList.toggle('is-visible', !!(data && data.boostUnavailable));
    }
  }

  function renderSitePerm(data) {
    const pop = document.createElement('div');
    pop.className = 'panel-site-perm-popover';
    pop.dataset.role = 'site-perm-popover';
    const title = document.createElement('div');
    title.className = 'panel-site-perm-origin';
    title.textContent = (data && data.origin) || '';
    const sec = data && data.security;
    if (sec) {
      const secBlock = document.createElement('div');
      secBlock.className = 'panel-site-perm-security';
      secBlock.dataset.role = 'site-security';
      const secLabel = document.createElement('div');
      secLabel.className = 'panel-site-perm-security-label';
      secLabel.textContent = sec.label || (sec.secure ? 'Conexão segura' : 'Conexão não segura');
      secBlock.appendChild(secLabel);
      if (sec.certificate) {
        const c = sec.certificate;
        const meta = document.createElement('div');
        meta.className = 'panel-site-perm-security-meta';
        meta.innerHTML = '';
        const lines = [
          'Assunto: ' + (c.subject || '—'),
          'Emissor: ' + (c.issuer || '—'),
          'Impressão digital: ' + (c.fingerprint || '—'),
        ];
        if (c.validExpiry != null) {
          try {
            lines.push(
              'Validade: ' + new Date(Number(c.validExpiry) * 1000).toLocaleDateString('pt-BR')
            );
          } catch {
            /* ignore */
          }
        }
        for (const line of lines) {
          const p = document.createElement('div');
          p.textContent = line;
          meta.appendChild(p);
        }
        secBlock.appendChild(meta);
      } else if (sec.http) {
        const meta = document.createElement('div');
        meta.className = 'panel-site-perm-security-meta';
        meta.textContent = 'Esta página usa HTTP (sem criptografia).';
        secBlock.appendChild(meta);
      }
      pop.appendChild(secBlock);
    }
    const list = document.createElement('div');
    const labels = (data && data.labels) || {};
    const states = (data && data.states) || {};
    const keys = (data && data.keys) || Object.keys(labels);
    for (const key of keys) {
      const row = document.createElement('div');
      row.className = 'panel-site-perm-row';
      const lab = document.createElement('span');
      lab.className = 'panel-site-perm-name';
      lab.textContent = labels[key] || key;
      const sel = document.createElement('select');
      sel.className = 'panel-site-perm-select';
      for (const [val, text] of [['ask', 'Perguntar'], ['allow', 'Permitir'], ['deny', 'Bloquear']]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = text;
        if ((states[key] || 'ask') === val) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        window.mhPopover.action({
          type: 'perm-set',
          accountId: data.accountId,
          origin: data.origin,
          permission: key,
          value: sel.value,
        });
      });
      row.append(lab, sel);
      list.appendChild(row);
    }
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'panel-site-perm-reset';
    resetBtn.textContent = 'Redefinir permissões';
    resetBtn.addEventListener('click', () => {
      window.mhPopover.action({
        type: 'perm-reset',
        accountId: data.accountId,
        origin: data.origin,
      });
      window.mhPopover.close('action');
    });
    pop.append(title, list, resetBtn);
    return pop;
  }

  function renderMenu(data) {
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    const items = (data && data.items) || [];
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.textContent = item.label || '';
      btn.disabled = !!item.disabled;
      btn.addEventListener('click', () => {
        window.mhPopover.action({ type: 'menu-click', itemId: item.id, data: item.data || null });
        window.mhPopover.close('action');
      });
      menu.appendChild(btn);
    }
    return menu;
  }

  function renderLayout(data) {
    const menu = document.createElement('div');
    menu.className = 'layout-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Layout');
    menu.tabIndex = 0;
    const options = (data && data.options) || [];
    const value = (data && data.value) || '';
    /** @type {HTMLButtonElement[]} */
    const buttons = [];
    let activeIdx = Math.max(0, options.findIndex((o) => o.value === value));
    function focusIdx(i) {
      if (!buttons.length) return;
      activeIdx = Math.max(0, Math.min(buttons.length - 1, i));
      buttons.forEach((b, n) => b.classList.toggle('is-active', n === activeIdx));
      buttons[activeIdx].focus();
    }
    function choose(opt) {
      window.mhPopover.action({ type: 'layout-select', value: opt.value });
      window.mhPopover.close('action');
    }
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'option');
      btn.textContent = opt.label || opt.value;
      if (opt.value === value) btn.classList.add('is-active');
      btn.addEventListener('click', () => choose(opt));
      buttons.push(btn);
      menu.appendChild(btn);
    }
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusIdx(activeIdx + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusIdx(activeIdx - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        focusIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        focusIdx(buttons.length - 1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (options[activeIdx]) choose(options[activeIdx]);
      }
    });
    requestAnimationFrame(() => focusIdx(activeIdx >= 0 ? activeIdx : 0));
    return menu;
  }

  function renderExtMenu(data) {
    const menu = document.createElement('div');
    menu.className = 'panel-ext-menu';
    const badge = document.createElement('div');
    badge.className = 'panel-ext-badge';
    badge.textContent = 'Experimental (em testes)';
    menu.appendChild(badge);
    const list = (data && data.list) || [];
    const accountId = (data && data.accountId) || '';
    const anchorX = (data && data.anchorX) || 0;
    const anchorY = (data && data.anchorY) || 0;
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nenhuma extensão instalada';
      menu.appendChild(empty);
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'panel-ext-manage';
      addBtn.dataset.role = 'ext-add';
      addBtn.textContent = 'Adicionar extensão';
      addBtn.addEventListener('click', () => {
        window.mhPopover.action({ type: 'ext-manage' });
        window.mhPopover.close('action');
      });
      menu.appendChild(addBtn);
    } else {
      for (const ext of list) {
        const row = document.createElement('div');
        row.className = 'panel-ext-row' + (ext.activeOnPanel ? '' : ' inactive');
        if (ext.iconDataUrl) {
          const img = document.createElement('img');
          img.src = ext.iconDataUrl;
          img.alt = '';
          row.appendChild(img);
        }
        const nameBtn = document.createElement('button');
        nameBtn.type = 'button';
        nameBtn.className = 'panel-ext-name';
        nameBtn.textContent = ext.name || ext.id;
        nameBtn.disabled = !ext.activeOnPanel || !ext.hasAction;
        nameBtn.title = ext.hasAction
          ? 'Abrir popup da extensão'
          : 'Esta extensão não tem popup';
        nameBtn.addEventListener('click', () => {
          window.mhPopover.action({
            type: 'ext-open-action',
            extId: ext.id,
            accountId,
          });
          window.mhPopover.close('action');
        });
        row.appendChild(nameBtn);
        const swLabel = document.createElement('label');
        swLabel.className = 'panel-ext-switch';
        swLabel.title = 'Ativa nesta janela';
        const sw = document.createElement('input');
        sw.type = 'checkbox';
        sw.checked = !!ext.activeOnPanel;
        sw.addEventListener('change', () => {
          window.mhPopover.action({
            type: 'ext-set-active',
            extId: ext.id,
            accountId,
            active: sw.checked,
            anchorX,
            anchorY,
          });
        });
        swLabel.append(sw, document.createTextNode(' Nesta janela'));
        row.appendChild(swLabel);
        menu.appendChild(row);
      }
    }
    const footer = document.createElement('button');
    footer.type = 'button';
    footer.className = 'panel-ext-manage';
    footer.dataset.role = 'ext-manage';
    footer.textContent = 'Gerenciar extensões';
    footer.addEventListener('click', () => {
      window.mhPopover.action({ type: 'ext-manage' });
      window.mhPopover.close('action');
    });
    menu.appendChild(footer);
    return menu;
  }

  function faviconFor(url) {
    try {
      const u = new URL(url);
      return 'https://www.google.com/s2/favicons?sz=32&domain=' + encodeURIComponent(u.hostname);
    } catch {
      return '';
    }
  }

  function historyDayLabel(ts) {
    const d = new Date(ts || 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const that = new Date(d);
    that.setHours(0, 0, 0, 0);
    const diff = Math.round((today.getTime() - that.getTime()) / 86400000);
    const weekday = d.toLocaleDateString('pt-BR', { weekday: 'long' });
    const full = d.toLocaleDateString('pt-BR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    if (diff === 0) return 'Hoje — ' + weekday + ', ' + full;
    if (diff === 1) return 'Ontem — ' + weekday + ', ' + full;
    return weekday + ', ' + full;
  }

  function historyDomain(url) {
    try {
      return new URL(String(url || '')).hostname || '';
    } catch {
      return '';
    }
  }

  function historyTooltipUrl(url) {
    try {
      const u = new URL(String(url || ''));
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return String(url || '').split(/[?#]/)[0];
    }
  }

  function renderHistoryPopover(data) {
    const pop = document.createElement('div');
    pop.className = 'history-popover';
    pop.dataset.role = 'history-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Histórico');

    const head = document.createElement('div');
    head.className = 'history-popover-head';
    const title = document.createElement('strong');
    title.textContent = 'Histórico';
    const headActions = document.createElement('div');
    headActions.className = 'history-popover-head-actions';

    const mkIcon = (label, role, type, glyph) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'history-popover-icon';
      b.dataset.role = role;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.textContent = glyph;
      b.addEventListener('click', () => {
        window.mhPopover.action({ type });
        if (type === 'history-open-page' && !(data && data.pinned)) {
          window.mhPopover.close('action');
        }
      });
      return b;
    };
    const searchToggle = mkIcon('Buscar', 'history-search-toggle', 'history-focus-search', '⌕');
    const trashBtn = mkIcon('Limpar histórico', 'history-trash', 'history-clear', '🗑');
    const openPageBtn = mkIcon('Abrir página completa', 'history-open-page', 'history-open-page', '…');
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'history-popover-pin' + (data && data.pinned ? ' is-pinned' : '');
    pinBtn.dataset.role = 'history-pin';
    pinBtn.title = data && data.pinned ? 'Desafixar' : 'Fixar';
    pinBtn.textContent = data && data.pinned ? 'Fixado' : 'Fixar';
    pinBtn.addEventListener('click', () => {
      window.mhPopover.action({ type: 'history-pin', pinned: !(data && data.pinned) });
    });
    headActions.append(searchToggle, trashBtn, openPageBtn, pinBtn);
    head.append(title, headActions);
    pop.appendChild(head);

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'history-popover-search';
    search.dataset.role = 'history-search';
    search.placeholder = 'Pesquisar no histórico';
    search.value = (data && data.query) || '';
    pop.appendChild(search);

    const tabs = document.createElement('div');
    tabs.className = 'history-popover-tabs';
    const tabAll = document.createElement('button');
    tabAll.type = 'button';
    tabAll.className =
      'history-popover-tab' + (!(data && data.tab === 'closed') ? ' is-active' : '');
    tabAll.dataset.role = 'history-tab-all';
    tabAll.textContent = 'Tudo';
    tabAll.addEventListener('click', () => {
      window.mhPopover.action({ type: 'history-tab', tab: 'all' });
    });
    const tabClosed = document.createElement('button');
    tabClosed.type = 'button';
    tabClosed.className =
      'history-popover-tab' + (data && data.tab === 'closed' ? ' is-active' : '');
    tabClosed.dataset.role = 'history-tab-closed';
    tabClosed.textContent = 'Fechadas recentemente';
    tabClosed.addEventListener('click', () => {
      window.mhPopover.action({ type: 'history-tab', tab: 'closed' });
    });
    tabs.append(tabAll, tabClosed);
    pop.appendChild(tabs);

    const list = document.createElement('div');
    list.className = 'history-popover-list';
    list.dataset.role = 'history-list';

    const entries = (data && data.entries) || [];
    /** @type {Map<string, any[]>} */
    const byDay = new Map();
    for (const e of entries) {
      const label = historyDayLabel(e.time);
      if (!byDay.has(label)) byDay.set(label, []);
      byDay.get(label).push(e);
    }
    for (const [day, items] of byDay) {
      const dayEl = document.createElement('div');
      dayEl.className = 'history-day-header';
      dayEl.dataset.role = 'history-day';
      dayEl.textContent = day;
      list.appendChild(dayEl);
      for (const e of items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'history-item-row';
        row.dataset.role = 'history-item';
        row.dataset.historyId = e.id || '';
        row.title = historyTooltipUrl(e.url);
        const img = document.createElement('img');
        img.className = 'history-item-favicon';
        img.alt = '';
        img.src = e.favicon || faviconFor(e.url);
        const lab = document.createElement('span');
        lab.className = 'history-item-title';
        lab.textContent = e.title || historyDomain(e.url) || 'Página';
        const time = document.createElement('span');
        time.className = 'history-item-time';
        time.textContent = new Date(e.time || 0).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        });
        row.append(img, lab, time);
        row.addEventListener('click', () => {
          window.mhPopover.action({
            type: 'history-open',
            historyId: e.id,
            url: e.url,
            windowId: e.windowId,
          });
          if (!(data && data.pinned)) window.mhPopover.close('action');
        });
        list.appendChild(row);
      }
    }
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'history-popover-empty';
      empty.textContent =
        data && data.tab === 'closed'
          ? 'Nenhuma janela fechada recentemente.'
          : 'Nenhum item no histórico.';
      list.appendChild(empty);
    }
    pop.appendChild(list);

    search.addEventListener('input', () => {
      window.mhPopover.action({ type: 'history-search', query: search.value });
    });
    searchToggle.addEventListener('click', () => {
      search.focus();
      search.select();
    });

    return pop;
  }

  function renderFavoritesPopover(data) {
    const pop = document.createElement('div');
    pop.className = 'favorites-popover';
    pop.dataset.role = 'favorites-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Favoritos');

    const head = document.createElement('div');
    head.className = 'favorites-popover-head';
    const title = document.createElement('strong');
    title.textContent = 'Favoritos';
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'favorites-popover-pin' + (data && data.pinned ? ' is-pinned' : '');
    pinBtn.dataset.role = 'favorites-pin';
    pinBtn.title = data && data.pinned ? 'Desafixar' : 'Fixar';
    pinBtn.textContent = data && data.pinned ? 'Fixado' : 'Fixar';
    pinBtn.addEventListener('click', () => {
      window.mhPopover.action({ type: 'favorites-pin', pinned: !(data && data.pinned) });
    });
    head.append(title, pinBtn);
    pop.appendChild(head);

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'favorites-popover-search';
    search.dataset.role = 'favorites-search';
    search.placeholder = 'Pesquisar favoritos';
    search.value = (data && data.query) || '';
    pop.appendChild(search);

    const tree = document.createElement('div');
    tree.className = 'favorites-popover-tree';
    tree.dataset.role = 'favorites-tree';

    const q = String((data && data.query) || '')
      .trim()
      .toLowerCase();
    const folders = (data && data.folders) || [];
    const items = (data && data.items) || [];
    const expanded = new Set((data && data.expandedFolders) || []);

    function matches(it) {
      if (!q) return true;
      return (
        String(it.name || '')
          .toLowerCase()
          .includes(q) ||
        String(it.title || '')
          .toLowerCase()
          .includes(q) ||
        String(it.url || '')
          .toLowerCase()
          .includes(q)
      );
    }

    for (const folder of folders) {
      const folderItems = items.filter((it) => it.folderId === folder.id && matches(it));
      if (q && !folderItems.length && !String(folder.name || '').toLowerCase().includes(q)) {
        continue;
      }
      const isOpen = q ? true : expanded.has(folder.id);
      const row = document.createElement('div');
      row.className = 'favorites-folder-row';
      row.dataset.folderId = folder.id || '';
      const arrow = document.createElement('button');
      arrow.type = 'button';
      arrow.className = 'favorites-folder-arrow';
      arrow.textContent = isOpen ? '▾' : '▸';
      arrow.addEventListener('click', () => {
        window.mhPopover.action({ type: 'favorites-toggle-folder', folderId: folder.id });
      });
      const name = document.createElement('span');
      name.className = 'favorites-folder-name';
      name.textContent = folder.name || 'Pasta';
      row.append(arrow, name);
      tree.appendChild(row);
      if (isOpen) {
        for (const it of folderItems) {
          const itemBtn = document.createElement('button');
          itemBtn.type = 'button';
          itemBtn.className = 'favorites-item-row';
          itemBtn.dataset.bookmarkId = it.id || '';
          itemBtn.dataset.role = 'favorites-item';
          const img = document.createElement('img');
          img.className = 'favorites-item-favicon';
          img.alt = '';
          img.src = faviconFor(it.url);
          const lab = document.createElement('span');
          lab.textContent = it.name || it.title || it.url || 'Favorito';
          itemBtn.append(img, lab);
          itemBtn.addEventListener('click', () => {
            window.mhPopover.action({
              type: 'favorites-open',
              bookmarkId: it.id,
              url: it.url,
            });
            if (!(data && data.pinned)) window.mhPopover.close('action');
          });
          tree.appendChild(itemBtn);
        }
      }
    }
    pop.appendChild(tree);

    const actions = document.createElement('div');
    actions.className = 'favorites-popover-actions';
    const mkBtn = (label, type, role) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'favorites-popover-action';
      b.dataset.role = role;
      b.textContent = label;
      b.addEventListener('click', () => {
        window.mhPopover.action({ type });
        if (type !== 'favorites-add-folder' && type !== 'favorites-add' && !(data && data.pinned)) {
          /* keep open for add flows handled by chrome */
        }
        if (type === 'favorites-open-page') window.mhPopover.close('action');
      });
      return b;
    };
    actions.append(
      mkBtn('Adicionar favorito', 'favorites-add', 'favorites-add'),
      mkBtn('Adicionar pasta', 'favorites-add-folder', 'favorites-add-folder'),
      mkBtn('Abrir página de favoritos', 'favorites-open-page', 'favorites-open-page')
    );
    pop.appendChild(actions);

    search.addEventListener('input', () => {
      window.mhPopover.action({ type: 'favorites-search', query: search.value });
    });

    return pop;
  }

  function renderMem(data) {
    const box = document.createElement('div');
    box.className = 'mem-popover-box mh-popover-shell';
    box.dataset.role = 'mem-popover';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Monitor de memória');
    const head = document.createElement('div');
    head.className = 'mem-popover-head mh-popover-head';
    const t = document.createElement('strong');
    t.textContent = 'Monitor de memória';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mem-popover-close';
    closeBtn.dataset.role = 'mem-close';
    closeBtn.title = 'Fechar';
    closeBtn.setAttribute('aria-label', 'Fechar');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.mhPopover.close('mem-close');
    });
    head.append(t, closeBtn);
    box.appendChild(head);

    const body = document.createElement('div');
    body.className = 'mem-popover-body mh-popover-scroll';
    body.dataset.role = 'mem-body';

    const stats = (data && data.stats) || {};
    const statsRow = document.createElement('div');
    statsRow.className = 'mem-popover-stats';
    statsRow.dataset.role = 'mem-stats';
    const statBits = [
      ['CPU', stats.cpu || '—'],
      ['RAM', stats.ram || '—'],
      ['FPS', stats.fps || '—'],
      ['Uptime', stats.uptime || '—'],
    ];
    for (const [label, value] of statBits) {
      const cell = document.createElement('div');
      cell.className = 'mem-stat';
      const k = document.createElement('span');
      k.className = 'mem-stat-k';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'mem-stat-v';
      v.dataset.role = 'mem-stat-' + label.toLowerCase();
      v.textContent = value;
      cell.append(k, v);
      statsRow.appendChild(cell);
    }
    body.appendChild(statsRow);

    const total = document.createElement('div');
    total.className = 'mem-popover-total';
    total.dataset.role = 'mem-total';
    const totalText = (data && data.totalText) || (data && data.totalLabel) || 'Coletando métricas…';
    total.textContent = totalText;
    body.appendChild(total);

    const toolbar = document.createElement('div');
    toolbar.className = 'mem-popover-toolbar';
    const freeBtn = document.createElement('button');
    freeBtn.type = 'button';
    freeBtn.className = 'mem-action-btn';
    freeBtn.dataset.role = 'mem-free';
    freeBtn.textContent = 'Liberar memória';
    freeBtn.disabled = !!(data && data.freeMemBusy);
    freeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.mhPopover.action({ type: 'mem-free' });
    });
    const reactAll = document.createElement('button');
    reactAll.type = 'button';
    reactAll.className = 'mem-action-btn';
    reactAll.dataset.role = 'mem-reactivate-all';
    reactAll.textContent = 'Reativar todas';
    reactAll.addEventListener('click', (e) => {
      e.stopPropagation();
      window.mhPopover.action({ type: 'mem-reactivate-all' });
    });
    toolbar.append(freeBtn, reactAll);
    body.appendChild(toolbar);

    const list = document.createElement('div');
    list.className = 'mem-popover-list';
    list.dataset.role = 'mem-list';
    const rows = (data && data.rows) || [];
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'mem-row';
      el.dataset.accountId = row.accountId || '';
      el.dataset.active = row.active ? '1' : '0';
      if (row.title) el.title = row.title;
      const title = document.createElement('div');
      title.className = 'mem-row-title';
      title.textContent = row.name || row.label || '';
      const meta = document.createElement('div');
      meta.className = 'mem-row-meta';
      meta.textContent = row.meta || row.value || '';
      const actions = document.createElement('div');
      actions.className = 'mem-row-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.role = row.active ? 'mem-suspend' : 'mem-reactivate';
      btn.dataset.accountId = row.accountId || '';
      btn.textContent = row.active ? 'Suspender' : 'Reativar';
      btn.title = row.active ? 'Suspender esta janela' : 'Reativar esta janela';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.mhPopover.action({
          type: row.active ? 'mem-suspend' : 'mem-reactivate',
          accountId: row.accountId,
        });
      });
      actions.appendChild(btn);
      el.addEventListener('click', () => {
        if (!row.accountId) return;
        window.mhPopover.action({ type: 'mem-focus', accountId: row.accountId });
      });
      el.append(title, actions, meta);
      list.appendChild(el);
    }
    body.appendChild(list);

    const settings = (data && data.settings) || {};
    const opts = document.createElement('div');
    opts.className = 'mem-popover-opts';
    opts.dataset.role = 'mem-opts';

    function emitSettings(partial) {
      window.mhPopover.action({ type: 'mem-settings', settings: partial });
    }

    const suspendLabel = document.createElement('label');
    suspendLabel.className = 'mem-opt-check';
    const suspendCb = document.createElement('input');
    suspendCb.type = 'checkbox';
    suspendCb.dataset.role = 'mem-suspend-hidden';
    suspendCb.checked = !!settings.suspendHidden;
    suspendCb.addEventListener('change', () => {
      emitSettings({ suspendHidden: !!suspendCb.checked });
    });
    suspendLabel.append(suspendCb, document.createTextNode(' Suspender painéis ocultos'));
    opts.appendChild(suspendLabel);

    const delayRow = document.createElement('label');
    delayRow.className = 'mem-opt-row';
    delayRow.appendChild(document.createTextNode('Atraso ao suspender (ms) '));
    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = '0';
    delayInput.step = '100';
    delayInput.dataset.role = 'mem-suspend-delay';
    delayInput.value = String(Number(settings.suspendDelayMs) || 0);
    delayInput.addEventListener('change', () => {
      emitSettings({ suspendDelayMs: Number(delayInput.value) || 0 });
    });
    delayRow.appendChild(delayInput);
    opts.appendChild(delayRow);

    const exceptNote = document.createElement('p');
    exceptNote.className = 'mem-opt-note';
    exceptNote.dataset.role = 'mem-exceptions-note';
    exceptNote.textContent =
      'Exceções: janela em uso, áudio, vídeo ou chamada — não são suspensas.';
    opts.appendChild(exceptNote);

    const intervalSel = document.createElement('select');
    intervalSel.dataset.role = 'mem-cleanup-interval';
    for (const n of [5, 10, 15, 30, 60]) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = String(n);
      intervalSel.appendChild(opt);
    }
    let curInterval = Number(settings.memoryCleanupIntervalMin);
    if (![5, 10, 15, 30, 60].includes(curInterval)) curInterval = 30;
    intervalSel.value = String(curInterval);
    intervalSel.disabled = !settings.memoryCleanupEnabled;
    intervalSel.addEventListener('change', () => {
      emitSettings({ memoryCleanupIntervalMin: Number(intervalSel.value) || 30 });
    });

    const cleanLabel = document.createElement('label');
    cleanLabel.className = 'mem-opt-check';
    const cleanCb = document.createElement('input');
    cleanCb.type = 'checkbox';
    cleanCb.dataset.role = 'mem-cleanup-enabled';
    cleanCb.checked = !!settings.memoryCleanupEnabled;
    cleanCb.addEventListener('change', () => {
      emitSettings({ memoryCleanupEnabled: !!cleanCb.checked });
      intervalSel.disabled = !cleanCb.checked;
    });
    cleanLabel.append(cleanCb, document.createTextNode(' Limpar memória periodicamente'));
    opts.appendChild(cleanLabel);

    const intervalRow = document.createElement('label');
    intervalRow.className = 'mem-opt-row';
    intervalRow.dataset.role = 'mem-cleanup-interval-row';
    intervalRow.appendChild(document.createTextNode('A cada '));
    intervalRow.append(intervalSel, document.createTextNode(' minutos'));
    opts.appendChild(intervalRow);

    body.appendChild(opts);
    box.appendChild(body);
    return box;
  }

  function updateMem(data) {
    if (!current || current.kind !== 'mem') return;
    current.data = Object.assign({}, current.data || {}, data || {});
    const node = renderMem(current.data);
    root.replaceChildren(node);
    ensureResizeObserver();
    scheduleMeasure();
  }

  function clear() {
    current = null;
    root.replaceChildren();
  }

  function renderAiWrite(data) {
    const pop = document.createElement('div');
    pop.className = 'ai-write-popover';
    pop.dataset.role = 'ai-write-popover';
    const title = document.createElement('div');
    title.className = 'ai-write-title';
    title.textContent = 'IA para escrever';
    const actions = document.createElement('div');
    actions.className = 'ai-write-actions';
    const list = (data && data.actions) || [
      { id: 'corrigir', label: 'Corrigir' },
      { id: 'melhorar', label: 'Melhorar' },
      { id: 'reformular', label: 'Reformular' },
      { id: 'mais-formal', label: 'Mais formal' },
      { id: 'mais-curto', label: 'Mais curto' },
    ];
    const busy = (data && data.status) === 'loading';
    for (const a of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = a.label || a.id;
      btn.disabled = busy;
      btn.addEventListener('click', () => {
        window.mhPopover.action({ type: 'ai-action', action: a.id });
      });
      actions.appendChild(btn);
    }
    const status = document.createElement('div');
    status.className = 'ai-write-status' + ((data && data.status) === 'error' ? ' is-error' : '');
    if ((data && data.status) === 'loading') status.textContent = 'Gerando…';
    else if (data && data.error) status.textContent = data.error;
    else if ((data && data.status) === 'done') status.textContent = 'Pronto.';
    else status.textContent = 'Escolha uma ação.';
    const result = document.createElement('textarea');
    result.className = 'ai-write-result';
    result.readOnly = true;
    result.value = (data && data.resultText) || '';
    result.placeholder = 'O resultado aparece aqui.';
    const footer = document.createElement('div');
    footer.className = 'ai-write-footer';
    const btnReplace = document.createElement('button');
    btnReplace.type = 'button';
    btnReplace.textContent = 'Substituir';
    btnReplace.disabled = busy || !((data && data.resultText) || '').trim();
    btnReplace.addEventListener('click', () => {
      window.mhPopover.action({ type: 'ai-replace' });
    });
    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.textContent = 'Copiar';
    btnCopy.disabled = busy || !((data && data.resultText) || '').trim();
    btnCopy.addEventListener('click', () => {
      window.mhPopover.action({ type: 'ai-copy' });
    });
    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.textContent = 'Cancelar';
    btnCancel.addEventListener('click', () => {
      window.mhPopover.action({ type: 'ai-cancel' });
      window.mhPopover.close('ai-cancel');
    });
    footer.append(btnReplace, btnCopy, btnCancel);
    pop.append(title, actions, status, result, footer);
    return pop;
  }

  function updateAiWrite(data) {
    if (!current) return;
    current.data = Object.assign({}, current.data || {}, data || {});
    const node = renderAiWrite(current.data);
    root.replaceChildren(node);
    scheduleMeasure();
  }

  function render(payload) {
    clear();
    if (!payload || !payload.kind) return;
    applyTheme(payload.theme);
    current = payload;
    let node = null;
    if (payload.kind === 'volume') node = renderVolume(payload.data || {});
    else if (payload.kind === 'site-perm') node = renderSitePerm(payload.data || {});
    else if (payload.kind === 'menu') node = renderMenu(payload.data || {});
    else if (payload.kind === 'layout') node = renderLayout(payload.data || {});
    else if (payload.kind === 'ext-menu') node = renderExtMenu(payload.data || {});
    else if (payload.kind === 'favorites') node = renderFavoritesPopover(payload.data || {});
    else if (payload.kind === 'history') node = renderHistoryPopover(payload.data || {});
    else if (payload.kind === 'mem') node = renderMem(payload.data || {});
    else if (payload.kind === 'ai-write') node = renderAiWrite(payload.data || {});
    if (node) root.appendChild(node);
    ensureResizeObserver();
    scheduleMeasure();
  }

  document.addEventListener('mouseenter', () => {
    if (window.mhPopover) window.mhPopover.pointer('enter');
  }, true);
  document.addEventListener('mouseleave', () => {
    if (window.mhPopover) window.mhPopover.pointer('leave');
  }, true);

  document.body.addEventListener('mouseenter', () => {
    if (window.mhPopover) window.mhPopover.pointer('enter');
  });
  document.body.addEventListener('mouseleave', () => {
    if (window.mhPopover) window.mhPopover.pointer('leave');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      window.mhPopover.close('escape');
    }
  });

  if (window.mhPopover) {
    window.mhPopover.onRender(render);
    window.mhPopover.onUpdate((data) => {
      if (!current) return;
      if (current.kind === 'volume') updateVolume(data || {});
      else if (current.kind === 'ai-write') updateAiWrite(data || {});
      else if (current.kind === 'mem') updateMem(data || {});
      else if (current.kind === 'ext-menu' && data) {
        current.data = Object.assign({}, current.data || {}, data);
        const node = renderExtMenu(current.data);
        root.replaceChildren(node);
        scheduleMeasure();
      } else if (current.kind === 'favorites' && data) {
        current.data = Object.assign({}, current.data || {}, data);
        const node = renderFavoritesPopover(current.data);
        root.replaceChildren(node);
        scheduleMeasure();
      } else if (current.kind === 'history' && data) {
        current.data = Object.assign({}, current.data || {}, data);
        const node = renderHistoryPopover(current.data);
        root.replaceChildren(node);
        scheduleMeasure();
      } else if (data) current.data = Object.assign({}, current.data || {}, data);
    });
    window.mhPopover.onClear(clear);
    window.mhPopover.ready();
  }
})();
