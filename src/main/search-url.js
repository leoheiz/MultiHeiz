'use strict';

const { SEARCH_ENGINES } = require('./config');
const { isNavigableUrl } = require('./url-policy');

function looksLikeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return true;
  if (/\s/.test(s)) return false;
  if (/^localhost(:\d+)?(\/|$)/i.test(s)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return true;
  // domain.tld or subdomain.domain.tld
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?(\/.*)?$/i.test(s)) {
    return true;
  }
  return false;
}

/**
 * Build search URL for omnibox query text.
 * @param {string} raw
 * @param {{ searchEngine?: string, searchTemplate?: string }} settings
 */
function toSearchUrl(raw, settings = {}) {
  const engine = settings.searchEngine || 'google';
  let template =
    engine === 'custom' && settings.searchTemplate
      ? String(settings.searchTemplate)
      : SEARCH_ENGINES[engine] || SEARCH_ENGINES.google;
  if (!template.includes('%s')) template = `${template}%s`;
  const q = encodeURIComponent(raw);
  return template.replace(/%s/g, q);
}

/**
 * Resolve omnibox input to a navigable URL using settings search engine.
 * Only http/https navigate; other schemes become a search query.
 * @param {string} input
 * @param {{ searchEngine?: string, searchTemplate?: string }} settings
 */
function resolveNavigateUrl(input, settings = {}) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (looksLikeUrl(raw)) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      if (isNavigableUrl(raw)) return raw;
      // file:, javascript:, data:, mailto:, etc. → search, never navigate
      return toSearchUrl(raw, settings);
    }
    return `https://${raw}`;
  }
  return toSearchUrl(raw, settings);
}

module.exports = {
  looksLikeUrl,
  resolveNavigateUrl,
  toSearchUrl,
  SEARCH_ENGINES,
};
