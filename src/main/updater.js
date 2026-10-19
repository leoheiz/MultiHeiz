'use strict';

/**
 * Auto-update via electron-updater (GitHub provider).
 * NSIS + AppImage: full download/install. Portable/.deb: check-only + open Releases.
 */

const { app, ipcMain, shell } = require('electron');
const { RELEASES_URL } = require('./config');

const GITHUB_OWNER = 'leoheiz';
const GITHUB_REPO = 'MultiHeiz';
const AUTO_CHECK_DELAY_MS = 4000;

/** @type {{ status: string, message: string, version: string|null, percent: number|null, canInstall: boolean, manualDownload: boolean }} */
let lastStatus = {
  status: 'idle',
  message: '',
  version: null,
  percent: null,
  canInstall: false,
  manualDownload: false,
};

/** @type {((payload: object) => void) | null} */
let emitFn = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let autoCheckTimer = null;

/** @type {boolean} */
let handlersBound = false;

/**
 * Portable Windows exe or Linux .deb cannot self-update via electron-updater.
 * AppImage sets process.env.APPIMAGE; NSIS is the default win installed case.
 */
function detectUpdateChannel() {
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) {
    return 'portable';
  }
  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) return 'appimage';
    // Packaged without APPIMAGE ⇒ .deb (or similar); cannot self-update
    if (app.isPackaged) return 'deb';
    return 'unknown';
  }
  if (process.platform === 'win32' && app.isPackaged) {
    return 'nsis';
  }
  return 'unknown';
}

function isManualOnlyChannel(channel) {
  return channel === 'portable' || channel === 'deb';
}

function setStatus(partial) {
  lastStatus = { ...lastStatus, ...partial };
  if (typeof emitFn === 'function') {
    emitFn({ type: 'updates:status', ...lastStatus });
  }
  return lastStatus;
}

function getStatus() {
  return { ...lastStatus };
}

function getAutoCheckEnabled(getState) {
  try {
    const st = typeof getState === 'function' ? getState() : null;
    const v = st && st.settings && st.settings.autoCheckUpdates;
    if (v === false) return false;
    return true; // default ON
  } catch {
    return true;
  }
}

function setAutoCheckEnabled(enabled, updateState) {
  if (typeof updateState !== 'function') return false;
  updateState((s) => {
    if (!s.settings || typeof s.settings !== 'object') s.settings = {};
    s.settings.autoCheckUpdates = !!enabled;
  });
  return true;
}

/**
 * Compare simple semver a vs b. Returns negative if a < b.
 */
function compareSemver(a, b) {
  const pa = String(a || '0.0.0')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b || '0.0.0')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  const aa = pa ? [Number(pa[1]), Number(pa[2]), Number(pa[3])] : [0, 0, 0];
  const bb = pb ? [Number(pb[1]), Number(pb[2]), Number(pb[3])] : [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return 0;
}

/**
 * Public GitHub releases API check (no token). Used for portable/deb and as fallback.
 * @returns {Promise<{ ok: boolean, version?: string, error?: string, upToDate?: boolean }>}
 */
async function checkViaGithubApi() {
  const current = app.getVersion();
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `MultiHeiz/${current}`,
      },
    });
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error:
          res.status === 404
            ? 'Repositório privado ou sem releases públicas'
            : 'Não foi possível acessar as releases',
      };
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const tag = String((data && data.tag_name) || '').replace(/^v/i, '');
    if (!tag) return { ok: false, error: 'Release sem versão' };
    if (compareSemver(current, tag) >= 0) {
      return { ok: true, upToDate: true, version: tag };
    }
    return { ok: true, upToDate: false, version: tag };
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || 'Falha de rede',
    };
  }
}

function getAutoUpdater() {
  // Lazy require so missing dep / unpackaged never crashes module load
  // eslint-disable-next-line global-require
  return require('electron-updater').autoUpdater;
}

/**
 * @param {{
 *   getState: () => object,
 *   updateState: (fn: (s: any) => void) => void,
 *   emitToRenderer: (payload: object) => void,
 *   silent?: boolean,
 * }} opts
 */
async function checkForUpdates(opts) {
  const { getState, emitToRenderer, silent } = opts || {};
  emitFn = typeof emitToRenderer === 'function' ? emitToRenderer : emitFn;

  if (!app.isPackaged) {
    return setStatus({
      status: 'dev',
      message: 'Atualizações só funcionam na versão instalada',
      version: null,
      percent: null,
      canInstall: false,
      manualDownload: false,
    });
  }

  const channel = detectUpdateChannel();
  setStatus({
    status: 'checking',
    message: 'Verificando…',
    version: null,
    percent: null,
    canInstall: false,
    manualDownload: false,
  });

  if (isManualOnlyChannel(channel)) {
    const r = await checkViaGithubApi();
    if (!r.ok) {
      const msg = r.error || 'Erro ao verificar';
      if (silent) {
        return setStatus({
          status: 'idle',
          message: '',
          version: null,
          percent: null,
          canInstall: false,
          manualDownload: false,
        });
      }
      return setStatus({
        status: 'error',
        message: msg,
        version: null,
        percent: null,
        canInstall: false,
        manualDownload: false,
      });
    }
    if (r.upToDate) {
      return setStatus({
        status: 'up-to-date',
        message: 'Você está atualizado',
        version: r.version || app.getVersion(),
        percent: null,
        canInstall: false,
        manualDownload: false,
      });
    }
    return setStatus({
      status: 'available-manual',
      message: `Nova versão ${r.version} disponível — baixe a nova versão`,
      version: r.version,
      percent: null,
      canInstall: false,
      manualDownload: true,
    });
  }

  try {
    const autoUpdater = getAutoUpdater();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    if (!handlersBound) {
      bindAutoUpdaterEvents(autoUpdater);
      handlersBound = true;
    }
    const result = await autoUpdater.checkForUpdates();
    const info = result && result.updateInfo;
    const remote = info && info.version ? String(info.version) : null;
    if (remote && compareSemver(app.getVersion(), remote) >= 0) {
      return setStatus({
        status: 'up-to-date',
        message: 'Você está atualizado',
        version: remote,
        percent: null,
        canInstall: false,
        manualDownload: false,
      });
    }
    if (remote) {
      return setStatus({
        status: 'available',
        message: `Nova versão ${remote} disponível`,
        version: remote,
        percent: null,
        canInstall: false,
        manualDownload: false,
      });
    }
    return getStatus();
  } catch (err) {
    const msg = shortError(err);
    if (silent) {
      return setStatus({
        status: 'idle',
        message: '',
        version: null,
        percent: null,
        canInstall: false,
        manualDownload: false,
      });
    }
    return setStatus({
      status: 'error',
      message: msg,
      version: null,
      percent: null,
      canInstall: false,
      manualDownload: false,
    });
  }
}

function shortError(err) {
  const raw = (err && err.message) || String(err || 'Erro');
  if (/404|not found/i.test(raw)) return 'Nenhuma release encontrada';
  if (/ENOTFOUND|ECONNREFUSED|network|offline|getaddrinfo/i.test(raw)) {
    return 'Sem conexão';
  }
  if (/401|403|private|Bad credentials/i.test(raw)) {
    return 'Repositório privado ou sem acesso';
  }
  return raw.length > 120 ? raw.slice(0, 117) + '…' : raw;
}

function bindAutoUpdaterEvents(autoUpdater) {
  autoUpdater.on('checking-for-update', () => {
    setStatus({
      status: 'checking',
      message: 'Verificando…',
      percent: null,
      canInstall: false,
      manualDownload: false,
    });
  });
  autoUpdater.on('update-available', (info) => {
    const v = info && info.version ? String(info.version) : null;
    setStatus({
      status: 'available',
      message: v ? `Nova versão ${v} disponível` : 'Nova versão disponível',
      version: v,
      percent: null,
      canInstall: false,
      manualDownload: false,
    });
  });
  autoUpdater.on('update-not-available', () => {
    setStatus({
      status: 'up-to-date',
      message: 'Você está atualizado',
      version: app.getVersion(),
      percent: null,
      canInstall: false,
      manualDownload: false,
    });
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = p && typeof p.percent === 'number' ? Math.round(p.percent) : null;
    setStatus({
      status: 'downloading',
      message: percent != null ? `Baixando ${percent}%` : 'Baixando…',
      percent,
      canInstall: false,
      manualDownload: false,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    const v = info && info.version ? String(info.version) : lastStatus.version;
    setStatus({
      status: 'ready',
      message: v ? `Versão ${v} pronta — reinicie para atualizar` : 'Atualização pronta — reinicie para atualizar',
      version: v,
      percent: 100,
      canInstall: true,
      manualDownload: false,
    });
  });
  autoUpdater.on('error', (err) => {
    // Silent-ish: keep short message; auto-check callers already use silent path on throw
    setStatus({
      status: 'error',
      message: shortError(err),
      percent: null,
      canInstall: false,
      manualDownload: false,
    });
  });
}

function quitAndInstall() {
  if (!app.isPackaged) {
    return { ok: false, error: 'Somente na versão instalada' };
  }
  try {
    const autoUpdater = getAutoUpdater();
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: shortError(err) };
  }
}

function openReleasesPage() {
  shell.openExternal(RELEASES_URL);
  return { ok: true, url: RELEASES_URL };
}

/**
 * Wire IPC + optional auto-check after startup.
 * @param {{
 *   getState: () => object,
 *   updateState: (fn: (s: any) => void) => void,
 *   emitToRenderer: (payload: object) => void,
 *   skipAutoCheck?: boolean,
 * }} ctx
 */
function initUpdater(ctx) {
  const { getState, updateState, emitToRenderer, skipAutoCheck } = ctx || {};
  emitFn = typeof emitToRenderer === 'function' ? emitToRenderer : null;

  ipcMain.removeHandler('updates:check');
  ipcMain.removeHandler('updates:status');
  ipcMain.removeHandler('updates:install');
  ipcMain.removeHandler('updates:open-releases');
  ipcMain.removeHandler('updates:get-auto-check');
  ipcMain.removeHandler('updates:set-auto-check');

  ipcMain.handle('updates:check', async () => {
    const st = await checkForUpdates({
      getState,
      updateState,
      emitToRenderer,
      silent: false,
    });
    return { ok: true, ...st };
  });
  ipcMain.handle('updates:status', () => ({ ok: true, ...getStatus() }));
  ipcMain.handle('updates:install', () => quitAndInstall());
  ipcMain.handle('updates:open-releases', () => openReleasesPage());
  ipcMain.handle('updates:get-auto-check', () => ({
    ok: true,
    enabled: getAutoCheckEnabled(getState),
  }));
  ipcMain.handle('updates:set-auto-check', (_e, enabled) => {
    setAutoCheckEnabled(!!enabled, updateState);
    let state = null;
    try {
      state = typeof getState === 'function' ? getState() : null;
    } catch {
      /* ignore */
    }
    return { ok: true, enabled: !!enabled, state };
  });

  if (!skipAutoCheck && getAutoCheckEnabled(getState)) {
    if (autoCheckTimer) clearTimeout(autoCheckTimer);
    autoCheckTimer = setTimeout(() => {
      checkForUpdates({
        getState,
        updateState,
        emitToRenderer,
        silent: true,
      }).catch(() => {
        /* never popup on auto-check failure */
      });
    }, AUTO_CHECK_DELAY_MS);
  }

  return {
    checkForUpdates,
    getStatus,
    detectUpdateChannel,
    isManualOnlyChannel,
    getAutoCheckEnabled,
    GITHUB_OWNER,
    GITHUB_REPO,
  };
}

/** Test helpers (no electron-updater side effects). */
function resetStatusForTest() {
  lastStatus = {
    status: 'idle',
    message: '',
    version: null,
    percent: null,
    canInstall: false,
    manualDownload: false,
  };
  handlersBound = false;
  if (autoCheckTimer) {
    clearTimeout(autoCheckTimer);
    autoCheckTimer = null;
  }
}

module.exports = {
  initUpdater,
  checkForUpdates,
  getStatus,
  detectUpdateChannel,
  isManualOnlyChannel,
  quitAndInstall,
  openReleasesPage,
  getAutoCheckEnabled,
  setAutoCheckEnabled,
  compareSemver,
  checkViaGithubApi,
  resetStatusForTest,
  GITHUB_OWNER,
  GITHUB_REPO,
  RELEASES_URL,
  AUTO_CHECK_DELAY_MS,
};
