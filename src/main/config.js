'use strict';

/**
 * Empty = hide "Apoiar no Ko-fi" button / status heart.
 * Override in tests with MULTIHEIZ_KOFI_URL (incl. empty string).
 */
let KOFI_URL =
  process.env.MULTIHEIZ_KOFI_URL !== undefined
    ? process.env.MULTIHEIZ_KOFI_URL
    : 'https://ko-fi.com/HeiZz';

const APP_USER_MODEL_ID = 'com.leo.multiheiz';
const APP_DISPLAY_NAME = 'MultiHeiz';
const RELEASES_URL = 'https://github.com/leoheiz/MultiHeiz/releases/latest';

const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=%s',
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  bing: 'https://www.bing.com/search?q=%s',
};

/** First non-empty env value among keys. */
function envGet(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/** @param {string} url */
function setKofiUrlForTest(url) {
  KOFI_URL = url == null ? '' : String(url);
}

module.exports = {
  get KOFI_URL() {
    return KOFI_URL;
  },
  setKofiUrlForTest,
  APP_USER_MODEL_ID,
  APP_DISPLAY_NAME,
  RELEASES_URL,
  SEARCH_ENGINES,
  envGet,
};
