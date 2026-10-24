'use strict';

/**
 * Local address-bar suggestions (history, favorites, open windows, search).
 * Never logs typed text or URLs. Remote engine suggestions are opt-in.
 */

const history = require('./history');
const { toSearchUrl, looksLikeUrl } = require('./search-url');

const MAX_ITEMS = 8;

/**
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  return history.domainOf(url) || '';
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
 * @returns {Array<{host:string,count:number}>}
 */
function rankDomains(entries) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const e of entries || []) {
    if (!e || !e.url) continue;
    const h = hostOf(history.stripSensitiveUrl(e.url)).toLowerCase();
    if (!h) continue;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

/**
 * Inline domain completion: typed prefix → remainder selected in the field.
 * @param {string} typed
 * @param {Array<object>} historyEntries
 * @returns {{ full: string, completion: string } | null}
 */
function inlineDomainCompletion(typed, historyEntries) {
  const raw = String(typed || '');
  if (!raw || /\s/.test(raw)) return null;
  // Only complete bare host-ish prefixes (no scheme with path yet, no spaces).
  let prefix = raw;
  let scheme = '';
  const m = raw.match(/^(https?:\/\/)(.*)$/i);
  if (m) {
    scheme = m[1];
    prefix = m[2];
  }
  if (!prefix || prefix.includes('/') || prefix.includes('?') || prefix.includes('#')) {
    return null;
  }
  const lower = prefix.toLowerCase();
  if (lower.length < 1) return null;
  const domains = rankDomains(historyEntries);
  for (const d of domains) {
    if (d.host.startsWith(lower) && d.host.length > lower.length) {
      const full = scheme + d.host;
      return { full, completion: full.slice(raw.length) };
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.windowId] current panel (for private-history skip of that window's own private? private never recorded)
 * @param {Array<object>} opts.accounts
 * @param {Array<object>} opts.bookmarkItems
 * @param {{ searchEngine?: string, searchTemplate?: string, searchEngineSuggestions?: boolean }} opts.settings
 * @returns {{ items: Array<object>, inline: { full: string, completion: string } | null, remoteEnabled: boolean }}
 */
function suggest(opts = {}) {
  const query = String(opts.query || '');
  const q = query.trim().toLowerCase();
  const settings = opts.settings || {};
  const remoteEnabled = !!settings.searchEngineSuggestions;
  const entries = history.query({ limit: 2000 }) || [];
  const ranked = rankHistory(entries);
  const items = [];
  const seenUrls = new Set();

  function push(item) {
    if (items.length >= MAX_ITEMS) return false;
    const key = item.url ? String(item.url) : `search:${item.title}`;
    if (item.url && seenUrls.has(item.url)) return true;
    if (item.url) seenUrls.add(item.url);
    if (!item.url && items.some((x) => x.kind === 'search')) return true;
    items.push(item);
    return items.length < MAX_ITEMS;
  }

  // Open windows ("Alternar para a janela")
  for (const acc of opts.accounts || []) {
    if (!acc || !acc.id) continue;
    const name = String(acc.name || '').trim() || 'Janela';
    const start = String(acc.startUrl || acc.lastUrl || '');
    const hay = `${name} ${start}`.toLowerCase();
    if (q && !hay.includes(q) && !name.toLowerCase().startsWith(q)) continue;
    if (
      !push({
        kind: 'window',
        id: `win-${acc.id}`,
        accountId: acc.id,
        title: name,
        subtitle: 'Alternar para a janela',
        url: start || '',
      })
    ) {
      break;
    }
  }

  // Favorites
  for (const b of opts.bookmarkItems || []) {
    if (!b || !b.url) continue;
    const url = history.stripSensitiveUrl(b.url);
    if (history.shouldIgnoreUrl(url)) continue;
    const title = String(b.name || b.title || url);
    if (q) {
      const hay = `${title} ${url} ${hostOf(url)}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    if (
      !push({
        kind: 'favorite',
        id: b.id || `fav-${url}`,
        title,
        url,
        subtitle: hostOf(url) || url,
      })
    ) {
      break;
    }
  }

  // History (most visited + recent)
  for (const h of ranked) {
    if (q) {
      const hay = `${h.title} ${h.url} ${hostOf(h.url)}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    if (
      !push({
        kind: 'history',
        id: h.id,
        title: h.title || hostOf(h.url) || h.url,
        url: h.url,
        subtitle: hostOf(h.url) || h.url,
        count: h.count,
      })
    ) {
      break;
    }
  }

  // Search line (always when there is typed text that isn't only a perfect URL match)
  if (query.trim()) {
    const label = `Pesquisar ${query.trim()}`;
    push({
      kind: 'search',
      id: 'search-line',
      title: label,
      url: toSearchUrl(query.trim(), settings),
      subtitle: '',
      query: query.trim(),
    });
  }

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
};
