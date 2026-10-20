'use strict';

/**
 * Chrome-compatible User-Agent + Client Hints for MultiHeiz panels.
 * Rebuilds a clean Chrome UA (no Electron/app tokens); patches navigator via
 * structured data (Trusted-Types safe — no new Function / script tags).
 *
 * Google accounts.google.com exception (Electron 44 / Chrome 152):
 * Spoofing a stock Chrome UA routes GlifWebSignIn into Botguard (rrk=46 /
 * "This browser or app may not be secure"). For Google auth hosts only we send
 * Electron's UA without the app name, Chromium client-hints (no "Google Chrome"
 * brand claim), and matching navigator patch data.
 */

const { app, session } = require('electron');
const hub = require('./adblock/web-request-hub');

const HUB_ID = 'ua-client-hints';
const GOOGLE_FLOW_HUB_ID = 'ua-google-signin-flow';

/** GREASE brand used by Chromium 120+ / Chrome 152 (matches Electron native brands). */
const GREASE_BRAND = 'Not?A_Brand';
const GREASE_MAJOR = '24';
const GREASE_FULL = '10.0.0.0';

/** @type {Set<Electron.Session>} */
const hookedSessions = new Set();

function readIdentity() {
  try {
    const { getState } = require('./state');
    const id = (getState().settings && getState().settings.uaIdentity) || 'chrome';
    return id === 'edge' ? 'edge' : 'chrome';
  } catch {
    return 'chrome';
  }
}

function chromiumVersionFromUa(ua) {
  const m = String(ua || '').match(/Chrome\/([\d.]+)/i);
  if (m) return m[1];
  try {
    if (process.versions && process.versions.chrome) return process.versions.chrome;
  } catch {
    /* ignore */
  }
  return '152.0.0.0';
}

function majorFromVersion(v) {
  const n = parseInt(String(v).split('.')[0], 10);
  return Number.isFinite(n) ? n : 152;
}

function platformUaPrefix() {
  if (process.platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
  }
  if (process.platform === 'linux') {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)';
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)';
}

/**
 * @param {string} [baseUa]
 */
function resolveChromeVersion(baseUa) {
  if (baseUa && /Chrome\//i.test(baseUa)) {
    return chromiumVersionFromUa(baseUa);
  }
  try {
    if (process.versions && process.versions.chrome) return process.versions.chrome;
  } catch {
    /* ignore */
  }
  try {
    return chromiumVersionFromUa(session.defaultSession.getUserAgent());
  } catch {
    return '152.0.0.0';
  }
}

/**
 * True for Google authentication hosts where Chrome-UA spoofing triggers Botguard.
 * @param {string} [url]
 */
function isGoogleAuthUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const h = u.hostname.toLowerCase();
    if (h === 'accounts.google.com') return true;
    if (h === 'account.google.com') return true;
    if (h.endsWith('.google.com') && /\/(?:signin|o\/oauth2|accounts\/oauth)/i.test(u.pathname)) {
      return true;
    }
    return false;
  } catch {
    return /accounts\.google\.com/i.test(String(url || ''));
  }
}

/**
 * Electron UA without MultiHeiz/app product token (keeps Electron/ for Google auth).
 */
function buildGoogleAuthUserAgent() {
  const chromeVer = resolveChromeVersion();
  let electronVer = (process.versions && process.versions.electron) || '';
  if (!electronVer) {
    try {
      electronVer = app.getVersion();
    } catch {
      electronVer = '0.0.0';
    }
  }
  return `${platformUaPrefix()} Chrome/${chromeVer} Electron/${electronVer} Safari/537.36`;
}

/**
 * Build a clean Chrome/Edge UA (never includes Electron/, MultiHeiz/, or app name).
 * @param {string} [baseUa] optional source for Chrome version only
 * @param {'chrome'|'edge'} [identity]
 */
function buildChromeUserAgent(baseUa, identity) {
  const id = identity || readIdentity();
  const chromeVer = resolveChromeVersion(baseUa);
  let ua = `${platformUaPrefix()} Chrome/${chromeVer} Safari/537.36`;
  if (id === 'edge') {
    ua = `${platformUaPrefix()} Chrome/${chromeVer} Safari/537.36 Edg/${chromeVer}`;
  }
  ua = ua
    .replace(/\s*Electron\/[\d.]+\s*/gi, ' ')
    .replace(/\s*MultiHeiz\/[\d.]+\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return ua;
}

/**
 * Sec-CH-UA style brand list consistent with UA identity and Chromium GREASE.
 * @param {'chrome'|'edge'} [identity]
 * @param {string} [chromeVer]
 */
function buildSecChUa(identity, chromeVer) {
  const id = identity || readIdentity();
  const ver = chromeVer || chromiumVersionFromUa(buildChromeUserAgent());
  const major = String(majorFromVersion(ver));
  if (id === 'edge') {
    return `"${GREASE_BRAND}";v="${GREASE_MAJOR}", "Microsoft Edge";v="${major}", "Chromium";v="${major}"`;
  }
  return `"${GREASE_BRAND}";v="${GREASE_MAJOR}", "Google Chrome";v="${major}", "Chromium";v="${major}"`;
}

/** Chromium-only CH brands (no Google Chrome claim) — matches stock Electron. */
function buildChromiumOnlySecChUa(chromeVer) {
  const ver = chromeVer || resolveChromeVersion();
  const major = String(majorFromVersion(ver));
  return `"${GREASE_BRAND}";v="${GREASE_MAJOR}", "Chromium";v="${major}"`;
}

function buildClientHintHeaders(identity) {
  const id = identity || readIdentity();
  const ua = buildChromeUserAgent(undefined, id);
  const ver = chromiumVersionFromUa(ua);
  const isWin = process.platform === 'win32';
  const fullList =
    id === 'edge'
      ? `"${GREASE_BRAND}";v="${GREASE_FULL}", "Microsoft Edge";v="${ver}", "Chromium";v="${ver}"`
      : `"${GREASE_BRAND}";v="${GREASE_FULL}", "Google Chrome";v="${ver}", "Chromium";v="${ver}"`;
  return {
    'User-Agent': ua,
    'sec-ch-ua': buildSecChUa(id, ver),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': isWin ? '"Windows"' : process.platform === 'darwin' ? '"macOS"' : '"Linux"',
    'sec-ch-ua-full-version': `"${ver}"`,
    'sec-ch-ua-full-version-list': fullList,
    'sec-ch-ua-platform-version': isWin ? '"15.0.0"' : '"0.0.0"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-arch': '"x86"',
  };
}

function buildGoogleAuthClientHintHeaders() {
  const ua = buildGoogleAuthUserAgent();
  const ver = chromiumVersionFromUa(ua);
  const isWin = process.platform === 'win32';
  return {
    'User-Agent': ua,
    'sec-ch-ua': buildChromiumOnlySecChUa(ver),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': isWin ? '"Windows"' : process.platform === 'darwin' ? '"macOS"' : '"Linux"',
    'sec-ch-ua-full-version': `"${ver}"`,
    'sec-ch-ua-full-version-list': `"${GREASE_BRAND}";v="${GREASE_FULL}", "Chromium";v="${ver}"`,
    'sec-ch-ua-platform-version': isWin ? '"15.0.0"' : '"0.0.0"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-arch': '"x86"',
  };
}

/**
 * Structured payload for Trusted-Types-safe main-world UA patch.
 * @param {'chrome'|'edge'} [identity]
 * @param {{ googleAuth?: boolean }} [opts]
 */
function mainWorldUaPatchData(identity, opts = {}) {
  const googleAuth = !!(opts && opts.googleAuth);
  if (googleAuth) {
    const ua = buildGoogleAuthUserAgent();
    const ver = chromiumVersionFromUa(ua);
    const major = String(majorFromVersion(ver));
    const brands = [
      { brand: GREASE_BRAND, version: GREASE_MAJOR },
      { brand: 'Chromium', version: major },
    ];
    const fullVersionList = [
      { brand: GREASE_BRAND, version: GREASE_FULL },
      { brand: 'Chromium', version: ver },
    ];
    const platform =
      process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    return {
      ua,
      brands,
      fullVersionList,
      platform,
      platformVersion: process.platform === 'win32' ? '15.0.0' : '0.0.0',
      mobile: false,
      model: '',
      architecture: 'x86',
      bitness: '64',
    };
  }

  const id = identity || readIdentity();
  const ua = buildChromeUserAgent(undefined, id);
  const ver = chromiumVersionFromUa(ua);
  const major = String(majorFromVersion(ver));
  const brands =
    id === 'edge'
      ? [
          { brand: GREASE_BRAND, version: GREASE_MAJOR },
          { brand: 'Microsoft Edge', version: major },
          { brand: 'Chromium', version: major },
        ]
      : [
          { brand: GREASE_BRAND, version: GREASE_MAJOR },
          { brand: 'Google Chrome', version: major },
          { brand: 'Chromium', version: major },
        ];
  const fullVersionList =
    id === 'edge'
      ? [
          { brand: GREASE_BRAND, version: GREASE_FULL },
          { brand: 'Microsoft Edge', version: ver },
          { brand: 'Chromium', version: ver },
        ]
      : [
          { brand: GREASE_BRAND, version: GREASE_FULL },
          { brand: 'Google Chrome', version: ver },
          { brand: 'Chromium', version: ver },
        ];
  const platform =
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return {
    ua,
    brands,
    fullVersionList,
    platform,
    platformVersion: process.platform === 'win32' ? '15.0.0' : '0.0.0',
    mobile: false,
    model: '',
    architecture: 'x86',
    bitness: '64',
  };
}

/**
 * Legacy string source (may be blocked by Trusted Types on some sites).
 * @param {'chrome'|'edge'} [identity]
 * @param {{ googleAuth?: boolean }} [opts]
 */
function mainWorldUaPatchSource(identity, opts) {
  const D = mainWorldUaPatchData(identity, opts);
  const payload = JSON.stringify(D);
  return `(function(){try{var D=${payload};try{Object.defineProperty(Navigator.prototype,'userAgent',{get:function(){return D.ua},configurable:true});}catch(e){}try{Object.defineProperty(navigator,'userAgent',{get:function(){return D.ua},configurable:true});}catch(e){}var uad={brands:D.brands,mobile:D.mobile,platform:D.platform,getHighEntropyValues:function(hints){var o={brands:D.brands,mobile:D.mobile,platform:D.platform,platformVersion:D.platformVersion,architecture:D.architecture,bitness:D.bitness,model:D.model,uaFullVersion:D.fullVersionList[0]&&D.fullVersionList[0].version,fullVersionList:D.fullVersionList};return Promise.resolve(o);},toJSON:function(){return{brands:D.brands,mobile:D.mobile,platform:D.platform};}};try{Object.defineProperty(Navigator.prototype,'userAgentData',{get:function(){return uad},configurable:true});}catch(e){}try{Object.defineProperty(navigator,'userAgentData',{get:function(){return uad},configurable:true});}catch(e){}}catch(e){}})();`;
}

function applySessionUserAgent(ses, identity) {
  if (!ses) return;
  const ua = buildChromeUserAgent(undefined, identity || readIdentity());
  try {
    if (typeof ses.setUserAgent === 'function') ses.setUserAgent(ua);
  } catch {
    /* ignore */
  }
  hookClientHints(ses);
  hookGoogleSignInFlow(ses);
}

function applyAppUserAgentFallback(identity) {
  const ua = buildChromeUserAgent(undefined, identity || readIdentity());
  try {
    app.userAgentFallback = ua;
  } catch {
    /* ignore */
  }
  try {
    applySessionUserAgent(session.defaultSession, identity);
  } catch {
    /* ignore */
  }
}

function setHeaderMap(requestHeaders, name, value) {
  const keys = Object.keys(requestHeaders || {});
  const found = keys.find((k) => k.toLowerCase() === name.toLowerCase());
  if (found) requestHeaders[found] = value;
  else requestHeaders[name] = value;
}

function hookClientHints(ses) {
  if (!ses || hookedSessions.has(ses)) return;
  hookedSessions.add(ses);
  hub.addBeforeSendHeaders(ses, HUB_ID, (details, callback) => {
    try {
      const headers = { ...(details.requestHeaders || {}) };
      const hint = isGoogleAuthUrl(details.url)
        ? buildGoogleAuthClientHintHeaders()
        : buildClientHintHeaders(readIdentity());
      for (const [k, v] of Object.entries(hint)) {
        setHeaderMap(headers, k, v);
      }
      callback({ requestHeaders: headers });
    } catch {
      callback({});
    }
  });
}

/**
 * Prefer WebLiteSignIn over GlifWebSignIn (lighter checks on embedded Chromium).
 * @param {Electron.Session} ses
 */
function hookGoogleSignInFlow(ses) {
  if (!ses) return;
  hub.addBeforeRequest(ses, GOOGLE_FLOW_HUB_ID, (details, callback) => {
    try {
      const url = String(details.url || '');
      if (/accounts\.google\.com/i.test(url) && /flowName=GlifWebSignIn/i.test(url)) {
        callback({
          redirectURL: url.replace(/flowName=GlifWebSignIn/gi, 'flowName=WebLiteSignIn'),
        });
        return;
      }
    } catch {
      /* ignore */
    }
    callback({});
  });
}

function reapplyAllSessions(sessions) {
  applyAppUserAgentFallback();
  const list = sessions || [];
  for (const ses of list) applySessionUserAgent(ses);
}

module.exports = {
  buildChromeUserAgent,
  buildGoogleAuthUserAgent,
  buildSecChUa,
  buildClientHintHeaders,
  buildGoogleAuthClientHintHeaders,
  mainWorldUaPatchSource,
  mainWorldUaPatchData,
  applySessionUserAgent,
  applyAppUserAgentFallback,
  hookClientHints,
  hookGoogleSignInFlow,
  reapplyAllSessions,
  readIdentity,
  chromiumVersionFromUa,
  isGoogleAuthUrl,
  GREASE_BRAND,
};
