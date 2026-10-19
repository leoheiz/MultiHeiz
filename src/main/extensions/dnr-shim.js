'use strict';

/**
 * chrome.declarativeNetRequest static ruleset shim for Electron.
 * Enforced via webRequestHub alongside the built-in adblock engine.
 *
 * Supported actions: block, allow, allowAllRequests, redirect, upgradeScheme.
 * Condition fields: urlFilter, regexFilter, requestDomains, excludedRequestDomains,
 * initiatorDomains, excludedInitiatorDomains, resourceTypes, excludedResourceTypes,
 * domainType, isUrlFilterCaseSensitive.
 */

const fs = require('node:fs');
const path = require('node:path');
const hub = require('../adblock/web-request-hub');

const HUB_ID = 'dnr-shim';

/** @type {Map<Electron.Session, { accountId: string|null }>} */
const attached = new WeakMap();

/** @type {Map<string, ExtensionEngine>} installId -> engine */
const enginesByInstall = new Map();

/** installIds whose DNR applies to accountId (or '*') */
/** @type {Map<string, Set<string>>} accountId -> Set<installId> */
const applyMap = new Map();

/** Accounts already warned for missing applyMap (fail-closed). */
/** @type {Set<string>} */
const missingApplyLogged = new Set();

/** webContentsId -> allow-all until next mainFrame */
/** @type {Set<number>} */
const allowAllWc = new Set();

let adblockRef = null;

function getAdblock() {
  if (!adblockRef) {
    try {
      adblockRef = require('../adblock');
    } catch {
      adblockRef = null;
    }
  }
  return adblockRef;
}

/** Electron resourceType -> Chrome DNR resourceTypes */
const RT_MAP = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
};

const ACTION_RANK = {
  allow: 5,
  allowAllRequests: 4,
  block: 3,
  upgradeScheme: 2,
  redirect: 1,
};

/**
 * Chrome urlFilter → RegExp source (approximate Chromium conversion).
 * @param {string} filter
 * @param {boolean} caseSensitive
 */
function urlFilterToRegExp(filter, caseSensitive) {
  let f = String(filter || '');
  let prefix = '';
  let suffix = '';
  if (f.startsWith('||')) {
    // Domain anchor: scheme:// + optional subdomain labels
    prefix = '^[a-zA-Z0-9+.-]+:\\/\\/(?:[^\\/:*?]+\\.)*';
    f = f.slice(2);
  } else if (f.startsWith('|')) {
    prefix = '^';
    f = f.slice(1);
  }
  if (f.endsWith('|')) {
    suffix = '$';
    f = f.slice(0, -1);
  }
  let out = '';
  for (let i = 0; i < f.length; i++) {
    const ch = f[i];
    if (ch === '*') {
      out += '.*';
    } else if (ch === '^') {
      // Separator: end or char not in [a-zA-Z0-9_.%-]
      out += '(?:[^a-zA-Z0-9_.%-]|$)';
    } else if (/[.+?()[\]{}\\|$]/.test(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  const flags = caseSensitive ? '' : 'i';
  try {
    return new RegExp(prefix + out + suffix, flags);
  } catch {
    return null;
  }
}

/**
 * Extract hostname for indexing from ||domain... urlFilter.
 * @param {string} filter
 * @returns {string|null}
 */
function domainFromUrlFilter(filter) {
  if (!filter || !filter.startsWith('||')) return null;
  let rest = filter.slice(2);
  const cut = rest.search(/[\/^?*|]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  rest = rest.toLowerCase();
  if (!rest || rest.includes(' ')) return null;
  return rest;
}

/**
 * @param {string} hostname
 * @returns {string[]}
 */
function hostSuffixes(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  if (!h) return [];
  const parts = h.split('.').filter(Boolean);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(i).join('.'));
  }
  return out;
}

/**
 * @param {string} host
 * @param {string[]} domains
 */
function hostMatchesDomainList(host, domains) {
  if (!domains || !domains.length) return true;
  const h = host.toLowerCase();
  for (const d of domains) {
    const dd = String(d).toLowerCase();
    if (h === dd || h.endsWith('.' + dd)) return true;
  }
  return false;
}

/**
 * @typedef {object} CompiledRule
 * @property {number} id
 * @property {number} priority
 * @property {string} actionType
 * @property {object} action
 * @property {RegExp|null} urlRe
 * @property {RegExp|null} regexRe
 * @property {string[]|null} requestDomains
 * @property {string[]|null} excludedRequestDomains
 * @property {string[]|null} initiatorDomains
 * @property {string[]|null} excludedInitiatorDomains
 * @property {Set<string>|null} resourceTypes
 * @property {Set<string>|null} excludedResourceTypes
 * @property {'firstParty'|'thirdParty'|null} domainType
 * @property {string|null} indexDomain
 */

/**
 * @param {object} raw
 * @returns {CompiledRule|null}
 */
function compileRule(raw) {
  if (!raw || !raw.action || !raw.condition) return null;
  const actionType = String(raw.action.type || '');
  if (!ACTION_RANK[actionType]) return null;
  // Skip rules that need unsupported condition fields exclusively
  if (raw.condition.responseHeaders || raw.condition.requestMethods) {
    // Still allow if they also have url/regex — but responseHeaders can't be checked on beforeRequest
    if (raw.condition.responseHeaders && !raw.condition.urlFilter && !raw.condition.regexFilter) {
      return null;
    }
  }
  const caseSensitive = !!raw.condition.isUrlFilterCaseSensitive;
  let urlRe = null;
  if (raw.condition.urlFilter) {
    urlRe = urlFilterToRegExp(raw.condition.urlFilter, caseSensitive);
    if (!urlRe) return null;
  }
  let regexRe = null;
  if (raw.condition.regexFilter) {
    try {
      regexRe = new RegExp(
        raw.condition.regexFilter,
        caseSensitive ? '' : 'i'
      );
    } catch {
      return null;
    }
  }
  if (!urlRe && !regexRe && !raw.condition.requestDomains) {
    // Domain-only / type-only rules still valid
  }
  /** @type {CompiledRule} */
  const rule = {
    id: Number(raw.id) || 0,
    priority: Number(raw.priority) || 1,
    actionType,
    action: raw.action,
    urlRe,
    regexRe,
    requestDomains: Array.isArray(raw.condition.requestDomains)
      ? raw.condition.requestDomains.map(String)
      : null,
    excludedRequestDomains: Array.isArray(raw.condition.excludedRequestDomains)
      ? raw.condition.excludedRequestDomains.map(String)
      : null,
    initiatorDomains: Array.isArray(raw.condition.initiatorDomains)
      ? raw.condition.initiatorDomains.map(String)
      : null,
    excludedInitiatorDomains: Array.isArray(raw.condition.excludedInitiatorDomains)
      ? raw.condition.excludedInitiatorDomains.map(String)
      : null,
    resourceTypes: Array.isArray(raw.condition.resourceTypes)
      ? new Set(raw.condition.resourceTypes.map(String))
      : null,
    excludedResourceTypes: Array.isArray(raw.condition.excludedResourceTypes)
      ? new Set(raw.condition.excludedResourceTypes.map(String))
      : null,
    domainType:
      raw.condition.domainType === 'firstParty' || raw.condition.domainType === 'thirdParty'
        ? raw.condition.domainType
        : null,
    indexDomain: null,
  };
  if (rule.requestDomains && rule.requestDomains.length === 1) {
    rule.indexDomain = rule.requestDomains[0].toLowerCase();
  } else if (raw.condition.urlFilter) {
    rule.indexDomain = domainFromUrlFilter(raw.condition.urlFilter);
  }
  return rule;
}

/**
 * @typedef {object} ExtensionEngine
 * @property {string} installId
 * @property {string} extPath
 * @property {Map<string, { enabled: boolean, path: string, rules: CompiledRule[] }>} rulesets
 * @property {CompiledRule[]} dynamicRules
 * @property {CompiledRule[]} sessionRules
 * @property {Map<string, CompiledRule[]>} hostIndex
 * @property {CompiledRule[]} genericRules
 * @property {number} ruleCount
 * @property {number} loadMs
 */

/**
 * @param {ExtensionEngine} eng
 */
function rebuildIndexes(eng) {
  eng.hostIndex = new Map();
  eng.genericRules = [];
  eng.ruleCount = 0;
  /** @type {CompiledRule[]} */
  const all = [];
  for (const rs of eng.rulesets.values()) {
    if (!rs.enabled) continue;
    for (const r of rs.rules) all.push(r);
  }
  for (const r of eng.dynamicRules) all.push(r);
  for (const r of eng.sessionRules) all.push(r);
  eng.ruleCount = all.length;
  for (const r of all) {
    if (r.indexDomain) {
      const key = r.indexDomain.toLowerCase();
      let list = eng.hostIndex.get(key);
      if (!list) {
        list = [];
        eng.hostIndex.set(key, list);
      }
      list.push(r);
    } else {
      eng.genericRules.push(r);
    }
  }
}

/**
 * Load static rulesets from an extension directory + manifest.
 * @param {string} installId
 * @param {string} extPath
 * @param {object} manifest
 * @returns {ExtensionEngine}
 */
function loadExtensionRules(installId, extPath, manifest) {
  const t0 = Date.now();
  /** @type {ExtensionEngine} */
  const eng = {
    installId,
    extPath,
    rulesets: new Map(),
    dynamicRules: [],
    sessionRules: [],
    hostIndex: new Map(),
    genericRules: [],
    ruleCount: 0,
    loadMs: 0,
  };
  const dnr = manifest && manifest.declarative_net_request;
  const resources = (dnr && dnr.rule_resources) || [];
  for (const rr of resources) {
    const id = String(rr.id || '');
    if (!id) continue;
    const rel = String(rr.path || '');
    const abs = path.join(extPath, rel);
    /** @type {CompiledRule[]} */
    const compiled = [];
    if (fs.existsSync(abs)) {
      try {
        const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
        const arr = Array.isArray(raw) ? raw : [];
        for (const item of arr) {
          const c = compileRule(item);
          if (c) compiled.push(c);
        }
      } catch (err) {
        console.warn('[dnr] ruleset parse failed', id, err && err.message);
      }
    }
    eng.rulesets.set(id, {
      enabled: !!rr.enabled,
      path: abs,
      rules: compiled,
    });
  }
  rebuildIndexes(eng);
  eng.loadMs = Date.now() - t0;
  enginesByInstall.set(installId, eng);
  return eng;
}

/**
 * @param {string} installId
 */
function unloadExtensionRules(installId) {
  enginesByInstall.delete(installId);
  for (const set of applyMap.values()) set.delete(installId);
}

/**
 * @param {string} installId
 * @param {{ enableRulesetIds?: string[], disableRulesetIds?: string[] }} update
 */
function updateEnabledRulesets(installId, update) {
  const eng = enginesByInstall.get(installId);
  if (!eng) return { ok: false, error: 'engine missing' };
  for (const id of update.enableRulesetIds || []) {
    const rs = eng.rulesets.get(String(id));
    if (rs) rs.enabled = true;
  }
  for (const id of update.disableRulesetIds || []) {
    const rs = eng.rulesets.get(String(id));
    if (rs) rs.enabled = false;
  }
  rebuildIndexes(eng);
  return { ok: true, ruleCount: eng.ruleCount };
}

/**
 * @param {string} installId
 * @param {'dynamic'|'session'} which
 * @param {{ removeRuleIds?: number[], addRules?: object[] }} update
 */
function updateRules(installId, which, update) {
  const eng = enginesByInstall.get(installId);
  if (!eng) return { ok: false, error: 'engine missing' };
  const key = which === 'session' ? 'sessionRules' : 'dynamicRules';
  const remove = new Set((update.removeRuleIds || []).map(Number));
  if (remove.size) {
    eng[key] = eng[key].filter((r) => !remove.has(r.id));
  }
  for (const raw of update.addRules || []) {
    const c = compileRule(raw);
    if (c) {
      eng[key] = eng[key].filter((r) => r.id !== c.id);
      eng[key].push(c);
    }
  }
  rebuildIndexes(eng);
  return { ok: true, ruleCount: eng.ruleCount };
}

/**
 * Which install engines apply to an account.
 * @param {string} accountId
 * @param {string[]} installIds
 */
function setApplies(accountId, installIds) {
  applyMap.set(accountId, new Set(installIds));
}

/**
 * Sync apply map from extension records + loader.
 * @param {string[]} accountIds
 * @param {(rec: object, accountId: string) => boolean} appliesFn
 * @param {() => object[]} listRecords
 */
function syncApplyFromStore(accountIds, appliesFn, listRecords) {
  const records = listRecords();
  for (const accountId of accountIds) {
    const ids = [];
    for (const rec of records) {
      if (
        rec &&
        rec.enabled &&
        appliesFn(rec, accountId) &&
        enginesByInstall.has(rec.id)
      ) {
        ids.push(rec.id);
      }
    }
    setApplies(accountId, ids);
  }
}

/**
 * @param {CompiledRule} rule
 * @param {{ url: string, host: string, initiatorHost: string, resourceType: string, firstParty: boolean }} ctx
 */
function ruleMatches(rule, ctx) {
  if (rule.resourceTypes && !rule.resourceTypes.has(ctx.resourceType)) return false;
  if (rule.excludedResourceTypes && rule.excludedResourceTypes.has(ctx.resourceType)) {
    return false;
  }
  if (rule.requestDomains && !hostMatchesDomainList(ctx.host, rule.requestDomains)) {
    return false;
  }
  if (
    rule.excludedRequestDomains &&
    hostMatchesDomainList(ctx.host, rule.excludedRequestDomains)
  ) {
    return false;
  }
  if (rule.initiatorDomains && !hostMatchesDomainList(ctx.initiatorHost, rule.initiatorDomains)) {
    return false;
  }
  if (
    rule.excludedInitiatorDomains &&
    hostMatchesDomainList(ctx.initiatorHost, rule.excludedInitiatorDomains)
  ) {
    return false;
  }
  if (rule.domainType === 'firstParty' && !ctx.firstParty) return false;
  if (rule.domainType === 'thirdParty' && ctx.firstParty) return false;
  if (rule.urlRe && !rule.urlRe.test(ctx.url)) return false;
  if (rule.regexRe && !rule.regexRe.test(ctx.url)) return false;
  return true;
}

/**
 * Pick winning rule among matches (highest priority, then action rank).
 * @param {CompiledRule[]} matches
 * @returns {CompiledRule|null}
 */
function pickWinner(matches) {
  if (!matches.length) return null;
  let best = matches[0];
  for (let i = 1; i < matches.length; i++) {
    const r = matches[i];
    if (r.priority > best.priority) {
      best = r;
      continue;
    }
    if (r.priority === best.priority) {
      const ra = ACTION_RANK[r.actionType] || 0;
      const ba = ACTION_RANK[best.actionType] || 0;
      if (ra > ba) best = r;
    }
  }
  return best;
}

/**
 * @param {ExtensionEngine} eng
 * @param {{ url: string, host: string, initiatorHost: string, resourceType: string, firstParty: boolean }} ctx
 * @returns {CompiledRule|null}
 */
function matchEngine(eng, ctx) {
  /** @type {CompiledRule[]} */
  const candidates = [];
  const seen = new Set();
  for (const suf of hostSuffixes(ctx.host)) {
    const list = eng.hostIndex.get(suf);
    if (!list) continue;
    for (const r of list) {
      if (seen.has(r)) continue;
      seen.add(r);
      candidates.push(r);
    }
  }
  for (const r of eng.genericRules) {
    if (!seen.has(r)) candidates.push(r);
  }
  /** @type {CompiledRule[]} */
  const matches = [];
  for (const r of candidates) {
    if (ruleMatches(r, ctx)) matches.push(r);
  }
  return pickWinner(matches);
}

/**
 * @param {string} url
 */
function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Registrable-ish same-site check (suffix equality).
 * @param {string} a
 * @param {string} b
 */
function sameSite(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('.' + b) || b.endsWith('.' + a);
}

/**
 * Evaluate all engines for an account; return Electron CallbackResponse-ish.
 * @param {string|null} accountId
 * @param {Electron.OnBeforeRequestListenerDetails} details
 */
function evaluate(accountId, details) {
  const url = details.url || '';
  if (!url || url.startsWith('chrome-extension:') || url.startsWith('data:')) {
    return {};
  }
  const resourceType = RT_MAP[details.resourceType] || 'other';
  if (resourceType === 'main_frame') {
    if (details.webContentsId != null) allowAllWc.delete(details.webContentsId);
  }
  if (details.webContentsId != null && allowAllWc.has(details.webContentsId)) {
    return {};
  }

  const ab = getAdblock();
  if (ab) {
    let pageUrl = details.referrer || '';
    try {
      const { webContents } = require('electron');
      if (details.webContentsId) {
        const wc = webContents.fromId(details.webContentsId);
        if (wc && !wc.isDestroyed()) pageUrl = wc.getURL() || pageUrl;
      }
    } catch {
      /* ignore */
    }
    if (pageUrl && ab.isAllowed(pageUrl)) return {};
  }

  const host = hostnameOf(url);
  let initiatorHost = hostnameOf(details.referrer || '');
  if (!initiatorHost && details.webContentsId) {
    try {
      const { webContents } = require('electron');
      const wc = webContents.fromId(details.webContentsId);
      if (wc && !wc.isDestroyed()) initiatorHost = hostnameOf(wc.getURL());
    } catch {
      /* ignore */
    }
  }
  const firstParty = sameSite(host, initiatorHost);
  const ctx = { url, host, initiatorHost, resourceType, firstParty };

  // Fail-closed: only apply engines explicitly mapped for this account (or '*').
  // Missing map must NOT fall back to all engines (cross-account leak).
  let installIds = null;
  if (accountId && applyMap.has(accountId)) {
    installIds = applyMap.get(accountId);
  } else if (applyMap.has('*')) {
    installIds = applyMap.get('*');
  } else {
    const key = accountId || '(null)';
    if (!missingApplyLogged.has(key)) {
      missingApplyLogged.add(key);
      console.warn(
        '[dnr-shim] applyMap missing for account — denying all DNR rules (fail-closed)',
        key
      );
    }
    return {};
  }

  /** @type {CompiledRule[]} */
  const winners = [];
  if (installIds && installIds.size) {
    for (const id of installIds) {
      const eng = enginesByInstall.get(id);
      if (!eng || !eng.ruleCount) continue;
      const w = matchEngine(eng, ctx);
      if (w) winners.push(w);
    }
  }

  const winner = pickWinner(winners);
  if (!winner) return {};

  if (winner.actionType === 'allow') return {};
  if (winner.actionType === 'allowAllRequests') {
    if (
      (resourceType === 'main_frame' || resourceType === 'sub_frame') &&
      details.webContentsId != null
    ) {
      allowAllWc.add(details.webContentsId);
    }
    return {};
  }
  if (winner.actionType === 'block') {
    // Do not cancel main navigations (login-safe; matches built-in)
    if (resourceType === 'main_frame') return {};
    return { cancel: true };
  }
  if (winner.actionType === 'upgradeScheme') {
    if (url.startsWith('http://')) {
      return { redirectURL: 'https://' + url.slice('http://'.length) };
    }
    return {};
  }
  if (winner.actionType === 'redirect') {
    const red = winner.action.redirect;
    if (!red) return {};
    if (red.url) return { redirectURL: String(red.url) };
    if (red.extensionPath && winner /* need ext path */) {
      // extensionPath redirects need chrome-extension:// id — skip if unknown
      return {};
    }
    if (red.transform) {
      try {
        const u = new URL(url);
        const t = red.transform;
        if (t.scheme) u.protocol = t.scheme + ':';
        if (t.host) u.host = t.host;
        if (t.port) u.port = t.port;
        if (t.path != null) u.pathname = t.path;
        if (t.query != null) u.search = t.query ? '?' + t.query : '';
        if (t.fragment != null) u.hash = t.fragment ? '#' + t.fragment : '';
        return { redirectURL: u.href };
      } catch {
        return {};
      }
    }
  }
  return {};
}

/**
 * @param {Electron.Session} ses
 * @param {string|null} accountId
 */
function attachSession(ses, accountId) {
  attached.set(ses, { accountId: accountId || null });
  hub.removeBeforeRequest(ses, HUB_ID);
  hub.addBeforeRequest(ses, HUB_ID, (details, callback) => {
    const meta = attached.get(ses) || { accountId: null };
    let accountId2 = meta.accountId;
    try {
      const ab = getAdblock();
      if (ab && details.webContentsId && ab.wcToAccount) {
        accountId2 = ab.wcToAccount.get(details.webContentsId) || accountId2;
      }
    } catch {
      /* ignore */
    }
    // Resolve account from panels binding if available
    try {
      const ab = getAdblock();
      if ((!accountId2 || accountId2 === 'acc') && details.webContentsId && ab) {
        // wcToAccount may not be exported — use referrer path only
      }
    } catch {
      /* ignore */
    }
    try {
      const result = evaluate(accountId2, details);
      callback(result || {});
    } catch (err) {
      console.warn('[dnr] evaluate error', err && err.message);
      callback({});
    }
  });
}

/**
 * @param {Electron.Session} ses
 */
function detachSession(ses) {
  hub.removeBeforeRequest(ses, HUB_ID);
  attached.delete(ses);
}

/**
 * Benchmark match speed.
 * @param {string} installId
 * @param {string[]} urls
 * @returns {{ ruleCount: number, loadMs: number, lookups: number, totalMs: number, avgUs: number }}
 */
function measureLookup(installId, urls) {
  const eng = enginesByInstall.get(installId);
  if (!eng) {
    return { ruleCount: 0, loadMs: 0, lookups: 0, totalMs: 0, avgUs: 0 };
  }
  const t0 = process.hrtime.bigint();
  let n = 0;
  for (const url of urls) {
    const host = hostnameOf(url);
    matchEngine(eng, {
      url,
      host,
      initiatorHost: 'www.example.com',
      resourceType: 'image',
      firstParty: false,
    });
    n += 1;
  }
  const t1 = process.hrtime.bigint();
  const totalMs = Number(t1 - t0) / 1e6;
  return {
    ruleCount: eng.ruleCount,
    loadMs: eng.loadMs,
    lookups: n,
    totalMs,
    avgUs: n ? (totalMs * 1000) / n : 0,
  };
}

function getEngine(installId) {
  return enginesByInstall.get(installId) || null;
}

function listEngines() {
  return [...enginesByInstall.entries()].map(([id, e]) => ({
    installId: id,
    ruleCount: e.ruleCount,
    loadMs: e.loadMs,
    rulesets: [...e.rulesets.entries()].map(([rid, rs]) => ({
      id: rid,
      enabled: rs.enabled,
      rules: rs.rules.length,
    })),
  }));
}

/**
 * Match without session (unit / selftest).
 * @param {string} installId
 * @param {string} url
 * @param {{ resourceType?: string, initiator?: string }} [opts]
 */
function matchUrl(installId, url, opts = {}) {
  const eng = enginesByInstall.get(installId);
  if (!eng) return null;
  const host = hostnameOf(url);
  const initiatorHost = hostnameOf(opts.initiator || '');
  return matchEngine(eng, {
    url,
    host,
    initiatorHost,
    resourceType: opts.resourceType || 'image',
    firstParty: sameSite(host, initiatorHost),
  });
}

module.exports = {
  loadExtensionRules,
  unloadExtensionRules,
  updateEnabledRulesets,
  updateRules,
  setApplies,
  syncApplyFromStore,
  attachSession,
  detachSession,
  evaluate,
  measureLookup,
  getEngine,
  listEngines,
  matchUrl,
  compileRule,
  urlFilterToRegExp,
  HUB_ID,
  enginesByInstall,
};
