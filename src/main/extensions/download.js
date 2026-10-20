'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');
const {
  CHROME_ID_RE,
  parseStoreUrl,
  crxUrlFor,
  webstoreTestBase,
  isAllowedCrxDownloadHost,
  normalizeHost,
} = require('./webstore');

const EDGE_ID_RE = /^[a-z0-9]{32}$/i;
const MAX_REDIRECTS = 5;
const MAX_CRX_BYTES = 100 * 1024 * 1024; // 100 MB

/** Edge CDN regional HTTP hosts (e.g. f.tlu) — rewrite to HTTPS sf.tlu. */
const EDGE_CDN_HTTP_HOST_RE =
  /^msedgeextensions\.[a-z0-9]+\.tlu\.dl\.delivery\.mp\.microsoft\.com$/i;
const EDGE_CDN_HTTPS_HOST = 'msedgeextensions.sf.tlu.dl.delivery.mp.microsoft.com';

/**
 * Edge Add-ons update URL may 302 to http://msedgeextensions.<region>.tlu.…
 * That host lacks a valid HTTPS cert; the same path+query works on sf.tlu via HTTPS.
 * Mutates `parsed` in place when rewritten.
 * @param {URL} parsed
 * @returns {boolean}
 */
function rewriteEdgeCrxHttpRedirect(parsed) {
  if (parsed.protocol !== 'http:') return false;
  const host = normalizeHost(parsed.hostname);
  if (!EDGE_CDN_HTTP_HOST_RE.test(host)) return false;
  parsed.protocol = 'https:';
  parsed.hostname = EDGE_CDN_HTTPS_HOST;
  return true;
}

/**
 * @param {string} input URL or bare ID
 * @returns {{ store: 'chrome'|'edge', id: string } | null}
 */
function parseStoreInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const fromUrl = parseStoreUrl(raw);
  if (fromUrl) return fromUrl;

  // Bare id (legacy install-by-id)
  if (CHROME_ID_RE.test(raw)) {
    return { store: 'chrome', id: raw.toLowerCase() };
  }
  if (EDGE_ID_RE.test(raw)) {
    return { store: 'edge', id: raw.toLowerCase() };
  }
  return null;
}

/**
 * @param {string} id
 * @param {string} chromeVersion
 */
function chromeUpdateUrl(id, chromeVersion) {
  return crxUrlFor('chrome', id, chromeVersion);
}

/**
 * @param {string} id
 */
function edgeUpdateUrl(id) {
  return crxUrlFor('edge', id);
}

/**
 * Reject unsafe redirect targets. Production: HTTPS + allowlisted hosts.
 * Selftest + MULTIHEIZ_WEBSTORE_TEST_BASE: also allow that origin (http loopback OK).
 * Edge CDN: http://msedgeextensions.<region>.tlu.… → https://…sf.tlu… (path+query kept).
 * May mutate `parsed` (Edge HTTP→HTTPS rewrite).
 * @param {URL} parsed
 */
function assertAllowedCrxUrl(parsed) {
  rewriteEdgeCrxHttpRedirect(parsed);
  const host = normalizeHost(parsed.hostname);
  const testBase = webstoreTestBase();
  if (testBase) {
    try {
      const tb = new URL(testBase);
      if (parsed.origin === tb.origin) {
        if (tb.protocol === 'http:' || tb.protocol === 'https:') return;
      }
    } catch {
      /* fall through */
    }
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Download CRX exige HTTPS (redirect HTTP rejeitado)');
  }
  if (!isAllowedCrxDownloadHost(host)) {
    throw new Error('Host de download CRX não permitido: ' + host);
  }
}

/**
 * Follow redirects and return body buffer (size-capped).
 * @param {string} url
 * @param {number} [maxRedirects]
 * @returns {Promise<Buffer>}
 */
function fetchBuffer(url, maxRedirects = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const go = (u, left) => {
      let parsed;
      try {
        parsed = new URL(u);
      } catch (err) {
        reject(err);
        return;
      }
      try {
        assertAllowedCrxUrl(parsed);
      } catch (err) {
        reject(err);
        return;
      }
      // Use (possibly rewritten) URL after Edge CDN HTTP→HTTPS fix
      u = parsed.href;
      const lib = parsed.protocol === 'http:' ? http : https;
      const req = lib.get(
        u,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            Accept: '*/*',
          },
        },
        (res) => {
          const code = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
            res.resume();
            if (left <= 0) {
              reject(new Error('Muitos redirecionamentos no download CRX'));
              return;
            }
            let next;
            try {
              next = new URL(res.headers.location, u);
            } catch (err) {
              reject(err);
              return;
            }
            go(next.href, left - 1);
            return;
          }
          if (code < 200 || code >= 300) {
            res.resume();
            reject(new Error(`Download CRX falhou HTTP ${code}`));
            return;
          }
          const declared = Number(res.headers['content-length']) || 0;
          if (declared > MAX_CRX_BYTES) {
            res.resume();
            reject(new Error('Download CRX excede limite de 100 MB'));
            return;
          }
          /** @type {Buffer[]} */
          const chunks = [];
          let total = 0;
          res.on('data', (c) => {
            total += c.length;
            if (total > MAX_CRX_BYTES) {
              req.destroy();
              reject(new Error('Download CRX excede limite de 100 MB'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy(new Error('Timeout no download CRX'));
      });
    };
    go(url, maxRedirects);
  });
}

/**
 * @param {'chrome'|'edge'} store
 * @param {string} id
 * @param {string} [chromeVersion]
 */
async function downloadCrx(store, id, chromeVersion) {
  const url =
    store === 'edge'
      ? crxUrlFor('edge', id)
      : crxUrlFor('chrome', id, chromeVersion);
  const buf = await fetchBuffer(url);
  if (!buf.length) throw new Error('CRX vazio');
  return { buffer: buf, url, store, id };
}

module.exports = {
  parseStoreInput,
  parseStoreUrl,
  crxUrlFor,
  chromeUpdateUrl,
  edgeUpdateUrl,
  downloadCrx,
  fetchBuffer,
  assertAllowedCrxUrl,
  rewriteEdgeCrxHttpRedirect,
  isAllowedCrxDownloadHost,
  CHROME_ID_RE,
  MAX_CRX_BYTES,
  MAX_REDIRECTS,
  EDGE_CDN_HTTPS_HOST,
};
