'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { app, ipcMain, webContents, net } = require('electron');
const { ElectronBlocker, fetchResources } = require('@ghostery/adblocker-electron');
const { parse } = require('tldts-experimental');
const { getState, updateState } = require('../state');
const { resolvePreloadPath } = require('../preload-path');
const settingsApply = require('../settings-apply');
const hub = require('./web-request-hub');
const {
  LISTS,
  GROUP_LABELS,
  RESOURCES_URL,
  RESOURCES_FILE,
  YOUTUBE_EXPERIMENTAL_FILTERS,
  YOUTUBE_BUILTIN_SCRIPTLETS,
  GOOGLE_SEARCH_COSMETICS,
  UPDATE_INTERVAL_HOURS_OPTIONS,
  DEFAULT_UPDATE_INTERVAL_HOURS,
  defaultListFlags,
  countFilterLines,
} = require('./lists');
const {
  preprocessAbuList,
  shouldPreprocessList,
  emptyStats: emptyPreprocessStats,
  mergeStats: mergePreprocessStats,
} = require('./preprocess');

const PRELOAD_RESOLVED = resolvePreloadPath(path.join(__dirname, 'cosmetic-preload.js'));
const PRELOAD_PATH = PRELOAD_RESOLVED.path;

const HUB_ID = 'adblock';
const IPC_COSMETIC = '@ghostery/adblocker/inject-cosmetic-filters';
const IPC_MUTATION = '@ghostery/adblocker/is-mutation-observer-enabled';
const IPC_EARLY = '@ghostery/adblocker/early-scriptlets';
const IPC_EARLY_TIMING = '@ghostery/adblocker/early-timing';

/** @type {import('@ghostery/adblocker-electron').ElectronBlocker | null} */
let blocker = null;
/** @type {Promise<void> | null} */
let readyPromise = null;
let cosmeticIpcRegistered = false;
let updateTimer = null;
/** @type {((payload: object) => void) | null} */
let emitFn = null;

/** @type {'lists'|'prebuilt'|'cache'|'test'|'none'} */
let engineSource = 'none';
let lastBuildMs = 0;
let lastBuildRssMb = 0;
let resourcesLoaded = 0;
let networkFilterCount = 0;
let cosmeticFilterCount = 0;
let rebuildInProgress = false;
let rebuildProgress = '';
/** Coalesce concurrent buildEngine calls (single-flight + trailing rerun). */
let rebuildActive = false;
let rebuildAgain = false;
/** @type {{ resolve: (v: boolean) => void, reject: (e: Error) => void }[]} */
let rebuildWaiters = [];
/** @type {Record<string, unknown>} */
let rebuildPendingOpts = {};
/** @type {ReturnType<typeof setTimeout> | null} */
let rebuildDebounceTimer = null;
const REBUILD_DEBOUNCE_MS = 400;
/** Instrumentation for selftests: peak parallel rebuilds (should stay ≤ 1). */
let rebuildParallelPeak = 0;
let rebuildParallelNow = 0;
/** Last ABU AdGuard-syntax preprocess totals (converted/dropped). */
let lastPreprocessStats = emptyPreprocessStats();

/** @type {WeakMap<Electron.Session, { accountId: string|null, preloadId: string|undefined }>} */
const attachedSessions = new WeakMap();
/** @type {Set<Electron.Session>} */
const knownSessions = new Set();

/** @type {Map<number, string>} */
const wcToAccount = new Map();

/** @type {Map<string, number>} */
const pageBlocked = new Map();
/** @type {Map<string, string[]>} */
const recentBlocked = new Map();
const RECENT_MAX = 40;

/** @type {Map<string, Array<{url:string,type:string,blocked:boolean,filter:string|null,at:number}>>} */
const recentRequests = new Map();
const RECENT_REQ_MAX = 80;

/** Hostname → { scripts, styles, at } for early sync injection */
const earlyCache = new Map();
const EARLY_CACHE_MAX = 200;

/** @type {Array<{url:string,syncMs:number,injectMs:number,scripts:number,hasStyles:boolean,via:string,at:number,accountId:string|null}>} */
const earlyTimingLog = [];
const EARLY_TIMING_MAX = 40;

/** accountId → last early injection report from preload */
/** @type {Map<string, {url:string,syncMs:number,injectMs:number,scripts:number,hasStyles:boolean,via:string,at:number}>} */
const lastEarlyByAccount = new Map();

let sessionBlockedTotal = 0;
let earlyIpcRegistered = false;

const fetchLog = [];
let fetchBlocked = false;

function envGet(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function isTestMode() {
  const st = envGet('MULTIHEIZ_SELFTEST') || '';
  return (
    st === 'adblock' ||
    st === 'adblock-startup' ||
    st === 'adblock-real' ||
    st === 'adblock-packaged' ||
    st === 'v18' ||
    st === 'builtin-yt' ||
    envGet('MULTIHEIZ_ADBLOCK_TEST') === '1'
  );
}

function debugLog(...args) {
  if (envGet('MULTIHEIZ_ADBLOCK_DEBUG') === '1' || isTestMode()) {
    console.log('[adblock]', ...args);
  }
}

function adblockDir() {
  return path.join(app.getPath('userData'), 'adblock');
}

function enginePath() {
  return path.join(adblockDir(), 'engine.bin');
}

function metaPath() {
  return path.join(adblockDir(), 'meta.json');
}

function resourcesCachePath() {
  return path.join(adblockDir(), RESOURCES_FILE);
}

function defaultAdblockSettings() {
  return {
    enabled: true,
    antiTracking: true,
    cosmetic: true,
    youtubeExperimental: false,
    lists: defaultListFlags(),
    allowlist: [],
    customLists: [],
    userRules: '',
    updateIntervalHours: DEFAULT_UPDATE_INTERVAL_HOURS,
    lastUpdateAt: null,
    listStatus: {},
    listMeta: {},
    statusMessage: '',
  };
}

function readAdblockSettings() {
  const s = getState().settings || {};
  const base = defaultAdblockSettings();
  const ab = s.adblock && typeof s.adblock === 'object' ? s.adblock : {};
  const lists = { ...base.lists, ...(ab.lists || {}) };
  // Migrate v1.7.0: antiTracking / easyprivacy coupling
  if (ab.antiTracking === false) lists.easyprivacy = false;
  if (ab.antiTracking === false) lists.ublock_privacy = false;
  if (ab.antiTracking === false) lists.abu_privacy = false;
  return {
    ...base,
    ...ab,
    lists,
    allowlist: Array.isArray(ab.allowlist)
      ? ab.allowlist.map((d) => String(d).toLowerCase().replace(/^www\./, ''))
      : [],
    customLists: Array.isArray(ab.customLists) ? ab.customLists : [],
    userRules: typeof ab.userRules === 'string' ? ab.userRules : '',
    updateIntervalHours: UPDATE_INTERVAL_HOURS_OPTIONS.includes(Number(ab.updateIntervalHours))
      ? Number(ab.updateIntervalHours)
      : DEFAULT_UPDATE_INTERVAL_HOURS,
    listMeta: ab.listMeta && typeof ab.listMeta === 'object' ? ab.listMeta : {},
  };
}

function writeAdblockSettings(partial) {
  updateState((st) => {
    const cur = readAdblockSettings();
    st.settings.adblock = {
      ...cur,
      ...partial,
      lists: { ...cur.lists, ...((partial && partial.lists) || {}) },
      allowlist: Array.isArray(partial.allowlist) ? partial.allowlist : cur.allowlist,
      customLists: Array.isArray(partial.customLists) ? partial.customLists : cur.customLists,
      userRules: typeof partial.userRules === 'string' ? partial.userRules : cur.userRules,
      listMeta: partial.listMeta ? { ...cur.listMeta, ...partial.listMeta } : cur.listMeta,
    };
  });
}

function siteKeyFromUrl(url) {
  try {
    const p = parse(url);
    return (p.domain || p.hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isAllowlisted(pageUrl) {
  const settings = readAdblockSettings();
  const site = siteKeyFromUrl(pageUrl);
  const host = hostnameFromUrl(pageUrl);
  if (!site && !host) return false;
  return settings.allowlist.some(
    (d) => d === site || d === host || host.endsWith('.' + d) || site.endsWith('.' + d)
  );
}

function isWindowBlockingEnabled(accountId) {
  if (!accountId) return true;
  const acc = getState().accounts.find((a) => a.id === accountId);
  if (!acc) return true;
  return acc.adblockEnabled !== false;
}

function isGloballyEnabled() {
  return readAdblockSettings().enabled !== false;
}

/**
 * Enrich Electron webRequest details so Ghostery gets a reliable sourceUrl
 * (referrer is often empty → $domain= filters fail).
 * @param {Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails} details
 */
function enrichDetails(details) {
  let referrer = details.referrer || '';
  try {
    if (details.frame && typeof details.frame.url === 'string' && details.frame.url) {
      if (!referrer) referrer = details.frame.url;
    }
  } catch {
    /* ignore */
  }
  if ((!referrer || referrer === 'about:blank') && details.webContentsId) {
    try {
      const wc = webContents.fromId(details.webContentsId);
      if (wc && !wc.isDestroyed()) {
        const u = wc.getURL();
        if (u) referrer = u;
      }
    } catch {
      /* ignore */
    }
  }
  if (referrer && referrer !== details.referrer) {
    return Object.assign({}, details, { referrer });
  }
  return details;
}

function shouldBlockForDetails(details) {
  if (!blocker) return false;
  if (!isGloballyEnabled()) return false;
  const accountId = details.webContentsId ? wcToAccount.get(details.webContentsId) : null;
  if (accountId && !isWindowBlockingEnabled(accountId)) return false;
  const pageUrl =
    (details.webContentsId &&
      (() => {
        try {
          const wc = webContents.fromId(details.webContentsId);
          return wc && !wc.isDestroyed() ? wc.getURL() : '';
        } catch {
          return '';
        }
      })()) ||
    details.referrer ||
    '';
  if (pageUrl && isAllowlisted(pageUrl)) return false;
  return true;
}

function recordBlocked(accountId, url) {
  sessionBlockedTotal += 1;
  if (accountId) {
    pageBlocked.set(accountId, (pageBlocked.get(accountId) || 0) + 1);
    const list = recentBlocked.get(accountId) || [];
    list.unshift(url);
    if (list.length > RECENT_MAX) list.length = RECENT_MAX;
    recentBlocked.set(accountId, list);
  }
  if (emitFn) {
    emitFn({
      type: 'adblock:stats',
      accountId: accountId || null,
      pageBlocked: accountId ? pageBlocked.get(accountId) || 0 : 0,
      sessionTotal: sessionBlockedTotal,
    });
  }
}

/**
 * @param {string|null} accountId
 * @param {{ url: string, type?: string, blocked: boolean, filter?: string|null }} entry
 */
function recordRequest(accountId, entry) {
  if (!accountId) return;
  const list = recentRequests.get(accountId) || [];
  list.unshift({
    url: String(entry.url || ''),
    type: String(entry.type || ''),
    blocked: !!entry.blocked,
    filter: entry.filter || null,
    at: Date.now(),
  });
  if (list.length > RECENT_REQ_MAX) list.length = RECENT_REQ_MAX;
  recentRequests.set(accountId, list);
}

function resetPageStats(accountId) {
  if (!accountId) return;
  pageBlocked.set(accountId, 0);
  recentBlocked.set(accountId, []);
  recentRequests.set(accountId, []);
  if (emitFn) {
    emitFn({
      type: 'adblock:stats',
      accountId,
      pageBlocked: 0,
      sessionTotal: sessionBlockedTotal,
    });
  }
}

function cancelResponseBody(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') {
      res.body.cancel();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Internet fetch for adblock lists/resources via Electron Chromium stack (net.fetch),
 * not Node undici — avoids intermittent AssertionError assert(!this.paused) on E44.
 * Uses the default session (no account partition cookies).
 * @param {string|URL} url
 * @param {RequestInit} [opts]
 * @returns {Promise<Response>}
 */
async function auditedFetch(url, opts) {
  fetchLog.push({ url: String(url), at: Date.now() });
  if (fetchBlocked) {
    throw new Error('adblock fetch blocked (offline mode)');
  }
  if (!app.isReady()) {
    await app.whenReady();
  }
  const res = await net.fetch(String(url), opts || {});
  try {
    const dateHdr = res && res.headers && res.headers.get && res.headers.get('date');
    if (dateHdr) {
      const changelog = require('../changelog');
      changelog.noteHttpDate(dateHdr);
    }
  } catch {
    /* ignore */
  }
  return res;
}

function getFetchLog() {
  return fetchLog.slice();
}

function clearFetchLog() {
  fetchLog.length = 0;
}

function setFetchBlocked(v) {
  fetchBlocked = !!v;
}

function ensureDir() {
  fs.mkdirSync(adblockDir(), { recursive: true });
}

function defaultMeta() {
  return { lastUpdateAt: null, listStatus: {}, fingerprint: null };
}

function loadMeta() {
  ensureDir();
  try {
    const { readJsonDurable } = require('../json-store');
    const result = readJsonDurable(metaPath(), defaultMeta, 'adblock/meta.json');
    return result.data && typeof result.data === 'object' ? result.data : defaultMeta();
  } catch {
    return defaultMeta();
  }
}

function saveMeta(meta) {
  ensureDir();
  try {
    const { writeJsonDurable } = require('../json-store');
    writeJsonDurable(metaPath(), meta || defaultMeta());
  } catch (err) {
    console.error('[adblock] saveMeta:', err && err.message);
  }
}

function emitProgress(msg) {
  rebuildProgress = msg || '';
  if (emitFn) {
    emitFn({
      type: 'adblock:progress',
      progress: rebuildProgress,
      rebuilding: rebuildInProgress,
      status: getStatus(),
    });
  }
}

function emitStatus() {
  if (emitFn) emitFn({ type: 'adblock:status', status: getStatus() });
}

/**
 * @returns {string[]}
 */
function selectedBuiltinListIds() {
  const ab = readAdblockSettings();
  const ids = [];
  for (const id of Object.keys(LISTS)) {
    if (ab.lists[id] !== false && LISTS[id]) {
      // antiTracking master switch also gates privacy lists
      if (
        (id === 'easyprivacy' ||
          id === 'ublock_privacy' ||
          id === 'adguard_tracking' ||
          id === 'abu_privacy') &&
        ab.antiTracking === false
      ) {
        continue;
      }
      ids.push(id);
    }
  }
  return ids;
}

function listFingerprint() {
  const ab = readAdblockSettings();
  const parts = [
    selectedBuiltinListIds().sort().join(','),
    (ab.customLists || [])
      .filter((c) => c && c.enabled !== false && c.url)
      .map((c) => c.url)
      .sort()
      .join('|'),
    crypto.createHash('sha1').update(ab.userRules || '').digest('hex').slice(0, 12),
    ab.youtubeExperimental ? 'yt1' : 'yt0',
    ab.cosmetic !== false ? 'cos1-ytb1' : 'cos0',
  ];
  return parts.join('::');
}

function refreshFilterCounts() {
  networkFilterCount = 0;
  cosmeticFilterCount = 0;
  resourcesLoaded = 0;
  if (!blocker) return;
  try {
    const { networkFilters, cosmeticFilters } = blocker.getFilters();
    networkFilterCount = networkFilters.length;
    cosmeticFilterCount = cosmeticFilters.length;
  } catch {
    /* ignore */
  }
  try {
    const res = blocker.resources;
    if (res) {
      const scripts = (res.scriptlets && res.scriptlets.length) || 0;
      const redirects = (res.resources && res.resources.length) || 0;
      resourcesLoaded = scripts + redirects;
    }
  } catch {
    /* ignore */
  }
}

function engineConfig() {
  const ab = readAdblockSettings();
  const offlineSelftest =
    envGet('MULTIHEIZ_SELFTEST') === 'adblock' ||
    envGet('MULTIHEIZ_SELFTEST') === 'adblock-startup' ||
    envGet('MULTIHEIZ_SELFTEST') === 'adblock-packaged' ||
    envGet('MULTIHEIZ_SELFTEST') === 'v18';
  return {
    loadNetworkFilters: true,
    loadCosmeticFilters: ab.cosmetic !== false,
    loadGenericCosmeticsFilters: ab.cosmetic !== false,
    enableMutationObserver: ab.cosmetic !== false,
    // HTML/CSP filters can strip or block inline <script> in local selftests
    enableHtmlFiltering: !offlineSelftest,
    enableCompression: true,
    loadCSPFilters: !offlineSelftest,
    guessRequestTypeFromUrl: true,
    enableOptimizations: true,
  };
}

/**
 * Load uBO-compatible resources.json (scriptlets + redirects).
 * @param {{ forceDownload?: boolean }} [opts]
 */
function minimalTestResources() {
  return JSON.stringify({
    scriptlets: [
      {
        name: 'set-constant.js',
        aliases: ['set-constant'],
        dependencies: [],
        body: 'function(a,b){try{var v=b;if(b==="true")v=true;else if(b==="false")v=false;else if(b==="undefined")v=undefined;else if(b==="null")v=null;Object.defineProperty(window,a,{value:v,writable:false,configurable:true});}catch(e){}}',
      },
      {
        name: 'json-prune.js',
        aliases: ['json-prune'],
        dependencies: [],
        body: 'function(a,b){try{var keys=String(a||"").split(/\\s+/).filter(Boolean);var orig=JSON.parse;JSON.parse=function(t){var o=orig.apply(this,arguments);if(o&&typeof o==="object"){for(var i=0;i<keys.length;i++){try{delete o[keys[i]];}catch(e){}}}return o;};}catch(e){}}',
      },
    ],
    redirects: [],
  });
}

/**
 * Append minimal stubs for rare uBO-only scriptlets missing from Ghostery resources
 * (original behaviours — not copied from GPL uBO source).
 * @param {string} text
 */
function ensureScriptletCoverage(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return text;
  }
  if (!data || typeof data !== 'object') return text;
  if (!Array.isArray(data.scriptlets)) data.scriptlets = [];
  const names = new Set();
  for (const s of data.scriptlets) {
    if (s && s.name) names.add(String(s.name).replace(/\.js$/, ''));
    if (s && Array.isArray(s.aliases)) {
      for (const a of s.aliases) names.add(String(a).replace(/\.js$/, ''));
    }
  }
  const stubs = [
    {
      need: 'abort-current-inline-script',
      entry: {
        name: 'abort-current-inline-script.js',
        aliases: ['abort-current-inline-script', 'acis'],
        dependencies: [],
        body: 'function(a,b){try{var needle=String(b||"");var prop=String(a||"");var abort=function(){throw new ReferenceError("mh-acis");};var desc=Object.getOwnPropertyDescriptor(window,prop);if(desc&&desc.set){Object.defineProperty(window,prop,{set:function(v){if(!needle||String(v).indexOf(needle)!==-1)abort();desc.set.call(this,v);},get:desc.get,configurable:true});}}catch(e){}}',
      },
    },
  ];
  for (const stub of stubs) {
    if (!names.has(stub.need)) data.scriptlets.push(stub.entry);
  }
  return JSON.stringify(data);
}

async function loadResourcesText(opts = {}) {
  ensureDir();
  const file = resourcesCachePath();
  // Offline adblock selftest: never hit the network for resources
  if (
    envGet('MULTIHEIZ_SELFTEST') === 'adblock' ||
    envGet('MULTIHEIZ_SELFTEST') === 'adblock-startup' ||
    envGet('MULTIHEIZ_SELFTEST') === 'v18'
  ) {
    const minimal = minimalTestResources();
    fs.writeFileSync(file, minimal, 'utf8');
    return minimal;
  }
  if (opts.forceDownload && !fetchBlocked) {
    try {
      const text = ensureScriptletCoverage(await fetchResources(auditedFetch));
      fs.writeFileSync(file, text, 'utf8');
      debugLog('resources downloaded', text.length, 'bytes');
      return text;
    } catch (err) {
      console.warn('[adblock] resources download failed', err && err.message);
    }
  }
  if (fs.existsSync(file)) {
    try {
      const text = ensureScriptletCoverage(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, text, 'utf8');
      return text;
    } catch {
      return fs.readFileSync(file, 'utf8');
    }
  }
  if (!fetchBlocked) {
    try {
      const text = ensureScriptletCoverage(await fetchResources(auditedFetch));
      fs.writeFileSync(file, text, 'utf8');
      return text;
    } catch (err) {
      console.warn('[adblock] resources fetch failed', err && err.message);
    }
  }
  return '';
}

/**
 * @param {{ forceDownload?: boolean }} [opts]
 */
async function gatherFilterText(opts = {}) {
  const forceDownload = !!opts.forceDownload;
  const ab = readAdblockSettings();
  ensureDir();
  const listStatus = {};
  const listMeta = { ...(ab.listMeta || {}) };
  const chunks = [];

  if (
    isTestMode() &&
    (envGet('MULTIHEIZ_SELFTEST') === 'adblock' ||
      envGet('MULTIHEIZ_SELFTEST') === 'adblock-startup' ||
      envGet('MULTIHEIZ_SELFTEST') === 'adblock-packaged' ||
      envGet('MULTIHEIZ_SELFTEST') === 'v18')
  ) {
    const testFile = path.join(adblockDir(), 'test-filters.txt');
    let text = '';
    if (fs.existsSync(testFile)) {
      text = fs.readFileSync(testFile, 'utf8');
      listStatus.test = 'ok';
    } else {
      text = ['||ads.test.local^', '/adserver/*', '/tracker.js', '##.ad-banner'].join('\n');
      fs.writeFileSync(testFile, text, 'utf8');
      listStatus.test = 'ok';
    }
    chunks.push(text);
    if (ab.userRules) chunks.push(ab.userRules);
    if (ab.youtubeExperimental) chunks.push(YOUTUBE_EXPERIMENTAL_FILTERS);
    if (ab.cosmetic !== false) {
      chunks.push(YOUTUBE_BUILTIN_SCRIPTLETS);
      chunks.push(GOOGLE_SEARCH_COSMETICS);
    }
    listMeta.test = {
      ruleCount: countFilterLines(text),
      lastUpdateAt: Date.now(),
      status: 'ok',
    };
    return { text: chunks.join('\n'), listStatus, listMeta, fromCache: true };
  }

  // Built-in YouTube selftest: MIT YT scriptlets only (no remote list download).
  if (envGet('MULTIHEIZ_SELFTEST') === 'builtin-yt') {
    if (ab.userRules) chunks.push(ab.userRules);
    if (ab.cosmetic !== false) {
      chunks.push(YOUTUBE_BUILTIN_SCRIPTLETS);
    }
    listStatus.builtin_yt = 'ok';
    listMeta.builtin_yt = {
      ruleCount: countFilterLines(chunks.join('\n')),
      lastUpdateAt: Date.now(),
      status: 'ok',
    };
    return {
      text: chunks.join('\n'),
      listStatus,
      listMeta,
      fromCache: true,
      empty: chunks.length === 0,
      anyError: false,
    };
  }

  let anyFresh = false;
  let anyCache = false;
  let anyError = false;
  const preprocessTotals = emptyPreprocessStats();

  for (const id of selectedBuiltinListIds()) {
    const info = LISTS[id];
    if (!info) continue;
    const file = path.join(adblockDir(), info.file);
    let body = null;
    let status = 'erro';

    const tryDownload = forceDownload || !fs.existsSync(file);
    if (tryDownload && !fetchBlocked) {
      try {
        emitProgress(`Baixando ${info.name}…`);
        const res = await auditedFetch(info.url, {
          headers: { 'User-Agent': 'MultiHeiz-Adblock/1.7.1' },
        });
        if (!res.ok) {
          cancelResponseBody(res);
          throw new Error(`HTTP ${res.status}`);
        }
        body = await res.text();
        fs.writeFileSync(file, body, 'utf8');
        status = 'ok';
        anyFresh = true;
      } catch (err) {
        console.warn('[adblock] list download failed', id, err && err.message);
        anyError = true;
        listMeta[id] = {
          ...(listMeta[id] || {}),
          status: 'erro',
          error: String(err && err.message ? err.message : err),
        };
      }
    }

    if (!body && fs.existsSync(file)) {
      body = fs.readFileSync(file, 'utf8');
      status = 'cache';
      anyCache = true;
    }

    if (body) {
      let parseBody = body;
      /** @type {ReturnType<typeof emptyPreprocessStats> | null} */
      let preStats = null;
      if (shouldPreprocessList(info)) {
        emitProgress(`Pré-processando ${info.name}…`);
        const pre = await preprocessAbuList(body);
        parseBody = pre.text;
        preStats = pre.stats;
        mergePreprocessStats(preprocessTotals, pre.stats);
      }
      chunks.push(parseBody);
      listStatus[id] = status;
      listMeta[id] = {
        ruleCount: countFilterLines(parseBody),
        lastUpdateAt: Date.now(),
        status,
        error: null,
        bytes: Buffer.byteLength(body, 'utf8'),
        ...(preStats
          ? {
              preprocess: {
                scriptletsConverted: preStats.scriptletsConverted,
                scriptletsDropped: preStats.scriptletsDropped,
                adguardOnlyDropped: preStats.adguardOnlyDropped,
                agtreeAvailable: preStats.agtreeAvailable,
              },
            }
          : {}),
      };
    } else {
      listStatus[id] = 'erro';
      anyError = true;
    }
  }

  // Custom lists by URL
  for (const custom of ab.customLists || []) {
    if (!custom || custom.enabled === false || !custom.url) continue;
    const id = custom.id || custom.url;
    const file = path.join(
      adblockDir(),
      'custom-' + crypto.createHash('sha1').update(custom.url).digest('hex').slice(0, 16) + '.txt'
    );
    let body = null;
    let status = 'erro';
    const tryDownload = forceDownload || !fs.existsSync(file);
    if (tryDownload && !fetchBlocked) {
      try {
        emitProgress(`Baixando lista custom…`);
        const res = await auditedFetch(custom.url, {
          headers: { 'User-Agent': 'MultiHeiz-Adblock/1.7.1' },
        });
        if (!res.ok) {
          cancelResponseBody(res);
          throw new Error(`HTTP ${res.status}`);
        }
        body = await res.text();
        fs.writeFileSync(file, body, 'utf8');
        status = 'ok';
        anyFresh = true;
      } catch (err) {
        anyError = true;
        listStatus[id] = 'erro';
        listMeta[id] = {
          ruleCount: 0,
          lastUpdateAt: Date.now(),
          status: 'erro',
          error: String(err && err.message ? err.message : err),
        };
      }
    }
    if (!body && fs.existsSync(file)) {
      body = fs.readFileSync(file, 'utf8');
      status = 'cache';
      anyCache = true;
    }
    if (body) {
      chunks.push(body);
      listStatus[id] = status;
      listMeta[id] = {
        ruleCount: countFilterLines(body),
        lastUpdateAt: Date.now(),
        status,
        error: null,
        bytes: Buffer.byteLength(body, 'utf8'),
      };
    }
  }

  if (ab.userRules && ab.userRules.trim()) {
    chunks.push(ab.userRules);
    listStatus.userRules = 'ok';
    listMeta.userRules = {
      ruleCount: countFilterLines(ab.userRules),
      lastUpdateAt: Date.now(),
      status: 'ok',
    };
  }

  if (ab.youtubeExperimental) chunks.push(YOUTUBE_EXPERIMENTAL_FILTERS);
  if (ab.cosmetic !== false) {
    chunks.push(YOUTUBE_BUILTIN_SCRIPTLETS);
    chunks.push(GOOGLE_SEARCH_COSMETICS);
  }

  lastPreprocessStats = preprocessTotals;

  if (!chunks.length) {
    return {
      text: '',
      listStatus,
      listMeta,
      fromCache: false,
      empty: true,
      anyError,
      preprocess: preprocessTotals,
    };
  }

  if (
    preprocessTotals.scriptletsConverted ||
    preprocessTotals.scriptletsDropped ||
    preprocessTotals.adguardOnlyDropped
  ) {
    debugLog(
      'ABU preprocess scriptletsConverted=' +
        preprocessTotals.scriptletsConverted +
        ' dropped=' +
        preprocessTotals.scriptletsDropped +
        ' adguardOnlyDropped=' +
        preprocessTotals.adguardOnlyDropped +
        ' agtree=' +
        preprocessTotals.agtreeAvailable
    );
  }

  return {
    text: chunks.join('\n'),
    listStatus,
    listMeta,
    fromCache: anyCache && !anyFresh,
    empty: false,
    anyError,
    preprocess: preprocessTotals,
  };
}

/**
 * Resolve engine-worker.js path (prefer asar.unpacked when packaged).
 * @returns {string}
 */
function engineWorkerPath() {
  const candidate = path.join(__dirname, 'engine-worker.js');
  try {
    const resolved = resolvePreloadPath(candidate);
    if (resolved && resolved.path) return resolved.path;
  } catch {
    /* ignore */
  }
  return candidate;
}

/**
 * Parse + serialize off the main thread. Falls back to sync parse if Worker fails.
 * @param {{ text: string, config: object, resourcesText: string, skipSerialize?: boolean }} args
 * @returns {Promise<Buffer>}
 */
function compileEngineOffMain(args) {
  return new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    const finish = (err, bin) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (worker) void worker.terminate();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(bin);
    };
    try {
      worker = new Worker(engineWorkerPath());
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      finish(new Error('engine-worker timeout'));
    }, 120000);
    worker.on('message', (msg) => {
      if (msg && msg.ok && msg.bin) {
        finish(null, Buffer.isBuffer(msg.bin) ? msg.bin : Buffer.from(msg.bin));
        return;
      }
      finish(new Error((msg && msg.error) || 'engine-worker falhou'));
    });
    worker.on('error', (err) => {
      finish(err);
    });
    worker.on('exit', (code) => {
      if (!settled && code !== 0) finish(new Error('engine-worker exit ' + code));
    });
    ensureDir();
    worker.postMessage({
      type: 'compile',
      text: args.text,
      config: args.config,
      resourcesText: args.resourcesText || '',
      skipSerialize: !!args.skipSerialize,
      engineOutPath: args.skipSerialize ? '' : enginePath(),
    });
  });
}

/**
 * Sync fallback (main thread) — used only if worker_threads cannot start.
 * @param {{ text: string, config: object, resourcesText: string, skipSerialize?: boolean }} args
 * @returns {Buffer}
 */
function compileEngineOnMain(args) {
  const parsed = ElectronBlocker.parse(args.text, args.config);
  if (args.resourcesText) {
    parsed.updateResources(args.resourcesText, '' + args.resourcesText.length);
  }
  const bin = Buffer.from(parsed.serialize());
  if (!args.skipSerialize) {
    ensureDir();
    fs.writeFileSync(enginePath(), bin);
  }
  return bin;
}

/**
 * Actual engine compile (single runner). Callers go through buildEngine / schedule.
 * Heavy parse/serialize runs in a worker thread; main only deserializes.
 * @param {{ forceDownload?: boolean, skipSerialize?: boolean }} [opts]
 */
async function buildEngineBody(opts = {}) {
  emitProgress('Compilando motor…');
  const t0 = Date.now();
  const rss0 = process.memoryUsage().rss;
  const ab = readAdblockSettings();
  const gathered = await gatherFilterText(opts);

  if (gathered.empty) {
    if (!isTestMode() && !fetchBlocked) {
      try {
        emitProgress('Fallback pré-construído…');
        const pre = await ElectronBlocker.fromPrebuiltAdsAndTracking(auditedFetch);
        blocker = pre;
        engineSource = 'prebuilt';
        refreshFilterCounts();
        lastBuildMs = Date.now() - t0;
        lastBuildRssMb = Math.round((process.memoryUsage().rss - rss0) / (1024 * 1024));
        writeAdblockSettings({
          listStatus: { prebuilt: 'ok' },
          statusMessage: 'Usando listas pré-construídas (sem cache local)',
          lastUpdateAt: Date.now(),
        });
        emitProgress('');
        debugLog('engine source=prebuilt filters', networkFilterCount, cosmeticFilterCount);
        return true;
      } catch (err) {
        console.warn('[adblock] prebuilt fallback failed', err && err.message);
      }
    }
    blocker = null;
    engineSource = 'none';
    refreshFilterCounts();
    writeAdblockSettings({
      listStatus: gathered.listStatus,
      listMeta: gathered.listMeta,
      statusMessage: 'Sem listas e offline — bloqueio desativado',
      lastUpdateAt: ab.lastUpdateAt || null,
    });
    emitProgress('');
    return false;
  }

  const resourcesText = await loadResourcesText({ forceDownload: !!opts.forceDownload });
  const config = engineConfig();
  let bin;
  try {
    emitProgress('Parse de filtros (worker)…');
    try {
      bin = await compileEngineOffMain({
        text: gathered.text,
        config,
        resourcesText: resourcesText || '',
        skipSerialize: !!opts.skipSerialize,
      });
    } catch (workerErr) {
      console.warn(
        '[adblock] worker compile fallback → main',
        workerErr && workerErr.message ? workerErr.message : workerErr
      );
      emitProgress('Parse de filtros…');
      bin = compileEngineOnMain({
        text: gathered.text,
        config,
        resourcesText: resourcesText || '',
        skipSerialize: !!opts.skipSerialize,
      });
    }
    emitProgress('Aplicando motor…');
    blocker = ElectronBlocker.deserialize(new Uint8Array(bin));
  } catch (err) {
    console.error('[adblock] parse failed', err);
    blocker = null;
    engineSource = 'none';
    writeAdblockSettings({
      listStatus: gathered.listStatus,
      listMeta: gathered.listMeta,
      statusMessage: 'Erro ao compilar motor',
    });
    emitProgress('');
    return false;
  }

  engineSource =
    envGet('MULTIHEIZ_SELFTEST') === 'adblock' ||
    envGet('MULTIHEIZ_SELFTEST') === 'adblock-startup'
      ? 'test'
      : 'lists';
  refreshFilterCounts();
  lastBuildMs = Date.now() - t0;
  lastBuildRssMb = Math.round((process.memoryUsage().rss - rss0) / (1024 * 1024));

  const now = Date.now();
  const fp = listFingerprint();
  writeAdblockSettings({
    listStatus: gathered.listStatus,
    listMeta: gathered.listMeta,
    lastUpdateAt: now,
    statusMessage: gathered.fromCache
      ? `Listas do cache · ${networkFilterCount} rede + ${cosmeticFilterCount} cosmético`
      : `Listas atualizadas · ${networkFilterCount} rede + ${cosmeticFilterCount} cosmético`,
  });
  saveMeta({
    lastUpdateAt: now,
    listStatus: gathered.listStatus,
    fingerprint: fp,
    networkFilterCount,
    cosmeticFilterCount,
    resourcesLoaded,
    lastBuildMs,
    lastBuildRssMb,
    engineSource,
  });
  emitProgress('');
  debugLog(
    'engine built',
    'source=' + engineSource,
    'net=' + networkFilterCount,
    'cos=' + cosmeticFilterCount,
    'res=' + resourcesLoaded,
    'ms=' + lastBuildMs,
    'rssDeltaMb=' + lastBuildRssMb
  );
  return true;
}

/**
 * Debounced + single-flight rebuild: never two bodies in parallel; if a request
 * arrives during a rebuild, one trailing rebuild runs with coalesced opts.
 * @param {{ forceDownload?: boolean, skipSerialize?: boolean }} [opts]
 * @param {{ immediate?: boolean }} [sched]
 * @returns {Promise<boolean>}
 */
function buildEngine(opts = {}, sched = {}) {
  const immediate = !!(sched && sched.immediate);
  return new Promise((resolve, reject) => {
    rebuildPendingOpts = {
      ...rebuildPendingOpts,
      ...opts,
      // forceDownload sticks if any caller asked for it
      forceDownload: !!(rebuildPendingOpts.forceDownload || opts.forceDownload),
      skipSerialize:
        opts.skipSerialize !== undefined
          ? !!opts.skipSerialize
          : !!rebuildPendingOpts.skipSerialize,
    };
    rebuildWaiters.push({ resolve, reject });
    const kick = () => {
      rebuildDebounceTimer = null;
      void flushRebuildQueue();
    };
    if (immediate) {
      if (rebuildDebounceTimer) {
        clearTimeout(rebuildDebounceTimer);
        rebuildDebounceTimer = null;
      }
      kick();
      return;
    }
    if (rebuildDebounceTimer) clearTimeout(rebuildDebounceTimer);
    rebuildDebounceTimer = setTimeout(kick, REBUILD_DEBOUNCE_MS);
  });
}

async function flushRebuildQueue() {
  if (rebuildActive) {
    rebuildAgain = true;
    return;
  }
  if (!rebuildWaiters.length && !Object.keys(rebuildPendingOpts).length && !rebuildAgain) {
    return;
  }
  rebuildActive = true;
  rebuildInProgress = true;
  rebuildAgain = false;
  const opts = { ...rebuildPendingOpts };
  rebuildPendingOpts = {};
  const waiters = rebuildWaiters;
  rebuildWaiters = [];
  rebuildParallelNow += 1;
  if (rebuildParallelNow > rebuildParallelPeak) rebuildParallelPeak = rebuildParallelNow;
  let result = false;
  let err = null;
  try {
    result = await buildEngineBody(opts);
  } catch (e) {
    err = e;
  } finally {
    rebuildParallelNow = Math.max(0, rebuildParallelNow - 1);
    rebuildActive = false;
    rebuildInProgress = false;
  }
  if (err) {
    for (const w of waiters) w.reject(err);
  } else {
    for (const w of waiters) w.resolve(result);
  }
  if (rebuildAgain || rebuildWaiters.length || Object.keys(rebuildPendingOpts).length) {
    rebuildAgain = false;
    await flushRebuildQueue();
  }
}

function getRebuildDebug() {
  return {
    active: rebuildActive,
    parallelNow: rebuildParallelNow,
    parallelPeak: rebuildParallelPeak,
    pendingWaiters: rebuildWaiters.length,
    debounceMs: REBUILD_DEBOUNCE_MS,
  };
}

function resetRebuildDebug() {
  rebuildParallelPeak = 0;
  rebuildParallelNow = 0;
}

function tryLoadSerializedEngine() {
  try {
    if (!fs.existsSync(enginePath())) return false;
    const meta = loadMeta();
    const fp = listFingerprint();
    if (meta.fingerprint && meta.fingerprint !== fp) {
      debugLog('engine.bin fingerprint mismatch — rebuild required');
      return false;
    }
    const buf = fs.readFileSync(enginePath());
    blocker = ElectronBlocker.deserialize(new Uint8Array(buf));
    engineSource = 'cache';
    refreshFilterCounts();
    if (meta.networkFilterCount) networkFilterCount = meta.networkFilterCount;
    if (meta.cosmeticFilterCount) cosmeticFilterCount = meta.cosmeticFilterCount;
    if (meta.resourcesLoaded) resourcesLoaded = meta.resourcesLoaded;
    if (meta.lastBuildMs) lastBuildMs = meta.lastBuildMs;
    if (meta.lastBuildRssMb) lastBuildRssMb = meta.lastBuildRssMb;
    writeAdblockSettings({
      listStatus: meta.listStatus || { engine: 'cache' },
      lastUpdateAt: meta.lastUpdateAt || null,
      statusMessage: `Motor do cache · ${networkFilterCount} rede + ${cosmeticFilterCount} cosmético`,
    });
    debugLog('engine deserialized', networkFilterCount, cosmeticFilterCount, 'resources', resourcesLoaded);
    // If serialized engine has no resources, try load from disk without full rebuild
    if (resourcesLoaded === 0 && fs.existsSync(resourcesCachePath())) {
      try {
        const text = fs.readFileSync(resourcesCachePath(), 'utf8');
        blocker.updateResources(text, '' + text.length);
        refreshFilterCounts();
        debugLog('resources attached post-deserialize', resourcesLoaded);
      } catch (err) {
        console.warn('[adblock] attach resources failed', err && err.message);
      }
    }
    return true;
  } catch (err) {
    console.warn('[adblock] deserialize failed', err && err.message);
    return false;
  }
}

/**
 * True for YouTube-family hosts (incl. music / m / nocookie / kids).
 * @param {string} hostname
 */
function isYoutubeFamilyHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  return (
    h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'youtube-nocookie.com' ||
    h.endsWith('.youtube-nocookie.com') ||
    h === 'youtubekids.com' ||
    h.endsWith('.youtubekids.com') ||
    h === 'youtu.be'
  );
}

/**
 * Resolve about:blank / about:srcdoc to a parent frame URL when possible
 * so YouTube-hosted blank/srcdoc frames inherit hostname scriptlets.
 * @param {string} url
 * @param {Electron.IpcMainEvent} event
 */
function resolveFrameUrlForEarly(url, event) {
  const raw = String(url || '');
  const blank =
    !raw ||
    raw === 'about:blank' ||
    raw === 'about:srcdoc' ||
    raw.startsWith('about:srcdoc');
  if (!blank) return raw;
  try {
    let frame = event && event.senderFrame;
    let guard = 0;
    while (frame && guard++ < 8) {
      const parent = frame.parent;
      if (!parent) break;
      const pu = String(parent.url || '');
      if (pu && pu !== 'about:blank' && !pu.startsWith('about:srcdoc')) {
        return pu;
      }
      frame = parent;
    }
  } catch {
    /* ignore */
  }
  // Fallback: top-level panel URL when frame.parent is unavailable at document_start
  try {
    const top =
      event && event.sender && typeof event.sender.getURL === 'function'
        ? String(event.sender.getURL() || '')
        : '';
    if (top && top !== 'about:blank' && !top.startsWith('about:srcdoc')) {
      return top;
    }
  } catch {
    /* ignore */
  }
  return raw;
}

/**
 * Compute hostname scriptlets/styles for early sync injection (cached).
 * @param {string} url
 */
function computeEarlyPayload(url) {
  if (!blocker || readAdblockSettings().cosmetic === false || !isGloballyEnabled()) {
    return { ok: false, scripts: [], styles: '' };
  }
  if (url && isAllowlisted(url)) {
    return { ok: false, scripts: [], styles: '' };
  }
  const parsed = parse(url || '');
  const hostname = parsed.hostname || '';
  const domain = parsed.domain || '';
  const cacheKey = hostname || url || '';
  const ttlMs = isYoutubeFamilyHost(hostname) ? 5 * 60_000 : 60_000;
  const cached = earlyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ttlMs) {
    return { ok: true, scripts: cached.scripts, styles: cached.styles, cached: true };
  }
  const { active, styles, scripts } = blocker.getCosmeticsFilters({
    domain,
    hostname,
    url: url || `https://${hostname}/`,
    getBaseRules: true,
    getInjectionRules: true,
    getExtendedRules: false,
    getRulesFromHostname: true,
    getRulesFromDOM: false,
  });
  if (active === false) {
    return { ok: false, scripts: [], styles: '' };
  }
  const payload = {
    ok: true,
    scripts: scripts || [],
    styles: styles || '',
  };
  earlyCache.set(cacheKey, { scripts: payload.scripts, styles: payload.styles, at: Date.now() });
  if (earlyCache.size > EARLY_CACHE_MAX) {
    const first = earlyCache.keys().next().value;
    earlyCache.delete(first);
  }
  return payload;
}

function lightModeCssIfEnabled() {
  try {
    const { getState } = require('../state');
    if (getState().settings && getState().settings.lightMode) {
      return (
        '*,*::before,*::after{animation:none!important;transition:none!important;' +
        'scroll-behavior:auto!important;}' +
        'html{scroll-behavior:auto!important;}'
      );
    }
  } catch {
    /* ignore */
  }
  return '';
}

function uaPatchOptsForUrl(url) {
  try {
    const ua = require('../user-agent');
    return { googleAuth: ua.isGoogleAuthUrl(url || '') };
  } catch {
    return {};
  }
}

function uaPatchIfNeeded(url) {
  try {
    const ua = require('../user-agent');
    return ua.mainWorldUaPatchSource(undefined, uaPatchOptsForUrl(url));
  } catch {
    return '';
  }
}

function uaPatchDataIfNeeded(url) {
  try {
    const ua = require('../user-agent');
    return ua.mainWorldUaPatchData(undefined, uaPatchOptsForUrl(url));
  } catch {
    return null;
  }
}

function passkeyDisableIfNeeded() {
  try {
    const passkeys = require('../passkeys');
    return passkeys.shouldDisablePasskeysInMainWorld();
  } catch {
    return false;
  }
}

/**
 * Sync IPC handler — must return before page scripts run.
 */
function handleEarlyScriptlets(event, url) {
  try {
    const wc = event.sender;
    const accountId = wc ? wcToAccount.get(wc.id) : null;
    const resolvedUrl = resolveFrameUrlForEarly(url || '', event);
    const patchUrl = resolvedUrl || url || '';
    const passkeyDisable = passkeyDisableIfNeeded();
    if (accountId && !isWindowBlockingEnabled(accountId)) {
      event.returnValue = {
        ok: true,
        scripts: [],
        styles: '',
        uaPatch: uaPatchIfNeeded(patchUrl),
        uaPatchData: uaPatchDataIfNeeded(patchUrl),
        passkeyDisable,
        lightModeCss: lightModeCssIfEnabled(),
      };
      return;
    }
    const early = computeEarlyPayload(resolvedUrl || '');
    event.returnValue = {
      ok: early.ok,
      scripts: early.scripts || [],
      styles: early.styles || '',
      cached: !!early.cached,
      resolvedUrl,
      uaPatch: uaPatchIfNeeded(patchUrl),
      uaPatchData: uaPatchDataIfNeeded(patchUrl),
      passkeyDisable,
      lightModeCss: lightModeCssIfEnabled(),
    };
  } catch (err) {
    console.warn('[adblock] early-scriptlets', err && err.message);
    const patchUrl = url || '';
    event.returnValue = {
      ok: false,
      scripts: [],
      styles: '',
      uaPatch: uaPatchIfNeeded(patchUrl),
      uaPatchData: uaPatchDataIfNeeded(patchUrl),
      passkeyDisable: passkeyDisableIfNeeded(),
    };
  }
}

/**
 * Inject cosmetics/scriptlets into the requesting frame (main or iframe).
 * Hostname scriptlets are preferred via early sync path; async path skips
 * re-running them when lifecycle === 'post-early'.
 */
async function handleInjectCosmeticFilters(event, url, msg) {
  if (!blocker || readAdblockSettings().cosmetic === false) return;
  if (!isGloballyEnabled()) return;
  try {
    const wc = event.sender;
    const accountId = wcToAccount.get(wc.id);
    if (accountId && !isWindowBlockingEnabled(accountId)) return;
    if (url && isAllowlisted(url)) return;

    const parsed = parse(url);
    const hostname = parsed.hostname || '';
    const domain = parsed.domain || '';
    const lifecycle = (msg && msg.lifecycle) || '';
    const postEarly = lifecycle === 'post-early';
    const isMutation = lifecycle === 'mutation' || (msg && (msg.classes || msg.ids || msg.hrefs));
    const isFirstRun = !msg || lifecycle === 'document-start' || postEarly;
    const { active, styles, scripts } = blocker.getCosmeticsFilters({
      domain,
      hostname,
      url,
      classes: msg && msg.classes,
      hrefs: msg && msg.hrefs,
      ids: msg && msg.ids,
      getBaseRules: isFirstRun && !postEarly,
      getInjectionRules: isFirstRun && !postEarly,
      getExtendedRules: false,
      getRulesFromHostname: isFirstRun && !postEarly,
      getRulesFromDOM: !!isMutation || !isFirstRun,
      callerContext: {
        frameId: event.frameId,
        processId: event.processId,
        lifecycle,
      },
    });
    if (active === false) return;

    const frame = event.senderFrame;
    const useFrame = frame && typeof frame.isDestroyed === 'function' && !frame.isDestroyed();
    const isSubFrame = useFrame && frame !== wc.mainFrame;

    if (styles && styles.length > 0) {
      if (isSubFrame) {
        const css = JSON.stringify(styles);
        await frame.executeJavaScript(
          `(function(){var s=document.getElementById('mh-adblock-css');` +
            `if(!s){s=document.createElement('style');s.id='mh-adblock-css';` +
            `(document.head||document.documentElement).appendChild(s);s.textContent='';}` +
            `s.textContent+=${css};})()`,
          true
        );
      } else if (useFrame && typeof frame.insertCSS === 'function' && frame === wc.mainFrame) {
        try {
          await frame.insertCSS(styles);
        } catch {
          await wc.insertCSS(styles, { cssOrigin: 'user' });
        }
      } else {
        await wc.insertCSS(styles, { cssOrigin: 'user' });
      }
    }
    // Skip hostname scriptlets when early sync already ran them
    if (!postEarly) {
      for (const script of scripts || []) {
        try {
          if (useFrame && typeof frame.executeJavaScript === 'function') {
            await frame.executeJavaScript(script, true);
          } else {
            await wc.executeJavaScript(script, true);
          }
        } catch (e) {
          console.warn('[adblock] scriptlet crashed', e && e.message);
        }
      }
    }
  } catch (err) {
    console.warn('[adblock] cosmetic inject', err && err.message);
  }
}

function registerCosmeticIpc() {
  if (cosmeticIpcRegistered) return;
  cosmeticIpcRegistered = true;
  ipcMain.handle(IPC_COSMETIC, handleInjectCosmeticFilters);
  ipcMain.handle(IPC_MUTATION, async () => {
    return !!(blocker && readAdblockSettings().cosmetic !== false);
  });
  if (!earlyIpcRegistered) {
    earlyIpcRegistered = true;
    ipcMain.on(IPC_EARLY, handleEarlyScriptlets);
    ipcMain.on(IPC_EARLY_TIMING, (event, payload) => {
      if (!payload) return;
      const accountId = event && event.sender ? wcToAccount.get(event.sender.id) || null : null;
      const entry = {
        url: String(payload.url || ''),
        syncMs: Number(payload.syncMs) || 0,
        injectMs: Number(payload.injectMs) || 0,
        scripts: Number(payload.scripts) || 0,
        hasStyles: !!payload.hasStyles,
        via: String(payload.via || 'cosmetic-preload'),
        at: Date.now(),
        accountId,
      };
      earlyTimingLog.unshift(entry);
      if (earlyTimingLog.length > EARLY_TIMING_MAX) earlyTimingLog.length = EARLY_TIMING_MAX;
      if (accountId) lastEarlyByAccount.set(accountId, entry);
      debugLog(
        'early-timing',
        'syncMs=',
        payload.syncMs,
        'injectMs=',
        payload.injectMs,
        'scripts=',
        payload.scripts,
        'via=',
        entry.via,
        'account=',
        accountId
      );
    });
  }
}

function unregisterCosmeticIpc() {
  if (!cosmeticIpcRegistered) return;
  try {
    ipcMain.removeHandler(IPC_COSMETIC);
    ipcMain.removeHandler(IPC_MUTATION);
  } catch {
    /* ignore */
  }
  cosmeticIpcRegistered = false;
}

/**
 * @param {Electron.Session} ses
 * @param {string|null} accountId
 */
function attachSession(ses, accountId) {
  knownSessions.add(ses);
  const prev = attachedSessions.get(ses) || { accountId: null, preloadId: undefined };
  if (accountId) prev.accountId = accountId;
  attachedSessions.set(ses, prev);

  hub.removeBeforeRequest(ses, HUB_ID);
  hub.removeHeadersReceived(ses, HUB_ID);

  if (!blocker || !isGloballyEnabled()) {
    if (prev.preloadId) {
      try {
        ses.unregisterPreloadScript(prev.preloadId);
      } catch {
        /* ignore */
      }
      prev.preloadId = undefined;
    }
    // Still register early IPC so panel-preload sendSync always has a listener
    registerCosmeticIpc();
    debugLog('attachSession: blocker inactive', accountId);
    return;
  }

  hub.addBeforeRequest(ses, HUB_ID, (details, callback) => {
    const enriched = enrichDetails(details);
    const accountId2 = enriched.webContentsId
      ? wcToAccount.get(enriched.webContentsId)
      : prev.accountId;
    if (!shouldBlockForDetails(enriched)) {
      if (enriched.resourceType !== 'mainFrame') {
        recordRequest(accountId2 || null, {
          url: enriched.url,
          type: enriched.resourceType || '',
          blocked: false,
          filter: null,
        });
      }
      callback({});
      return;
    }
    if (enriched.resourceType === 'mainFrame') {
      callback({});
      return;
    }
    blocker.onBeforeRequest(enriched, (response) => {
      const blocked = !!(response && response.cancel);
      if (blocked) {
        recordBlocked(accountId2 || null, enriched.url);
      }
      recordRequest(accountId2 || null, {
        url: enriched.url,
        type: enriched.resourceType || '',
        blocked,
        filter: blocked ? 'matched' : null,
      });
      callback(response || {});
    });
  });

  hub.addHeadersReceived(ses, HUB_ID, (details, callback) => {
    const enriched = enrichDetails(details);
    if (!shouldBlockForDetails(enriched) || readAdblockSettings().cosmetic === false) {
      callback({});
      return;
    }
    blocker.onHeadersReceived(enriched, callback);
  });

  const wantCosmetic = readAdblockSettings().cosmetic !== false;
  if (wantCosmetic && !prev.preloadId) {
    try {
      if (!PRELOAD_RESOLVED.exists) {
        console.warn('[adblock] cosmetic preload missing', PRELOAD_PATH);
      }
      prev.preloadId = ses.registerPreloadScript({
        type: 'frame',
        filePath: PRELOAD_PATH,
      });
      debugLog(
        'registerPreloadScript ok',
        accountId,
        prev.preloadId,
        'path=',
        PRELOAD_PATH,
        'unpacked=',
        PRELOAD_RESOLVED.unpacked
      );
    } catch (err) {
      console.warn('[adblock] registerPreloadScript failed', err && err.message, PRELOAD_PATH);
    }
  } else if (!wantCosmetic && prev.preloadId) {
    try {
      ses.unregisterPreloadScript(prev.preloadId);
    } catch {
      /* ignore */
    }
    prev.preloadId = undefined;
  }
  attachedSessions.set(ses, prev);
  registerCosmeticIpc();
  debugLog('attachSession active', accountId, 'sessions', knownSessions.size);
}

/**
 * Attach hub + session preload for every persist:acc-* account partition
 * (including accounts created later / restored before first panel paint).
 */
function attachAllAccountSessions() {
  const accounts = getState().accounts || [];
  const { session } = require('electron');
  let panelsMod = null;
  try {
    panelsMod = require('../panels');
  } catch {
    panelsMod = null;
  }
  for (const acc of accounts) {
    if (!acc || !acc.id) continue;
    try {
      const part =
        panelsMod && typeof panelsMod.partitionFor === 'function'
          ? panelsMod.partitionFor(acc.id)
          : 'persist:' + String(acc.id);
      const ses = session.fromPartition(part);
      attachSession(ses, acc.id);
    } catch (err) {
      console.warn('[adblock] attachAllAccountSessions', acc.id, err && err.message);
    }
  }
}

function detachSession(ses) {
  hub.removeBeforeRequest(ses, HUB_ID);
  hub.removeHeadersReceived(ses, HUB_ID);
  const prev = attachedSessions.get(ses);
  if (prev && prev.preloadId) {
    try {
      ses.unregisterPreloadScript(prev.preloadId);
    } catch {
      /* ignore */
    }
  }
  attachedSessions.delete(ses);
  knownSessions.delete(ses);
}

function reattachAll() {
  for (const ses of knownSessions) {
    const meta = attachedSessions.get(ses);
    attachSession(ses, meta ? meta.accountId : null);
  }
}

function bindWebContents(accountId, wc) {
  if (!wc || wc.isDestroyed()) return;
  wcToAccount.set(wc.id, accountId);
  const onNav = () => resetPageStats(accountId);
  wc.on('did-navigate', onNav);
  wc.on('destroyed', () => {
    wcToAccount.delete(wc.id);
  });
}

function updateIntervalMs() {
  const h = readAdblockSettings().updateIntervalHours || DEFAULT_UPDATE_INTERVAL_HOURS;
  return h * 60 * 60 * 1000;
}

function isOfflineAdblockSelftest() {
  const st = envGet('MULTIHEIZ_SELFTEST') || '';
  return (
    st === 'adblock' ||
    st === 'adblock-startup' ||
    st === 'adblock-packaged' ||
    st === 'v18' ||
    st === 'builtin-yt'
  );
}

function scheduleUpdateTimer() {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (isTestMode() && isOfflineAdblockSelftest()) {
    return;
  }
  updateTimer = setInterval(() => {
    updateListsNow().catch(() => {});
  }, updateIntervalMs());
  if (typeof updateTimer.unref === 'function') updateTimer.unref();
}

/**
 * Attach hub listeners to every known session + every account partition +
 * the default session. Safe to call repeatedly after the engine is ready.
 */
function attachBlockingEverywhere() {
  reattachAll();
  attachAllAccountSessions();
  try {
    const { session } = require('electron');
    if (session && session.defaultSession) {
      attachSession(session.defaultSession, null);
    }
  } catch (err) {
    debugLog('attach defaultSession', err && err.message ? err.message : err);
  }
}

/**
 * Ensure a live engine exists when adblock is enabled: prefer a valid
 * engine.bin cache, else compile off the main thread (worker) immediately.
 * @param {{ forceDownload?: boolean, allowStaleBgUpdate?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
async function ensureEngineAtStartup(opts = {}) {
  const forceDownload = !!opts.forceDownload;
  const allowStaleBgUpdate = opts.allowStaleBgUpdate !== false;

  if (tryLoadSerializedEngine()) {
    if (allowStaleBgUpdate && forceDownload && !fetchBlocked) {
      buildEngine({ forceDownload: true }, { immediate: false })
        .then((ok) => {
          if (ok && isGloballyEnabled()) attachBlockingEverywhere();
          emitStatus();
        })
        .catch((e) => console.warn('[adblock] bg update', e && e.message));
    }
    return true;
  }

  return buildEngine({ forceDownload }, { immediate: true });
}

/**
 * @param {{ emit: (p: object) => void }} opts
 */
function init(opts) {
  emitFn = opts.emit || null;
  // Register early-scriptlets before any panel/extension frame can sendSync
  // (attachSession may not run yet when accounts are empty or blocker inactive).
  registerCosmeticIpc();
  readyPromise = (async () => {
    try {
      ensureDir();
      if (!getState().settings.adblock) {
        writeAdblockSettings(defaultAdblockSettings());
      } else {
        // Merge new default list flags for upgrades from 1.7.0
        const cur = readAdblockSettings();
        const defaults = defaultListFlags();
        const merged = { ...defaults, ...cur.lists };
        writeAdblockSettings({ lists: merged });
      }

      // Disabled in saved settings: do not compile; still register IPC + detach hubs.
      if (!isGloballyEnabled()) {
        reattachAll();
        emitStatus();
        scheduleUpdateTimer();
        debugLog('init skipped engine (adblock disabled)');
        return;
      }

      const meta = loadMeta();
      const interval = updateIntervalMs();
      const stale = !meta.lastUpdateAt || Date.now() - Number(meta.lastUpdateAt) > interval;
      const forceDownload = isOfflineAdblockSelftest() ? false : stale;

      const ok = await ensureEngineAtStartup({
        forceDownload,
        // Cache hit + stale lists → refresh in background without blocking startup attach
        allowStaleBgUpdate: !isOfflineAdblockSelftest() && stale,
      });

      if (ok && isGloballyEnabled()) {
        attachBlockingEverywhere();
      }
      emitStatus();
      scheduleUpdateTimer();
      debugLog('init done source=' + engineSource, 'ready=' + !!blocker, 'enabled=' + isGloballyEnabled());
    } catch (err) {
      console.error('[adblock] init failed', err);
      writeAdblockSettings({ statusMessage: 'Falha ao iniciar bloqueador' });
    }
  })();
  return readyPromise;
}

function whenReady() {
  return readyPromise || Promise.resolve();
}

async function updateListsNow() {
  const ok = await buildEngine(
    {
      forceDownload: !(isTestMode() && isOfflineAdblockSelftest()),
    },
    { immediate: true }
  );
  if (ok && isGloballyEnabled()) attachBlockingEverywhere();
  else reattachAll();
  emitStatus();
  return getStatus();
}

async function applySettings(partial) {
  if (partial && typeof partial === 'object') {
    writeAdblockSettings(partial);
  }
  const p = partial && typeof partial === 'object' ? partial : {};
  const needRebuild = settingsApply.adblockPartialNeedsRebuild(p);
  const enabledTouched = typeof p.enabled === 'boolean';
  const intervalTouched = typeof p.updateIntervalHours === 'number';

  if (needRebuild) {
    clearEarlyCache();
    // Structural change (lists/cosmetic/rules) — compile off-main, then swap.
    await buildEngine({ forceDownload: false }, { immediate: true });
    if (isGloballyEnabled()) attachBlockingEverywhere();
    else reattachAll();
  } else if (enabledTouched || Object.keys(p).length > 0) {
    // Enable/disable (and other soft keys): never rebuild when engine already cached.
    clearEarlyCache();
    if (enabledTouched && p.enabled !== false && !blocker) {
      // First enable with empty cache — need an engine once.
      await buildEngine({ forceDownload: false }, { immediate: true });
    }
    if (isGloballyEnabled()) attachBlockingEverywhere();
    else reattachAll();
  }

  if (intervalTouched) {
    scheduleUpdateTimer();
  }
  emitStatus();
  return getStatus();
}

function setWindowEnabled(accountId, enabled) {
  updateState((st) => {
    const a = st.accounts.find((x) => x.id === accountId);
    if (a) a.adblockEnabled = !!enabled;
  });
  reattachAll();
  return !!enabled;
}

function addAllowlistDomain(domain) {
  const d = String(domain || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
    .trim();
  if (!d) return readAdblockSettings().allowlist;
  const ab = readAdblockSettings();
  if (!ab.allowlist.includes(d)) {
    writeAdblockSettings({ allowlist: [...ab.allowlist, d] });
  }
  reattachAll();
  return readAdblockSettings().allowlist;
}

function removeAllowlistDomain(domain) {
  const d = String(domain || '')
    .toLowerCase()
    .replace(/^www\./, '');
  const ab = readAdblockSettings();
  writeAdblockSettings({ allowlist: ab.allowlist.filter((x) => x !== d) });
  reattachAll();
  return readAdblockSettings().allowlist;
}

/**
 * Add custom list by URL (http/https). Downloads and validates.
 * @param {string} url
 */
async function addCustomList(url) {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) {
    return { ok: false, error: 'URL deve começar com http:// ou https://' };
  }
  let body;
  try {
    const res = await auditedFetch(raw, {
      headers: { 'User-Agent': 'MultiHeiz-Adblock/1.7.1' },
    });
    if (!res.ok) {
      cancelResponseBody(res);
      throw new Error(`HTTP ${res.status}`);
    }
    body = await res.text();
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
  const ruleCount = countFilterLines(body);
  if (ruleCount < 1) {
    return { ok: false, error: 'Lista vazia ou formato inválido' };
  }
  ensureDir();
  const id = 'custom_' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
  const file = path.join(
    adblockDir(),
    'custom-' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '.txt'
  );
  fs.writeFileSync(file, body, 'utf8');
  const ab = readAdblockSettings();
  const entry = {
    id,
    url: raw,
    name: raw.replace(/^https?:\/\//i, '').split('/')[0] || 'Lista custom',
    enabled: true,
  };
  const customLists = [...(ab.customLists || []).filter((c) => c.url !== raw), entry];
  const listMeta = {
    ...(ab.listMeta || {}),
    [id]: { ruleCount, lastUpdateAt: Date.now(), status: 'ok', error: null },
  };
  writeAdblockSettings({ customLists, listMeta });
  await buildEngine({ forceDownload: false }, { immediate: true });
  reattachAll();
  emitStatus();
  return { ok: true, entry, ruleCount, status: getStatus() };
}

function removeCustomList(id) {
  const ab = readAdblockSettings();
  writeAdblockSettings({
    customLists: (ab.customLists || []).filter((c) => c.id !== id),
  });
  return applySettings({ customLists: readAdblockSettings().customLists });
}

async function setUserRules(text) {
  writeAdblockSettings({ userRules: String(text || '') });
  await buildEngine({ forceDownload: false }, { immediate: true });
  reattachAll();
  emitStatus();
  return getStatus();
}

function getStatus() {
  const ab = readAdblockSettings();
  const catalog = Object.values(LISTS).map((def) => ({
    id: def.id,
    name: def.name,
    group: def.group,
    groupLabel: GROUP_LABELS[def.group] || def.group,
    url: def.url,
    license: def.license || '',
    vendor: def.vendor || '',
    enabled: ab.lists[def.id] !== false,
    defaultOn: def.defaultOn,
    note: def.note || '',
    status: (ab.listStatus && ab.listStatus[def.id]) || (ab.listMeta[def.id] && ab.listMeta[def.id].status) || '—',
    ruleCount: (ab.listMeta[def.id] && ab.listMeta[def.id].ruleCount) || 0,
    lastUpdateAt: (ab.listMeta[def.id] && ab.listMeta[def.id].lastUpdateAt) || ab.lastUpdateAt,
    error: (ab.listMeta[def.id] && ab.listMeta[def.id].error) || null,
  }));
  return {
    enabled: ab.enabled !== false,
    ready: !!blocker,
    antiTracking: ab.antiTracking !== false,
    cosmetic: ab.cosmetic !== false,
    youtubeExperimental: !!ab.youtubeExperimental,
    lists: ab.lists,
    allowlist: ab.allowlist,
    customLists: ab.customLists,
    userRules: ab.userRules,
    updateIntervalHours: ab.updateIntervalHours,
    updateIntervalHoursOptions: UPDATE_INTERVAL_HOURS_OPTIONS,
    lastUpdateAt: ab.lastUpdateAt,
    listStatus: ab.listStatus || {},
    listMeta: ab.listMeta || {},
    statusMessage: ab.statusMessage || '',
    sessionTotal: sessionBlockedTotal,
    engine: blocker ? 'ghostery' : null,
    engineSource,
    networkFilterCount,
    cosmeticFilterCount,
    totalFilterCount: networkFilterCount + cosmeticFilterCount,
    resourcesLoaded,
    lastBuildMs,
    lastBuildRssMb,
    rebuilding: rebuildInProgress,
    progress: rebuildProgress,
    catalog,
    groupLabels: GROUP_LABELS,
    preprocess: { ...lastPreprocessStats },
  };
}

function getDiagnostics() {
  const st = getStatus();
  const meta = loadMeta();
  return {
    engineSource: st.engineSource,
    ready: st.ready,
    enabled: st.enabled,
    youtubeExperimental: !!st.youtubeExperimental,
    networkFilterCount: st.networkFilterCount,
    cosmeticFilterCount: st.cosmeticFilterCount,
    resourcesLoaded: st.resourcesLoaded,
    lastUpdateAt: st.lastUpdateAt,
    lastBuildMs: st.lastBuildMs,
    lastBuildRssMb: st.lastBuildRssMb,
    fingerprint: meta.fingerprint || null,
    listStatus: st.listStatus,
    listMeta: st.listMeta,
    catalog: st.catalog,
    customLists: st.customLists,
    statusMessage: st.statusMessage,
    attachedSessions: knownSessions.size,
    preloadPath: PRELOAD_PATH,
    preloadExists: PRELOAD_RESOLVED.exists,
    preloadInAsar: PRELOAD_RESOLVED.inAsar,
    preloadUnpacked: PRELOAD_RESOLVED.unpacked,
    packaged: !!(app && app.isPackaged),
  };
}

/**
 * Diagnósticos > Painel em foco — early injection + rule counts for hostname.
 * @param {string|null|undefined} accountId
 * @param {string} [pageUrl]
 */
function getFocusedPanelDiagnostics(accountId, pageUrl) {
  const id = accountId || null;
  const early = id ? lastEarlyByAccount.get(id) : null;
  const url = pageUrl || (early && early.url) || '';
  const hostname = hostnameFromUrl(url);
  let cosmeticRules = 0;
  let scriptletRules = 0;
  if (blocker && hostname) {
    try {
      const parsed = parse(url || `https://${hostname}/`);
      const { scripts, styles, active } = blocker.getCosmeticsFilters({
        domain: parsed.domain || '',
        hostname,
        url: url || `https://${hostname}/`,
        getBaseRules: true,
        getInjectionRules: true,
        getExtendedRules: false,
        getRulesFromHostname: true,
        getRulesFromDOM: false,
      });
      if (active !== false) {
        scriptletRules = (scripts || []).length;
        cosmeticRules = styles ? String(styles).split('{').length - 1 : 0;
      }
    } catch {
      /* ignore */
    }
  }
  const st = getStatus();
  return {
    accountId: id,
    url,
    hostname,
    scriptletsInjected: !!(early && early.scripts > 0),
    scriptletCount: early ? early.scripts : 0,
    earlyCss: !!(early && early.hasStyles),
    earlySyncMs: early ? early.syncMs : null,
    earlyInjectMs: early ? early.injectMs : null,
    earlyVia: early ? early.via : null,
    earlyAt: early ? early.at : null,
    rulesApplied: {
      cosmeticApprox: cosmeticRules,
      scriptlets: scriptletRules,
    },
    pageBlocked: id ? pageBlocked.get(id) || 0 : 0,
    sessionTotal: sessionBlockedTotal,
    windowEnabled: isWindowBlockingEnabled(id),
    globalEnabled: isGloballyEnabled(),
    engineSource: st.engineSource,
    engineVersion: st.engine || 'ghostery',
    networkFilterCount: st.networkFilterCount,
    cosmeticFilterCount: st.cosmeticFilterCount,
    resourcesLoaded: st.resourcesLoaded,
    preloadPath: PRELOAD_PATH,
    preloadUnpacked: PRELOAD_RESOLVED.unpacked,
  };
}

/**
 * Short summary for shield menu tooltip.
 * @param {string|null|undefined} accountId
 * @param {string} [pageUrl]
 */
function getShieldTooltip(accountId, pageUrl) {
  const d = getFocusedPanelDiagnostics(accountId, pageUrl);
  const early =
    d.scriptletsInjected || d.earlyCss
      ? `early: scriptlets ${d.scriptletCount}${d.earlyCss ? ' + CSS' : ''} (${d.earlySyncMs != null ? d.earlySyncMs.toFixed(1) + 'ms' : '?'})`
      : 'early: ainda não reportado';
  return [
    `Bloqueados nesta página: ${d.pageBlocked}`,
    early,
    `Regras host: ~${d.rulesApplied.cosmeticApprox} cosmético + ${d.rulesApplied.scriptlets} scriptlets`,
    `Motor: ${d.engineSource || '?'} · res ${d.resourcesLoaded}`,
  ].join('\n');
}

function getPageStats(accountId) {
  return {
    pageBlocked: pageBlocked.get(accountId) || 0,
    recent: recentBlocked.get(accountId) || [],
    sessionTotal: sessionBlockedTotal,
    windowEnabled: isWindowBlockingEnabled(accountId),
    globalEnabled: isGloballyEnabled(),
    siteAllowed: false,
  };
}

function getRecentBlocked(accountId) {
  return recentBlocked.get(accountId) || [];
}

function getRecentRequests(accountId) {
  return recentRequests.get(accountId) || [];
}

function getEarlyTimingLog() {
  return earlyTimingLog.slice();
}

function clearEarlyCache() {
  earlyCache.clear();
}

/**
 * Count network/cosmetic filters mentioning youtube hostnames (diagnostic).
 */
function countYoutubeRules() {
  if (!blocker) return { network: 0, cosmetic: 0, scriptlets: 0 };
  let network = 0;
  let cosmetic = 0;
  let scriptlets = 0;
  try {
    const { networkFilters, cosmeticFilters } = blocker.getFilters();
    for (const f of networkFilters) {
      const s = typeof f.toString === 'function' ? f.toString() : String(f);
      if (/youtube|googlevideo|youtu\.be/i.test(s)) network += 1;
    }
    for (const f of cosmeticFilters) {
      const s = typeof f.toString === 'function' ? f.toString() : String(f);
      if (/youtube|youtu\.be/i.test(s)) {
        cosmetic += 1;
        if (typeof f.isScriptInject === 'function' ? f.isScriptInject() : /##\+js/i.test(s)) {
          scriptlets += 1;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return { network, cosmetic, scriptlets };
}

/**
 * Write local ad-leak report under userData/adblock/reports/.
 * @param {{ accountId?: string, pageUrl?: string }} opts
 */
function writeAdReport(opts = {}) {
  ensureDir();
  const reportsDir = path.join(adblockDir(), 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(reportsDir, `${stamp}.json`);
  const accountId = opts.accountId || null;
  const pageUrl = opts.pageUrl || '';
  let ua = '';
  try {
    const uaMod = require('../user-agent');
    ua = uaMod.buildChromeUserAgent();
  } catch {
    ua = '';
  }
  const st = getStatus();
  const hostname = hostnameFromUrl(pageUrl);
  const early = hostname ? earlyCache.get(hostname) : null;
  const report = {
    at: new Date().toISOString(),
    pageUrl,
    userAgent: ua,
    engine: {
      source: st.engineSource,
      networkFilterCount: st.networkFilterCount,
      cosmeticFilterCount: st.cosmeticFilterCount,
      resourcesLoaded: st.resourcesLoaded,
      youtubeExperimental: st.youtubeExperimental,
      youtubeRuleCounts: countYoutubeRules(),
    },
    listVersions: st.listMeta || {},
    listStatus: st.listStatus || {},
    lastUpdateAt: st.lastUpdateAt,
    requests: getRecentRequests(accountId),
    recentBlocked: getRecentBlocked(accountId),
    cosmetics: {
      hostname,
      cachedScripts: early ? (early.scripts || []).length : 0,
      cachedStylesBytes: early && early.styles ? early.styles.length : 0,
      earlyTiming: earlyTimingLog.slice(0, 5),
    },
  };
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return { ok: true, path: file, dir: reportsDir };
}

function isAllowed(url, site) {
  const page = site || url;
  return isAllowlisted(page);
}

async function injectTestFilters(text) {
  ensureDir();
  fs.writeFileSync(path.join(adblockDir(), 'test-filters.txt'), String(text || ''), 'utf8');
  try {
    fs.unlinkSync(enginePath());
  } catch {
    /* ignore */
  }
  await buildEngine({ forceDownload: false, skipSerialize: false }, { immediate: true });
  if (isGloballyEnabled()) attachBlockingEverywhere();
  else reattachAll();
  return getStatus();
}

function shutdown() {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  for (const ses of [...knownSessions]) {
    detachSession(ses);
  }
  unregisterCosmeticIpc();
}

module.exports = {
  init,
  whenReady,
  attachSession,
  attachAllAccountSessions,
  attachBlockingEverywhere,
  ensureEngineAtStartup,
  detachSession,
  bindWebContents,
  applySettings,
  updateListsNow,
  setWindowEnabled,
  addAllowlistDomain,
  removeAllowlistDomain,
  addCustomList,
  removeCustomList,
  setUserRules,
  getStatus,
  getDiagnostics,
  getFocusedPanelDiagnostics,
  getShieldTooltip,
  getPageStats,
  getRecentBlocked,
  getRecentRequests,
  getEarlyTimingLog,
  writeAdReport,
  countYoutubeRules,
  computeEarlyPayload,
  clearEarlyCache,
  isAllowed,
  isGloballyEnabled,
  isWindowBlockingEnabled,
  siteKeyFromUrl,
  injectTestFilters,
  getFetchLog,
  clearFetchLog,
  setFetchBlocked,
  defaultAdblockSettings,
  readAdblockSettings,
  LISTS,
  GROUP_LABELS,
  knownSessions,
  PRELOAD_PATH,
  shutdown,
  buildEngine,
  getRebuildDebug,
  resetRebuildDebug,
  REBUILD_DEBOUNCE_MS,
  preprocess: require('./preprocess'),
};
