'use strict';

/**
 * Pure helpers for Chrome Web Store / Edge Add-ons detail URLs and CRX update URLs.
 * No Electron/network deps — unit-testable.
 */

const CHROME_ID_RE = /^[a-p]{32}$/i;

/**
 * @param {string} hostname
 * @returns {string}
 */
function normalizeHost(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^www\./, '');
}

/**
 * Selftest/dev only: MULTIHEIZ_WEBSTORE_TEST_BASE when MULTIHEIZ_SELFTEST is set.
 * @returns {string|null} origin without trailing slash
 */
function webstoreTestBase() {
  if (!process.env.MULTIHEIZ_SELFTEST) return null;
  const raw = String(process.env.MULTIHEIZ_WEBSTORE_TEST_BASE || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Parse a store detail page URL (not bare IDs).
 * @param {string} url
 * @returns {{ store: 'chrome'|'edge', id: string } | null}
 */
function parseStoreUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  const testBase = webstoreTestBase();
  if (testBase) {
    try {
      const tb = new URL(testBase);
      if (u.origin === tb.origin) {
        // /detail/<slug>/<id> | /detail/<id> | /addons/detail/<slug>/<id>
        const m = u.pathname.match(
          /\/(?:addons\/)?detail\/(?:[^/]+\/)?([a-p]{32})(?:\/|$)/i
        );
        if (m && m[1] && CHROME_ID_RE.test(m[1])) {
          const storeParam = (u.searchParams.get('store') || 'chrome').toLowerCase();
          const store = storeParam === 'edge' ? 'edge' : 'chrome';
          return { store, id: m[1].toLowerCase() };
        }
      }
    } catch {
      /* ignore */
    }
  }

  const host = normalizeHost(u.hostname);

  if (host === 'chrome.google.com' || host === 'chromewebstore.google.com') {
    // /detail/<slug>/<id> or /detail/<id>
    const m = u.pathname.match(/\/detail\/(?:[^/]+\/)?([a-p]{32})(?:\/|$)/i);
    const id = (m && m[1]) || u.searchParams.get('id');
    if (id && CHROME_ID_RE.test(id)) {
      return { store: 'chrome', id: id.toLowerCase() };
    }
  }

  if (host === 'microsoftedge.microsoft.com' || host === 'edge.microsoft.com') {
    const m = u.pathname.match(
      /\/addons\/detail\/(?:[^/]+\/)?([a-p]{32})(?:\/|$)/i
    );
    if (m && m[1] && CHROME_ID_RE.test(m[1])) {
      return { store: 'edge', id: m[1].toLowerCase() };
    }
  }

  return null;
}

/**
 * Official CRX update/download URL (may redirect).
 * @param {'chrome'|'edge'} store
 * @param {string} id
 * @param {string} [chromeVersion]
 * @returns {string}
 */
function crxUrlFor(store, id, chromeVersion) {
  const extId = String(id || '').toLowerCase();
  const testBase = webstoreTestBase();
  if (testBase) {
    const q = new URLSearchParams({
      response: 'redirect',
      store: store === 'edge' ? 'edge' : 'chrome',
      id: extId,
    });
    return testBase + '/crx?' + q.toString();
  }
  if (store === 'edge') {
    const x = encodeURIComponent(`id=${extId}&installsource=ondemand&uc`);
    return (
      'https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=' +
      x
    );
  }
  const prod = encodeURIComponent(chromeVersion || '137.0.0.0');
  const x = encodeURIComponent(`id=${extId}&uc`);
  return (
    'https://clients2.google.com/service/update2/crx?response=redirect' +
    `&prodversion=${prod}&acceptformat=crx2,crx3&x=${x}`
  );
}

/**
 * Hosts allowed for CRX download redirects (HTTPS).
 * @param {string} hostname
 * @returns {boolean}
 */
function isAllowedCrxDownloadHost(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return false;

  const testBase = webstoreTestBase();
  if (testBase) {
    try {
      const tb = new URL(testBase);
      if (normalizeHost(tb.hostname) === h) return true;
    } catch {
      /* ignore */
    }
  }

  if (h === 'clients2.google.com' || h === 'clients2.googleusercontent.com') {
    return true;
  }
  if (h.endsWith('.gvt1.com') || h === 'gvt1.com') return true;
  if (h === 'edge.microsoft.com') return true;
  if (h.endsWith('.microsoft.com') || h === 'microsoft.com') return true;
  // CDN host used by Edge extension delivery
  if (h.includes('dl.delivery.mp.microsoft.com')) return true;
  return false;
}

module.exports = {
  CHROME_ID_RE,
  parseStoreUrl,
  crxUrlFor,
  webstoreTestBase,
  isAllowedCrxDownloadHost,
  normalizeHost,
};
