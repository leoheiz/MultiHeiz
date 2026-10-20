'use strict';

/**
 * Isolated-world panel preload:
 * - v1.8 early scriptlets/CSS/UA in MAIN WORLD (sync, before page scripts)
 * - FPS probe via rAF
 */

const { ipcRenderer, contextBridge } = require('electron');

/**
 * Trusted-Types-safe UA/CH patch: apply structured data via a native function
 * (no new Function / <script> — Google accounts.google.com blocks those).
 * @param {object|null|undefined} D
 */
function applyUaPatchData(D) {
  if (!D || !D.ua) return;
  try {
    contextBridge.executeInMainWorld({
      func: (data) => {
        try {
          Object.defineProperty(Navigator.prototype, 'userAgent', {
            get: function () {
              return data.ua;
            },
            configurable: true,
          });
        } catch (e) {
          /* ignore */
        }
        try {
          Object.defineProperty(navigator, 'userAgent', {
            get: function () {
              return data.ua;
            },
            configurable: true,
          });
        } catch (e) {
          /* ignore */
        }
        var uad = {
          brands: data.brands,
          mobile: data.mobile,
          platform: data.platform,
          getHighEntropyValues: function () {
            return Promise.resolve({
              brands: data.brands,
              mobile: data.mobile,
              platform: data.platform,
              platformVersion: data.platformVersion,
              architecture: data.architecture,
              bitness: data.bitness,
              model: data.model,
              uaFullVersion:
                data.fullVersionList && data.fullVersionList[0]
                  ? data.fullVersionList[0].version
                  : undefined,
              fullVersionList: data.fullVersionList,
            });
          },
          toJSON: function () {
            return { brands: data.brands, mobile: data.mobile, platform: data.platform };
          },
        };
        try {
          Object.defineProperty(Navigator.prototype, 'userAgentData', {
            get: function () {
              return uad;
            },
            configurable: true,
          });
        } catch (e) {
          /* ignore */
        }
        try {
          Object.defineProperty(navigator, 'userAgentData', {
            get: function () {
              return uad;
            },
            configurable: true,
          });
        } catch (e) {
          /* ignore */
        }
        try {
          Object.defineProperty(Navigator.prototype, 'webdriver', {
            get: function () {
              return false;
            },
            configurable: true,
          });
        } catch (e) {
          /* ignore */
        }
      },
      args: [D],
    });
  } catch {
    /* ignore */
  }
}

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

/**
 * When Windows passkeys are disabled in settings: hide platform authenticator
 * and reject publicKey credentials.get/create with NotAllowedError (no Windows UI).
 * Trusted-Types-safe (func+args, no new Function).
 */
function applyPasskeyDisablePatch() {
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        try {
          window.__MH_PASSKEYS_DISABLED__ = true;
        } catch (e0) {
          /* ignore */
        }
        try {
          if (typeof PublicKeyCredential !== 'undefined') {
            if (
              typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable ===
              'function'
            ) {
              PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function () {
                return Promise.resolve(false);
              };
            }
            if (typeof PublicKeyCredential.isConditionalMediationAvailable === 'function') {
              PublicKeyCredential.isConditionalMediationAvailable = function () {
                return Promise.resolve(false);
              };
            }
          }
        } catch (e1) {
          /* ignore */
        }
        try {
          if (!navigator.credentials) return;
          var origGet = navigator.credentials.get
            ? navigator.credentials.get.bind(navigator.credentials)
            : null;
          var origCreate = navigator.credentials.create
            ? navigator.credentials.create.bind(navigator.credentials)
            : null;
          function notAllowed() {
            return Promise.reject(
              new DOMException(
                'The operation either timed out or was not allowed.',
                'NotAllowedError'
              )
            );
          }
          if (origGet) {
            navigator.credentials.get = function (opts) {
              if (opts && opts.publicKey) return notAllowed();
              return origGet(opts);
            };
          }
          if (origCreate) {
            navigator.credentials.create = function (opts) {
              if (opts && opts.publicKey) return notAllowed();
              return origCreate(opts);
            };
          }
        } catch (e2) {
          /* ignore */
        }
      },
      args: [],
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
    if (payload && payload.uaPatchData) applyUaPatchData(payload.uaPatchData);
    else if (payload && payload.uaPatch) injectInMainWorld(payload.uaPatch);
    if (payload && payload.passkeyDisable) applyPasskeyDisablePatch();
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
  if (payload.uaPatchData) applyUaPatchData(payload.uaPatchData);
  else if (payload.uaPatch) injectInMainWorld(payload.uaPatch);
  if (payload.passkeyDisable) applyPasskeyDisablePatch();
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

/**
 * Indicador de captura mic/câmera.
 * Electron 44 não expõe app/session "media-access"; observamos getUserMedia no main
 * world e reportamos via bridge → ipc-message do painel (como panel:fps).
 * O main world é recriado a cada navegação — reaplicamos o hook cedo (preload + rehook).
 */
(function installMediaUseObserver() {
  try {
    contextBridge.exposeInMainWorld('__mhMediaUseReport', (payload) => {
      try {
        ipcRenderer.send('panel:media-use', {
          microphone: !!(payload && payload.microphone),
          camera: !!(payload && payload.camera),
        });
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }

  function hookMainWorld() {
    try {
      contextBridge.executeInMainWorld({
        func: () => {
          try {
            if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
              return;
            }
            if (window.__MH_MEDIA_USE_HOOK__) return;
            window.__MH_MEDIA_USE_HOOK__ = true;
            /** @type {MediaStream[]} */
            var liveStreams = [];
            var pollTimer = null;
            function recountAndReport() {
              var mic = 0;
              var cam = 0;
              var next = [];
              for (var i = 0; i < liveStreams.length; i++) {
                var s = liveStreams[i];
                var tracks = [];
                try {
                  tracks = s.getTracks();
                } catch (eT) {
                  continue;
                }
                var anyLive = false;
                for (var j = 0; j < tracks.length; j++) {
                  var t = tracks[j];
                  if (!t || t.readyState !== 'live') continue;
                  anyLive = true;
                  if (t.kind === 'audio') mic += 1;
                  if (t.kind === 'video') cam += 1;
                }
                if (anyLive) next.push(s);
              }
              liveStreams = next;
              try {
                if (typeof window.__mhMediaUseReport === 'function') {
                  window.__mhMediaUseReport({
                    microphone: mic > 0,
                    camera: cam > 0,
                  });
                }
              } catch (e0) {
                /* ignore */
              }
              if (!liveStreams.length && pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
              }
            }
            function watchStream(stream) {
              if (!stream) return;
              liveStreams.push(stream);
              try {
                stream.getTracks().forEach(function (track) {
                  try {
                    track.addEventListener('ended', recountAndReport);
                  } catch (e1) {
                    /* ignore */
                  }
                });
              } catch (e2) {
                /* ignore */
              }
              recountAndReport();
              if (!pollTimer) {
                pollTimer = setInterval(recountAndReport, 400);
              }
            }
            var orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = function (constraints) {
              return orig(constraints).then(function (stream) {
                try {
                  watchStream(stream);
                } catch (e3) {
                  /* ignore */
                }
                return stream;
              });
            };
          } catch (e3) {
            /* ignore */
          }
        },
        args: [],
      });
    } catch {
      /* ignore */
    }
  }

  hookMainWorld();
  try {
    ipcRenderer.on('mh-rehook-media', () => {
      hookMainWorld();
    });
  } catch {
    /* ignore */
  }
})();

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
