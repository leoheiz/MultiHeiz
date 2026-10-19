'use strict';

/**
 * Keep the main app window on a visible display.
 */

/**
 * @param {{ x?: number, y?: number, width?: number, height?: number }} bounds
 * @param {Electron.Display[]} displays
 * @returns {{ x: number, y: number, width: number, height: number, adjusted: boolean }}
 */
function clampBoundsToDisplays(bounds, displays) {
  const width = Math.max(400, Math.round(Number(bounds && bounds.width) || 1280));
  const height = Math.max(300, Math.round(Number(bounds && bounds.height) || 800));
  let x = typeof (bounds && bounds.x) === 'number' ? Math.round(bounds.x) : undefined;
  let y = typeof (bounds && bounds.y) === 'number' ? Math.round(bounds.y) : undefined;
  const list = Array.isArray(displays) && displays.length ? displays : [];

  const primary = list[0];
  const fallback = primary
    ? {
        x: Math.round(primary.workArea.x + 40),
        y: Math.round(primary.workArea.y + 40),
        width: Math.min(width, primary.workArea.width),
        height: Math.min(height, primary.workArea.height),
      }
    : { x: 40, y: 40, width, height };

  if (typeof x !== 'number' || typeof y !== 'number') {
    return { ...fallback, width, height: Math.min(height, fallback.height), adjusted: true };
  }

  const intersects = (b, d) => {
    const a = d.bounds || d.workArea;
    return (
      b.x + b.width > a.x &&
      b.x < a.x + a.width &&
      b.y + b.height > a.y &&
      b.y < a.y + a.height
    );
  };

  const rect = { x, y, width, height };
  if (list.some((d) => intersects(rect, d))) {
    return { x, y, width, height, adjusted: false };
  }

  return {
    x: fallback.x,
    y: fallback.y,
    width: Math.min(width, fallback.width),
    height: Math.min(height, fallback.height),
    adjusted: true,
  };
}

/**
 * @param {Electron.BrowserWindow | null} win
 * @param {() => Electron.Display[]} getDisplays
 */
function ensureWindowOnDisplay(win, getDisplays) {
  if (!win || win.isDestroyed()) return { adjusted: false };
  try {
    if (win.isMaximized() || win.isFullScreen()) return { adjusted: false };
  } catch {
    /* ignore */
  }
  const displays = typeof getDisplays === 'function' ? getDisplays() : [];
  const b = win.getBounds();
  const next = clampBoundsToDisplays(b, displays);
  if (next.adjusted) {
    try {
      win.setBounds({
        x: next.x,
        y: next.y,
        width: next.width,
        height: next.height,
      });
    } catch {
      /* ignore */
    }
  }
  return next;
}

module.exports = {
  clampBoundsToDisplays,
  ensureWindowOnDisplay,
};
