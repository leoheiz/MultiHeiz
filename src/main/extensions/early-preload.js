'use strict';

/**
 * Frame preload: replay cached ABU MAIN-world injections before page scripts.
 * Independent of the built-in adblock cosmetic preload.
 *
 * Builds each function with new Function in the ISOLATED preload world, then
 * runs contextBridge.executeInMainWorld so page CSP/Trusted Types do not apply.
 */

const { ipcRenderer, contextBridge } = require('electron');

(function mhExtEarlyPreload() {
  try {
    const href = typeof location !== 'undefined' ? location.href : '';
    if (!href || href === 'about:blank') return;
    if (href.startsWith('chrome-extension://') || href.startsWith('devtools://')) return;

    const list = ipcRenderer.sendSync('multiheiz/ext-early', href) || [];
    if (!Array.isArray(list) || !list.length) return;

    /** @type {string[]} */
    const keys = [];
    for (const it of list) {
      if (!it || typeof it.func !== 'string') continue;
      try {
        const fn = new Function('return (' + it.func + ')')();
        const args = Array.isArray(it.args) ? it.args : [];
        contextBridge.executeInMainWorld({ func: fn, args });
        if (it.key) keys.push(String(it.key));
      } catch (err) {
        console.warn(
          '[mh-early] item failed',
          err && err.message ? err.message : err
        );
      }
    }

    if (keys.length) {
      try {
        // Marker for selftests / diagnostics (same shape as the ABU prototype).
        contextBridge.executeInMainWorld({
          func: (n) => {
            try {
              (window.__INJ = window.__INJ || []).push('early-replay:' + n);
            } catch {
              /* ignore */
            }
          },
          args: [keys.length],
        });
      } catch {
        /* ignore */
      }
      try {
        ipcRenderer.send('multiheiz/ext-early-done', { keys, href });
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.warn('[mh-early] failed', err && err.message ? err.message : err);
  }
})();
