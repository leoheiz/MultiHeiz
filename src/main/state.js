'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { readJsonDurable, writeJsonDurable, writeJsonDurableAsync } = require('./json-store');

const STATE_FILE = 'multiheiz-state.json';
const SAVE_DEBOUNCE_MS = 400;

/** Layout modes shown in the top-bar <select> (and app menu). */
const VALID_LAYOUTS = Object.freeze(['1', '2', '4', '6', 'auto', 'livre']);
const VALID_LAYOUT_SET = new Set(VALID_LAYOUTS);

/**
 * Normalize a layout value to a known select option.
 * Invalid / legacy shapes (objects, unknown strings) fall back to "auto"
 * so the Layout <select> never appears empty.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeLayout(value) {
  if (typeof value === 'string' && VALID_LAYOUT_SET.has(value)) return value;
  if (typeof value === 'number') {
    const asStr = String(value);
    if (VALID_LAYOUT_SET.has(asStr)) return asStr;
  }
  return 'auto';
}

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
    workspaces: [
      {
        id: wsId,
        name: 'Principal',
        sessionType: 'independent',
        sharedPartitionId: null,
      },
    ],
    activeWorkspaceId: wsId,
    accounts: [],
    /**
     * Active workspace layout mode (mirror of layoutByWorkspace[activeWorkspaceId]).
     * Kept for backwards-compatible reads; writers should update layoutByWorkspace too.
     */
    layout: 'auto',
    /**
     * Per-workspace layout mode: { [wsId]: '1'|'2'|'4'|'6'|'auto'|'livre' }.
     * New workspaces copy the current area's layout (see workspace:create).
     */
    layoutByWorkspace: {},
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
    /**
     * Mini player (experimental): last position/size/opacity.
     * { x?, y?, width?, height?, opacityPercent? }
     */
    miniPlayer: {
      width: 420,
      height: 280,
      opacityPercent: 100,
    },
    ui: {
      /**
       * Compact icon rail (52px). Independent of sidebarAutoHide in standard mode;
       * also used by legacy always-active compact/expand.
       */
      sidebarCollapsed: false,
      /**
       * Auto-hide sidebar (overlay on hover). Used when settings.sidebarAlwaysActive is off.
       * Default false = fixed (pinned). Independent of sidebarCollapsed (compact/expanded).
       * When true, panels use nearly full width; a thin hot-zone reveals the sidebar as
       * an overlay at the last chosen compact/expanded width.
       */
      sidebarAutoHide: false,
      layoutLocked: true,
      /** Expanded sidebar width in CSS px (user-resizable) */
      sidebarWidth: 240,
      /** Last changelog version shown in Novidades (show-once after update) */
      lastSeenChangelogVersion: null,
    },
    appearance: defaultAppearance(),
    /**
     * Certificados de cliente lembrados por origem: { [origin]: fingerprint }.
     * Sem material sensível — só a escolha (impressão digital).
     */
    clientCertChoices: {},
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
      /** Limpeza periódica: cache HTTP + suspender ociosos (OFF por padrão). */
      memoryCleanupEnabled: false,
      /** Intervalo em minutos (5–240). Padrão 30. */
      memoryCleanupIntervalMin: 30,
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
       * Legacy sidebar: only the collapse arrow (no pin); never auto-hides.
       * Default off = standard mode with independent arrow (compact/expand) + pin (auto-hide).
       */
      sidebarAlwaysActive: false,
      /**
       * F11: reveal the top bar when the cursor is near the top edge (overlay).
       * ON by default. No always-visible / pinned mode.
       */
      fullscreenTopbarReveal: true,
      /** Mostrar botão PiP na barra do painel (padrão: ligado). */
      showPipToolbarButton: true,
      /** Opacidade padrão do mini player (20–100). */
      miniPlayerOpacity: 100,
      /**
       * DNS over HTTPS (app-wide). mode: off | automatic | secure.
       * provider: cloudflare | google | quad9 | adguard | custom (+ customUrl https).
       */
      doh: {
        mode: 'off',
        provider: 'cloudflare',
        customUrl: '',
      },
      /**
       * Corretor LanguageTool (desligado por padrão — opt-in).
       * Ao ligar, o texto dos campos é enviado ao servidor LT.
       * Corretor nativo do Chromium permanece ativo salvo disableNativeSpellcheck.
       */
      languageTool: {
        enabled: false,
        languages: ['pt-BR', 'pt-PT', 'en', 'es', 'fr', 'de', 'it', 'nl', 'ca'],
        serverUrl: '',
        disabledOrigins: [],
        disableNativeSpellcheck: false,
      },
      /**
       * IA experimental (escrita) — desligada por padrão.
       * Chave só em apiKeyEnc (safeStorage); nunca texto puro.
       */
      aiWrite: {
        enabled: false,
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        baseUrl: '',
        apiKeyEnc: null,
      },
      /**
       * Atalhos de teclado: só overrides (combo/disabled).
       * Vazio = todos os padrões do keymap (usuários existentes sem mudança).
       */
      keyboardShortcuts: {
        overrides: {},
      },
      backgroundPreset: 'balanced', // balanced | always | max-save
      preferHighPerfGpu: false,
      frameCapHidden: 30,
      frameCapAll: 0, // 0 = off; else FPS for all panels
      /** Verificar atualizações automaticamente ao iniciar (default ON) */
      autoCheckUpdates: true,
      /** Iniciar com o sistema (default OFF) */
      openAtLogin: false,
      /** Se openAtLogin: iniciar minimizado/oculto (--hidden) */
      openAsHidden: false,
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
    layoutByWorkspace:
      parsed.layoutByWorkspace && typeof parsed.layoutByWorkspace === 'object'
        ? parsed.layoutByWorkspace
        : {},
    maximizedByWorkspace:
      parsed.maximizedByWorkspace && typeof parsed.maximizedByWorkspace === 'object'
        ? parsed.maximizedByWorkspace
        : {},
    pageByWorkspace:
      parsed.pageByWorkspace && typeof parsed.pageByWorkspace === 'object'
        ? parsed.pageByWorkspace
        : {},
    windowMaximized: !!parsed.windowMaximized,
    clientCertChoices:
      parsed.clientCertChoices && typeof parsed.clientCertChoices === 'object'
        ? { ...parsed.clientCertChoices }
        : {},
    workspaces:
      Array.isArray(parsed.workspaces) && parsed.workspaces.length
        ? parsed.workspaces.map((w) => {
            try {
              const part = require('./partition');
              return part.normalizeWorkspaceSessionFields(w);
            } catch {
              return {
                ...w,
                sessionType:
                  w && w.sessionType === 'conventional' ? 'conventional' : 'independent',
                sharedPartitionId:
                  w && w.sharedPartitionId != null && String(w.sharedPartitionId).trim()
                    ? String(w.sharedPartitionId).trim()
                    : null,
              };
            }
          })
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
          const id = a && a.id != null ? String(a.id) : '';
          // partitionId: chave da sessão Chromium (persist:acc-<id>).
          // Ausente ou vazio → própria janela (id). Idempotente.
          let partitionId =
            a && a.partitionId != null && String(a.partitionId).trim()
              ? String(a.partitionId).trim()
              : id;
          return {
            ...a,
            pauseInBackground,
            keepAliveInBackground,
            minimized: !!(a && a.minimized),
            privateHistory: !!(a && a.privateHistory),
            adblockEnabled: a && a.adblockEnabled === false ? false : true,
            showUnread: a && a.showUnread === false ? false : true,
            zoomFactor:
              typeof (a && a.zoomFactor) === 'number' && a.zoomFactor >= 0.25 && a.zoomFactor <= 3
                ? a.zoomFactor
                : 1,
            partitionId,
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
  if (typeof next.settings.memoryCleanupEnabled !== 'boolean') {
    next.settings.memoryCleanupEnabled = false;
  }
  {
    let mins = Number(next.settings.memoryCleanupIntervalMin);
    if (!Number.isFinite(mins)) mins = 30;
    next.settings.memoryCleanupIntervalMin = Math.min(240, Math.max(5, Math.round(mins)));
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
  if (typeof next.settings.fullscreenTopbarReveal !== 'boolean') {
    next.settings.fullscreenTopbarReveal = true;
  }
  if (typeof next.settings.showPipToolbarButton !== 'boolean') {
    next.settings.showPipToolbarButton = true;
  }
  {
    let op = Number(next.settings.miniPlayerOpacity);
    if (!Number.isFinite(op)) op = 100;
    next.settings.miniPlayerOpacity = Math.min(100, Math.max(20, Math.round(op)));
  }
  if (!next.miniPlayer || typeof next.miniPlayer !== 'object') {
    next.miniPlayer = { ...base.miniPlayer };
  } else {
    const mp = next.miniPlayer;
    let w = Number(mp.width);
    let h = Number(mp.height);
    let op = Number(mp.opacityPercent);
    if (!Number.isFinite(w) || w < 200) w = base.miniPlayer.width;
    if (!Number.isFinite(h) || h < 120) h = base.miniPlayer.height;
    if (!Number.isFinite(op)) op = next.settings.miniPlayerOpacity;
    next.miniPlayer = {
      ...mp,
      width: Math.round(w),
      height: Math.round(h),
      opacityPercent: Math.min(100, Math.max(20, Math.round(op))),
    };
    if (typeof mp.x === 'number') next.miniPlayer.x = mp.x;
    if (typeof mp.y === 'number') next.miniPlayer.y = mp.y;
  }
  // 1.3.1 one-shot: early 1.3.1 test builds defaulted OFF and wrote false into
  // state. Force ON once; after the marker is set, user toggles persist.
  {
    if (!next.settings.migrations || typeof next.settings.migrations !== 'object') {
      next.settings.migrations = {};
    }
    if (!next.settings.migrations.fullscreenTopbarRevealMigrated131) {
      next.settings.fullscreenTopbarReveal = true;
      next.settings.migrations.fullscreenTopbarRevealMigrated131 = true;
    }
  }
  {
    const { normalizeDoh, defaultDohSettings } = require('./doh');
    const rawDoh =
      next.settings.doh && typeof next.settings.doh === 'object' ? next.settings.doh : null;
    next.settings.doh = rawDoh ? normalizeDoh(rawDoh) : defaultDohSettings();
  }
  {
    const { normalizeLanguageTool, defaultLanguageToolSettings } = require('./languagetool');
    const rawLt =
      next.settings.languageTool && typeof next.settings.languageTool === 'object'
        ? next.settings.languageTool
        : null;
    next.settings.languageTool = rawLt
      ? normalizeLanguageTool(rawLt)
      : defaultLanguageToolSettings();
    // 1.3.1 one-shot: LT passa a opt-in (OFF). Força OFF uma vez para perfis
    // existentes (incluindo quem tinha o antigo default ON).
    if (!next.settings.migrations || typeof next.settings.migrations !== 'object') {
      next.settings.migrations = {};
    }
    if (!next.settings.migrations.languageToolDefaultOff131) {
      next.settings.languageTool = normalizeLanguageTool({
        ...next.settings.languageTool,
        enabled: false,
      });
      next.settings.migrations.languageToolDefaultOff131 = true;
    }
  }
  {
    const { normalizeAiWrite, defaultAiWriteSettings } = require('./ai-write');
    const rawAi =
      next.settings.aiWrite && typeof next.settings.aiWrite === 'object'
        ? next.settings.aiWrite
        : null;
    next.settings.aiWrite = rawAi ? normalizeAiWrite(rawAi) : defaultAiWriteSettings();
  }
  {
    const { normalizeKeyboardShortcuts, defaultKeyboardShortcuts } = require('./keymap');
    const rawKs =
      next.settings.keyboardShortcuts && typeof next.settings.keyboardShortcuts === 'object'
        ? next.settings.keyboardShortcuts
        : null;
    next.settings.keyboardShortcuts = rawKs
      ? normalizeKeyboardShortcuts(rawKs)
      : defaultKeyboardShortcuts();
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
  // Check *parsed* ui: defaultState already has sidebarAutoHide:false after merge.
  {
    const rawUi = parsed.ui && typeof parsed.ui === 'object' ? parsed.ui : {};
    if (typeof rawUi.sidebarAutoHide !== 'boolean') {
      next.ui.sidebarAutoHide = false;
    }
  }
  // Dual-button model (arrow compact/expand + pin auto-hide): one-shot migration so
  // existing fixed profiles stay fixed+expanded; auto-hide profiles stay auto-hide.
  // Stale sidebarCollapsed from when the flag was ignored outside legacy must not
  // suddenly shrink a fixed sidebar.
  if (!next.settings.migrations || typeof next.settings.migrations !== 'object') {
    next.settings.migrations = {};
  }
  if (!next.settings.migrations.sidebarDualButtons130) {
    next.settings.migrations.sidebarDualButtons130 = true;
    if (!next.settings.sidebarAlwaysActive && next.ui.sidebarAutoHide === false) {
      next.ui.sidebarCollapsed = false;
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
  // v1.3.0 one-shot: layout was global; copy current global layout to EVERY
  // existing workspace so nothing changes visually after update. Afterwards
  // each area keeps its own layout (layoutByWorkspace). Global `layout` stays
  // as the active-workspace mirror (read/migration).
  {
    if (!next.settings.migrations || typeof next.settings.migrations !== 'object') {
      next.settings.migrations = {};
    }
    if (!next.layoutByWorkspace || typeof next.layoutByWorkspace !== 'object') {
      next.layoutByWorkspace = {};
    }
    const globalLayout = normalizeLayout(next.layout);
    if (!next.settings.migrations.layoutPerWorkspace130) {
      next.settings.migrations.layoutPerWorkspace130 = true;
      for (const ws of next.workspaces) {
        if (ws && ws.id) next.layoutByWorkspace[ws.id] = globalLayout;
      }
    } else {
      for (const ws of next.workspaces) {
        if (!ws || !ws.id) continue;
        if (next.layoutByWorkspace[ws.id] == null) {
          next.layoutByWorkspace[ws.id] = globalLayout;
        } else {
          next.layoutByWorkspace[ws.id] = normalizeLayout(next.layoutByWorkspace[ws.id]);
        }
      }
    }
    const activeId = next.activeWorkspaceId;
    next.layout = normalizeLayout(
      activeId && next.layoutByWorkspace[activeId] != null
        ? next.layoutByWorkspace[activeId]
        : globalLayout
    );
    if (activeId) next.layoutByWorkspace[activeId] = next.layout;
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
  if (partial && partial.layoutByWorkspace) {
    state.layoutByWorkspace = partial.layoutByWorkspace;
  }
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'layout')) {
    const normalized = normalizeLayout(partial.layout);
    state.layout = normalized;
    if (!state.layoutByWorkspace || typeof state.layoutByWorkspace !== 'object') {
      state.layoutByWorkspace = {};
    }
    if (state.activeWorkspaceId) {
      state.layoutByWorkspace[state.activeWorkspaceId] = normalized;
    }
  }
  scheduleSave();
  return state;
}

function updateState(mutator) {
  mutator(state);
  scheduleSave();
  return state;
}

/**
 * Keep active `layout` and layoutByWorkspace[active] in sync before persist.
 * Prefer a valid string on `layout` (writers often set only the mirror via
 * updateState); otherwise fall back to the per-workspace map / Auto.
 * @param {ReturnType<typeof defaultState>} s
 */
function reconcileLayoutBeforeSave(s) {
  if (!s || typeof s !== 'object') return;
  if (!s.layoutByWorkspace || typeof s.layoutByWorkspace !== 'object') {
    s.layoutByWorkspace = {};
  }
  const wsId = s.activeWorkspaceId;
  const fromMirror =
    typeof s.layout === 'string' && VALID_LAYOUT_SET.has(s.layout) ? s.layout : null;
  const fromMap =
    wsId && s.layoutByWorkspace[wsId] != null
      ? normalizeLayout(s.layoutByWorkspace[wsId])
      : null;
  const chosen = fromMirror || fromMap || 'auto';
  s.layout = chosen;
  if (wsId) s.layoutByWorkspace[wsId] = chosen;
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
    reconcileLayoutBeforeSave(state);
    writeJsonDurable(file, state);
  } catch (err) {
    console.error('Falha ao salvar estado:', err);
  }
}

/** @type {Promise<void> | null} */
let saveInFlight = null;
/** @type {boolean} */
let saveQueuedAgain = false;

function saveNowAsync() {
  const file = getStatePath();
  try {
    reconcileLayoutBeforeSave(state);
  } catch {
    /* ignore */
  }
  // structuredClone keeps a frozen snapshot without blocking on JSON.stringify yet.
  let snapshot;
  try {
    snapshot = typeof structuredClone === 'function' ? structuredClone(state) : JSON.parse(JSON.stringify(state));
  } catch {
    snapshot = state;
  }
  const run = async () => {
    try {
      await writeJsonDurableAsync(file, snapshot);
    } catch (err) {
      console.error('Falha ao salvar estado:', err);
    } finally {
      saveInFlight = null;
      if (saveQueuedAgain) {
        saveQueuedAgain = false;
        saveNowAsync();
      }
    }
  };
  if (saveInFlight) {
    saveQueuedAgain = true;
    return;
  }
  saveInFlight = run();
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // Drop async queue — sync write on quit / selftest barriers.
  saveQueuedAgain = false;
  saveInFlight = null;
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
  normalizeLayout,
  VALID_LAYOUTS,
  STATE_FILE,
};
