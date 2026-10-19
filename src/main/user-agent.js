'use strict';

/**
 * Chrome-compatible User-Agent + Client Hints for MultiHeiz panels.
 * Strips Electron/app tokens; optional Chrome vs Edge brand.
 */

const { app, session } = require('electron');
const hub = require('./adblock/web-request-hub');

const HUB_ID = 'ua-client-hints';

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
  return m ? m[1] : '137.0.0.0';
}

function majorFromVersion(v) {
  const n = parseInt(String(v).split('.')[0], 10);
  return Number.isFinite(n) ? n : 137;
}

/**
 * Build a Chrome/Edge UA from the session's base Chromium UA (no Electron tokens).
 * @param {string} [baseUa]
 * @param {'chrome'|'edge'} [identity]
 */
function buildChromeUserAgent(baseUa, identity) {
  const id = identity || readIdentity();
  let base =
    baseUa ||
    (() => {
      try {
        return session.defaultSession.getUserAgent();
      } catch {
        return '';
      }
    })();
  base = String(base || '')
    .replace(/\s*Electron\/[\d.]+\s*/gi, ' ')
    .replace(/\s*MultiHeiz\/[\d.]+\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const chromeVer = chromiumVersionFromUa(base);
  // Ensure Chrome/ token exists
  if (!/Chrome\//i.test(base)) {
    base = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
  }
  // Strip leftover app Name/version after Safari if any
  base = base.replace(/\s+[A-Za-z][\w.-]*\/[\d.]+$/g, (m) => {
    if (/Safari\//i.test(m)) return m;
    return '';
  });

  if (id === 'edge') {
    if (!/Edg\//i.test(base)) {
      base = base.replace(/(Chrome\/[\d.]+)/i, `$1 Edg/${chromeVer}`);
    }
  } else {
    base = base.replace(/\s*Edg\/[\d.]+\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  return base;
}

/**
 * Sec-CH-UA style brand list consistent with UA identity.
 * @param {'chrome'|'edge'} [identity]
 * @param {string} [chromeVer]
 */
function buildSecChUa(identity, chromeVer) {
  const id = identity || readIdentity();
  const ver = chromeVer || chromiumVersionFromUa(buildChromeUserAgent());
  const major = String(majorFromVersion(ver));
  if (id === 'edge') {
    return `"Microsoft Edge";v="${major}", "Chromium";v="${major}", "Not-A.Brand";v="24"`;
  }
  return `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not-A.Brand";v="24"`;
}

function buildClientHintHeaders(identity) {
  const id = identity || readIdentity();
  const ua = buildChromeUserAgent(undefined, id);
  const ver = chromiumVersionFromUa(ua);
  const major = String(majorFromVersion(ver));
  const isWin = process.platform === 'win32';
  return {
    'User-Agent': ua,
    'sec-ch-ua': buildSecChUa(id, ver),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': isWin ? '"Windows"' : process.platform === 'darwin' ? '"macOS"' : '"Linux"',
    'sec-ch-ua-full-version': `"${ver}"`,
    'sec-ch-ua-full-version-list':
      id === 'edge'
        ? `"Microsoft Edge";v="${ver}", "Chromium";v="${ver}", "Not-A.Brand";v="10.0.0.0"`
        : `"Google Chrome";v="${ver}", "Chromium";v="${ver}", "Not-A.Brand";v="10.0.0.0"`,
    'sec-ch-ua-platform-version': isWin ? '"15.0.0"' : '"0.0.0"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-bitness': '"64"',
    'sec-ch-ua-arch': '"x86"',
  };
}

/**
 * Main-world patch source for navigator.userAgent / userAgentData.
 * @param {'chrome'|'edge'} [identity]
 */
function mainWorldUaPatchSource(identity) {
  const id = identity || readIdentity();
  const ua = buildChromeUserAgent(undefined, id);
  const ver = chromiumVersionFromUa(ua);
  const major = majorFromVersion(ver);
  const brands =
    id === 'edge'
      ? [
          { brand: 'Microsoft Edge', version: String(major) },
          { brand: 'Chromium', version: String(major) },
          { brand: 'Not-A.Brand', version: '24' },
        ]
      : [
          { brand: 'Google Chrome', version: String(major) },
          { brand: 'Chromium', version: String(major) },
          { brand: 'Not-A.Brand', version: '24' },
        ];
  const fullVersionList =
    id === 'edge'
      ? [
          { brand: 'Microsoft Edge', version: ver },
          { brand: 'Chromium', version: ver },
          { brand: 'Not-A.Brand', version: '10.0.0.0' },
        ]
      : [
          { brand: 'Google Chrome', version: ver },
          { brand: 'Chromium', version: ver },
          { brand: 'Not-A.Brand', version: '10.0.0.0' },
        ];
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const payload = JSON.stringify({
    ua,
    brands,
    fullVersionList,
    platform,
    platformVersion: process.platform === 'win32' ? '15.0.0' : '0.0.0',
    mobile: false,
    model: '',
    architecture: 'x86',
    bitness: '64',
  });
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
      const hint = buildClientHintHeaders(readIdentity());
      for (const [k, v] of Object.entries(hint)) {
        setHeaderMap(headers, k, v);
      }
      callback({ requestHeaders: headers });
    } catch {
      callback({});
    }
  });
}

function reapplyAllSessions(sessions) {
  applyAppUserAgentFallback();
  const list = sessions || [];
  for (const ses of list) applySessionUserAgent(ses);
}

module.exports = {
  buildChromeUserAgent,
  buildSecChUa,
  buildClientHintHeaders,
  mainWorldUaPatchSource,
  applySessionUserAgent,
  applyAppUserAgentFallback,
  hookClientHints,
  reapplyAllSessions,
  readIdentity,
  chromiumVersionFromUa,
};
