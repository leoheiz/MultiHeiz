(function () {
  const root = document.getElementById('root');
  let current = null;

  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    const r = document.documentElement;
    for (const [k, v] of Object.entries(theme)) {
      if (v == null || v === '') continue;
      const name = k.startsWith('--') ? k : '--' + k;
      r.style.setProperty(name, String(v));
    }
  }

  function reportMeasure() {
    const el = root.firstElementChild || root;
    const r = el.getBoundingClientRect();
    const w = Math.ceil(r.width) || Math.ceil(root.scrollWidth);
    const h = Math.ceil(r.height) || Math.ceil(root.scrollHeight);
    if (window.mhPopover && window.mhPopover.measure) {
      window.mhPopover.measure({ width: w, height: h });
    }
  }

  function scheduleMeasure() {
    requestAnimationFrame(() => {
      reportMeasure();
      requestAnimationFrame(reportMeasure);
    });
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

  function renderMem(data) {
    const box = document.createElement('div');
    box.className = 'mem-popover-box';
    box.dataset.role = 'mem-popover';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Monitor de memória');
    const head = document.createElement('div');
    head.className = 'mem-popover-head';
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

    const total = document.createElement('div');
    total.className = 'mem-popover-total';
    total.dataset.role = 'mem-total';
    const totalText = (data && data.totalText) || (data && data.totalLabel) || 'Coletando métricas…';
    total.textContent = totalText;
    box.appendChild(total);

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
    box.appendChild(list);
    return box;
  }

  function updateMem(data) {
    if (!current || current.kind !== 'mem') return;
    current.data = Object.assign({}, current.data || {}, data || {});
    const node = renderMem(current.data);
    root.replaceChildren(node);
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
    else if (payload.kind === 'mem') node = renderMem(payload.data || {});
    else if (payload.kind === 'ai-write') node = renderAiWrite(payload.data || {});
    if (node) root.appendChild(node);
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
      } else if (data) current.data = Object.assign({}, current.data || {}, data);
    });
    window.mhPopover.onClear(clear);
    window.mhPopover.ready();
  }
})();
