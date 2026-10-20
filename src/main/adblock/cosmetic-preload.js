'use strict';

/**
 * Session-level cosmetic preload (all frames, including iframes).
 * v1.8: scriptlets + base CSS injected synchronously into MAIN WORLD at document
 * start via sendSync + contextBridge.executeInMainWorld (before page scripts).
 */

const { ipcRenderer, contextBridge } = require('electron');

const SCRIPT_ID = 'ghostery-adblocker-script';
const IGNORED_TAGS = new Set(['br', 'head', 'link', 'meta', 'script', 'style', 's']);

function debounce(fn, { waitFor, maxWait }) {
  let delayedTimer;
  let maxWaitTimer;
  const clear = () => {
    clearTimeout(delayedTimer);
    clearTimeout(maxWaitTimer);
    delayedTimer = undefined;
    maxWaitTimer = undefined;
  };
  const run = () => {
    clear();
    fn();
  };
  return [
    () => {
      if (maxWaitTimer === undefined) {
        maxWaitTimer = setTimeout(run, maxWait);
      }
      clearTimeout(delayedTimer);
      delayedTimer = setTimeout(run, waitFor);
    },
    clear,
  ];
}

function isElement(node) {
  return node.nodeType === 1;
}

function getElementsFromMutations(mutations) {
  const elements = [];
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') {
      if (isElement(mutation.target)) elements.push(mutation.target);
    } else if (mutation.type === 'childList') {
      for (const addedNode of mutation.addedNodes) {
        if (isElement(addedNode) && addedNode.id !== SCRIPT_ID) {
          elements.push(addedNode);
        }
      }
    }
  }
  return elements;
}

function extractFeaturesFromDOM(roots = [document.documentElement]) {
  const ignoredTags = new Set(['br', 'head', 'link', 'meta', 'script', 'style', 's']);
  const classes = new Set();
  const hrefs = new Set();
  const ids = new Set();
  const seenElements = new Set();
  for (const root of roots) {
    for (const element of [
      root,
      ...root.querySelectorAll(
        '[id]:not(html):not(body),[class]:not(html):not(body),[href]:not(html):not(body)'
      ),
    ]) {
      if (seenElements.has(element)) continue;
      seenElements.add(element);
      if (ignoredTags.has(element.nodeName.toLowerCase())) continue;
      const id = element.getAttribute('id');
      if (typeof id === 'string') ids.add(id);
      for (const classEntry of element.classList) classes.add(classEntry);
      const href = element.getAttribute('href');
      if (typeof href === 'string') hrefs.add(href);
    }
  }
  return {
    classes: Array.from(classes),
    hrefs: Array.from(hrefs),
    ids: Array.from(ids),
  };
}

class DOMMonitor {
  constructor(cb) {
    this.cb = cb;
    this.knownIds = new Set();
    this.knownHrefs = new Set();
    this.knownClasses = new Set();
    this.observer = null;
  }

  queryAll(windowRef) {
    this.cb({ type: 'elements', elements: [windowRef.document.documentElement] });
    this.handleUpdatedNodes([windowRef.document.documentElement]);
  }

  start(windowRef) {
    if (this.observer === null && windowRef.MutationObserver !== undefined) {
      const nodes = new Set();
      const handleUpdatedNodesCallback = () => {
        this.handleUpdatedNodes(Array.from(nodes));
        nodes.clear();
      };
      const [debouncedHandleUpdatedNodes, cancelHandleUpdatedNodes] = debounce(
        handleUpdatedNodesCallback,
        { waitFor: 25, maxWait: 1000 }
      );
      this.observer = new windowRef.MutationObserver((mutations) => {
        getElementsFromMutations(mutations).forEach(nodes.add, nodes);
        if (nodes.size > 512) {
          cancelHandleUpdatedNodes();
          handleUpdatedNodesCallback();
        } else {
          debouncedHandleUpdatedNodes();
        }
      });
      this.observer.observe(windowRef.document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'id', 'href'],
        childList: true,
        subtree: true,
      });
    }
  }

  stop() {
    if (this.observer !== null) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  handleNewFeatures({ hrefs, ids, classes }) {
    const newIds = [];
    const newClasses = [];
    const newHrefs = [];
    for (const id of ids) {
      if (!this.knownIds.has(id)) {
        newIds.push(id);
        this.knownIds.add(id);
      }
    }
    for (const cls of classes) {
      if (!this.knownClasses.has(cls)) {
        newClasses.push(cls);
        this.knownClasses.add(cls);
      }
    }
    for (const href of hrefs) {
      if (!this.knownHrefs.has(href)) {
        newHrefs.push(href);
        this.knownHrefs.add(href);
      }
    }
    if (newIds.length !== 0 || newClasses.length !== 0 || newHrefs.length !== 0) {
      this.cb({ type: 'features', classes: newClasses, hrefs: newHrefs, ids: newIds });
      return true;
    }
    return false;
  }

  handleUpdatedNodes(elements) {
    if (elements.length !== 0) {
      this.cb({
        type: 'elements',
        elements: elements.filter((e) => IGNORED_TAGS.has(e.nodeName.toLowerCase()) === false),
      });
      return this.handleNewFeatures(extractFeaturesFromDOM(elements));
    }
    return false;
  }
}

/**
 * Trusted-Types-safe UA/CH patch (no new Function / <script>).
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
    /* executeInMainWorld unavailable */
  }
}

/** Windows passkeys OFF: reject publicKey WebAuthn without opening OS dialog. */
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

/**
 * Synchronous document-start injection (MAIN WORLD) before page scripts.
 * Measured path: sendSync roundtrip + executeInMainWorld (no async IPC).
 */

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
    return { early: false, syncMs: t1 - t0, scripts: 0 };
  }
  if (payload.styles) {
    injectInMainWorld(styleInjectSource('mh-adblock-css-early', payload.styles, 'append'));
  }
  for (const script of payload.scripts || []) {
    injectInMainWorld(script);
  }
  if (payload.uaPatchData) {
    applyUaPatchData(payload.uaPatchData);
  } else if (payload.uaPatch) {
    injectInMainWorld(payload.uaPatch);
  }
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
      hasStyles: !!payload.styles,
    });
  } catch {
    /* ignore */
  }
  return {
    early: true,
    syncMs: t1 - t0,
    injectMs: t2 - t1,
    scripts: (payload.scripts || []).length,
  };
}

function injectCosmeticFilters(data) {
  return ipcRenderer.invoke(
    '@ghostery/adblocker/inject-cosmetic-filters',
    window.location.href,
    data
  );
}

if (window.location.href.startsWith('devtools://') === false) {
  (() => {
    const earlyInfo = injectEarlySync();
    let DOM_MONITOR = null;
    const unload = () => {
      if (DOM_MONITOR !== null) {
        DOM_MONITOR.stop();
        DOM_MONITOR = null;
      }
    };
    // Async path: CSS refresh + DOM-feature rules. Skip re-running hostname scriptlets
    // when early sync already applied them (flag via lifecycle).
    injectCosmeticFilters({
      lifecycle: earlyInfo.early ? 'post-early' : 'document-start',
      earlyScripts: earlyInfo.scripts || 0,
    });
    window.addEventListener(
      'DOMContentLoaded',
      () => {
        DOM_MONITOR = new DOMMonitor((update) => {
          if (update.type === 'features') {
            injectCosmeticFilters({ ...update, lifecycle: 'mutation' });
          }
        });
        DOM_MONITOR.queryAll(window);
        ipcRenderer
          .invoke('@ghostery/adblocker/is-mutation-observer-enabled')
          .then((enableMutationObserver) => enableMutationObserver && DOM_MONITOR?.start(window));
      },
      { once: true, passive: true }
    );
    window.addEventListener('unload', unload, { once: true, passive: true });
  })();
}
