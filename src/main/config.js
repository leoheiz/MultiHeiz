'use strict';

/**
 * Empty = hide "Apoiar o desenvolvedor (Ko-fi)" button / status heart.
 * Override in tests with MULTIHEIZ_KOFI_URL (incl. empty string).
 */
let KOFI_URL =
  process.env.MULTIHEIZ_KOFI_URL !== undefined
    ? process.env.MULTIHEIZ_KOFI_URL
    : 'https://ko-fi.com/HeiZz';

/** Production AUMID (must match package.json build.appId / NSIS APP_ID). */
const APP_USER_MODEL_ID = 'com.leo.multiheiz';
/** Dev/selftest AUMID — never share production ID (avoids Start Menu merge with installed app). */
const APP_USER_MODEL_ID_DEV = 'com.leo.multiheiz.dev';
const APP_DISPLAY_NAME = 'MultiHeiz';
const RELEASES_URL = 'https://github.com/leoheiz/MultiHeiz/releases/latest';

/**
 * AUMID for the current process. Unpackaged (npm start / selftests) uses .dev so
 * Electron.exe never registers the same AppUserModelID as the installed MultiHeiz
 * (that collision made Windows Search prefer Electron.lnk over the real app).
 * @returns {string}
 */
function resolveAppUserModelId() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged === false) return APP_USER_MODEL_ID_DEV;
  } catch {
    /* ignore */
  }
  return APP_USER_MODEL_ID;
}

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
  APP_USER_MODEL_ID_DEV,
  APP_DISPLAY_NAME,
  RELEASES_URL,
  SEARCH_ENGINES,
  envGet,
  resolveAppUserModelId,
};
