'use strict';

/**
 * Detect Chrome Web Store / Edge Add-ons detail pages in panel navigations
 * and drive the MultiHeiz install bar (renderer chrome) + best-effort CSS hide
 * of the store's own install / unsupported-browser UI.
 */

const { parseStoreUrl } = require('./webstore');
const store = require('./store');

/** @type {((p: object) => void) | null} */
let emitFn = null;

/** @type {Map<string, { store: string, id: string, key: string }>} accountId -> offer */
const offers = new Map();

/** CSS keys already injected per webContents id */
const cssInjected = new WeakSet();

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
    injectHideCss(wc).catch(() => {});
  }
  return offer;
}

/**
 * @param {Electron.WebContents} wc
 */
async function injectHideCss(wc) {
  if (cssInjected.has(wc)) return;
  try {
    await wc.insertCSS(HIDE_STORE_CSS, { cssOrigin: 'user' });
    cssInjected.add(wc);
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
