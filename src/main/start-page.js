'use strict';

/**
 * Start page data (favorites bar, Apps, most visited).
 * Used both for the empty-area start page and for a "pending" new window
 * (Nova janela → start page inside the panel slot).
 * No network — favicons only from stored history/bookmark/catalog fields (prefer data:/file:).
 *
 * Global (shared by every area): custom Apps (state.customStartApps) and hidden
 * built-in catalog apps (state.startPageHiddenCatalogApps).
 * Per-area: showFavoritesBar / showApps / showMostVisited / rows / hiddenSuggested.
 */

const history = require('./history');
const bookmarks = require('./bookmarks');
const omnibox = require('./omnibox');
const catalog = require('./catalog');

/** Fill most visited from global history when the area itself has fewer than this. */
const MIN_SCOPED_MOST_VISITED = 8;
const PER_ROW = 5;

function defaultOpts() {
  return {
    showFavoritesBar: true,
    showApps: true,
    showMostVisited: true,
    mostVisitedRows: 2,
    hiddenSuggested: [],
    // Legacy per-area custom tiles (migrated into state.customStartApps once).
    customTiles: [],
  };
}

/**
 * Only allow local/cached favicon URLs (no remote fetch from the start page).
 * @param {unknown} fav
 * @returns {string}
 */
function localFavicon(fav) {
  const s = String(fav || '').trim();
  if (!s) return '';
  if (s.startsWith('data:')) return s;
  if (s.startsWith('file:')) return s;
  // Cached blob / app protocol if ever used
  if (s.startsWith('blob:') || s.startsWith('multiheiz:')) return s;
  return '';
}

/**
 * http(s) only; bare host gets https://.
 * @param {unknown} raw
 * @returns {string} '' when invalid
 */
function normalizeAppUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || /\s/.test(s)) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[^/]*:\d+(\/|$)/.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    if (!u.hostname) return '';
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * @param {unknown} raw
 * @returns {Array<{id:string,title:string,url:string,favicon:string,order:number}>}
 */
function normalizeCustomApps(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const tile = /** @type {Record<string, unknown>} */ (t);
    const url = normalizeAppUrl(tile.url);
    if (!url) return;
    let id = String(tile.id || `ca-${i}`);
    if (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    out.push({
      id,
      title: String(tile.title || tile.name || '').trim().slice(0, 80),
      url,
      favicon: localFavicon(tile.favicon),
      order: typeof tile.order === 'number' && Number.isFinite(tile.order) ? tile.order : i,
    });
  });
  out.sort((a, b) => a.order - b.order);
  return out.map((a, i) => ({ ...a, order: i }));
}

/**
 * @param {unknown} raw
 */
function normalizeOpts(raw) {
  const base = defaultOpts();
  if (!raw || typeof raw !== 'object') return base;
  const o = /** @type {Record<string, unknown>} */ (raw);
  base.showFavoritesBar = o.showFavoritesBar !== false;
  base.showApps = o.showApps !== false;
  base.showMostVisited = o.showMostVisited !== false;
  const rows = Number(o.mostVisitedRows);
  base.mostVisitedRows = Number.isFinite(rows) ? Math.min(6, Math.max(1, Math.round(rows))) : 2;
  base.hiddenSuggested = Array.isArray(o.hiddenSuggested)
    ? o.hiddenSuggested.map((u) => String(u || '')).filter(Boolean)
    : [];
  base.customTiles = normalizeCustomApps(o.customTiles);
  return base;
}

/**
 * Move legacy per-area customTiles into the global custom apps list — once
 * (only when the global list is empty). Mutates `state`; idempotent.
 * @param {object} state
 * @returns {boolean} true when state changed
 */
function migrateCustomTiles(state) {
  if (!state || typeof state !== 'object') return false;
  if (!Array.isArray(state.customStartApps)) state.customStartApps = [];
  const byWs = state.startPageByWorkspace;
  if (!byWs || typeof byWs !== 'object') return false;
  const wsWithTiles = Object.keys(byWs).filter(
    (k) => byWs[k] && Array.isArray(byWs[k].customTiles) && byWs[k].customTiles.length
  );
  if (!wsWithTiles.length) return false;
  if (state.customStartApps.length) {
    // Already migrated (or user built a global list): drop the legacy copies.
    for (const k of wsWithTiles) byWs[k].customTiles = [];
    return true;
  }
  const merged = [];
  const seenUrl = new Set();
  for (const k of wsWithTiles) {
    for (const t of normalizeCustomApps(byWs[k].customTiles)) {
      if (seenUrl.has(t.url)) continue;
      seenUrl.add(t.url);
      merged.push({ ...t, id: t.id || `ca-${merged.length}` });
    }
  }
  state.customStartApps = normalizeCustomApps(
    merged.map((t, i) => ({ ...t, order: i }))
  );
  for (const k of wsWithTiles) byWs[k].customTiles = [];
  return true;
}

function needsMigration(state) {
  if (!state || typeof state !== 'object') return false;
  const byWs = state.startPageByWorkspace;
  if (!byWs || typeof byWs !== 'object') return false;
  return Object.keys(byWs).some(
    (k) => byWs[k] && Array.isArray(byWs[k].customTiles) && byWs[k].customTiles.length
  );
}

function hiddenCatalogIds(state) {
  const arr = state && Array.isArray(state.startPageHiddenCatalogApps)
    ? state.startPageHiddenCatalogApps
    : [];
  return arr.map((x) => String(x || '')).filter(Boolean);
}

/**
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {object} opts.state
 */
function getData(opts) {
  const workspaceId = String((opts && opts.workspaceId) || '');
  const state = (opts && opts.state) || {};
  // Keep the in-memory state consistent even if the caller forgot to migrate.
  if (needsMigration(state)) migrateCustomTiles(state);
  const byWs = state.startPageByWorkspace || {};
  const pageOpts = normalizeOpts(byWs[workspaceId]);
  const hiddenCatalog = hiddenCatalogIds(state);
  pageOpts.hiddenCatalogApps = hiddenCatalog;

  const bm = bookmarks.list();
  const foldersOnBar = (bm.folders || [])
    .filter((f) => f && f.parentId === bookmarks.FOLDER_BAR)
    .map((f) => ({
      id: f.id,
      name: f.name || 'Pasta',
      items: (bm.items || [])
        .filter((it) => it && it.folderId === f.id)
        .map((it) => ({
          id: it.id,
          title: it.title || it.name || '',
          url: it.url || '',
          favicon: localFavicon(it.favicon),
        })),
    }));
  const topLevelBar = (bm.items || [])
    .filter((it) => it && it.folderId === bookmarks.FOLDER_BAR)
    .map((it) => ({
      id: it.id,
      title: it.title || it.name || '',
      url: it.url || '',
      favicon: localFavicon(it.favicon),
      kind: 'bookmark',
    }));

  // --- Apps: built-in catalog (minus hidden) + global custom sites ---
  const hiddenSet = new Set(hiddenCatalog);
  let catalogPublic = [];
  try {
    catalogPublic = catalog.listAppsPublic() || [];
  } catch {
    catalogPublic = [];
  }
  const catalogApps = catalogPublic
    .filter((a) => a && a.id && !hiddenSet.has(a.id))
    .map((a) => ({
      kind: 'catalog',
      id: `catalog:${a.id}`,
      catalogId: a.id,
      title: a.name || a.defaultName || a.id,
      url: a.url,
      favicon: localFavicon(a.iconUrl),
      color: a.color || '',
    }));
  const customApps = normalizeCustomApps(state.customStartApps).map((a) => ({
    kind: 'custom',
    id: a.id,
    title: a.title,
    url: a.url,
    favicon: a.favicon,
    order: a.order,
  }));
  const apps = [...catalogApps, ...customApps];
  const hiddenCatalogInfo = catalogPublic
    .filter((a) => a && hiddenSet.has(a.id))
    .map((a) => ({ id: a.id, name: a.name || a.id }));

  // --- Most visited ---
  const wsAccountIds = new Set(
    (state.accounts || [])
      .filter((a) => a && a.workspaceId === workspaceId)
      .map((a) => a.id)
  );
  // Private windows never record history, so global history is safe to merge here.
  const entries = history.query({ limit: 2000 });
  const hidden = new Set(pageOpts.hiddenSuggested);
  const maxSuggested = pageOpts.mostVisitedRows * PER_ROW;
  const toTile = (e) => ({
    id: e.id,
    title: e.title || '',
    url: e.url,
    favicon: localFavicon(e.favicon),
    count: e.count,
    kind: 'suggested',
  });
  const usable = (e) => e && e.url && !hidden.has(e.url);
  const scopedEntries = entries.filter((e) => e && e.windowId && wsAccountIds.has(e.windowId));
  const scopedRanked = omnibox.rankHistory(scopedEntries).filter(usable);
  /** @type {Array<object>} */
  let mostVisited = scopedRanked.slice(0, maxSuggested).map(toTile);
  if (mostVisited.length < Math.min(MIN_SCOPED_MOST_VISITED, maxSuggested)) {
    const have = new Set(mostVisited.map((t) => t.url));
    const globalRanked = omnibox.rankHistory(entries).filter(usable);
    for (const e of globalRanked) {
      if (mostVisited.length >= maxSuggested) break;
      if (have.has(e.url)) continue;
      have.add(e.url);
      mostVisited.push(toTile(e));
    }
  }
  if (!mostVisited.length && pageOpts.showMostVisited && catalogPublic.length) {
    // No history at all (fresh profile / new area): never leave the section empty.
    const visible = catalogPublic.filter((a) => a && !hiddenSet.has(a.id));
    const source = visible.length ? visible : catalogPublic;
    mostVisited = source
      .filter((a) => a && a.url && !hidden.has(a.url))
      .slice(0, maxSuggested)
      .map((a) => ({
        id: `catalog-fallback:${a.id}`,
        title: a.name || a.id,
        url: a.url,
        favicon: localFavicon(a.iconUrl),
        count: 0,
        kind: 'catalog-fallback',
        catalogId: a.id,
      }));
  }

  return {
    opts: pageOpts,
    favoritesBar: {
      items: topLevelBar,
      folders: foldersOnBar,
    },
    apps,
    hiddenCatalogApps: hiddenCatalogInfo,
    mostVisited,
    // Back-compat name: now the GLOBAL custom Apps list.
    customTiles: customApps,
    perRow: PER_ROW,
  };
}

/**
 * @param {object} state
 * @param {string} workspaceId
 * @param {object} patch
 */
function applyPatch(state, workspaceId, patch) {
  if (!state.startPageByWorkspace || typeof state.startPageByWorkspace !== 'object') {
    state.startPageByWorkspace = {};
  }
  if (needsMigration(state)) migrateCustomTiles(state);
  const cur = normalizeOpts(state.startPageByWorkspace[workspaceId]);
  const p = patch && typeof patch === 'object' ? patch : {};
  if (typeof p.showFavoritesBar === 'boolean') cur.showFavoritesBar = p.showFavoritesBar;
  if (typeof p.showApps === 'boolean') cur.showApps = p.showApps;
  if (typeof p.showMostVisited === 'boolean') cur.showMostVisited = p.showMostVisited;
  if (p.mostVisitedRows != null) {
    const rows = Number(p.mostVisitedRows);
    if (Number.isFinite(rows)) cur.mostVisitedRows = Math.min(6, Math.max(1, Math.round(rows)));
  }
  if (Array.isArray(p.hiddenSuggested)) {
    cur.hiddenSuggested = p.hiddenSuggested.map((u) => String(u || '')).filter(Boolean);
  }

  // Global: custom Apps (customTiles kept as an alias for older callers/tests).
  const customPatch = Array.isArray(p.customStartApps)
    ? p.customStartApps
    : Array.isArray(p.customTiles)
      ? p.customTiles
      : null;
  if (customPatch) state.customStartApps = normalizeCustomApps(customPatch);
  else if (!Array.isArray(state.customStartApps)) state.customStartApps = [];

  // Global: hidden built-in catalog apps.
  let hiddenCat = hiddenCatalogIds(state);
  if (Array.isArray(p.hiddenCatalogApps)) {
    hiddenCat = p.hiddenCatalogApps.map((x) => String(x || '')).filter(Boolean);
  }
  if (typeof p.hideCatalogApp === 'string' && p.hideCatalogApp) {
    if (!hiddenCat.includes(p.hideCatalogApp)) hiddenCat.push(p.hideCatalogApp);
  }
  if (typeof p.restoreCatalogApp === 'string' && p.restoreCatalogApp) {
    hiddenCat =
      p.restoreCatalogApp === '*' || p.restoreCatalogApp === 'all'
        ? []
        : hiddenCat.filter((id) => id !== p.restoreCatalogApp);
  }
  state.startPageHiddenCatalogApps = [...new Set(hiddenCat)];

  // Legacy per-area tiles are never written again (kept [] after migration).
  cur.customTiles = [];
  state.startPageByWorkspace[workspaceId] = cur;
  return cur;
}

module.exports = {
  defaultOpts,
  normalizeOpts,
  normalizeCustomApps,
  normalizeAppUrl,
  migrateCustomTiles,
  needsMigration,
  getData,
  applyPatch,
  localFavicon,
  MIN_SCOPED_MOST_VISITED,
};
