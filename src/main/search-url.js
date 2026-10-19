'use strict';

const { SEARCH_ENGINES } = require('./config');

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
 * Resolve omnibox input to a navigable URL using settings search engine.
 * @param {string} input
 * @param {{ searchEngine?: string, searchTemplate?: string }} settings
 */
function resolveNavigateUrl(input, settings = {}) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (looksLikeUrl(raw)) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
    return `https://${raw}`;
  }
  const engine = settings.searchEngine || 'google';
  let template =
    engine === 'custom' && settings.searchTemplate
      ? String(settings.searchTemplate)
      : SEARCH_ENGINES[engine] || SEARCH_ENGINES.google;
  if (!template.includes('%s')) template = `${template}%s`;
  const q = encodeURIComponent(raw);
  return template.replace(/%s/g, q);
}

module.exports = {
  looksLikeUrl,
  resolveNavigateUrl,
  SEARCH_ENGINES,
};
