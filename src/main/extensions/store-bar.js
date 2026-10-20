'use strict';

/**
 * Detect Chrome Web Store / Edge Add-ons detail pages in panel navigations
 * and drive the MultiHeiz install bar (renderer chrome) + best-effort CSS/JS hide
 * of the store's own install / unsupported-browser UI.
 */

const { parseStoreUrl, webstoreTestBase } = require('./webstore');
const store = require('./store');

/** @type {((p: object) => void) | null} */
let emitFn = null;

/** @type {Map<string, { store: string, id: string, key: string }>} accountId -> offer */
const offers = new Map();

const HIDE_STORE_CSS = `
/* MultiHeiz: hide store native install / unsupported banners (best-effort) */
button[aria-label*="Chrome" i],
button[aria-label*="Adicionar" i],
button[aria-label*="Add to" i],
button[aria-label*="Usar no" i],
a[aria-label*="Chrome" i],
[role="button"][aria-label*="Chrome" i],
[role="button"][aria-label*="Adicionar ao Chrome" i],
[role="button"][aria-label*="Add to Chrome" i],
[role="button"][aria-label*="Obter" i],
[role="button"][aria-label*="Get" i] {
  /* keep layout; prefer hiding known CTAs below */
}
/* Chrome Web Store — primary install CTA / switch banner */
div[role="dialog"],
.webstore-test-unsupported,
[class*="Unsupported"],
[class*="unsupported"],
[class*="Unavailable"],
[data-test-id*="unsupported" i],
[jsname] button[jsaction*="install" i] {
}
/* Broad host-only heuristics — hide common unsupported banners */
body [class*="banner"][class*="chrome" i],
body [class*="Banner"] {
}
/* Target frequent CWS / Edge strings via attribute contains */
button:is(
  [aria-label*="Usar no Chrome" i],
  [aria-label*="Adicionar ao Chrome" i],
  [aria-label*="Add to Chrome" i],
  [aria-label*="Obter" i],
  [aria-label*="Get" i]
),
a:is(
  [aria-label*="Usar no Chrome" i],
  [aria-label*="Adicionar ao Chrome" i],
  [aria-label*="Add to Chrome" i]
) {
  visibility: hidden !important;
  pointer-events: none !important;
  opacity: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
}
`;

/**
 * Allowed hostnames for the in-page hide script (real stores + optional selftest base).
 * @returns {string[]}
 */
function hideScriptHosts() {
  const hosts = [
    'chromewebstore.google.com',
    'chrome.google.com',
    'microsoftedge.microsoft.com',
    'edge.microsoft.com',
  ];
  try {
    const tb = webstoreTestBase();
    if (tb) {
      const h = new URL(tb).hostname.toLowerCase();
      if (h && !hosts.includes(h)) hosts.push(h);
    }
  } catch {
    /* ignore */
  }
  return hosts;
}

/**
 * Idempotent page script: hide native install CTAs / small incompatible-browser banners.
 * Host allowlist is inlined at inject time (no external data eval).
 */
function buildHideStoreScript() {
  const hostsJson = JSON.stringify(hideScriptHosts());
  return `(() => {
  try {
    if (window.__mhStoreHide) return;
    var hosts = ${hostsJson};
    var host = String(location.hostname || '').toLowerCase().replace(/^www\\./, '');
    if (hosts.indexOf(host) < 0) return;
    var path = String(location.pathname || '');
    if (!/\\/(?:addons\\/)?detail\\//i.test(path)) return;
    window.__mhStoreHide = true;
    var CTA_RE = /^(Add to Chrome|Adicionar ao Chrome|Usar no Chrome|Remove from Chrome|Remover do Chrome|Get|Obter|Remove|Remover)$/i;
    var BANNER_RE = /Switch to Chrome|Mudar para o Chrome|não é compatível|nao e compativel|not compatible/i;
    var timer = null;
    function visibleText(el) {
      try {
        return String(el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
      } catch (e) {
        return '';
      }
    }
    function hideEl(el) {
      try {
        el.style.setProperty('display', 'none', 'important');
      } catch (e) { /* ignore */ }
    }
    function sweep() {
      try {
        var nodes = document.querySelectorAll('button, a, [role="button"]');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var t = visibleText(el);
          if (!t || t.length >= 60) continue;
          if (CTA_RE.test(t)) hideEl(el);
        }
        var all = document.querySelectorAll('div, section, aside, p, span');
        for (var j = 0; j < all.length; j++) {
          var b = all[j];
          var bt = visibleText(b);
          if (!bt || bt.length >= 200) continue;
          if (BANNER_RE.test(bt)) hideEl(b);
        }
      } catch (e) { /* ignore */ }
    }
    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        sweep();
      }, 150);
    }
    sweep();
    try {
      var mo = new MutationObserver(schedule);
      mo.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
})();`;
}

/**
 * @param {{ emit?: (p: object) => void }} deps
 */
function init(deps) {
  emitFn = deps && typeof deps.emit === 'function' ? deps.emit : null;
}

function emit(payload) {
  if (emitFn) emitFn(payload);
}

/**
 * @param {string} id store / extension id
 */
function findInstalledByStoreId(id) {
  const needle = String(id || '').toLowerCase();
  if (!needle) return null;
  return (
    store.listRecords().find(
      (r) =>
        (r.storeId && String(r.storeId).toLowerCase() === needle) ||
        String(r.id).toLowerCase() === needle
    ) || null
  );
}

/**
 * @param {string} accountId
 * @param {string} url
 * @param {Electron.WebContents} [wc]
 */
function onPanelUrl(accountId, url, wc) {
  const parsed = parseStoreUrl(url);
  if (!parsed) {
    if (offers.has(accountId)) {
      offers.delete(accountId);
      emit({ type: 'extensions:store-offer', accountId, offer: null });
    }
    return null;
  }

  const key = parsed.store + ':' + parsed.id;
  const installed = findInstalledByStoreId(parsed.id);
  const offer = {
    store: parsed.store,
    id: parsed.id,
    installed: !!installed,
    extensionId: installed ? installed.id : null,
    name: installed ? installed.name : null,
  };
  offers.set(accountId, { store: parsed.store, id: parsed.id, key });
  emit({ type: 'extensions:store-offer', accountId, offer });

  if (wc && !wc.isDestroyed()) {
    injectHideUi(wc).catch(() => {});
  }
  return offer;
}

/**
 * Re-inject CSS + hide script on every detail navigation (insertCSS is lost on
 * full document loads; the page script uses window.__mhStoreHide as SPA guard).
 * @param {Electron.WebContents} wc
 */
async function injectHideUi(wc) {
  if (!wc || wc.isDestroyed()) return;
  try {
    await wc.insertCSS(HIDE_STORE_CSS, { cssOrigin: 'user' });
  } catch {
    /* ignore — best effort */
  }
  try {
    await wc.executeJavaScript(buildHideStoreScript());
  } catch {
    /* ignore — best effort */
  }
}

/**
 * @param {string} accountId
 */
function getOffer(accountId) {
  const o = offers.get(accountId);
  if (!o) return null;
  const installed = findInstalledByStoreId(o.id);
  return {
    store: o.store,
    id: o.id,
    installed: !!installed,
    extensionId: installed ? installed.id : null,
    name: installed ? installed.name : null,
  };
}

/**
 * Re-emit offer for an account after install/remove.
 * @param {string} accountId
 */
function refreshOffer(accountId) {
  const o = offers.get(accountId);
  if (!o) {
    emit({ type: 'extensions:store-offer', accountId, offer: null });
    return;
  }
  const installed = findInstalledByStoreId(o.id);
  emit({
    type: 'extensions:store-offer',
    accountId,
    offer: {
      store: o.store,
      id: o.id,
      installed: !!installed,
      extensionId: installed ? installed.id : null,
      name: installed ? installed.name : null,
    },
  });
}

/**
 * @param {string} accountId
 * @param {'idle'|'downloading'|'installing'|'done'|'error'} status
 * @param {string} [message]
 */
function emitProgress(accountId, status, message) {
  emit({
    type: 'extensions:store-progress',
    accountId,
    status,
    message: message || '',
  });
}

function clearAccount(accountId) {
  offers.delete(accountId);
}

module.exports = {
  init,
  onPanelUrl,
  getOffer,
  refreshOffer,
  emitProgress,
  findInstalledByStoreId,
  clearAccount,
};
