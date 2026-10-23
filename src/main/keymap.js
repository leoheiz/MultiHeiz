'use strict';

/**
 * Central keymap: defaults + user overrides.
 * Used by the application menu and focused-panel before-input-event handler.
 * Combo format: "Ctrl+P", "Ctrl+Shift+R", "Alt+Left", "F11", "Ctrl+Plus", …
 */

/** @typedef {{ combo?: string|null, disabled?: boolean }} ShortcutOverride */
/** @typedef {{ overrides?: Record<string, ShortcutOverride> }} KeyboardShortcutsSettings */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   defaultCombo: string,
 *   altDefaultCombo?: string|null,
 *   scope: 'panel'|'app'|'both',
 *   group: string,
 * }} ShortcutDef
 */

/** @type {ShortcutDef[]} */
const SHORTCUT_DEFS = [
  {
    id: 'print',
    name: 'Imprimir',
    defaultCombo: 'Ctrl+P',
    scope: 'panel',
    group: 'Página',
  },
  {
    id: 'find',
    name: 'Localizar na página',
    defaultCombo: 'Ctrl+F',
    scope: 'panel',
    group: 'Página',
  },
  {
    id: 'findNext',
    name: 'Localizar próximo',
    defaultCombo: 'F3',
    scope: 'panel',
    group: 'Página',
  },
  {
    id: 'findPrev',
    name: 'Localizar anterior',
    defaultCombo: 'Shift+F3',
    scope: 'panel',
    group: 'Página',
  },
  {
    id: 'savePage',
    name: 'Salvar página',
    defaultCombo: 'Ctrl+S',
    scope: 'panel',
    group: 'Página',
  },
  {
    id: 'viewSource',
    name: 'Ver código-fonte',
    defaultCombo: 'Ctrl+U',
    scope: 'panel',
    group: 'Página',
  },
  {
    id: 'reload',
    name: 'Recarregar',
    defaultCombo: 'Ctrl+R',
    scope: 'panel',
    group: 'Navegação',
  },
  {
    id: 'reloadF5',
    name: 'Recarregar (F5)',
    defaultCombo: 'F5',
    scope: 'panel',
    group: 'Navegação',
  },
  {
    id: 'hardReload',
    name: 'Recarregar forçado',
    defaultCombo: 'Ctrl+Shift+R',
    scope: 'panel',
    group: 'Navegação',
  },
  {
    id: 'hardReloadCtrlF5',
    name: 'Recarregar forçado (Ctrl+F5)',
    defaultCombo: 'Ctrl+F5',
    scope: 'panel',
    group: 'Navegação',
  },
  {
    id: 'back',
    name: 'Voltar',
    defaultCombo: 'Alt+Left',
    scope: 'panel',
    group: 'Navegação',
  },
  {
    id: 'forward',
    name: 'Avançar',
    defaultCombo: 'Alt+Right',
    scope: 'panel',
    group: 'Navegação',
  },
  {
    id: 'home',
    name: 'Início',
    defaultCombo: 'Alt+Home',
    scope: 'panel',
    group: 'Navegação',
  },
  {
    id: 'stop',
    name: 'Parar carregamento / sair da tela cheia',
    defaultCombo: 'Escape',
    scope: 'both',
    group: 'Navegação',
  },
  {
    id: 'focusUrl',
    name: 'Focar barra de URL',
    defaultCombo: 'Ctrl+L',
    scope: 'both',
    group: 'Navegação',
  },
  {
    id: 'zoomIn',
    name: 'Aumentar zoom',
    defaultCombo: 'Ctrl+Plus',
    altDefaultCombo: 'Ctrl+=',
    scope: 'panel',
    group: 'Exibir',
  },
  {
    id: 'zoomOut',
    name: 'Diminuir zoom',
    defaultCombo: 'Ctrl+-',
    scope: 'panel',
    group: 'Exibir',
  },
  {
    id: 'zoomReset',
    name: 'Zoom padrão',
    defaultCombo: 'Ctrl+0',
    scope: 'panel',
    group: 'Exibir',
  },
  {
    id: 'fullscreen',
    name: 'Tela cheia',
    defaultCombo: 'F11',
    scope: 'both',
    group: 'Exibir',
  },
  {
    id: 'devtools',
    name: 'Ferramentas de desenvolvedor (painel)',
    defaultCombo: 'F12',
    scope: 'panel',
    group: 'Exibir',
  },
  {
    id: 'devtoolsPanel',
    name: 'Ferramentas de desenvolvedor (painel, Ctrl+Shift+I)',
    defaultCombo: 'Ctrl+Shift+I',
    scope: 'panel',
    group: 'Exibir',
  },
  {
    id: 'devtoolsApp',
    name: 'Ferramentas de desenvolvedor (app)',
    defaultCombo: 'Ctrl+Shift+Alt+I',
    scope: 'app',
    group: 'Exibir',
  },
  {
    id: 'newWindow',
    name: 'Nova janela',
    defaultCombo: 'Ctrl+T',
    scope: 'app',
    group: 'Janela',
  },
  {
    id: 'favorite',
    name: 'Favoritar página',
    defaultCombo: 'Ctrl+D',
    scope: 'app',
    group: 'Janela',
  },
  {
    id: 'history',
    name: 'Histórico',
    defaultCombo: 'Ctrl+H',
    scope: 'app',
    group: 'Janela',
  },
  {
    id: 'downloads',
    name: 'Downloads',
    defaultCombo: 'Ctrl+J',
    scope: 'app',
    group: 'Janela',
  },
  {
    id: 'aiWrite',
    name: 'IA: melhorar texto…',
    defaultCombo: 'Ctrl+Shift+Space',
    scope: 'both',
    group: 'Editar',
  },
];

const DEF_BY_ID = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));

/**
 * @returns {KeyboardShortcutsSettings}
 */
function defaultKeyboardShortcuts() {
  return { overrides: {} };
}

/**
 * @param {unknown} raw
 * @returns {KeyboardShortcutsSettings}
 */
function normalizeKeyboardShortcuts(raw) {
  const out = defaultKeyboardShortcuts();
  if (!raw || typeof raw !== 'object') return out;
  const ov = /** @type {{ overrides?: unknown }} */ (raw).overrides;
  if (!ov || typeof ov !== 'object') return out;
  /** @type {Record<string, ShortcutOverride>} */
  const cleaned = {};
  for (const [id, val] of Object.entries(ov)) {
    if (!DEF_BY_ID.has(id)) continue;
    if (!val || typeof val !== 'object') continue;
    const v = /** @type {ShortcutOverride} */ (val);
    /** @type {ShortcutOverride} */
    const entry = {};
    if (v.disabled === true) entry.disabled = true;
    if (v.combo === null) {
      entry.combo = null;
    } else if (typeof v.combo === 'string' && v.combo.trim()) {
      const n = normalizeComboString(v.combo);
      if (n) entry.combo = n;
    }
    if (entry.disabled || entry.combo !== undefined) cleaned[id] = entry;
  }
  out.overrides = cleaned;
  return out;
}

/**
 * @param {string} combo
 * @returns {string}
 */
function normalizeComboString(combo) {
  const parts = String(combo || '')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  const mods = new Set();
  let key = '';
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'ctrl' || low === 'control' || low === 'cmdorctrl' || low === 'commandorcontrol') {
      mods.add('Ctrl');
    } else if (low === 'cmd' || low === 'command' || low === 'meta') {
      mods.add('Meta');
    } else if (low === 'alt' || low === 'option') {
      mods.add('Alt');
    } else if (low === 'shift') {
      mods.add('Shift');
    } else if (low === 'plus' || p === '+') {
      key = 'Plus';
    } else if (low === 'minus' || p === '-') {
      key = '-';
    } else if (low === 'escape' || low === 'esc') {
      key = 'Escape';
    } else if (low === 'space' || low === ' ') {
      key = 'Space';
    } else if (low === 'left' || low === 'arrowleft') {
      key = 'Left';
    } else if (low === 'right' || low === 'arrowright') {
      key = 'Right';
    } else if (low === 'up' || low === 'arrowup') {
      key = 'Up';
    } else if (low === 'down' || low === 'arrowdown') {
      key = 'Down';
    } else if (low === 'home') {
      key = 'Home';
    } else if (low === 'end') {
      key = 'End';
    } else if (low === 'insert') {
      key = 'Insert';
    } else if (low === 'delete' || low === 'del') {
      key = 'Delete';
    } else if (low === 'pause' || low === 'break') {
      key = 'Pause';
    } else if (low === 'scrolllock' || low === 'scroll') {
      key = 'ScrollLock';
    } else if (low === 'printscreen') {
      key = 'PrintScreen';
    } else if (low === 'pageup') {
      key = 'PageUp';
    } else if (low === 'pagedown') {
      key = 'PageDown';
    } else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) {
      key = p.toUpperCase();
    } else if (/^numpad/i.test(p)) {
      key = p.charAt(0).toUpperCase() + p.slice(1);
      if (key.startsWith('numpad')) key = 'Numpad' + key.slice(6);
    } else if (p.length === 1) {
      key = p.toUpperCase();
    } else {
      key = p.charAt(0).toUpperCase() + p.slice(1);
    }
  }
  if (!key) return '';
  const order = [];
  if (mods.has('Ctrl')) order.push('Ctrl');
  if (mods.has('Alt')) order.push('Alt');
  if (mods.has('Shift')) order.push('Shift');
  if (mods.has('Meta')) order.push('Meta');
  order.push(key);
  return order.join('+');
}

/**
 * @param {string} combo
 * @returns {{ ctrl: boolean, alt: boolean, shift: boolean, meta: boolean, key: string }}
 */
function parseCombo(combo) {
  const n = normalizeComboString(combo);
  const parts = n.split('+').filter(Boolean);
  const key = parts.length ? parts[parts.length - 1] : '';
  const mods = new Set(parts.slice(0, -1));
  return {
    ctrl: mods.has('Ctrl'),
    alt: mods.has('Alt'),
    shift: mods.has('Shift'),
    meta: mods.has('Meta'),
    key,
  };
}

/**
 * Keys Electron's Menu accelerator parser rejects (panel before-input still works).
 * @param {string} key
 * @returns {boolean}
 */
function isMenuUnsupportedKey(key) {
  const k = String(key || '');
  if (!k) return true;
  if (/^Numpad/i.test(k)) return true;
  if (/^F(1[3-9]|2[0-4])$/i.test(k)) return true;
  return (
    k === 'Pause' ||
    k === 'ScrollLock' ||
    k === 'Insert' ||
    k === 'Delete' ||
    k === 'PrintScreen' ||
    k === 'PageUp' ||
    k === 'PageDown'
  );
}

/**
 * Electron Menu accelerator (CmdOrCtrl on mac-friendly builds).
 * Returns empty string when the key cannot be bound on the application menu
 * (custom shortcuts still match via panel before-input-event).
 * @param {string} combo
 * @returns {string}
 */
function comboToAccelerator(combo) {
  const p = parseCombo(combo);
  if (isMenuUnsupportedKey(p.key)) return '';
  const bits = [];
  if (p.ctrl) bits.push('CmdOrCtrl');
  if (p.alt) bits.push('Alt');
  if (p.shift) bits.push('Shift');
  if (p.meta) bits.push('Meta');
  let k = p.key;
  if (k === 'Plus') k = 'Plus';
  else if (k === '-') k = '-';
  else if (k === 'Escape') k = 'Escape';
  else if (k === 'Space') k = 'Space';
  else if (k === 'Left') k = 'Left';
  else if (k === 'Right') k = 'Right';
  else if (k === 'Home') k = 'Home';
  bits.push(k);
  return bits.join('+');
}

/**
 * Normalize Electron Input.key for matching.
 * @param {Electron.Input} input
 * @returns {string}
 */
function inputKeyName(input) {
  const raw = String((input && input.key) || '');
  if (!raw) return '';
  if (raw === ' ') return 'Space';
  if (raw === '+' || raw === 'Add') return 'Plus';
  if (raw === '=' || raw === 'Equal') return '=';
  if (raw === '-' || raw === 'Subtract' || raw === '_') return '-';
  if (raw === 'Esc') return 'Escape';
  if (raw === 'ArrowLeft') return 'Left';
  if (raw === 'ArrowRight') return 'Right';
  if (raw === 'ArrowUp') return 'Up';
  if (raw === 'ArrowDown') return 'Down';
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (raw === 'Scroll' || raw === 'ScrollLock') return 'ScrollLock';
  if (raw === 'Pause' || raw === 'Break') return 'Pause';
  if (/^Numpad/i.test(raw)) {
    return 'Numpad' + raw.slice(6);
  }
  if (raw.length === 1) return raw.toUpperCase();
  return raw;
}

/**
 * @param {Electron.Input} input
 * @param {string} combo
 * @returns {boolean}
 */
function inputMatchesCombo(input, combo) {
  if (!input || !combo) return false;
  const want = parseCombo(combo);
  const key = inputKeyName(input);
  const ctrl = !!(input.control || input.meta);
  // Treat Meta as Ctrl on non-mac for CmdOrCtrl semantics when matching stored Ctrl
  const alt = !!input.alt;
  const shift = !!input.shift;

  if (!!want.ctrl !== ctrl) return false;
  if (!!want.alt !== alt) return false;
  if (!!want.meta && !input.meta) return false;
  // Shift: required if in combo; for letter keys without Shift in combo, allow either
  // (OS may report shift for some keys). Strict when combo includes Shift or is F-key/nav.
  if (want.shift) {
    if (!shift) return false;
  } else if (shift) {
    // Allow Shift+letter only when combo doesn't include shift for symbol keys like =
    // Reject Shift when combo has no Shift (except Ctrl+= vs Ctrl+Plus handled separately)
    const k = want.key;
    if (k === 'Plus' || k === '=' || k === '-') {
      /* ok */
    } else if (/^F\d+$/i.test(k) || k === 'Escape' || k === 'Left' || k === 'Right' || k === 'Home') {
      return false;
    } else if (k.length === 1 && /[A-Z0-9]/.test(k)) {
      return false;
    }
  }

  if (want.key === 'Plus') {
    return key === 'Plus' || key === '=' || key === '+';
  }
  if (want.key === '=') {
    return key === '=' || key === 'Plus';
  }
  return key === want.key;
}

/**
 * @param {KeyboardShortcutsSettings|null|undefined} settings
 * @param {string} id
 * @returns {{ combo: string|null, disabled: boolean, isDefault: boolean, altCombo: string|null }}
 */
function resolveShortcut(settings, id) {
  const def = DEF_BY_ID.get(id);
  if (!def) {
    return { combo: null, disabled: true, isDefault: true, altCombo: null };
  }
  const ks = normalizeKeyboardShortcuts(settings);
  const ov = ks.overrides[id];
  const altCombo = def.altDefaultCombo || null;
  if (ov && ov.disabled) {
    return { combo: null, disabled: true, isDefault: false, altCombo: null };
  }
  if (ov && ov.combo !== undefined) {
    if (ov.combo === null || ov.combo === '') {
      return { combo: null, disabled: true, isDefault: false, altCombo: null };
    }
    return {
      combo: normalizeComboString(ov.combo),
      disabled: false,
      isDefault: false,
      altCombo: null,
    };
  }
  return {
    combo: def.defaultCombo,
    disabled: false,
    isDefault: true,
    altCombo,
  };
}

/**
 * @param {KeyboardShortcutsSettings|null|undefined} settings
 * @param {Electron.Input} input
 * @param {{ scope?: 'panel'|'app'|'both' }} [opts]
 * @returns {string|null} matched shortcut id
 */
function matchInput(settings, input, opts = {}) {
  if (!input || input.type !== 'keyDown') return null;
  if (input.isAutoRepeat) return null;
  const scope = opts.scope || 'both';
  // Prefer longer / more specific combos first (more modifiers)
  const ranked = [...SHORTCUT_DEFS].sort((a, b) => {
    const ra = resolveShortcut(settings, a.id);
    const rb = resolveShortcut(settings, b.id);
    const score = (r) => {
      if (!r.combo) return -1;
      return parseCombo(r.combo).ctrl + parseCombo(r.combo).alt + parseCombo(r.combo).shift * 2;
    };
    return score(rb) - score(ra);
  });
  for (const def of ranked) {
    if (scope === 'panel' && def.scope === 'app') continue;
    if (scope === 'app' && def.scope === 'panel') continue;
    const r = resolveShortcut(settings, def.id);
    if (r.disabled || !r.combo) continue;
    if (inputMatchesCombo(input, r.combo)) return def.id;
    if (r.altCombo && inputMatchesCombo(input, r.altCombo)) return def.id;
  }
  return null;
}

/**
 * @param {KeyboardShortcutsSettings|null|undefined} settings
 * @param {string} combo
 * @param {string} [exceptId]
 * @returns {{ id: string, name: string }|null}
 */
function findConflict(settings, combo, exceptId) {
  const want = normalizeComboString(combo);
  if (!want) return null;
  for (const def of SHORTCUT_DEFS) {
    if (exceptId && def.id === exceptId) continue;
    const r = resolveShortcut(settings, def.id);
    if (r.disabled) continue;
    if (r.combo && normalizeComboString(r.combo) === want) {
      return { id: def.id, name: def.name };
    }
    if (r.altCombo && normalizeComboString(r.altCombo) === want) {
      return { id: def.id, name: def.name };
    }
    // Also conflict with defaults' alt when still on default
    if (r.isDefault && def.altDefaultCombo && normalizeComboString(def.altDefaultCombo) === want) {
      return { id: def.id, name: def.name };
    }
  }
  return null;
}

/**
 * @param {KeyboardShortcutsSettings|null|undefined} settings
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   group: string,
 *   combo: string|null,
 *   defaultCombo: string,
 *   disabled: boolean,
 *   isDefault: boolean,
 * }>}
 */
function listShortcuts(settings) {
  return SHORTCUT_DEFS.map((def) => {
    const r = resolveShortcut(settings, def.id);
    return {
      id: def.id,
      name: def.name,
      group: def.group,
      combo: r.disabled ? null : r.combo,
      defaultCombo: def.defaultCombo,
      disabled: r.disabled,
      isDefault: r.isDefault,
    };
  });
}

/**
 * @param {KeyboardShortcutsSettings|null|undefined} settings
 * @param {string} id
 * @param {{ combo?: string|null, disabled?: boolean, restore?: boolean }} patch
 * @returns {KeyboardShortcutsSettings}
 */
function applyOverride(settings, id, patch) {
  const ks = normalizeKeyboardShortcuts(settings);
  if (!DEF_BY_ID.has(id)) return ks;
  if (patch && patch.restore) {
    delete ks.overrides[id];
    return ks;
  }
  const prev = ks.overrides[id] ? { ...ks.overrides[id] } : {};
  if (patch && typeof patch.disabled === 'boolean') {
    if (patch.disabled) {
      ks.overrides[id] = { ...prev, disabled: true };
      return ks;
    }
    delete prev.disabled;
  }
  if (patch && 'combo' in patch) {
    if (patch.combo === null || patch.combo === '') {
      ks.overrides[id] = { disabled: true };
      return ks;
    }
    const n = normalizeComboString(String(patch.combo));
    const def = DEF_BY_ID.get(id);
    if (def && n === normalizeComboString(def.defaultCombo)) {
      delete ks.overrides[id];
      return ks;
    }
    ks.overrides[id] = { combo: n };
    return ks;
  }
  if (Object.keys(prev).length) ks.overrides[id] = prev;
  else delete ks.overrides[id];
  return ks;
}

/**
 * @returns {KeyboardShortcutsSettings}
 */
function restoreAllDefaults() {
  return defaultKeyboardShortcuts();
}

function getDefs() {
  return SHORTCUT_DEFS.slice();
}

function getDef(id) {
  return DEF_BY_ID.get(id) || null;
}

module.exports = {
  SHORTCUT_DEFS,
  defaultKeyboardShortcuts,
  normalizeKeyboardShortcuts,
  normalizeComboString,
  parseCombo,
  comboToAccelerator,
  isMenuUnsupportedKey,
  inputKeyName,
  inputMatchesCombo,
  resolveShortcut,
  matchInput,
  findConflict,
  listShortcuts,
  applyOverride,
  restoreAllDefaults,
  getDefs,
  getDef,
};
