'use strict';

/**
 * Native HTMLVideoElement Picture-in-Picture (Chromium).
 * Toggle via executeJavaScript(..., true) so the call counts as a user gesture.
 */

const { Menu } = require('electron');

/** @type {object | null} */
let panelsApi = null;
/** @type {(() => import('electron').BrowserWindow | null) | null} */
let getMainWindow = null;
/** @type {((accountId: string) => void) | null} */
let openMiniPlayer = null;

/** Script: pick largest playing video (else largest visible); toggle PiP. */
const TOGGLE_PIP_JS = `(() => {
  function list() {
    var out = [];
    var nodes = document.querySelectorAll('video');
    for (var i = 0; i < nodes.length; i++) {
      var v = nodes[i];
      var r = v.getBoundingClientRect();
      var area = Math.max(0, r.width) * Math.max(0, r.height);
      var playing = !v.paused && !v.ended && v.readyState >= 2;
      var visible = area > 16 && r.bottom > 0 && r.right > 0 &&
        r.top < (window.innerHeight || 800) && r.left < (window.innerWidth || 1200);
      out.push({ el: v, area: area, playing: playing, visible: visible });
    }
    return out;
  }
  function pick(items) {
    var playing = items.filter(function (x) { return x.playing; })
      .sort(function (a, b) { return b.area - a.area; });
    if (playing.length) return playing[0].el;
    var vis = items.filter(function (x) { return x.visible; })
      .sort(function (a, b) { return b.area - a.area; });
    return vis.length ? vis[0].el : null;
  }
  return (async function () {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return { ok: true, active: false };
      }
      var el = pick(list());
      if (!el) return { ok: false, reason: 'no-video' };
      if (typeof el.requestPictureInPicture !== 'function') {
        return { ok: false, reason: 'unsupported' };
      }
      await el.requestPictureInPicture();
      return { ok: true, active: true };
    } catch (err) {
      return {
        ok: false,
        reason: 'error',
        message: String(err && err.message ? err.message : err)
      };
    }
  })();
})()`;

const HAS_VIDEO_JS = `(() => {
  var nodes = document.querySelectorAll('video');
  var best = 0;
  var playing = false;
  for (var i = 0; i < nodes.length; i++) {
    var v = nodes[i];
    var r = v.getBoundingClientRect();
    var area = Math.max(0, r.width) * Math.max(0, r.height);
    if (area > best) best = area;
    if (!v.paused && !v.ended && v.readyState >= 2 && area > 16) playing = true;
  }
  return { count: nodes.length, maxArea: best, playing: playing, visible: best > 16 };
})()`;

const PIP_STATE_JS = `(() => ({
  active: !!document.pictureInPictureElement,
  tag: document.pictureInPictureElement
    ? (document.pictureInPictureElement.tagName || '')
    : null
}))()`;

/**
 * @param {{
 *   panels: object,
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   openMiniPlayer?: (accountId: string) => void,
 * }} deps
 */
function configure(deps) {
  panelsApi = deps.panels || null;
  getMainWindow = deps.getMainWindow || null;
  openMiniPlayer = typeof deps.openMiniPlayer === 'function' ? deps.openMiniPlayer : null;
}

/**
 * @param {string} accountId
 * @returns {import('electron').WebContents | null}
 */
function wcFor(accountId) {
  if (!panelsApi || typeof panelsApi.getPanelCapture !== 'function') return null;
  try {
    const wc = panelsApi.getPanelCapture(accountId);
    if (wc && !wc.isDestroyed()) return wc;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {string} accountId
 * @returns {Promise<{ ok: boolean, active?: boolean, reason?: string, message?: string }>}
 */
async function togglePip(accountId) {
  const wc = wcFor(accountId);
  if (!wc) return { ok: false, reason: 'no-panel' };
  try {
    const result = await wc.executeJavaScript(TOGGLE_PIP_JS, true);
    if (result && typeof result === 'object') return result;
    return { ok: false, reason: 'bad-result' };
  } catch (err) {
    return {
      ok: false,
      reason: 'error',
      message: String(err && err.message ? err.message : err),
    };
  }
}

/**
 * @param {string} accountId
 * @returns {Promise<{ count: number, maxArea: number, playing: boolean, visible: boolean }|null>}
 */
async function probeVideo(accountId) {
  const wc = wcFor(accountId);
  if (!wc) return null;
  try {
    const r = await wc.executeJavaScript(HAS_VIDEO_JS, false);
    return r && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} accountId
 * @returns {Promise<{ active: boolean, tag: string|null }|null>}
 */
async function getPipState(accountId) {
  const wc = wcFor(accountId);
  if (!wc) return null;
  try {
    const r = await wc.executeJavaScript(PIP_STATE_JS, false);
    return r && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

/**
 * Toolbar / overflow menu: native PiP + mini player.
 * @param {string} accountId
 * @param {number} [x]
 * @param {number} [y]
 */
function popupPipMenu(accountId, x, y) {
  const win = getMainWindow && getMainWindow();
  const template = [
    {
      label: 'Vídeo em janela flutuante (PiP)',
      click: () => {
        void togglePip(accountId);
      },
    },
    {
      label: 'Mini player (sempre no topo)',
      click: () => {
        if (openMiniPlayer) openMiniPlayer(accountId);
      },
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  const opts = {};
  if (win && !win.isDestroyed()) opts.window = win;
  if (typeof x === 'number' && typeof y === 'number') {
    opts.x = Math.round(x);
    opts.y = Math.round(y);
  }
  if (process.env.MULTIHEIZ_SELFTEST) {
    // No visible popup during selftest; still return descriptors for tests.
    return { ok: true, skippedPopup: true, items: template.map((t) => t.label) };
  }
  menu.popup(opts);
  return { ok: true };
}

module.exports = {
  configure,
  togglePip,
  probeVideo,
  getPipState,
  popupPipMenu,
  TOGGLE_PIP_JS,
  HAS_VIDEO_JS,
  PIP_STATE_JS,
};
