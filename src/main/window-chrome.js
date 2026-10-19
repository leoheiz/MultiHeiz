'use strict';

/** Height of the merged title/top bar (CSS --topbar-h). */
const TOPBAR_HEIGHT = 48;

/**
 * Platform chrome policy (documented for Phase 1b):
 * - Windows: titleBarStyle 'hidden' + titleBarOverlay so native min/max/close
 *   keep Windows 11 Snap Layouts on maximize hover.
 * - Linux (and non-Windows): frame:false with custom HTML min/max/close via IPC.
 * Fullscreen focus mode (F11): hide topbar + sidebar so panels fill the content area.
 */

/**
 * @param {object|null|undefined} appearance
 * @returns {{ color: string, symbolColor: string, height: number }}
 */
function appearanceToOverlay(appearance) {
  const a = appearance && typeof appearance === 'object' ? appearance : {};
  const color = String(a.surface || '#1e2430');
  const symbolColor = String(a.text || '#e6ebea');
  return {
    color,
    symbolColor,
    height: TOPBAR_HEIGHT,
  };
}

/**
 * Options merged into BrowserWindow constructor for custom chrome.
 * @param {object|null|undefined} appearance
 * @returns {{
 *   platform: string,
 *   usesOverlay: boolean,
 *   usesFrameFalse: boolean,
 *   titleBarStyle?: string,
 *   titleBarOverlay?: object,
 *   frame?: boolean,
 *   recorded: object
 * }}
 */
function getChromeConstructorOptions(appearance) {
  const platform = process.platform;
  if (platform === 'win32') {
    const overlay = appearanceToOverlay(appearance);
    return {
      platform,
      usesOverlay: true,
      usesFrameFalse: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: overlay,
      recorded: {
        platform,
        titleBarStyle: 'hidden',
        frame: true,
        titleBarOverlay: { ...overlay },
        topbarHeight: TOPBAR_HEIGHT,
        fullscreenKeepsRow: false,
      },
    };
  }
  return {
    platform,
    usesOverlay: false,
    usesFrameFalse: true,
    frame: false,
    recorded: {
      platform,
      titleBarStyle: 'default',
      frame: false,
      titleBarOverlay: null,
      topbarHeight: TOPBAR_HEIGHT,
      fullscreenKeepsRow: false,
    },
  };
}

/**
 * Apply / refresh titleBarOverlay colors from appearance (Windows only).
 * @param {import('electron').BrowserWindow | null} win
 * @param {object|null|undefined} appearance
 * @returns {object|null} overlay applied, or null
 */
function applyTitleBarOverlay(win, appearance) {
  if (!win || win.isDestroyed()) return null;
  if (process.platform !== 'win32') return null;
  if (typeof win.setTitleBarOverlay !== 'function') return null;
  const overlay = appearanceToOverlay(appearance);
  try {
    win.setTitleBarOverlay(overlay);
    return overlay;
  } catch {
    return null;
  }
}

module.exports = {
  TOPBAR_HEIGHT,
  appearanceToOverlay,
  getChromeConstructorOptions,
  applyTitleBarOverlay,
};
