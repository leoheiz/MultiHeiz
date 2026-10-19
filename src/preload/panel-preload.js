'use strict';

/**
 * Isolated-world panel preload:
 * - v1.8 early scriptlets/CSS/UA in MAIN WORLD (sync, before page scripts)
 * - FPS probe via rAF
 */

const { ipcRenderer, contextBridge } = require('electron');

function injectInMainWorld(source) {
  if (!source) return;
  try {
    contextBridge.executeInMainWorld({
      func: (src) => {
        try {
          // eslint-disable-next-line no-new-func
          new Function(src)();
        } catch (e1) {
          try {
            const el = document.createElement('script');
            el.textContent = src;
            const root = document.documentElement || document.head;
            if (!root) return;
            root.appendChild(el);
            el.remove();
          } catch (e2) {
            /* ignore */
          }
        }
      },
      args: [String(source)],
    });
  } catch {
    /* ignore */
  }
}

/** Never append to Document — that can make the style the documentElement. */
function styleInjectSource(id, css, mode) {
  const op = mode === 'append' ? '+=' : '=';
  return (
    '(function(){try{' +
    'var id=' +
    JSON.stringify(id) +
    ';' +
    'var css=' +
    JSON.stringify(css) +
    ';' +
    'function apply(){' +
    'var s=document.getElementById(id);' +
    'if(!s){s=document.createElement("style");s.id=id;' +
    'var r=document.head||document.documentElement;if(!r)return false;r.appendChild(s);}' +
    's.textContent' +
    op +
    'css;return true;}' +
    'if(!apply()){var o=new MutationObserver(function(){if(apply())o.disconnect();});' +
    'o.observe(document,{childList:true});}' +
    '}catch(e){}})();'
  );
}

function injectEarlySync() {
  if (String(window.location.href || '').startsWith('devtools://')) return;
  const t0 =
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  let payload = null;
  try {
    payload = ipcRenderer.sendSync('@ghostery/adblocker/early-scriptlets', window.location.href);
  } catch {
    payload = null;
  }
  const t1 =
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  if (!payload || !payload.ok) {
    if (payload && payload.uaPatch) injectInMainWorld(payload.uaPatch);
    if (payload && payload.lightModeCss) {
      injectInMainWorld(styleInjectSource('mh-light-mode', payload.lightModeCss, 'set'));
    }
    return;
  }
  if (payload.styles) {
    injectInMainWorld(styleInjectSource('mh-adblock-css-early', payload.styles, 'append'));
  }
  for (const script of payload.scripts || []) {
    injectInMainWorld(script);
  }
  if (payload.uaPatch) injectInMainWorld(payload.uaPatch);
  if (payload.lightModeCss) {
    injectInMainWorld(styleInjectSource('mh-light-mode', payload.lightModeCss, 'set'));
  }
  const t2 =
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  try {
    ipcRenderer.send('@ghostery/adblocker/early-timing', {
      url: window.location.href,
      syncMs: t1 - t0,
      injectMs: t2 - t1,
      scripts: (payload.scripts || []).length,
      via: 'panel-preload',
      hasStyles: !!payload.styles,
    });
  } catch {
    /* ignore */
  }
}

injectEarlySync();

/** Ctrl+wheel zoom — preventDefault so page pinch-zoom does not double-apply. */
try {
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      try {
        ipcRenderer.send('panel:ctrl-wheel', { deltaY: e.deltaY });
      } catch {
        /* ignore */
      }
    },
    { passive: false, capture: true }
  );
} catch {
  /* ignore */
}

let frames = 0;
let lastReport = Date.now();

function tick() {
  frames += 1;
  const now = Date.now();
  if (now - lastReport >= 1000) {
    const fps = Math.round((frames * 1000) / (now - lastReport));
    frames = 0;
    lastReport = now;
    try {
      ipcRenderer.send('panel:fps', { fps });
    } catch {
      /* ignore */
    }
  }
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
