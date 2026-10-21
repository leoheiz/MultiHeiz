'use strict';

/**
 * "Iniciar com o sistema" — Windows Login Items / Linux XDG autostart.
 * Selftests use a distinct Run name / desktop file so Leo's real entries are never touched.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const RUN_NAME = 'MultiHeiz';
const RUN_NAME_SELFTEST = 'MultiHeizSelftest';
const DESKTOP_FILE = 'multiheiz.desktop';
const DESKTOP_FILE_SELFTEST = 'multiheiz-selftest.desktop';

function isSelftestMode() {
  return !!(process.env.MULTIHEIZ_SELFTEST && String(process.env.MULTIHEIZ_SELFTEST).length);
}

function runName() {
  return isSelftestMode() ? RUN_NAME_SELFTEST : RUN_NAME;
}

function desktopFileName() {
  return isSelftestMode() ? DESKTOP_FILE_SELFTEST : DESKTOP_FILE;
}

function isPortableLike() {
  return !!(
    process.env.PORTABLE_EXECUTABLE_FILE ||
    process.env.PORTABLE_EXECUTABLE_DIR ||
    process.env.MULTIHEIZ_FAKE_PORTABLE_FILE
  );
}

/**
 * Resolve executable path + args for autostart.
 * @returns {{ ok: boolean, path?: string, args?: string[], reason?: string }}
 */
function resolveLaunch() {
  if (process.platform === 'win32') {
    const portableFile =
      process.env.PORTABLE_EXECUTABLE_FILE || process.env.MULTIHEIZ_FAKE_PORTABLE_FILE || '';
    if (isPortableLike()) {
      if (!portableFile || !fs.existsSync(portableFile)) {
        return {
          ok: false,
          reason:
            'Portátil: caminho real indisponível (PORTABLE_EXECUTABLE_FILE). Autostart desativado.',
        };
      }
      return { ok: true, path: portableFile, args: [] };
    }
    if (app.isPackaged) {
      return { ok: true, path: process.execPath, args: [] };
    }
    // Dev / selftest: electron.exe + app root
    let appPath = '';
    try {
      appPath = app.getAppPath();
    } catch {
      appPath = process.cwd();
    }
    return { ok: true, path: process.execPath, args: [appPath] };
  }

  if (process.platform === 'linux') {
    if (process.env.APPIMAGE) {
      return { ok: true, path: process.env.APPIMAGE, args: [] };
    }
    const debPath = '/opt/MultiHeiz/multiheiz';
    if (app.isPackaged) {
      return { ok: true, path: process.execPath, args: [] };
    }
    // Unpackaged: still write a desktop entry pointing at the usual install path
    // (selftests override with a fake Exec under temp via setAutostart).
    return { ok: true, path: debPath, args: [] };
  }

  return { ok: false, reason: 'Autostart não suportado neste sistema.' };
}

function xdgConfigHome() {
  if (process.env.XDG_CONFIG_HOME && String(process.env.XDG_CONFIG_HOME).trim()) {
    return String(process.env.XDG_CONFIG_HOME).trim();
  }
  return path.join(app.getPath('home') || require('node:os').homedir(), '.config');
}

function linuxAutostartPath() {
  return path.join(xdgConfigHome(), 'autostart', desktopFileName());
}

function buildLinuxDesktop({ execPath, openAsHidden }) {
  const execLine = openAsHidden ? `"${execPath}" --hidden` : `"${execPath}"`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${isSelftestMode() ? 'MultiHeiz Selftest' : 'MultiHeiz'}`,
    'Comment=Navegador multi-janela com painéis e sessões independentes',
    `Exec=${execLine}`,
    'Icon=multiheiz',
    'StartupWMClass=multiheiz',
    'Terminal=false',
    'Categories=Network;WebBrowser;',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/**
 * @returns {{
 *   supported: boolean,
 *   enabled: boolean,
 *   openAsHidden: boolean,
 *   disabledReason: string|null,
 *   path: string|null,
 *   name: string,
 *   platform: string
 * }}
 */
function getStatus() {
  const launch = resolveLaunch();
  const platform = process.platform;
  if (!launch.ok) {
    return {
      supported: false,
      enabled: false,
      openAsHidden: false,
      disabledReason: launch.reason || 'Indisponível',
      path: null,
      name: runName(),
      platform,
    };
  }

  if (platform === 'win32') {
    let enabled = false;
    let openAsHidden = false;
    try {
      const s = app.getLoginItemSettings({
        path: launch.path,
        args: launch.args || [],
        name: runName(),
      });
      enabled = !!(s && s.openAtLogin);
      openAsHidden = !!(s && s.openAsHidden);
    } catch {
      /* ignore */
    }
    // Also treat our --hidden arg as openAsHidden
    try {
      const s2 = app.getLoginItemSettings({ name: runName() });
      if (s2 && Array.isArray(s2.launchItems)) {
        const item = s2.launchItems.find((it) => it && it.name === runName());
        if (item && Array.isArray(item.args) && item.args.includes('--hidden')) {
          openAsHidden = true;
        }
      }
    } catch {
      /* ignore */
    }
    return {
      supported: true,
      enabled,
      openAsHidden,
      disabledReason: null,
      path: launch.path,
      name: runName(),
      platform,
    };
  }

  if (platform === 'linux') {
    const p = linuxAutostartPath();
    let enabled = false;
    let openAsHidden = false;
    try {
      if (fs.existsSync(p)) {
        const body = fs.readFileSync(p, 'utf8');
        enabled = true;
        if (/--hidden/.test(body)) openAsHidden = true;
        if (/X-GNOME-Autostart-enabled=false/i.test(body)) enabled = false;
      }
    } catch {
      /* ignore */
    }
    return {
      supported: true,
      enabled,
      openAsHidden,
      disabledReason: null,
      path: launch.path,
      name: desktopFileName(),
      platform,
    };
  }

  return {
    supported: false,
    enabled: false,
    openAsHidden: false,
    disabledReason: 'Autostart não suportado neste sistema.',
    path: null,
    name: runName(),
    platform,
  };
}

/**
 * @param {{ openAtLogin?: boolean, openAsHidden?: boolean }} opts
 * @returns {{ ok: boolean, error?: string, status: ReturnType<typeof getStatus> }}
 */
function setAutostart(opts) {
  const openAtLogin = !!opts.openAtLogin;
  const openAsHidden = !!opts.openAsHidden && openAtLogin;
  const launch = resolveLaunch();

  if (!launch.ok) {
    return { ok: false, error: launch.reason || 'Indisponível', status: getStatus() };
  }

  if (process.platform === 'win32') {
    const args = [...(launch.args || [])];
    if (openAsHidden) args.push('--hidden');
    try {
      app.setLoginItemSettings({
        openAtLogin,
        path: launch.path,
        args,
        name: runName(),
        // Windows: openAsHidden is best-effort; we also pass --hidden in args.
        openAsHidden,
      });
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : String(err),
        status: getStatus(),
      };
    }
    return { ok: true, status: getStatus() };
  }

  if (process.platform === 'linux') {
    const file = linuxAutostartPath();
    try {
      if (!openAtLogin) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return { ok: true, status: getStatus() };
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Selftest may inject MULTIHEIZ_AUTOSTART_EXEC to avoid writing a real /opt path.
      const execPath = process.env.MULTIHEIZ_AUTOSTART_EXEC || launch.path;
      fs.writeFileSync(file, buildLinuxDesktop({ execPath, openAsHidden }), 'utf8');
      return { ok: true, status: getStatus() };
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : String(err),
        status: getStatus(),
      };
    }
  }

  return { ok: false, error: 'Não suportado', status: getStatus() };
}

/** Remove selftest Run / desktop entry (always safe to call). */
function cleanupSelftest() {
  if (!isSelftestMode()) return;
  try {
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: false,
        name: RUN_NAME_SELFTEST,
      });
    } else if (process.platform === 'linux') {
      const file = linuxAutostartPath();
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  } catch {
    /* ignore */
  }
}

/** Windows: read HKCU Run value for our name (selftest verification). */
function readWindowsRunValue() {
  if (process.platform !== 'win32') return null;
  try {
    const { execFileSync } = require('node:child_process');
    const name = runName();
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', name],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    // REG_SZ    <value>
    const m = String(out).match(/REG_SZ\s+(.+)\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function wantsStartHidden() {
  return process.argv.includes('--hidden');
}

module.exports = {
  RUN_NAME,
  RUN_NAME_SELFTEST,
  getStatus,
  setAutostart,
  cleanupSelftest,
  readWindowsRunValue,
  resolveLaunch,
  wantsStartHidden,
  linuxAutostartPath,
  isSelftestMode,
};
