'use strict';

/**
 * Isolated-world panel preload:
 * - v1.8 early scriptlets/CSS/UA in MAIN WORLD (sync, before page scripts)
 * - FPS probe via rAF
 */

const { ipcRenderer, contextBridge } = require('electron');

/** Só frame de topo (não expor pontes de UI em iframes). */
function isTopFrame() {
  try {
    return window === window.top;
  } catch {
    return true;
  }
}

/**
 * APIs de selftest (forceCheck/openOn/getDiag): exige MULTIHEIZ_SELFTEST +
 * --mh-selftest-apis=1 (main só passa se !app.isPackaged).
 */
function allowSelftestApis() {
  try {
    if (!process.env.MULTIHEIZ_SELFTEST) return false;
    const argv = process.argv || [];
    for (let i = 0; i < argv.length; i++) {
      const a = String(argv[i] || '');
      if (a === '--mh-selftest-apis' || a === '--mh-selftest-apis=1') return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

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
 * Volume fino por janela (GainNode no main world). Guarda própria __mhVolCtlDone.
 * Fonte + ganho via sendSync (preload sandboxed — sem require local).
 */
(function installVolumeControl() {
  /** @type {string} */
  let cachedSource = '';

  function injectVol(src) {
    const code = src || cachedSource;
    if (!code) return;
    try {
      injectInMainWorld(code);
    } catch {
      /* ignore */
    }
  }

  function applyLevel(gain) {
    const g = Number(gain);
    if (!Number.isFinite(g)) return;
    try {
      contextBridge.executeInMainWorld({
        func: (level) => {
          try {
            if (window.__mhVol && typeof window.__mhVol.set === 'function') {
              window.__mhVol.set(level);
            }
          } catch (e) {
            /* ignore */
          }
        },
        args: [g],
      });
    } catch {
      /* ignore */
    }
  }

  try {
    const boot = ipcRenderer.sendSync('panel:volume-sync');
    if (boot && typeof boot.source === 'string' && boot.source) {
      cachedSource = boot.source;
      injectVol(cachedSource);
    }
    if (boot && boot.gain != null && Number.isFinite(Number(boot.gain))) {
      applyLevel(Number(boot.gain));
    }
  } catch {
    /* ignore */
  }
  try {
    ipcRenderer.on('mh-apply-volume', (_e, payload) => {
      if (payload && typeof payload.source === 'string' && payload.source) {
        cachedSource = payload.source;
      }
      injectVol(cachedSource);
      const g =
        payload && typeof payload.gain === 'number'
          ? payload.gain
          : payload && typeof payload.percent === 'number'
            ? Number(payload.percent) / 100
            : null;
      if (g != null) applyLevel(g);
    });
  } catch {
    /* ignore */
  }
  try {
    ipcRenderer.on('mh-rehook-media', () => {
      injectVol(cachedSource);
    });
  } catch {
    /* ignore */
  }
})();

/**
 * Indicador de captura mic/câmera.
 * Electron 44 não expõe app/session "media-access"; observamos getUserMedia no main
 * world e reportamos via bridge → ipc-message do painel (como panel:fps).
 * O main world é recriado a cada navegação — reaplicamos o hook cedo (preload + rehook).
 */
(function installMediaUseObserver() {
  if (!isTopFrame()) return;
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

/**
 * Corretor LanguageTool — overlay leve no campo (sem alterar DOM do site
 * de forma que quebre envio). Pedidos via IPC → main (net.fetch).
 * Campos sensíveis (password, cc-*, one-time-code, OTP, data-mh-no-spell) nunca.
 */
(function installLanguageToolClient() {
  /** @type {object} */
  let cfg = {
    enabled: false,
    languages: [],
    disabledOrigins: [],
    appLanguage: 'pt-BR',
    debounceMs: 1500,
  };
  /** @type {WeakMap<Element, object>} */
  const fieldState = new WeakMap();
  /** @type {Element|null} */
  let activeEl = null;
  let reqSeq = 0;
  let debounceTimer = null;
  /** @type {HTMLElement|null} */
  let overlayRoot = null;
  /** @type {HTMLElement|null} */
  let suggestBox = null;
  /** @type {{ matches: object[], text: string, requestId: number }|null} */
  let lastResult = null;
  let lastCheckAt = 0;
  let checksSent = 0;
  let sensitiveBlocked = 0;

  function originNow() {
    try {
      return location.origin || '';
    } catch {
      return '';
    }
  }

  function isOriginDisabled() {
    const o = originNow();
    const list = (cfg && cfg.disabledOrigins) || [];
    return !!(o && Array.isArray(list) && list.indexOf(o) >= 0);
  }

  const SENSITIVE_NAME_RE =
    /(?:^|[^a-z0-9])(?:senha|password|passwd|pass|pwd|token|otp|2fa|codigo|code|cpf|cnpj|rg|cartao|card|cc-|cvv|cvc|pin|iban|conta|secret|api[-_]?key|apikey)(?:[^a-z0-9]|$)/i;

  function foldAccents(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function hasSensitiveNameAttrs(a) {
    const parts = [a.name, a.id, a.autocomplete, a.ariaLabel, a.placeholder];
    for (let i = 0; i < parts.length; i++) {
      const folded = foldAccents(parts[i]).replace(/[_./]+/g, '-');
      if (!folded) continue;
      if (SENSITIVE_NAME_RE.test(folded) || SENSITIVE_NAME_RE.test(' ' + folded + ' ')) return true;
    }
    return false;
  }

  function fieldAttrs(el) {
    if (!el || !el.tagName) return { tagName: '' };
    const tagName = String(el.tagName || '');
    const type = el.getAttribute ? el.getAttribute('type') || el.type || '' : el.type || '';
    const autocomplete =
      (el.getAttribute && el.getAttribute('autocomplete')) || el.autocomplete || '';
    const inputMode =
      (el.getAttribute && (el.getAttribute('inputmode') || el.getAttribute('inputMode'))) ||
      el.inputMode ||
      '';
    const maxLength =
      el.maxLength != null && el.maxLength >= 0
        ? el.maxLength
        : Number(el.getAttribute && el.getAttribute('maxlength')) || -1;
    const noSpell =
      !!(el.getAttribute && el.getAttribute('data-mh-no-spell') != null) ||
      !!(el.dataset && el.dataset.mhNoSpell != null);
    const name = (el.getAttribute && el.getAttribute('name')) || el.name || '';
    const id = (el.getAttribute && el.getAttribute('id')) || el.id || '';
    const ariaLabel =
      (el.getAttribute && el.getAttribute('aria-label')) || el.ariaLabel || '';
    const placeholder =
      (el.getAttribute && el.getAttribute('placeholder')) || el.placeholder || '';
    return {
      tagName,
      type,
      autocomplete,
      inputMode,
      maxLength,
      noSpell,
      name,
      id,
      ariaLabel,
      placeholder,
    };
  }

  /** Espelha isSensitiveField do main (password / cc-* / OTP / name sensível). */
  function isSensitive(el) {
    const a = fieldAttrs(el);
    if (a.noSpell) return true;
    const type = String(a.type || '').toLowerCase();
    const ac = String(a.autocomplete || '')
      .toLowerCase()
      .trim();
    const im = String(a.inputMode || '').toLowerCase();
    const ml = Number(a.maxLength);
    if (type === 'password' || type === 'email' || type === 'hidden' || type === 'file') return true;
    if (type === 'number' || type === 'tel') return true;
    if (
      ac === 'one-time-code' ||
      ac === 'current-password' ||
      ac === 'new-password' ||
      ac.indexOf('cc-') === 0
    ) {
      return true;
    }
    if (hasSensitiveNameAttrs(a)) return true;
    if ((im === 'numeric' || im === 'decimal') && Number.isFinite(ml) && ml > 0 && ml <= 8) {
      return true;
    }
    const tag = String(a.tagName || '').toUpperCase();
    if (tag === 'INPUT') {
      const allowed = !type || type === 'text' || type === 'search' || type === 'url';
      if (!allowed) return true;
    }
    return false;
  }

  function isEditableTarget(el) {
    if (!el || !el.tagName) return false;
    if (isSensitive(el)) return false;
    const tag = String(el.tagName).toUpperCase();
    if (tag === 'TEXTAREA') return !(el.readOnly || el.disabled);
    if (tag === 'INPUT') {
      const type = String(el.type || el.getAttribute('type') || '').toLowerCase();
      return (!type || type === 'text' || type === 'search' || type === 'url') && !el.readOnly && !el.disabled;
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function readText(el) {
    if (!el) return '';
    if (el.isContentEditable) return String(el.innerText || el.textContent || '');
    return String(el.value || '');
  }

  function detectLang(el) {
    try {
      if (el && el.getAttribute) {
        const fl = el.getAttribute('lang') || (el.closest && el.closest('[lang]') && el.closest('[lang]').getAttribute('lang'));
        if (fl) return fl;
      }
      if (document.documentElement && document.documentElement.lang) {
        return document.documentElement.lang;
      }
    } catch {
      /* ignore */
    }
    return (cfg && cfg.appLanguage) || 'pt-BR';
  }

  function ensureOverlay() {
    if (overlayRoot && overlayRoot.isConnected) return overlayRoot;
    const root = document.createElement('div');
    root.setAttribute('data-mh-lt-overlay-root', '1');
    root.style.cssText =
      'position:absolute;left:0;top:0;pointer-events:none;z-index:2147483646;margin:0;padding:0;border:0;';
    (document.documentElement || document.body).appendChild(root);
    overlayRoot = root;
    return root;
  }

  function hideSuggest() {
    if (suggestBox && suggestBox.parentNode) suggestBox.parentNode.removeChild(suggestBox);
    suggestBox = null;
  }

  function clearOverlayMarks() {
    if (!overlayRoot) return;
    while (overlayRoot.firstChild) overlayRoot.removeChild(overlayRoot.firstChild);
    hideSuggest();
    try {
      if (typeof CSS !== 'undefined' && CSS.highlights && typeof CSS.highlights.delete === 'function') {
        CSS.highlights.delete('mh-lt-errors');
      }
    } catch {
      /* ignore */
    }
  }

  function applyTextReplacement(el, offset, length, replacement) {
    if (!el) return false;
    const off = Number(offset);
    const len = Number(length);
    const rep = String(replacement || '');
    if (!Number.isFinite(off) || !Number.isFinite(len) || len < 0) return false;
    if (el.isContentEditable) {
      try {
        const text = readText(el);
        const next = text.slice(0, off) + rep + text.slice(off + len);
        el.textContent = next;
        clearOverlayMarks();
        scheduleCheck(el);
        return true;
      } catch {
        return false;
      }
    }
    try {
      const val = String(el.value || '');
      el.value = val.slice(0, off) + rep + val.slice(off + len);
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch {
        /* ignore */
      }
      clearOverlayMarks();
      scheduleCheck(el);
      return true;
    } catch {
      return false;
    }
  }

  function showSuggestionsAt(match, clientX, clientY) {
    hideSuggest();
    if (!match || !Array.isArray(match.replacements) || !match.replacements.length) return;
    const box = document.createElement('div');
    box.setAttribute('data-mh-lt-suggest', '1');
    box.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:auto;background:#1e222a;color:#e8eaed;' +
      'border:1px solid #3a404c;border-radius:6px;padding:4px 0;min-width:120px;max-width:260px;' +
      'font:13px/1.35 Segoe UI,system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);';
    const title = document.createElement('div');
    title.textContent = 'Sugestões do LanguageTool';
    title.style.cssText = 'padding:4px 10px;opacity:.7;font-size:11px;';
    box.appendChild(title);
    match.replacements.forEach((r) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = r;
      btn.style.cssText =
        'display:block;width:100%;text-align:left;background:transparent;border:0;color:inherit;' +
        'padding:6px 10px;cursor:pointer;font:inherit;';
      btn.addEventListener('mouseenter', () => {
        btn.style.background = '#2a3140';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'transparent';
      });
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        applyTextReplacement(activeEl, match.offset, match.length, r);
        hideSuggest();
      });
      box.appendChild(btn);
    });
    const x = Math.max(4, Number(clientX) || 0);
    const y = Math.max(4, Number(clientY) || 0);
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    document.documentElement.appendChild(box);
    suggestBox = box;
  }

  function paintMatches(el, text, matches) {
    clearOverlayMarks();
    if (!el || !matches || !matches.length) return;
    lastResult = { matches, text, requestId: reqSeq };

    // contenteditable: CSS Custom Highlight se disponível
    if (el.isContentEditable) {
      try {
        if (typeof Highlight !== 'undefined' && CSS && CSS.highlights) {
          const ranges = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          /** @type {Text[]} */
          const nodes = [];
          let n;
          while ((n = walker.nextNode())) nodes.push(/** @type {Text} */ (n));
          let pos = 0;
          const nodeRanges = [];
          for (const tn of nodes) {
            const len = tn.data.length;
            nodeRanges.push({ node: tn, start: pos, end: pos + len });
            pos += len;
          }
          for (const m of matches) {
            const a = m.offset;
            const b = m.offset + m.length;
            for (const nr of nodeRanges) {
              if (nr.end <= a || nr.start >= b) continue;
              const r = new Range();
              r.setStart(nr.node, Math.max(0, a - nr.start));
              r.setEnd(nr.node, Math.min(nr.node.data.length, b - nr.start));
              ranges.push(r);
            }
          }
          if (ranges.length) {
            // eslint-disable-next-line no-undef
            CSS.highlights.set('mh-lt-errors', new Highlight(...ranges));
            if (!document.getElementById('mh-lt-highlight-style')) {
              const st = document.createElement('style');
              st.id = 'mh-lt-highlight-style';
              st.textContent =
                '::highlight(mh-lt-errors){text-decoration:underline wavy #e07070;background:transparent;}';
              document.documentElement.appendChild(st);
            }
          }
          return;
        }
      } catch {
        /* fallback abaixo */
      }
    }

    // input/textarea (e fallback contenteditable): overlay de sublinhado
    try {
      const rect = el.getBoundingClientRect();
      const root = ensureOverlay();
      const layer = document.createElement('div');
      layer.setAttribute('data-mh-lt-layer', '1');
      const cs = window.getComputedStyle(el);
      layer.style.cssText =
        'position:fixed;left:' +
        rect.left +
        'px;top:' +
        rect.top +
        'px;width:' +
        rect.width +
        'px;height:' +
        rect.height +
        'px;overflow:hidden;pointer-events:none;' +
        'font:' +
        cs.font +
        ';letter-spacing:' +
        cs.letterSpacing +
        ';white-space:pre-wrap;word-wrap:break-word;' +
        'padding:' +
        cs.padding +
        ';border:' +
        cs.borderWidth +
        ' solid transparent;box-sizing:border-box;color:transparent;';
      let html = '';
      let cursor = 0;
      const esc = (s) =>
        String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      const sorted = matches.slice().sort((a, b) => a.offset - b.offset);
      for (let i = 0; i < sorted.length; i++) {
        const m = sorted[i];
        if (m.offset < cursor) continue;
        html += esc(text.slice(cursor, m.offset));
        const bad = text.slice(m.offset, m.offset + m.length);
        html +=
          '<span data-mh-lt-err="' +
          i +
          '" style="border-bottom:2px wavy #e07070;pointer-events:auto;cursor:pointer;">' +
          esc(bad) +
          '</span>';
        cursor = m.offset + m.length;
      }
      html += esc(text.slice(cursor));
      layer.innerHTML = html.replace(/\n/g, '<br/>');
      layer.addEventListener(
        'click',
        (ev) => {
          const t = ev.target;
          if (!t || !t.getAttribute) return;
          const idx = t.getAttribute('data-mh-lt-err');
          if (idx == null) return;
          ev.preventDefault();
          ev.stopPropagation();
          const m = sorted[Number(idx)];
          if (m) showSuggestionsAt(m, ev.clientX, ev.clientY);
        },
        true
      );
      root.appendChild(layer);
    } catch {
      /* ignore */
    }
  }

  async function runCheck(el) {
    if (!cfg.enabled || isOriginDisabled()) {
      clearOverlayMarks();
      return;
    }
    if (!el || !isEditableTarget(el)) {
      if (el && isSensitive(el)) {
        sensitiveBlocked += 1;
        try {
          await ipcRenderer.invoke('panel:languagetool-check', {
            sensitive: true,
            field: fieldAttrs(el),
            text: '',
            origin: originNow(),
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const text = readText(el);
    const st = fieldState.get(el) || {};
    if (st.lastText === text && st.checked) return;
    const requestId = ++reqSeq;
    st.pendingId = requestId;
    fieldState.set(el, st);
    checksSent += 1;
    lastCheckAt = Date.now();
    let result;
    try {
      result = await ipcRenderer.invoke('panel:languagetool-check', {
        text,
        requestId,
        origin: originNow(),
        fieldLang: detectLang(el),
        pageLang: (document.documentElement && document.documentElement.lang) || '',
        field: fieldAttrs(el),
      });
    } catch {
      return;
    }
    if (!result || result.requestId !== requestId) return;
    if (st.pendingId !== requestId) return;
    if (result.skipped === 'sensitive') {
      sensitiveBlocked += 1;
      clearOverlayMarks();
      return;
    }
    if (result.error === '429') {
      // backoff no main — não trava a UI
      return;
    }
    st.lastText = text;
    st.checked = true;
    fieldState.set(el, st);
    const matches = Array.isArray(result.matches) ? result.matches : [];
    paintMatches(el, text, matches);
    try {
      ipcRenderer.send('panel:languagetool-matches', { matches, text, language: result.language });
    } catch {
      /* ignore */
    }
  }

  function scheduleCheck(el) {
    activeEl = el;
    if (debounceTimer) clearTimeout(debounceTimer);
    const ms = Number(cfg.debounceMs) > 0 ? Number(cfg.debounceMs) : 1500;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runCheck(el);
    }, ms);
  }

  function onFocusIn(ev) {
    const el = ev.target;
    if (!isEditableTarget(el)) {
      if (el && isSensitive(el)) {
        sensitiveBlocked += 1;
        // Conta no main sem enviar texto
        try {
          ipcRenderer.invoke('panel:languagetool-check', {
            sensitive: true,
            field: fieldAttrs(el),
            text: '',
            origin: originNow(),
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }
    activeEl = el;
    scheduleCheck(el);
  }

  function onInput(ev) {
    const el = ev.target;
    if (!isEditableTarget(el)) return;
    const st = fieldState.get(el) || {};
    st.checked = false;
    fieldState.set(el, st);
    scheduleCheck(el);
  }

  function applyConfig(next) {
    if (!next || typeof next !== 'object') return;
    cfg = {
      enabled: next.enabled !== false,
      languages: Array.isArray(next.languages) ? next.languages : cfg.languages,
      disabledOrigins: Array.isArray(next.disabledOrigins) ? next.disabledOrigins : [],
      appLanguage: next.appLanguage || cfg.appLanguage || 'pt-BR',
      debounceMs: Number(next.debounceMs) > 0 ? Number(next.debounceMs) : 1500,
    };
    if (!cfg.enabled || isOriginDisabled()) {
      clearOverlayMarks();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }
  }

  try {
    const boot = ipcRenderer.sendSync('panel:languagetool-sync');
    if (boot) applyConfig(boot);
  } catch {
    /* ignore */
  }
  try {
    ipcRenderer.on('mh-languagetool-config', (_e, payload) => applyConfig(payload));
  } catch {
    /* ignore */
  }

  try {
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener(
      'click',
      (ev) => {
        if (suggestBox && !suggestBox.contains(ev.target)) hideSuggest();
      },
      true
    );
    document.addEventListener(
      'scroll',
      () => {
        if (activeEl && lastResult) paintMatches(activeEl, lastResult.text, lastResult.matches);
      },
      true
    );
  } catch {
    /* ignore */
  }

  try {
    /** @type {Record<string, unknown>} */
    const ltApi = {
      applyReplacement: (offset, length, replacement) =>
        applyTextReplacement(activeEl, offset, length, replacement),
      applyFirstSuggestion: () => {
        if (!lastResult || !lastResult.matches || !lastResult.matches.length) return false;
        const m = lastResult.matches[0];
        const r = m.replacements && m.replacements[0];
        if (!r) return false;
        return applyTextReplacement(activeEl, m.offset, m.length, r);
      },
    };
    if (allowSelftestApis()) {
      ltApi.getDiag = () => ({
        enabled: !!(cfg && cfg.enabled),
        originDisabled: isOriginDisabled(),
        checksSent,
        sensitiveBlocked,
        lastCheckAt,
        matchCount: lastResult && lastResult.matches ? lastResult.matches.length : 0,
        lastText: lastResult ? lastResult.text : '',
        hasOverlay: !!(overlayRoot && overlayRoot.childNodes && overlayRoot.childNodes.length),
        suggestOpen: !!suggestBox,
      });
      /** Selftest: força verificação imediata (sem debounce). */
      ltApi.forceCheck = async (sel) => {
        const el = sel ? document.querySelector(sel) : activeEl || document.activeElement;
        if (!el) return { ok: false };
        activeEl = el;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        const st = fieldState.get(el) || {};
        st.checked = false;
        st.lastText = '';
        fieldState.set(el, st);
        await runCheck(el);
        return {
          ok: true,
          diag: {
            enabled: !!(cfg && cfg.enabled),
            originDisabled: isOriginDisabled(),
            checksSent,
            sensitiveBlocked,
            lastCheckAt,
            matchCount: lastResult && lastResult.matches ? lastResult.matches.length : 0,
            lastText: lastResult ? lastResult.text : '',
            hasOverlay: !!(overlayRoot && overlayRoot.childNodes && overlayRoot.childNodes.length),
          },
        };
      };
    }
    contextBridge.exposeInMainWorld('__mhLt', ltApi);
  } catch {
    /* ignore */
  }
})();

/**
 * IA experimental — atalho / leitura de campo / substituição.
 * Pedidos só pelo main; campos sensíveis e data-mh-no-ai bloqueados.
 */
(function installAiWriteClient() {
  /** @type {{ enabled: boolean, provider?: string }} */
  let cfg = { enabled: false };
  let openCount = 0;
  let blockedCount = 0;
  /** @type {Element|null} */
  let lastAiEl = null;

  function applyConfig(next) {
    if (!next || typeof next !== 'object') return;
    cfg = {
      enabled: !!next.enabled,
      provider: next.provider || '',
    };
  }

  function fieldAttrs(el) {
    if (!el || !el.tagName) return { tagName: '' };
    const tagName = String(el.tagName || '');
    const type = el.getAttribute ? el.getAttribute('type') || el.type || '' : el.type || '';
    const autocomplete =
      (el.getAttribute && el.getAttribute('autocomplete')) || el.autocomplete || '';
    const inputMode =
      (el.getAttribute && (el.getAttribute('inputmode') || el.getAttribute('inputMode'))) ||
      el.inputMode ||
      '';
    const maxLength =
      el.maxLength != null && el.maxLength >= 0
        ? el.maxLength
        : Number(el.getAttribute && el.getAttribute('maxlength')) || -1;
    const noAi =
      !!(el.getAttribute && el.getAttribute('data-mh-no-ai') != null) ||
      !!(el.dataset && el.dataset.mhNoAi != null);
    return { tagName, type, autocomplete, inputMode, maxLength, noAi, 'data-mh-no-ai': noAi };
  }

  function isBlocked(el) {
    const a = fieldAttrs(el);
    if (a.noAi) return true;
    const type = String(a.type || '').toLowerCase();
    if (type === 'password') return true;
    const ac = String(a.autocomplete || '')
      .toLowerCase()
      .trim();
    if (
      ac === 'one-time-code' ||
      ac === 'current-password' ||
      ac === 'new-password' ||
      ac.endsWith('-password') ||
      ac.indexOf('cc-') === 0
    ) {
      return true;
    }
    const im = String(a.inputMode || '').toLowerCase();
    const ml = Number(a.maxLength);
    if ((im === 'numeric' || im === 'decimal' || type === 'tel') && Number.isFinite(ml) && ml > 0 && ml <= 8) {
      return true;
    }
    return false;
  }

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    const tag = String(el.tagName).toUpperCase();
    if (tag === 'TEXTAREA') return !(el.readOnly || el.disabled);
    if (tag === 'INPUT') {
      const type = String(el.type || el.getAttribute('type') || 'text').toLowerCase();
      const ok = !type || type === 'text' || type === 'search' || type === 'url' || type === 'email';
      return ok && !(el.readOnly || el.disabled);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function readText(el) {
    if (!el) return '';
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') return String(el.value || '');
    if (el.isContentEditable) return String(el.innerText || el.textContent || '');
    return '';
  }

  function writeText(el, text) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    const value = String(text || '');
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      el.focus();
      el.innerText = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  }

  function anchorOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return {
        anchorX: Math.round(r.left),
        anchorY: Math.round(r.top),
        anchorW: Math.round(r.width) || 40,
        anchorH: Math.round(r.height) || 24,
      };
    } catch {
      return { anchorX: 40, anchorY: 40, anchorW: 40, anchorH: 24 };
    }
  }

  function readActive() {
    if (!cfg.enabled) {
      return { ok: false, error: 'disabled' };
    }
    const el = document.activeElement;
    if (!el || !el.tagName) {
      return { ok: false, error: 'no-field' };
    }
    const tag = String(el.tagName).toUpperCase();
    const isField = tag === 'TEXTAREA' || tag === 'INPUT' || !!el.isContentEditable;
    if (!isField) {
      return { ok: false, error: 'no-field' };
    }
    // Senha/OTP/etc.: detectar bloqueio antes do filtro de tipos "editáveis"
    if (isBlocked(el)) {
      blockedCount += 1;
      lastAiEl = null;
      return { ok: false, error: 'sensitive', sensitive: true, field: fieldAttrs(el) };
    }
    if (!isEditable(el)) {
      return { ok: false, error: 'no-field' };
    }
    lastAiEl = el;
    const text = readText(el);
    const a = anchorOf(el);
    return {
      ok: true,
      text,
      field: fieldAttrs(el),
      sensitive: false,
      ...a,
    };
  }

  function applyText(text) {
    let el = lastAiEl;
    if (!el || !el.isConnected) el = document.activeElement;
    if (!isEditable(el) || isBlocked(el)) return false;
    const ok = writeText(el, text);
    if (ok) lastAiEl = el;
    return ok;
  }

  async function openAi() {
    if (!cfg.enabled) {
      blockedCount += 1;
      return { ok: false, error: 'disabled' };
    }
    openCount += 1;
    try {
      return await ipcRenderer.invoke('panel:ai-open');
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  try {
    const boot = ipcRenderer.sendSync('panel:ai-sync');
    if (boot) applyConfig(boot);
  } catch {
    /* ignore */
  }
  try {
    ipcRenderer.on('mh-ai-config', (_e, payload) => applyConfig(payload));
  } catch {
    /* ignore */
  }

  if (isTopFrame()) {
    try {
      document.addEventListener(
        'keydown',
        (e) => {
          if (!cfg.enabled) return;
          const space = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
          if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || !space) return;
          e.preventDefault();
          e.stopPropagation();
          void openAi();
        },
        true
      );
    } catch {
      /* ignore */
    }
  }

  if (isTopFrame()) {
    try {
      /** @type {Record<string, unknown>} */
      const aiApi = {
        readActive,
        applyText,
        open: openAi,
        isBlocked: (sel) => {
          const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
          return isBlocked(el);
        },
      };
      if (allowSelftestApis()) {
        aiApi.getDiag = () => ({
          enabled: !!cfg.enabled,
          openCount,
          blockedCount,
        });
        /** Selftest: foca seletor e abre. */
        aiApi.openOn = async (sel) => {
          const el = sel ? document.querySelector(sel) : document.activeElement;
          if (el && typeof el.focus === 'function') el.focus();
          return openAi();
        };
      }
      contextBridge.exposeInMainWorld('__mhAi', aiApi);
    } catch {
      /* ignore */
    }
  }
})();

/** Ctrl+wheel zoom — preventDefault so page pinch-zoom does not double-apply. */
try {
  if (isTopFrame()) {
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
  }
} catch {
  /* ignore */
}

/**
 * Ctrl+left-click on a link opens a new MultiHeiz window (same area + settings).
 * Middle-click and plain click are left alone (existing blankLinkMode / window.open).
 */
try {
  if (isTopFrame()) {
    document.addEventListener(
      'click',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        if (e.button !== 0) return;
        if (e.altKey) return;
        const t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        const a = t.closest('a[href]');
        if (!a) return;
        let href = '';
        try {
          href = String(a.href || a.getAttribute('href') || '').trim();
        } catch {
          href = '';
        }
        if (!href || href === '#' || /^javascript:/i.test(href)) return;
        if (!/^https?:\/\//i.test(href)) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          ipcRenderer.send('panel:ctrl-click-link', {
            url: href,
            focus: !!(e.shiftKey),
          });
        } catch {
          /* ignore */
        }
      },
      true
    );
  }
} catch {
  /* ignore */
}

// Sonda FPS (rAF contínuo): só PROFILE ou selftest:fps.
// NÃO ligar em todo MULTIHEIZ_SELFTEST — em check:perf / idle isso mantém rAF
// 60 Hz em painéis quietos e infla cpuAvgPct. A barra de status usa a sonda UI
// (rajadas curtas em app.js). Em uso normal continua desligada.
(function startFpsProbeIfProfiling() {
  let enabled = false;
  try {
    const st = String(process.env.MULTIHEIZ_SELFTEST || '');
    enabled = !!(process.env.MULTIHEIZ_PROFILE || st === 'fps');
  } catch {
    enabled = false;
  }
  if (!enabled) return;
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
})();

/** Find-in-page bar (Ctrl+F) — DOM in isolated world, same page document. */
(function findBarUi() {
  if (!isTopFrame()) return;
  const HOST_ID = 'mh-find-bar-host';
  let host = null;
  let input = null;
  let countEl = null;
  let debounce = null;

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.getElementById(HOST_ID);
    if (host) {
      input = host.querySelector('input');
      countEl = host.querySelector('[data-role="count"]');
      return host;
    }
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-mh-find-bar', '1');
    host.style.cssText =
      'all:initial;position:fixed;top:8px;right:12px;z-index:2147483646;' +
      'display:none;font-family:Segoe UI,system-ui,sans-serif;font-size:13px;';
    const box = document.createElement('div');
    box.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px 8px;' +
      'background:#1e2430;color:#e8eaed;border-radius:8px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35);border:1px solid #3a4254;';
    input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Localizar na página';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.style.cssText =
      'width:180px;padding:4px 8px;border-radius:4px;border:1px solid #4a5568;' +
      'background:#0f1419;color:#e8eaed;outline:none;font:inherit;';
    countEl = document.createElement('span');
    countEl.setAttribute('data-role', 'count');
    countEl.style.cssText = 'min-width:4.5em;text-align:center;opacity:.85;font-variant-numeric:tabular-nums;';
    countEl.textContent = '';
    function mkBtn(label, title) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.style.cssText =
        'padding:2px 8px;border-radius:4px;border:1px solid #4a5568;' +
        'background:#2a3344;color:#e8eaed;cursor:pointer;font:inherit;';
      return b;
    }
    const prev = mkBtn('↑', 'Anterior');
    const next = mkBtn('↓', 'Próximo');
    const close = mkBtn('×', 'Fechar');
    prev.addEventListener('click', () => {
      try {
        ipcRenderer.send('mh-find-bar:from-panel', { type: 'prev' });
      } catch {
        /* ignore */
      }
    });
    next.addEventListener('click', () => {
      try {
        ipcRenderer.send('mh-find-bar:from-panel', { type: 'next' });
      } catch {
        /* ignore */
      }
    });
    close.addEventListener('click', () => {
      try {
        ipcRenderer.send('mh-find-bar:from-panel', { type: 'close' });
      } catch {
        /* ignore */
      }
    });
    input.addEventListener('input', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        try {
          ipcRenderer.send('mh-find-bar:from-panel', { type: 'query', query: input.value });
        } catch {
          /* ignore */
        }
      }, 80);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        try {
          ipcRenderer.send('mh-find-bar:from-panel', { type: 'close' });
        } catch {
          /* ignore */
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        try {
          ipcRenderer.send('mh-find-bar:from-panel', {
            type: e.shiftKey ? 'prev' : 'next',
          });
        } catch {
          /* ignore */
        }
      }
    });
    box.appendChild(input);
    box.appendChild(countEl);
    box.appendChild(prev);
    box.appendChild(next);
    box.appendChild(close);
    host.appendChild(box);
    const root = document.documentElement || document.body;
    if (root) root.appendChild(host);
    return host;
  }

  function show(query) {
    const h = ensureHost();
    if (!h) return;
    h.style.display = 'block';
    if (input) {
      if (query != null) input.value = String(query);
      try {
        input.focus();
        input.select();
      } catch {
        /* ignore */
      }
    }
  }

  function hide() {
    if (host) host.style.display = 'none';
    if (input) {
      try {
        input.blur();
      } catch {
        /* ignore */
      }
    }
  }

  function setResult(active, matches) {
    if (!countEl) return;
    const a = Number(active) || 0;
    const m = Number(matches) || 0;
    countEl.textContent = m > 0 ? a + ' / ' + m : '0 / 0';
  }

  try {
    ipcRenderer.on('mh-find-bar', (_e, msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'open') show(msg.query || '');
      else if (msg.type === 'close') hide();
      else if (msg.type === 'result') setResult(msg.active, msg.matches);
    });
  } catch {
    /* ignore */
  }
})();
