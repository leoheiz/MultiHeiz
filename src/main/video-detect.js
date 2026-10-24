'use strict';

/**
 * Find a <video> under click coordinates (overlays, open shadow roots, same-origin iframes).
 * Used by context-menu PiP / mini-player items when mediaType is not already "video".
 */

const TARGET_ATTR = 'data-mh-ctx-video';
const PROBE_BUDGET_MS = 50;

/**
 * Page script: probe at (x,y). Marks the chosen video with TARGET_ATTR.
 * Returns { found, id, via, ms } — never throws.
 */
const PROBE_AT_POINT_JS = `function mhProbeVideoAtPoint(x, y, attr) {
  var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  function elapsed() {
    var n = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    return n - t0;
  }
  function clearMarks(root) {
    try {
      var list = root.querySelectorAll('video[' + attr + ']');
      for (var i = 0; i < list.length; i++) list[i].removeAttribute(attr);
    } catch (e) {}
  }
  function clearAll() {
    clearMarks(document);
    try {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var doc = iframes[i].contentDocument;
          if (doc) clearMarks(doc);
        } catch (e) {}
      }
    } catch (e) {}
  }
  function isVideo(el) {
    return !!(el && el.tagName === 'VIDEO');
  }
  function deepElementsFromPoint(px, py, rootDoc, depth) {
    var out = [];
    if (depth > 6) return out;
    var doc = rootDoc || document;
    var list;
    try {
      list = doc.elementsFromPoint ? doc.elementsFromPoint(px, py) : [];
    } catch (e) {
      list = [];
    }
    if (!list || !list.length) {
      try {
        var one = doc.elementFromPoint && doc.elementFromPoint(px, py);
        if (one) list = [one];
      } catch (e2) {
        list = [];
      }
    }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      out.push(el);
      if (!el) continue;
      if (el.shadowRoot) {
        var deep = deepElementsFromPoint(px, py, el.shadowRoot, depth + 1);
        for (var d = 0; d < deep.length; d++) out.push(deep[d]);
      }
      if (el.tagName === 'IFRAME') {
        try {
          var idoc = el.contentDocument;
          if (idoc) {
            var rect = el.getBoundingClientRect();
            var lx = px - rect.left;
            var ly = py - rect.top;
            var nested = deepElementsFromPoint(lx, ly, idoc, depth + 1);
            for (var n = 0; n < nested.length; n++) out.push(nested[n]);
          }
        } catch (e3) {}
      }
    }
    return out;
  }
  function collectVideos(root, into) {
    try {
      var nodes = root.querySelectorAll('video');
      for (var i = 0; i < nodes.length; i++) into.push(nodes[i]);
    } catch (e) {}
    try {
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) collectVideos(all[j].shadowRoot, into);
      }
    } catch (e2) {}
  }
  function videoScore(v) {
    var r = v.getBoundingClientRect();
    var area = Math.max(0, r.width) * Math.max(0, r.height);
    var playing = !v.paused && !v.ended && v.readyState >= 2;
    var visible = area > 16 && r.bottom > 0 && r.right > 0 &&
      r.top < (window.innerHeight || 800) && r.left < (window.innerWidth || 1200);
    return { el: v, area: area, playing: playing, visible: visible, r: r };
  }
  function containsPoint(r, px, py) {
    return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
  }
  function mark(v, via) {
    clearAll();
    try { v.setAttribute(attr, '1'); } catch (e) {}
    if (!v.id) {
      try { v.setAttribute('data-mh-ctx-id', 'mh' + String(Math.random()).slice(2, 10)); } catch (e2) {}
    }
    return {
      found: true,
      via: via,
      id: v.id || v.getAttribute('data-mh-ctx-id') || '',
      ms: elapsed()
    };
  }

  clearAll();
  var stack = deepElementsFromPoint(x, y, document, 0);
  for (var i = 0; i < stack.length; i++) {
    var el = stack[i];
    if (isVideo(el)) return mark(el, 'elementsFromPoint');
    if (el && el.closest) {
      var cv = el.closest('video');
      if (isVideo(cv)) return mark(cv, 'closest');
    }
  }

  var videos = [];
  collectVideos(document, videos);
  try {
    var iframes = document.querySelectorAll('iframe');
    for (var f = 0; f < iframes.length; f++) {
      try {
        var doc = iframes[f].contentDocument;
        if (doc) collectVideos(doc, videos);
      } catch (e) {}
    }
  } catch (e4) {}

  var scored = [];
  for (var s = 0; s < videos.length; s++) {
    var sc = videoScore(videos[s]);
    if (sc.visible && containsPoint(sc.r, x, y)) scored.push(sc);
  }
  var playing = scored.filter(function (z) { return z.playing; })
    .sort(function (a, b) { return b.area - a.area; });
  if (playing.length) return mark(playing[0].el, 'playing-contains');
  scored.sort(function (a, b) { return b.area - a.area; });
  if (scored.length) return mark(scored[0].el, 'largest-contains');
  return { found: false, via: 'none', id: '', ms: elapsed() };
}`;

/**
 * Build executeJavaScript source that runs the probe and returns the result object.
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
function buildProbeScript(x, y) {
  const px = Number(x) || 0;
  const py = Number(y) || 0;
  return `(${PROBE_AT_POINT_JS})(${px}, ${py}, ${JSON.stringify(TARGET_ATTR)})`;
}

/**
 * Pick the marked context-menu target video, else largest playing / visible.
 * Shared by PiP toggle and mini-player isolation.
 */
const PICK_TARGET_OR_BEST_JS = `(() => {
  var ATTR = ${JSON.stringify(TARGET_ATTR)};
  function listFrom(root, into) {
    try {
      var nodes = root.querySelectorAll('video');
      for (var i = 0; i < nodes.length; i++) into.push(nodes[i]);
    } catch (e) {}
    try {
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) listFrom(all[j].shadowRoot, into);
      }
    } catch (e2) {}
  }
  function allVideos() {
    var out = [];
    listFrom(document, out);
    return out;
  }
  var marked = null;
  try {
    marked = document.querySelector('video[' + ATTR + ']');
  } catch (e) {}
  if (!marked) {
    var list = allVideos();
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute && list[i].getAttribute(ATTR) === '1') {
        marked = list[i];
        break;
      }
    }
  }
  if (marked) return marked;
  var items = allVideos().map(function (v) {
    var r = v.getBoundingClientRect();
    var area = Math.max(0, r.width) * Math.max(0, r.height);
    var playing = !v.paused && !v.ended && v.readyState >= 2;
    var visible = area > 16 && r.bottom > 0 && r.right > 0 &&
      r.top < (window.innerHeight || 800) && r.left < (window.innerWidth || 1200);
    return { el: v, area: area, playing: playing, visible: visible };
  });
  var playing = items.filter(function (x) { return x.playing; })
    .sort(function (a, b) { return b.area - a.area; });
  if (playing.length) return playing[0].el;
  var vis = items.filter(function (x) { return x.visible; })
    .sort(function (a, b) { return b.area - a.area; });
  return vis.length ? vis[0].el : null;
})()`;

/**
 * @param {import('electron').WebContents} wc
 * @param {number} x
 * @param {number} y
 * @param {number} [budgetMs]
 * @returns {Promise<{ found: boolean, via?: string, id?: string, ms?: number, timedOut?: boolean }>}
 */
async function probeVideoAtPoint(wc, x, y, budgetMs = PROBE_BUDGET_MS) {
  if (!wc || wc.isDestroyed()) return { found: false, via: 'no-wc' };
  const budget = Math.max(5, Number(budgetMs) || PROBE_BUDGET_MS);
  const script = buildProbeScript(x, y);
  try {
    const result = await Promise.race([
      wc.executeJavaScript(script, true).then(
        (r) => (r && typeof r === 'object' ? r : { found: false, via: 'bad-result' }),
        () => ({ found: false, via: 'exec-error' })
      ),
      new Promise((resolve) => {
        setTimeout(() => resolve({ found: false, via: 'timeout', timedOut: true }), budget);
      }),
    ]);
    return result;
  } catch {
    return { found: false, via: 'error' };
  }
}

module.exports = {
  TARGET_ATTR,
  PROBE_BUDGET_MS,
  PROBE_AT_POINT_JS,
  buildProbeScript,
  probeVideoAtPoint,
  PICK_TARGET_OR_BEST_JS,
};
