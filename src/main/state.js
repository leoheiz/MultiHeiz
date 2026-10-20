'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { readJsonDurable, writeJsonDurable } = require('./json-store');

const STATE_FILE = 'multiheiz-state.json';
const SAVE_DEBOUNCE_MS = 400;

/** @type {ReturnType<typeof defaultState>} */
let state = defaultState();
let saveTimer = null;
let statePath = null;

function defaultAppearance() {
  return {
    preset: 'escuro',
    accent: '#2bb8a6',
    background: '#14181f',
    surface: '#1e2430',
    text: '#e6ebea',
    panelHeader: '#243040',
    sidebar: '#181c24',
  };
}

function defaultState() {
  const wsId = 'ws-default';
  return {
    version: 1,
    workspaces: [{ id: wsId, name: 'Principal' }],
    activeWorkspaceId: wsId,
    accounts: [],
    layout: 'auto',
    page: 0,
    maximizedAccountId: null,
    /** Per-workspace maximized panel id */
    maximizedByWorkspace: {},
    /** Per-workspace pager page */
    pageByWorkspace: {},
    windowBounds: { width: 1280, height: 800, x: undefined, y: undefined },
    windowMaximized: false,
    /** Per-workspace free-tile map: { [wsId]: { [accountId]: { c, r, w, h } } } */
    freeTiles: {},
    ui: {
      sidebarCollapsed: false,
      /**
       * Auto-hide sidebar (overlay on hover). Used when settings.sidebarAlwaysActive is off.
       * Default false = fixed sidebar. When true, panels use nearly full width; a thin
       * hot-zone reveals the sidebar as an overlay without reflowing panel HTML layout.
       */
      sidebarAutoHide: false,
      layoutLocked: true,
      /** Expanded sidebar width in CSS px (user-resizable) */
      sidebarWidth: 240,
      /** Last changelog version shown in Novidades (show-once after update) */
      lastSeenChangelogVersion: null,
    },
    appearance: defaultAppearance(),
    settings: {
      openLastPage: true,
      confirmOnRemove: true,
      language: 'pt-BR',
      homepage: 'https://www.google.com',
      searchEngine: 'google',
      searchTemplate: 'https://www.google.com/search?q=%s',
      // v1.2.0: hidden panels throttle by default; opt-in per window (keepAliveInBackground)
      suspendHidden: false,
      suspendDelayMs: 0,
      keepBackgroundRunning: false,
      /** One-shot migration markers (do not remove keys once set) */
      migrations: {
        keepAlive120: true,
      },
      // Memória
      memoryLimitMb: 0,
      panelMemoryLimitMb: 0,
      hardMemoryLimit: false,
      // FPS throttle only when user enables it (default OFF in v1.3)
      backgroundThrottling: false,
      backgroundFps: 5,
      // v1.8
      persistSessions: true,
      openLastPageLabel: true, // Continuar de onde parou (alias openLastPage)
      uaIdentity: 'chrome', // chrome | edge
      /** Usar passkeys/WebAuthn do Windows nas sessões de conta (default ON) */
      windowsPasskeys: true,
      blankLinkMode: 'same', // same | new-panel
      lightMode: false,
      /**
       * Legacy sidebar: top arrow collapses/expands like before (icon rail), with no
       * auto-hide, hot-zone, or overlay inset. Default off = new fixed/auto-hide toggle.
       */
      sidebarAlwaysActive: false,
      /**
       * DNS over HTTPS (app-wide). mode: off | automatic | secure.
       * provider: cloudflare | google | quad9 | adguard | custom (+ customUrl https).
       */
      doh: {
        mode: 'off',
        provider: 'cloudflare',
        customUrl: '',
      },
      backgroundPreset: 'balanced', // balanced | always | max-save
      preferHighPerfGpu: false,
      frameCapHidden: 30,
      frameCapAll: 0, // 0 = off; else FPS for all panels
      /** Verificar atualizações automaticamente ao iniciar (default ON) */
      autoCheckUpdates: true,
      modules: {
        planilha: true,
        alarmes: true,
        notas: true,
      },
      adblock: {
        enabled: true,
        antiTracking: true,
        cosmetic: true,
        youtubeExperimental: false,
        lists: {
          ublock_filters: true,
          ublock_badware: true,
          ublock_privacy: true,
          ublock_quick_fixes: true,
          ublock_unbreak: true,
          ublock_resource_abuse: true,
          easylist: true,
          easyprivacy: true,
          portuguese: true,
          peter_lowe: true,
          adguard_base: true,
          adguard_tracking: false,
          abu_ad: false,
          abu_privacy: false,
          abu_security: false,
          abu_anticircumvention: false,
          abu_spanish_portuguese: false,
        },
        allowlist: [],
        customLists: [],
        userRules: '',
        updateIntervalHours: 24,
        lastUpdateAt: null,
        listStatus: {},
        listMeta: {},
        statusMessage: '',
      },
      /** Experimental MV3 extension compatibility (AdBlocker Ultimate etc.) */
      extensions: {
        /**
         * When ON, extensions with background.service_worker get SW API shims
         * (webNavigation, DNR bridge, early-replay, …). Default ON.
         */
        abuCompat: true,
      },
    },
  };
}

function getStatePath() {
  if (!statePath) {
    statePath = path.join(app.getPath('userData'), STATE_FILE);
  }
  return statePath;
}

function loadState() {
  const file = getStatePath();
  const result = readJsonDurable(file, defaultState, STATE_FILE);
  try {
    state = migrate(result.data && typeof result.data === 'object' ? result.data : defaultState());
  } catch (err) {
    console.error('Falha ao migrar estado:', err);
    state = defaultState();
  }
  return state;
}

function migrate(parsed) {
  const base = defaultState();
  const next = {
    ...base,
    ...parsed,
    settings: { ...base.settings, ...(parsed.settings || {}) },
    ui: { ...base.ui, ...(parsed.ui || {}) },
    appearance: { ...base.appearance, ...(parsed.appearance || {}) },
    freeTiles:
      parsed.freeTiles && typeof parsed.freeTiles === 'object' ? parsed.freeTiles : {},
    maximizedByWorkspace:
      parsed.maximizedByWorkspace && typeof parsed.maximizedByWorkspace === 'object'
        ? parsed.maximizedByWorkspace
        : {},
    pageByWorkspace:
      parsed.pageByWorkspace && typeof parsed.pageByWorkspace === 'object'
        ? parsed.pageByWorkspace
        : {},
    windowMaximized: !!parsed.windowMaximized,
    workspaces:
      Array.isArray(parsed.workspaces) && parsed.workspaces.length
        ? parsed.workspaces
        : base.workspaces,
    accounts: Array.isArray(parsed.accounts)
      ? parsed.accounts.map((a) => {
          let pauseInBackground = !!(a && a.pauseInBackground);
          // v1.2.0: opt-in keep-alive; existing accounts migrate to OFF
          let keepAliveInBackground = !!(a && a.keepAliveInBackground);
          // Mutually exclusive: pause wins (matches panels.js throttling priority)
          if (pauseInBackground && keepAliveInBackground) {
            keepAliveInBackground = false;
          }
          return {
            ...a,
            pauseInBackground,
            keepAliveInBackground,
            privateHistory: !!(a && a.privateHistory),
            adblockEnabled: a && a.adblockEnabled === false ? false : true,
            zoomFactor:
              typeof (a && a.zoomFactor) === 'number' && a.zoomFactor >= 0.25 && a.zoomFactor <= 3
                ? a.zoomFactor
                : 1,
          };
        })
      : [],
  };
  if (!next.settings.modules || typeof next.settings.modules !== 'object') {
    next.settings.modules = { planilha: true, alarmes: true, notas: true };
  } else {
    next.settings.modules = {
      planilha: next.settings.modules.planilha !== false,
      alarmes: next.settings.modules.alarmes !== false,
      notas: next.settings.modules.notas !== false,
    };
  }
  if (!next.settings.adblock || typeof next.settings.adblock !== 'object') {
    next.settings.adblock = base.settings.adblock;
  } else {
    next.settings.adblock = {
      ...base.settings.adblock,
      ...next.settings.adblock,
      lists: {
        ...base.settings.adblock.lists,
        ...((next.settings.adblock && next.settings.adblock.lists) || {}),
      },
      allowlist: Array.isArray(next.settings.adblock.allowlist)
        ? next.settings.adblock.allowlist
        : [],
    };
  }
  if (!next.settings.extensions || typeof next.settings.extensions !== 'object') {
    next.settings.extensions = { ...base.settings.extensions };
  } else {
    next.settings.extensions = {
      ...base.settings.extensions,
      ...next.settings.extensions,
      abuCompat:
        next.settings.extensions.abuCompat === false
          ? false
          : base.settings.extensions.abuCompat !== false,
    };
  }
  if (typeof next.settings.confirmOnRemove !== 'boolean') {
    next.settings.confirmOnRemove = true;
  }
  if (!next.settings.language) next.settings.language = 'pt-BR';
  if (!next.settings.homepage) next.settings.homepage = 'https://www.google.com';
  if (!next.settings.searchEngine) next.settings.searchEngine = 'google';
  if (!next.settings.searchTemplate) {
    next.settings.searchTemplate = 'https://www.google.com/search?q=%s';
  }
  if (!next.workspaces.some((w) => w.id === next.activeWorkspaceId)) {
    next.activeWorkspaceId = next.workspaces[0].id;
  }
  if (!next.windowBounds || typeof next.windowBounds !== 'object') {
    next.windowBounds = base.windowBounds;
  }
  if (typeof next.settings.keepBackgroundRunning !== 'boolean') {
    next.settings.keepBackgroundRunning = false;
  }
  // v1.2.0 one-shot: pre-1.2.0 profiles had keepBackgroundRunning=true as the old
  // default (kept every panel alive). Force OFF once; do not touch per-account
  // keepAliveInBackground. Marker from *parsed* settings only (not defaultState),
  // so legacy files without migrations still migrate.
  {
    const rawMigrations =
      parsed.settings &&
      parsed.settings.migrations &&
      typeof parsed.settings.migrations === 'object'
        ? parsed.settings.migrations
        : {};
    next.settings.migrations = { ...rawMigrations };
    if (!next.settings.migrations.keepAlive120) {
      next.settings.keepBackgroundRunning = false;
      next.settings.migrations.keepAlive120 = true;
    }
  }
  if (typeof next.settings.persistSessions !== 'boolean') {
    next.settings.persistSessions = true;
  }
  if (!next.settings.uaIdentity) next.settings.uaIdentity = 'chrome';
  if (typeof next.settings.windowsPasskeys !== 'boolean') {
    next.settings.windowsPasskeys = true;
  }
  if (!next.settings.blankLinkMode) next.settings.blankLinkMode = 'same';
  if (typeof next.settings.lightMode !== 'boolean') next.settings.lightMode = false;
  if (typeof next.settings.sidebarAlwaysActive !== 'boolean') {
    next.settings.sidebarAlwaysActive = false;
  }
  {
    const { normalizeDoh, defaultDohSettings } = require('./doh');
    const rawDoh =
      next.settings.doh && typeof next.settings.doh === 'object' ? next.settings.doh : null;
    next.settings.doh = rawDoh ? normalizeDoh(rawDoh) : defaultDohSettings();
  }
  if (!next.settings.backgroundPreset) next.settings.backgroundPreset = 'balanced';
  if (typeof next.settings.preferHighPerfGpu !== 'boolean') {
    next.settings.preferHighPerfGpu = false;
  }
  if (typeof next.settings.frameCapHidden !== 'number') next.settings.frameCapHidden = 30;
  if (typeof next.settings.frameCapAll !== 'number') next.settings.frameCapAll = 0;
  if (typeof next.settings.autoCheckUpdates !== 'boolean') {
    next.settings.autoCheckUpdates = true;
  }
  if (typeof next.ui.sidebarCollapsed !== 'boolean') {
    next.ui.sidebarCollapsed = false;
  }
  // Profiles without sidebarAutoHide start FIXED (new mode). Keep an existing boolean
  // (user already chose auto-hide). Do not map old sidebarCollapsed → autoHide.
  // Preserve sidebarCollapsed so legacy mode can restore the pre-1.3.0 compact/expand
  // preference; outside legacy the renderer ignores the flag for layout.
  // Check *parsed* ui: defaultState already has sidebarAutoHide:false after merge.
  {
    const rawUi = parsed.ui && typeof parsed.ui === 'object' ? parsed.ui : {};
    if (typeof rawUi.sidebarAutoHide !== 'boolean') {
      next.ui.sidebarAutoHide = false;
    }
  }
  if (typeof next.ui.sidebarWidth !== 'number' || !Number.isFinite(next.ui.sidebarWidth)) {
    next.ui.sidebarWidth = 240;
  } else {
    next.ui.sidebarWidth = Math.min(360, Math.max(160, Math.round(next.ui.sidebarWidth)));
  }
  if (typeof next.ui.layoutLocked !== 'boolean') {
    next.ui.layoutLocked = true;
  }
  // Ensure per-account lastBounds field exists when present
  for (const a of next.accounts) {
    if (a && a.lastBounds && typeof a.lastBounds === 'object') {
      a.lastBounds = {
        x: Number(a.lastBounds.x) || 0,
        y: Number(a.lastBounds.y) || 0,
        width: Number(a.lastBounds.width) || 0,
        height: Number(a.lastBounds.height) || 0,
      };
    }
  }
  return next;
}

function getState() {
  return state;
}

function setState(partial) {
  state = { ...state, ...partial };
  if (partial && partial.settings) {
    state.settings = { ...state.settings, ...partial.settings };
  }
  if (partial && partial.ui) {
    state.ui = { ...state.ui, ...partial.ui };
  }
  if (partial && partial.appearance) {
    state.appearance = { ...state.appearance, ...partial.appearance };
  }
  if (partial && partial.freeTiles) {
    state.freeTiles = partial.freeTiles;
  }
  scheduleSave();
  return state;
}

function updateState(mutator) {
  mutator(state);
  scheduleSave();
  return state;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Async write — keep main free; flushSave() on before-quit is still sync.
    setImmediate(() => saveNowAsync());
  }, SAVE_DEBOUNCE_MS);
}

function saveNow() {
  const file = getStatePath();
  try {
    writeJsonDurable(file, state);
  } catch (err) {
    console.error('Falha ao salvar estado:', err);
  }
}

function saveNowAsync() {
  const file = getStatePath();
  const snapshot = state;
  try {
    // writeJsonDurable is sync fs; run off the current turn via setImmediate caller.
    writeJsonDurable(file, snapshot);
  } catch (err) {
    console.error('Falha ao salvar estado:', err);
  }
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
}

module.exports = {
  loadState,
  getState,
  setState,
  updateState,
  flushSave,
  defaultState,
  defaultAppearance,
  migrate,
  STATE_FILE,
};
