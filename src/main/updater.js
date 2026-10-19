'use strict';

/**
 * Auto-update via electron-updater (NSIS + AppImage) and portable self-update.
 * .deb: check-only + open Releases.
 */

const { app, ipcMain, shell } = require('electron');
const { RELEASES_URL } = require('./config');
const portable = require('./portable-update');
const logger = require('./logger');

const GITHUB_OWNER = 'leoheiz';
const GITHUB_REPO = 'MultiHeiz';
const AUTO_CHECK_DELAY_MS = 4000;

const CHANNEL_LABELS = {
  nsis: 'Instalado',
  portable: 'Portátil',
  appimage: 'Linux AppImage',
  deb: '.deb',
  unknown: 'Desenvolvimento',
  dev: 'Desenvolvimento',
};

/** Label for Linux unpackaged / extracted / non-dpkg installs (never ".deb"). */
const LINUX_UNKNOWN_LABEL = 'Linux (não instalado / dev)';

/** @type {{
 *   status: string,
 *   message: string,
 *   version: string|null,
 *   percent: number|null,
 *   bytesPerSecond: number|null,
 *   canInstall: boolean,
 *   canDownload: boolean,
 *   manualDownload: boolean,
 *   channel: string,
 *   channelLabel: string,
 *   lastCheckAt: number|null,
 *   currentVersion: string,
 *   notWritable: boolean,
 *   downloadPath: string|null,
 * }} */
let lastStatus = {
  status: 'idle',
  message: '',
  version: null,
  percent: null,
  bytesPerSecond: null,
  canInstall: false,
  canDownload: false,
  manualDownload: false,
  channel: 'unknown',
  channelLabel: CHANNEL_LABELS.unknown,
  lastCheckAt: null,
  currentVersion: '',
  notWritable: false,
  downloadPath: null,
};

/** @type {((payload: object) => void) | null} */
let emitFn = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let autoCheckTimer = null;

/** @type {boolean} */
let handlersBound = false;

/**
 * True when path looks like a dpkg-installed Electron app (/opt/… or /usr/lib/…).
 * @param {string} p
 */
function isLinuxDebInstallPath(p) {
  const norm = String(p || '').replace(/\\/g, '/');
  if (!norm) return false;
  return (
    norm.startsWith('/opt/') ||
    norm === '/opt' ||
    norm.startsWith('/usr/lib/') ||
    norm === '/usr/lib' ||
    norm.includes('/usr/lib/')
  );
}

/**
 * Portable Windows exe, Linux AppImage / .deb / unknown.
 * AppImage sets process.env.APPIMAGE; .deb only when packaged under /opt or /usr/lib.
 * Portable env vars are Windows-only (PowerShell helper must never run on Linux).
 *
 * @param {{
 *   platform?: string,
 *   isPackaged?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   execPath?: string,
 *   appPath?: string,
 * }} [opts]  Optional overrides for selftests.
 */
function detectUpdateChannel(opts) {
  const o = opts || {};
  const platform = o.platform != null ? o.platform : process.platform;
  const env = o.env || process.env;
  const isPackaged = o.isPackaged != null ? o.isPackaged : !!(app && app.isPackaged);
  const execPath = o.execPath != null ? o.execPath : process.execPath || '';
  let appPath = o.appPath;
  if (appPath == null) {
    try {
      appPath = app && typeof app.getAppPath === 'function' ? app.getAppPath() : '';
    } catch {
      appPath = '';
    }
  }

  // Portable self-update is Windows-only (PowerShell).
  if (platform === 'win32') {
    if (env.MULTIHEIZ_FAKE_PORTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_FILE) {
      return 'portable';
    }
  }

  if (platform === 'linux') {
    if (env.APPIMAGE) return 'appimage';
    if (isPackaged) {
      if (isLinuxDebInstallPath(execPath) || isLinuxDebInstallPath(appPath)) {
        return 'deb';
      }
      // Packaged but extracted AppImage / loose dir — not a dpkg install.
      return 'unknown';
    }
    return 'unknown';
  }

  if (platform === 'win32' && isPackaged) {
    return 'nsis';
  }
  return 'unknown';
}

/** Channels that only open the Releases page (no in-app download). */
function isManualOnlyChannel(channel) {
  return channel === 'deb' || channel === 'unknown';
}

/**
 * @param {string} channel
 * @param {{ platform?: string }} [opts]
 */
function channelLabel(channel, opts) {
  const platform = (opts && opts.platform) || process.platform;
  if (channel === 'unknown' && platform === 'linux') {
    return LINUX_UNKNOWN_LABEL;
  }
  return CHANNEL_LABELS[channel] || CHANNEL_LABELS.unknown;
}

/**
 * Visibility / enabled state for Settings → Atualizações action buttons.
 * Baixar: only when update available and not downloading.
 * Cancelar: only while downloading.
 * Reiniciar: only when downloaded (ready).
 * Manual-only channels: all three hidden + disabled.
 *
 * @param {object} st  updater status payload
 * @returns {{
 *   download: { visible: boolean, enabled: boolean },
 *   cancel: { visible: boolean, enabled: boolean },
 *   install: { visible: boolean, enabled: boolean },
 * }}
 */
function computeUpdateActionButtons(st) {
  const s = st || {};
  const channel = s.channel || 'unknown';
  const manual =
    !!s.manualDownload ||
    s.status === 'available-manual' ||
    isManualOnlyChannel(channel);

  const downloading = s.status === 'downloading';
  const ready = s.status === 'ready' || !!s.canInstall;
  const available =
    !ready &&
    !downloading &&
    (s.status === 'available' || !!s.canDownload);

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

function setStatus(partial) {
  const ch = partial.channel != null ? partial.channel : lastStatus.channel || detectUpdateChannel();
  let message = partial.message != null ? partial.message : lastStatus.message;
  if (partial.status === 'error' && message && !/^Erro:/i.test(message)) {
    message = `Erro: ${message}`;
  }
  lastStatus = {
    ...lastStatus,
    ...partial,
    message,
    channel: ch,
    channelLabel: channelLabel(ch),
    currentVersion: app.getVersion(),
  };
  lastStatus.buttons = computeUpdateActionButtons(lastStatus);
  if (typeof emitFn === 'function') {
    emitFn({ type: 'updates:status', ...lastStatus });
  }
  return lastStatus;
}

function getStatus() {
  const channel = lastStatus.channel || detectUpdateChannel();
  const base = {
    ...lastStatus,
    channel,
    channelLabel: channelLabel(channel),
    currentVersion: app.getVersion(),
  };
  base.buttons = computeUpdateActionButtons(base);
  return base;
}

function getAutoCheckEnabled(getState) {
  try {
    const st = typeof getState === 'function' ? getState() : null;
    const v = st && st.settings && st.settings.autoCheckUpdates;
    if (v === false) return false;
    return true;
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

function compareSemver(a, b) {
  return portable.compareSemver(a, b);
}

function formatSpeed(bps) {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return '';
  const mb = bps / (1024 * 1024);
  return mb >= 0.1
    ? `${mb.toFixed(1).replace('.', ',')} MB/s`
    : `${Math.round(bps / 1024)} KB/s`;
}

/**
 * Public GitHub releases API check (no token). Used for deb and as fallback.
 * @returns {Promise<{ ok: boolean, version?: string, error?: string, upToDate?: boolean }>}
 */
async function checkViaGithubApi() {
  const current = app.getVersion();
  const url =
    process.env.MULTIHEIZ_UPDATE_FEED_URL ||
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  try {
    const r = await portable.httpGetBuffer(url, {
      Accept: 'application/vnd.github+json',
    });
    if (r.status === 404 || r.status === 401 || r.status === 403) {
      return {
        ok: false,
        error:
          r.status === 403
            ? 'Limite da API do GitHub (403) — tente mais tarde'
            : r.status === 404
              ? 'Repositório privado ou sem releases públicas'
              : 'Não foi possível acessar as releases',
      };
    }
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, error: `HTTP ${r.status}` };
    }
    const data = JSON.parse(r.body.toString('utf8'));
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
  // eslint-disable-next-line global-require
  return require('electron-updater').autoUpdater;
}

function forcePackagedForTest() {
  return process.env.MULTIHEIZ_FORCE_PACKAGED === '1';
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
  const { emitToRenderer, silent } = opts || {};
  emitFn = typeof emitToRenderer === 'function' ? emitToRenderer : emitFn;

  const channel = detectUpdateChannel();
  const packaged = app.isPackaged || forcePackagedForTest();

  if (!packaged && channel !== 'portable') {
    return setStatus({
      status: 'dev',
      message: 'Atualizações só funcionam na versão instalada',
      version: null,
      percent: null,
      bytesPerSecond: null,
      canInstall: false,
      canDownload: false,
      manualDownload: false,
      channel,
      lastCheckAt: Date.now(),
      notWritable: false,
      downloadPath: null,
    });
  }

  setStatus({
    status: 'checking',
    message: 'Verificando…',
    version: null,
    percent: null,
    bytesPerSecond: null,
    canInstall: false,
    canDownload: false,
    manualDownload: false,
    channel,
    notWritable: false,
    downloadPath: null,
  });
  logger.info('updates:check', { channel });

  if (channel === 'portable') {
    if (process.platform !== 'win32') {
      return setStatus({
        status: 'error',
        message: 'Atualização portátil só está disponível no Windows',
        version: null,
        percent: null,
        canInstall: false,
        canDownload: false,
        manualDownload: true,
        channel: 'unknown',
        lastCheckAt: Date.now(),
      });
    }
    const r = await portable.checkPortableUpdate({ logger });
    const checkedAt = Date.now();
    if (!r.ok) {
      const msg = r.error || 'Erro ao verificar';
      logger.warn('updates:portable check failed', { error: msg });
      if (silent) {
        return setStatus({
          status: 'idle',
          message: '',
          version: null,
          percent: null,
          canInstall: false,
          canDownload: false,
          manualDownload: false,
          channel,
          lastCheckAt: checkedAt,
        });
      }
      return setStatus({
        status: 'error',
        message: msg,
        version: r.version || null,
        percent: null,
        canInstall: false,
        canDownload: false,
        manualDownload: false,
        channel,
        lastCheckAt: checkedAt,
      });
    }
    if (r.upToDate) {
      return setStatus({
        status: 'up-to-date',
        message: 'Você está atualizado',
        version: r.version || app.getVersion(),
        percent: null,
        canInstall: false,
        canDownload: false,
        manualDownload: false,
        channel,
        lastCheckAt: checkedAt,
      });
    }
    return setStatus({
      status: 'available',
      message: `Nova versão ${r.version} disponível`,
      version: r.version,
      percent: null,
      canInstall: false,
      canDownload: true,
      manualDownload: false,
      channel,
      lastCheckAt: checkedAt,
    });
  }

  if (isManualOnlyChannel(channel)) {
    const r = await checkViaGithubApi();
    const checkedAt = Date.now();
    if (!r.ok) {
      const msg = r.error || 'Erro ao verificar';
      if (silent) {
        return setStatus({
          status: 'idle',
          message: '',
          version: null,
          percent: null,
          canInstall: false,
          canDownload: false,
          manualDownload: false,
          channel,
          lastCheckAt: checkedAt,
        });
      }
      return setStatus({
        status: 'error',
        message: msg,
        version: null,
        percent: null,
        canInstall: false,
        canDownload: false,
        manualDownload: false,
        channel,
        lastCheckAt: checkedAt,
      });
    }
    if (r.upToDate) {
      return setStatus({
        status: 'up-to-date',
        message: 'Você está atualizado',
        version: r.version || app.getVersion(),
        percent: null,
        canInstall: false,
        canDownload: false,
        manualDownload: false,
        channel,
        lastCheckAt: checkedAt,
      });
    }
    return setStatus({
      status: 'available-manual',
      message: `Nova versão ${r.version} disponível — baixe a nova versão`,
      version: r.version,
      percent: null,
      canInstall: false,
      canDownload: false,
      manualDownload: true,
      channel,
      lastCheckAt: checkedAt,
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
    const checkedAt = Date.now();
    if (remote && compareSemver(app.getVersion(), remote) >= 0) {
      return setStatus({
        status: 'up-to-date',
        message: 'Você está atualizado',
        version: remote,
        percent: null,
        canInstall: false,
        canDownload: false,
        manualDownload: false,
        channel,
        lastCheckAt: checkedAt,
      });
    }
    if (remote) {
      return setStatus({
        status: 'available',
        message: `Nova versão ${remote} disponível`,
        version: remote,
        percent: null,
        canInstall: false,
        canDownload: false,
        manualDownload: false,
        channel,
        lastCheckAt: checkedAt,
      });
    }
    return setStatus({ ...getStatus(), lastCheckAt: checkedAt, channel });
  } catch (err) {
    const msg = shortError(err);
    logger.warn('updates:check error', { error: msg });
    if (silent) {
      return setStatus({
        status: 'idle',
        message: '',
        version: null,
        percent: null,
        canInstall: false,
        canDownload: false,
        manualDownload: false,
        channel,
        lastCheckAt: Date.now(),
      });
    }
    return setStatus({
      status: 'error',
      message: msg,
      version: null,
      percent: null,
      canInstall: false,
      canDownload: false,
      manualDownload: false,
      channel,
      lastCheckAt: Date.now(),
    });
  }
}

async function downloadUpdate() {
  const channel = detectUpdateChannel();
  if (channel === 'portable') {
    if (process.platform !== 'win32') {
      return setStatus({
        status: 'error',
        message: 'Atualização portátil só está disponível no Windows',
        canDownload: false,
        canInstall: false,
        manualDownload: true,
        channel: 'unknown',
      });
    }
    let asset = portable.getPendingAsset();
    if (!asset) {
      const checked = await portable.checkPortableUpdate({ logger });
      if (!checked.ok || checked.upToDate || !checked.asset) {
        return setStatus({
          status: 'error',
          message: (checked && checked.error) || 'Nenhuma atualização para baixar',
          canDownload: false,
          canInstall: false,
          channel,
        });
      }
      asset = checked.asset;
    }
    setStatus({
      status: 'downloading',
      message: 'Baixando…',
      percent: 0,
      bytesPerSecond: null,
      canInstall: false,
      canDownload: false,
      version: asset.version,
      channel,
    });
    const r = await portable.downloadPortableAsset(asset, {
      logger,
      onProgress: (p) => {
        const speed = formatSpeed(p.bytesPerSecond);
        const pct = p.percent != null ? p.percent : null;
        setStatus({
          status: 'downloading',
          message:
            pct != null
              ? `Baixando ${pct}%${speed ? ` (${speed})` : ''}`
              : `Baixando…${speed ? ` (${speed})` : ''}`,
          percent: pct,
          bytesPerSecond: p.bytesPerSecond,
          version: asset.version,
          canInstall: false,
          canDownload: false,
          channel,
        });
      },
    });
    if (!r.ok) {
      if (r.cancelled) {
        return setStatus({
          status: 'available',
          message: `Nova versão ${asset.version} disponível`,
          version: asset.version,
          percent: null,
          bytesPerSecond: null,
          canInstall: false,
          canDownload: true,
          channel,
        });
      }
      logger.error('updates:portable download failed', { error: r.error });
      return setStatus({
        status: 'error',
        message: r.error || 'Erro no download',
        version: asset.version,
        percent: null,
        bytesPerSecond: null,
        canInstall: false,
        canDownload: true,
        channel,
      });
    }
    return setStatus({
      status: 'ready',
      message: `Pronto — Reiniciar para atualizar`,
      version: asset.version,
      percent: 100,
      bytesPerSecond: null,
      canInstall: true,
      canDownload: false,
      downloadPath: r.path,
      channel,
    });
  }

  // NSIS / AppImage: re-check triggers autoDownload
  return checkForUpdates({ silent: false, emitToRenderer: emitFn });
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
      canDownload: false,
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
      canDownload: false,
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
      canDownload: false,
      manualDownload: false,
    });
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = p && typeof p.percent === 'number' ? Math.round(p.percent) : null;
    const bps = p && typeof p.bytesPerSecond === 'number' ? p.bytesPerSecond : null;
    const speed = formatSpeed(bps);
    setStatus({
      status: 'downloading',
      message:
        percent != null
          ? `Baixando ${percent}%${speed ? ` (${speed})` : ''}`
          : `Baixando…${speed ? ` (${speed})` : ''}`,
      percent,
      bytesPerSecond: bps,
      canInstall: false,
      canDownload: false,
      manualDownload: false,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    const v = info && info.version ? String(info.version) : lastStatus.version;
    setStatus({
      status: 'ready',
      message: v
        ? `Pronto — Reiniciar para atualizar`
        : 'Pronto — Reiniciar para atualizar',
      version: v,
      percent: 100,
      canInstall: true,
      canDownload: false,
      manualDownload: false,
    });
  });
  autoUpdater.on('error', (err) => {
    setStatus({
      status: 'error',
      message: shortError(err),
      percent: null,
      canInstall: false,
      canDownload: false,
      manualDownload: false,
    });
  });
}

function quitAndInstall() {
  const channel = detectUpdateChannel();
  if (channel === 'portable') {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Atualização portátil só está disponível no Windows' };
    }
    const r = portable.applyPortableAndRelaunch({ logger });
    if (!r.ok) {
      logger.error('updates:portable apply failed', { error: r.error });
      setStatus({
        status: 'error',
        message: r.error || 'Falha ao aplicar atualização',
        notWritable: !!r.notWritable,
        downloadPath: r.downloadPath || portable.getDownloadedPath(),
        canInstall: !r.notWritable,
        channel,
      });
      return r;
    }
    return { ok: true };
  }
  if (!app.isPackaged && !forcePackagedForTest()) {
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

  const channel = detectUpdateChannel();
  setStatus({
    channel,
    currentVersion: app.getVersion(),
    status: lastStatus.status || 'idle',
  });

  if (channel === 'portable' && process.platform === 'win32') {
    portable.cleanupPortableLeftovers(logger);
  }

  ipcMain.removeHandler('updates:check');
  ipcMain.removeHandler('updates:status');
  ipcMain.removeHandler('updates:install');
  ipcMain.removeHandler('updates:download');
  ipcMain.removeHandler('updates:cancel');
  ipcMain.removeHandler('updates:open-releases');
  ipcMain.removeHandler('updates:open-download');
  ipcMain.removeHandler('updates:get-auto-check');
  ipcMain.removeHandler('updates:set-auto-check');
  ipcMain.removeHandler('updates:get-channel');

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
  ipcMain.handle('updates:download', async () => {
    const st = await downloadUpdate();
    return { ok: st.status !== 'error', ...st };
  });
  ipcMain.handle('updates:cancel', () => {
    const ch = detectUpdateChannel();
    if (ch === 'portable' && process.platform === 'win32') {
      portable.cancelDownload();
      if (lastStatus.version) {
        setStatus({
          status: 'available',
          message: `Nova versão ${lastStatus.version} disponível`,
          canDownload: true,
          canInstall: false,
          percent: null,
          bytesPerSecond: null,
          channel: ch,
        });
      }
    } else {
      try {
        const autoUpdater = getAutoUpdater();
        if (autoUpdater && typeof autoUpdater.cancel === 'function') {
          autoUpdater.cancel();
        }
      } catch {
        /* ignore */
      }
    }
    return { ok: true, ...getStatus() };
  });
  ipcMain.handle('updates:install', () => quitAndInstall());
  ipcMain.handle('updates:open-releases', () => openReleasesPage());
  ipcMain.handle('updates:open-download', () => {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Pasta de download portátil só no Windows' };
    }
    return portable.openDownloadedFolder();
  });
  ipcMain.handle('updates:get-channel', () => {
    const ch = detectUpdateChannel();
    return {
      ok: true,
      channel: ch,
      channelLabel: channelLabel(ch),
      currentVersion: app.getVersion(),
    };
  });
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
    downloadUpdate,
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
    bytesPerSecond: null,
    canInstall: false,
    canDownload: false,
    manualDownload: false,
    channel: 'unknown',
    channelLabel: CHANNEL_LABELS.unknown,
    lastCheckAt: null,
    currentVersion: '',
    notWritable: false,
    downloadPath: null,
  };
  handlersBound = false;
  portable.resetPortableStateForTest();
  if (autoCheckTimer) {
    clearTimeout(autoCheckTimer);
    autoCheckTimer = null;
  }
}

module.exports = {
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  getStatus,
  detectUpdateChannel,
  isManualOnlyChannel,
  isLinuxDebInstallPath,
  computeUpdateActionButtons,
  quitAndInstall,
  openReleasesPage,
  getAutoCheckEnabled,
  setAutoCheckEnabled,
  compareSemver,
  checkViaGithubApi,
  resetStatusForTest,
  channelLabel,
  CHANNEL_LABELS,
  LINUX_UNKNOWN_LABEL,
  GITHUB_OWNER,
  GITHUB_REPO,
  RELEASES_URL,
  AUTO_CHECK_DELAY_MS,
  portable,
};
