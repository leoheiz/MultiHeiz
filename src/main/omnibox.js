'use strict';

/**
 * Local address-bar suggestions (history, favorites, open windows, search).
 * Never logs typed text or URLs. Remote engine suggestions are opt-in.
 */

const history = require('./history');
const { toSearchUrl, looksLikeUrl } = require('./search-url');

const MAX_ITEMS = 8;

/** Match rank: lower is better. */
const RANK_DOMAIN_PREFIX = 0;
const RANK_LABEL_PREFIX = 1;
const RANK_SUBSTRING = 2;
const RANK_NONE = 99;

/**
 * Case- and accent-insensitive fold (NFD + strip diacritics).
 * @param {string} s
 * @returns {string}
 */
function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  return history.domainOf(url) || '';
}

/**
 * Strip scheme, leading www., m. for matching / inline completion.
 * @param {string} input
 * @returns {{ host: string, scheme: string, www: string, restPath: string }}
 */
function normalizeUrlForMatch(input) {
  let raw = String(input || '').trim();
  let scheme = '';
  const m = raw.match(/^(https?:\/\/)(.*)$/i);
  if (m) {
    scheme = m[1];
    raw = m[2];
  }
  let www = '';
  const wwwM = raw.match(/^(www\.)(.*)$/i);
  if (wwwM) {
    www = wwwM[1].toLowerCase() === 'www.' ? 'www.' : wwwM[1];
    raw = wwwM[2];
  } else {
    const mobM = raw.match(/^(m\.)(.*)$/i);
    if (mobM) {
      www = 'm.';
      raw = mobM[2];
    }
  }
  let host = raw;
  let restPath = '';
  const slash = raw.search(/[/?#]/);
  if (slash >= 0) {
    host = raw.slice(0, slash);
    restPath = raw.slice(slash);
  }
  return { host: fold(host), scheme, www, restPath, rawHost: host };
}

/**
 * Normalize a stored hostname the same way (strip www./m.).
 * @param {string} host
 * @returns {string}
 */
function normalizeHost(host) {
  let h = fold(host);
  if (h.startsWith('www.')) h = h.slice(4);
  else if (h.startsWith('m.')) h = h.slice(2);
  return h;
}

/**
 * Words from title + URL path for substring matching.
 * @param {string} title
 * @param {string} url
 * @returns {string[]}
 */
function urlWords(title, url) {
  const words = [];
  const foldedTitle = fold(title);
  if (foldedTitle) {
    for (const w of foldedTitle.split(/[^a-z0-9]+/i)) {
      if (w) words.push(w);
    }
  }
  let path = '';
  try {
    const u = new URL(String(url || ''));
    path = `${u.hostname} ${u.pathname} ${u.search}`.replace(/^[a-z]+:\/\//i, '');
  } catch {
    path = String(url || '');
  }
  const foldedPath = fold(path);
  for (const w of foldedPath.split(/[/\-_.?&#=+:\s]+/)) {
    if (w) words.push(w);
  }
  return words;
}

/**
 * Best match rank for query against a URL/title candidate.
 * @param {string} queryFolded
 * @param {string} url
 * @param {string} title
 * @returns {number}
 */
function matchRank(queryFolded, url, title) {
  const q = String(queryFolded || '');
  if (!q) return RANK_DOMAIN_PREFIX;
  const host = normalizeHost(hostOf(url));
  if (host && host.startsWith(q)) return RANK_DOMAIN_PREFIX;
  if (host) {
    const labels = host.split('.').filter(Boolean);
    for (const lab of labels) {
      if (lab.startsWith(q)) return RANK_LABEL_PREFIX;
    }
  }
  const words = urlWords(title, url);
  for (const w of words) {
    if (w.includes(q)) return RANK_SUBSTRING;
  }
  const hay = fold(`${title || ''} ${url || ''} ${host}`);
  if (hay.includes(q)) return RANK_SUBSTRING;
  return RANK_NONE;
}

/**
 * Aggregate history by URL: most visits first, then most recent.
 * @param {Array<object>} entries
 * @returns {Array<{url:string,title:string,favicon:string,id:string,count:number,time:number}>}
 */
function rankHistory(entries) {
  /** @type {Map<string, {url:string,title:string,favicon:string,id:string,count:number,time:number}>} */
  const byUrl = new Map();
  for (const e of entries || []) {
    if (!e || !e.url) continue;
    const url = history.stripSensitiveUrl(e.url);
    if (history.shouldIgnoreUrl(url)) continue;
    const cur = byUrl.get(url);
    if (!cur) {
      byUrl.set(url, {
        url,
        title: String(e.title || ''),
        favicon: e.favicon || '',
        id: e.id,
        count: 1,
        time: Number(e.time) || 0,
      });
    } else {
      cur.count += 1;
      if ((Number(e.time) || 0) > cur.time) {
        cur.time = Number(e.time) || 0;
        cur.id = e.id;
        if (e.title) cur.title = String(e.title);
        if (e.favicon) cur.favicon = e.favicon;
      }
    }
  }
  return [...byUrl.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.time - a.time;
  });
}

/**
 * Domains ranked by visit count (for inline completion).
 * @param {Array<object>} entries
 * @returns {Array<{host:string,norm:string,count:number}>}
 */
function rankDomains(entries) {
  /** @type {Map<string, {host:string,norm:string,count:number}>} */
  const counts = new Map();
  for (const e of entries || []) {
    if (!e || !e.url) continue;
    const h = hostOf(history.stripSensitiveUrl(e.url)).toLowerCase();
    if (!h) continue;
    const norm = normalizeHost(h);
    const cur = counts.get(norm);
    if (!cur) counts.set(norm, { host: norm, norm, count: 1 });
    else cur.count += 1;
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.host.localeCompare(b.host)
  );
}

/**
 * Inline domain completion: only for normalized domain-prefix matches.
 * @param {string} typed
 * @param {Array<object>} historyEntries
 * @returns {{ full: string, completion: string } | null}
 */
function inlineDomainCompletion(typed, historyEntries) {
  const raw = String(typed || '');
  if (!raw || /\s/.test(raw)) return null;
  const norm = normalizeUrlForMatch(raw);
  if (!norm.host || norm.restPath) return null;
  if (norm.host.includes('/') || norm.host.includes('?') || norm.host.includes('#')) {
    return null;
  }
  if (norm.host.length < 1) return null;
  const domains = rankDomains(historyEntries);
  for (const d of domains) {
    if (d.norm.startsWith(norm.host) && d.norm.length > norm.host.length) {
      // Preserve scheme + optional www./m. the user already typed.
      const full = norm.scheme + norm.www + d.norm;
      if (full.length <= raw.length) continue;
      return { full, completion: full.slice(raw.length) };
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.windowId]
 * @param {Array<object>} opts.accounts
 * @param {Array<object>} opts.bookmarkItems
 * @param {{ searchEngine?: string, searchTemplate?: string, searchEngineSuggestions?: boolean }} opts.settings
 * @returns {{ items: Array<object>, inline: { full: string, completion: string } | null, remoteEnabled: boolean }}
 */
function suggest(opts = {}) {
  const query = String(opts.query || '');
  const qFold = fold(query.trim());
  const settings = opts.settings || {};
  const remoteEnabled = !!settings.searchEngineSuggestions;
  const entries = history.query({ limit: 2000 }) || [];
  const ranked = rankHistory(entries);
  /** @type {Array<object>} */
  const candidates = [];
  const seenUrls = new Set();

  function addCandidate(item, rank) {
    if (rank >= RANK_NONE && qFold) return;
    const key = item.url ? String(item.url) : `search:${item.title}`;
    if (item.url && seenUrls.has(item.url)) return;
    if (item.url) seenUrls.add(item.url);
    if (!item.url && candidates.some((x) => x.kind === 'search')) return;
    candidates.push({
      ...item,
      __rank: rank,
      __count: Number(item.count) || 0,
      __time: Number(item.time) || 0,
    });
  }

  // Open windows
  for (const acc of opts.accounts || []) {
    if (!acc || !acc.id) continue;
    const name = String(acc.name || '').trim() || 'Janela';
    const start = String(acc.startUrl || acc.lastUrl || '');
    let rank = RANK_NONE;
    if (!qFold) rank = RANK_SUBSTRING;
    else {
      const nameFold = fold(name);
      if (nameFold.startsWith(qFold)) rank = RANK_LABEL_PREFIX;
      else if (nameFold.includes(qFold) || fold(start).includes(qFold)) rank = RANK_SUBSTRING;
      else {
        const r = matchRank(qFold, start, name);
        if (r < RANK_NONE) rank = r;
      }
    }
    if (rank >= RANK_NONE && qFold) continue;
    addCandidate(
      {
        kind: 'window',
        id: `win-${acc.id}`,
        accountId: acc.id,
        title: name,
        subtitle: 'Alternar para a janela',
        url: start || '',
        count: 0,
        time: 0,
      },
      rank
    );
  }

  // Favorites
  for (const b of opts.bookmarkItems || []) {
    if (!b || !b.url) continue;
    const url = history.stripSensitiveUrl(b.url);
    if (history.shouldIgnoreUrl(url)) continue;
    const title = String(b.name || b.title || url);
    const rank = qFold ? matchRank(qFold, url, title) : RANK_SUBSTRING;
    if (rank >= RANK_NONE && qFold) continue;
    addCandidate(
      {
        kind: 'favorite',
        id: b.id || `fav-${url}`,
        title,
        url,
        subtitle: hostOf(url) || url,
        count: 0,
        time: 0,
      },
      rank
    );
  }

  // History
  for (const h of ranked) {
    const rank = qFold ? matchRank(qFold, h.url, h.title) : RANK_SUBSTRING;
    if (rank >= RANK_NONE && qFold) continue;
    addCandidate(
      {
        kind: 'history',
        id: h.id,
        title: h.title || hostOf(h.url) || h.url,
        url: h.url,
        subtitle: hostOf(h.url) || h.url,
        count: h.count,
        time: h.time,
      },
      rank
    );
  }

  candidates.sort((a, b) => {
    if (a.__rank !== b.__rank) return a.__rank - b.__rank;
    if (b.__count !== a.__count) return b.__count - a.__count;
    return b.__time - a.__time;
  });

  const items = [];
  for (const c of candidates) {
    if (items.length >= MAX_ITEMS) break;
    if (!c.url && items.some((x) => x.kind === 'search')) continue;
    const { __rank, __count, __time, ...rest } = c;
    void __rank;
    void __count;
    void __time;
    items.push(rest);
  }

  // Search line (always when there is typed text)
  if (query.trim()) {
    const label = `Pesquisar ${query.trim()}`;
    if (items.length < MAX_ITEMS && !items.some((x) => x.kind === 'search')) {
      items.push({
        kind: 'search',
        id: 'search-line',
        title: label,
        url: toSearchUrl(query.trim(), settings),
        subtitle: '',
        query: query.trim(),
      });
    }
  }

  // Prefer domain-prefix history/fav over flooding; search stays last among equals via push order.
  const inline = inlineDomainCompletion(query, entries);

  return {
    items: items.slice(0, MAX_ITEMS),
    inline,
    remoteEnabled,
    looksLikeUrl: looksLikeUrl(query.trim()),
  };
}

/**
 * Fetch remote suggestions only when enabled. Returns [] on failure / when off.
 * @param {string} query
 * @param {{ searchEngine?: string, searchEngineSuggestions?: boolean }} settings
 * @param {{ fetchJson?: Function }} [deps]
 * @returns {Promise<string[]>}
 */
async function remoteSuggestions(query, settings = {}, deps = {}) {
  if (!settings.searchEngineSuggestions) return [];
  const q = String(query || '').trim();
  if (!q || q.length < 2) return [];
  const engine = settings.searchEngine || 'google';
  let url = '';
  if (engine === 'google') {
    url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`;
  } else if (engine === 'duckduckgo') {
    url = `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`;
  } else if (engine === 'bing') {
    url = `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`;
  } else {
    return [];
  }
  try {
    const fetchJson =
      deps.fetchJson ||
      (async (u) => {
        const { net } = require('electron');
        return new Promise((resolve, reject) => {
          const req = net.request(u);
          const chunks = [];
          req.on('response', (res) => {
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
              } catch (err) {
                reject(err);
              }
            });
            res.on('error', reject);
          });
          req.on('error', reject);
          req.end();
        });
      });
    const data = await fetchJson(url);
    if (Array.isArray(data) && Array.isArray(data[1])) {
      return data[1].map(String).filter(Boolean).slice(0, 5);
    }
    if (Array.isArray(data)) {
      return data
        .map((x) => (typeof x === 'string' ? x : x && x.phrase))
        .filter(Boolean)
        .slice(0, 5);
    }
  } catch {
    /* ignore network errors */
  }
  return [];
}

module.exports = {
  MAX_ITEMS,
  suggest,
  inlineDomainCompletion,
  rankHistory,
  rankDomains,
  remoteSuggestions,
  fold,
  normalizeUrlForMatch,
  normalizeHost,
  matchRank,
  RANK_DOMAIN_PREFIX,
  RANK_LABEL_PREFIX,
  RANK_SUBSTRING,
  RANK_NONE,
};
