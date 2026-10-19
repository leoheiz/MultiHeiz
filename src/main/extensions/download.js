'use strict';

const https = require('node:https');
const { URL } = require('node:url');

const CHROME_ID_RE = /^[a-p]{32}$/i;
const EDGE_ID_RE = /^[a-z0-9]{32}$/i;
const MAX_REDIRECTS = 5;
const MAX_CRX_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * @param {string} input
 * @returns {{ store: 'chrome'|'edge', id: string } | null}
 */
function parseStoreInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'chrome.google.com' || host === 'chromewebstore.google.com') {
      const m = u.pathname.match(/\/detail\/(?:[^/]+\/)?([a-p]{32})/i);
      const id = (m && m[1]) || u.searchParams.get('id');
      if (id && CHROME_ID_RE.test(id)) {
        return { store: 'chrome', id: id.toLowerCase() };
      }
    }
    if (
      host === 'microsoftedge.microsoft.com' ||
      host === 'edge.microsoft.com'
    ) {
      const m = u.pathname.match(/\/addon\/(?:[^/]+\/)?([a-z0-9]{32})/i);
      if (m && m[1]) return { store: 'edge', id: m[1].toLowerCase() };
    }
  } catch {
    /* not a URL — treat as bare id */
  }

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
  const prod = encodeURIComponent(chromeVersion || '137.0.0.0');
  const x = encodeURIComponent(`id=${id}&uc`);
  return (
    `https://clients2.google.com/service/update2/crx?response=redirect` +
    `&prodversion=${prod}&acceptformat=crx2,crx3&x=${x}`
  );
}

/**
 * @param {string} id
 */
function edgeUpdateUrl(id) {
  const x = encodeURIComponent(`id=${id}&installsource=ondemand&uc`);
  return `https://edge.microsoft.com/extensionwebstorebase/v1/crx?response=redirect&x=${x}`;
}

/**
 * Follow HTTPS-only redirects and return body buffer (size-capped).
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
      if (parsed.protocol !== 'https:') {
        reject(new Error('Download CRX exige HTTPS (redirect HTTP rejeitado)'));
        return;
      }
      const req = https.get(
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
            if (next.protocol !== 'https:') {
              reject(new Error('Download CRX exige HTTPS (redirect HTTP rejeitado)'));
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
    store === 'edge' ? edgeUpdateUrl(id) : chromeUpdateUrl(id, chromeVersion);
  const buf = await fetchBuffer(url);
  if (!buf.length) throw new Error('CRX vazio');
  return { buffer: buf, url, store, id };
}

module.exports = {
  parseStoreInput,
  chromeUpdateUrl,
  edgeUpdateUrl,
  downloadCrx,
  fetchBuffer,
  CHROME_ID_RE,
  MAX_CRX_BYTES,
  MAX_REDIRECTS,
};
