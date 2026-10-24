'use strict';

/**
 * Vivaldi-style app menu (DOM dropdown on the logo).
 * Exposes window.MultiHeizAppMenu.
 */
(function () {
  /** @type {HTMLElement|null} */
  let rootEl = null;
  /** @type {Array<{ menu: HTMLElement, items: HTMLElement[], index: number }>} */
  let stack = [];
  /** @type {((id: string) => void)|null} */
  let onAction = null;
  let open = false;
  let altArmed = false;
  let altSawOther = false;

  function closeAll() {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.querySelectorAll('.mh-app-menu').forEach((n) => n.remove());
    rootEl = null;
    stack = [];
    if (open) {
      open = false;
      try {
        if (window.multiheiz && window.multiheiz.setOverlay) {
          window.multiheiz.setOverlay('app-menu', false);
        }
      } catch {
        /* ignore */
      }
      const btn = document.getElementById('btn-app-menu');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  }

  function isOpen() {
    return open;
  }

  /**
   * @param {HTMLElement} menu
   * @returns {HTMLElement[]}
   */
  function focusableItems(menu) {
    return [...menu.querySelectorAll(':scope > .mh-app-menu-item')].filter(
      (el) => el.getAttribute('aria-disabled') !== 'true' && el.dataset.type !== 'separator'
    );
  }

  /**
   * @param {number} level
   * @param {number} index
   */
  function setActive(level, index) {
    const layer = stack[level];
    if (!layer) return;
    layer.items.forEach((el, i) => {
      el.classList.toggle('is-active', i === index);
      if (i === index) el.setAttribute('aria-selected', 'true');
      else el.removeAttribute('aria-selected');
    });
    layer.index = index;
    const el = layer.items[index];
    if (el && typeof el.focus === 'function') el.focus();
  }

  /**
   * @param {object} node
   * @param {HTMLElement} parentMenu
   * @param {number} level
   */
  function openSubmenu(node, parentMenu, level, anchorBtn) {
    while (stack.length > level + 1) {
      const gone = stack.pop();
      if (gone && gone.menu && gone.menu.parentNode) gone.menu.remove();
    }
    const sub = buildMenu(node.children || [], level + 1);
    document.body.appendChild(sub);
    const r = anchorBtn.getBoundingClientRect();
    const parentR = parentMenu.getBoundingClientRect();
    let left = parentR.right - 4;
    let top = r.top;
    sub.style.left = left + 'px';
    sub.style.top = top + 'px';
    const br = sub.getBoundingClientRect();
    if (br.right > window.innerWidth - 4) {
      left = parentR.left - br.width + 4;
      sub.style.left = left + 'px';
    }
    if (br.bottom > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - br.height - 4);
      sub.style.top = top + 'px';
    }
    const items = focusableItems(sub);
    stack.push({ menu: sub, items, index: items.length ? 0 : -1 });
    if (items.length) setActive(level + 1, 0);
  }

  function closeSubmenusTo(level) {
    while (stack.length > level + 1) {
      const gone = stack.pop();
      if (gone && gone.menu && gone.menu.parentNode) gone.menu.remove();
    }
  }

  /**
   * @param {object[]} nodes
   * @param {number} level
   * @returns {HTMLElement}
   */
  function buildMenu(nodes, level) {
    const menu = document.createElement('div');
    menu.className = 'context-menu mh-app-menu';
    menu.setAttribute('role', level === 0 ? 'menu' : 'menu');
    menu.dataset.level = String(level);
    menu.tabIndex = -1;

    for (const node of nodes || []) {
      if (!node) continue;
      if (node.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'mh-app-menu-sep';
        sep.dataset.type = 'separator';
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mh-app-menu-item';
      btn.setAttribute('role', 'menuitem');
      btn.dataset.id = node.id || '';
      if (node.enabled === false) {
        btn.setAttribute('aria-disabled', 'true');
        btn.disabled = true;
      }
      if (node.children && node.children.length) {
        btn.classList.add('has-submenu');
        btn.setAttribute('aria-haspopup', 'true');
      }
      if (node.type === 'radio' && node.checked) {
        btn.classList.add('is-checked');
      }
      if (node.icon === 'settings') {
        btn.classList.add('has-icon');
      }

      const label = document.createElement('span');
      label.className = 'mh-app-menu-label';
      if (node.icon === 'settings') {
        const ico = document.createElement('span');
        ico.className = 'mh-app-menu-ico';
        ico.setAttribute('aria-hidden', 'true');
        ico.textContent = '⚙';
        label.appendChild(ico);
      }
      const text = document.createElement('span');
      text.textContent = node.label || '';
      label.appendChild(text);
      btn.appendChild(label);

      if (node.children && node.children.length) {
        const tip = document.createElement('span');
        tip.className = 'mh-app-menu-caret';
        tip.setAttribute('aria-hidden', 'true');
        tip.textContent = '▸';
        btn.appendChild(tip);
      } else if (node.shortcut) {
        const accel = document.createElement('span');
        accel.className = 'mh-app-menu-accel';
        accel.textContent = node.shortcut;
        btn.appendChild(accel);
      }

      btn.addEventListener('mouseenter', () => {
        const items = focusableItems(menu);
        const idx = items.indexOf(btn);
        if (idx >= 0) {
          const layerIdx = stack.findIndex((s) => s.menu === menu);
          if (layerIdx >= 0) setActive(layerIdx, idx);
        }
        if (node.children && node.children.length) {
          openSubmenu(node, menu, level, btn);
        } else {
          closeSubmenusTo(level);
        }
      });

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        if (node.children && node.children.length) {
          openSubmenu(node, menu, level, btn);
          return;
        }
        const actionId = node.id || '';
        closeAll();
        if (actionId && typeof onAction === 'function') {
          onAction(actionId, node.data || null);
        }
      });

      menu.appendChild(btn);
    }
    return menu;
  }

  /**
   * @param {{ tree: object[], x?: number, y?: number, anchorEl?: HTMLElement }} opts
   */
  function openMenu(opts) {
    closeAll();
    const tree = (opts && opts.tree) || [];
    const menu = buildMenu(tree, 0);
    rootEl = menu;
    document.body.appendChild(menu);
    open = true;
    try {
      if (window.multiheiz && window.multiheiz.setOverlay) {
        window.multiheiz.setOverlay('app-menu', true);
      }
    } catch {
      /* ignore */
    }
    const btn = document.getElementById('btn-app-menu');
    if (btn) btn.setAttribute('aria-expanded', 'true');

    let left = Number(opts && opts.x) || 8;
    let top = Number(opts && opts.y) || 40;
    if (opts && opts.anchorEl) {
      const r = opts.anchorEl.getBoundingClientRect();
      left = Math.round(r.left);
      top = Math.round(r.bottom + 2);
    }
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    const br = menu.getBoundingClientRect();
    if (br.right > window.innerWidth - 4) {
      menu.style.left = Math.max(4, window.innerWidth - br.width - 4) + 'px';
    }
    if (br.bottom > window.innerHeight - 4) {
      menu.style.top = Math.max(4, window.innerHeight - br.height - 4) + 'px';
    }

    const items = focusableItems(menu);
    stack = [{ menu, items, index: items.length ? 0 : -1 }];
    if (items.length) setActive(0, 0);

    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    }, 0);
  }

  function onDocDown(ev) {
    if (!open) return;
    const t = ev.target;
    if (t && t.closest && t.closest('.mh-app-menu')) return;
    if (t && t.closest && t.closest('#btn-app-menu')) return;
    closeAll();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function onKeyDown(ev) {
    if (!open) return;
    const layer = stack[stack.length - 1];
    if (!layer || !layer.items.length) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeAll();
      }
      return;
    }
    const key = ev.key;
    if (key === 'Escape') {
      ev.preventDefault();
      if (stack.length > 1) {
        const gone = stack.pop();
        if (gone && gone.menu) gone.menu.remove();
        const prev = stack[stack.length - 1];
        if (prev && prev.index >= 0) setActive(stack.length - 1, prev.index);
      } else {
        closeAll();
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
      }
      return;
    }
    if (key === 'ArrowDown') {
      ev.preventDefault();
      const next = (layer.index + 1) % layer.items.length;
      setActive(stack.length - 1, next);
      return;
    }
    if (key === 'ArrowUp') {
      ev.preventDefault();
      const next = (layer.index - 1 + layer.items.length) % layer.items.length;
      setActive(stack.length - 1, next);
      return;
    }
    if (key === 'ArrowRight') {
      ev.preventDefault();
      const cur = layer.items[layer.index];
      if (cur && cur.classList.contains('has-submenu')) {
        cur.click();
      }
      return;
    }
    if (key === 'ArrowLeft') {
      ev.preventDefault();
      if (stack.length > 1) {
        const gone = stack.pop();
        if (gone && gone.menu) gone.menu.remove();
        const prev = stack[stack.length - 1];
        if (prev && prev.index >= 0) setActive(stack.length - 1, prev.index);
      }
      return;
    }
    if (key === 'Enter') {
      ev.preventDefault();
      const cur = layer.items[layer.index];
      if (cur) cur.click();
    }
  }

  function focusIsEditable() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  /**
   * Alt alone / F10 in the main UI (chrome). Panels use main-process before-input.
   */
  function installChromeKeys() {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'F10' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          toggleFromChrome();
          return;
        }
        if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
            altArmed = true;
            altSawOther = false;
          }
          return;
        }
        if (altArmed && e.key !== 'Alt') {
          altSawOther = true;
        }
      },
      true
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
          const alone = altArmed && !altSawOther && !e.ctrlKey && !e.metaKey && !e.shiftKey;
          altArmed = false;
          altSawOther = false;
          if (!alone) return;
          if (focusIsEditable()) return;
          e.preventDefault();
          toggleFromChrome();
        }
      },
      true
    );
  }

  function toggleFromChrome() {
    if (open) {
      closeAll();
      return;
    }
    const btn = document.getElementById('btn-app-menu');
    if (typeof window.__multiheizOpenAppMenu === 'function') {
      window.__multiheizOpenAppMenu();
    } else if (btn) {
      btn.click();
    }
  }

  /**
   * Snapshot for selftests.
   */
  function getDebugState() {
    const menus = [...document.querySelectorAll('.mh-app-menu')];
    const items = [...document.querySelectorAll('.mh-app-menu-item')].map((el) => ({
      id: el.dataset.id || '',
      label: (el.querySelector('.mh-app-menu-label') || el).textContent.trim(),
      accel: (el.querySelector('.mh-app-menu-accel') || {}).textContent || '',
      hasSubmenu: el.classList.contains('has-submenu'),
      active: el.classList.contains('is-active'),
    }));
    const r0 = menus[0] ? menus[0].getBoundingClientRect() : null;
    return {
      open,
      menuCount: menus.length,
      width: r0 ? r0.width : 0,
      height: r0 ? r0.height : 0,
      items,
      ids: items.map((i) => i.id).filter(Boolean),
    };
  }

  /**
   * @param {{ onAction: Function }} api
   */
  function init(api) {
    onAction = api && api.onAction ? api.onAction : null;
    installChromeKeys();
  }

  window.MultiHeizAppMenu = {
    init,
    open: openMenu,
    close: closeAll,
    isOpen,
    getDebugState,
    toggleFromChrome,
  };
})();
