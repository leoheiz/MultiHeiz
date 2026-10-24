'use strict';

/**
 * Empty-workspace start page data (favorites bar, most visited, custom tiles).
 * No network — favicons only from stored history/bookmark fields (prefer data:).
 */

const history = require('./history');
const bookmarks = require('./bookmarks');
const omnibox = require('./omnibox');

function defaultOpts() {
  return {
    showFavoritesBar: true,
    showMostVisited: true,
    mostVisitedRows: 2,
    hiddenSuggested: [],
    customTiles: [],
  };
}

/**
 * @param {unknown} raw
 */
function normalizeOpts(raw) {
  const base = defaultOpts();
  if (!raw || typeof raw !== 'object') return base;
  const o = /** @type {Record<string, unknown>} */ (raw);
  base.showFavoritesBar = o.showFavoritesBar !== false;
  base.showMostVisited = o.showMostVisited !== false;
  const rows = Number(o.mostVisitedRows);
  base.mostVisitedRows = Number.isFinite(rows) ? Math.min(6, Math.max(1, Math.round(rows))) : 2;
  base.hiddenSuggested = Array.isArray(o.hiddenSuggested)
    ? o.hiddenSuggested.map((u) => String(u || '')).filter(Boolean)
    : [];
  base.customTiles = Array.isArray(o.customTiles)
    ? o.customTiles
        .map((t, i) => {
          if (!t || typeof t !== 'object') return null;
          const tile = /** @type {Record<string, unknown>} */ (t);
          const url = String(tile.url || '').trim();
          if (!url) return null;
          return {
            id: String(tile.id || `tile-${i}`),
            title: String(tile.title || tile.name || ''),
            url,
            order: typeof tile.order === 'number' ? tile.order : i,
            favicon: localFavicon(tile.favicon),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.order - b.order)
    : [];
  return base;
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
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {object} opts.state
 */
function getData(opts) {
  const workspaceId = String((opts && opts.workspaceId) || '');
  const state = (opts && opts.state) || {};
  const byWs = state.startPageByWorkspace || {};
  const pageOpts = normalizeOpts(byWs[workspaceId]);

  const bm = bookmarks.list();
  const barFolders = (bm.folders || []).filter(
    (f) => f && (f.id === bookmarks.FOLDER_BAR || f.parentId === bookmarks.FOLDER_BAR)
  );
  const barFolderIds = new Set(barFolders.map((f) => f.id));
  barFolderIds.add(bookmarks.FOLDER_BAR);
  const barItems = (bm.items || [])
    .filter((it) => it && barFolderIds.has(it.folderId))
    .map((it) => ({
      id: it.id,
      title: it.title || it.name || '',
      url: it.url || '',
      folderId: it.folderId,
      favicon: localFavicon(it.favicon),
    }));
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

  const wsAccountIds = new Set(
    (state.accounts || [])
      .filter((a) => a && a.workspaceId === workspaceId)
      .map((a) => a.id)
  );
  // History is window-scoped; for empty workspace use all history (global),
  // optionally prefer entries whose windowId belonged to this area when known.
  let entries = history.query({ limit: 800 });
  const scoped = entries.filter((e) => e && e.windowId && wsAccountIds.has(e.windowId));
  // Empty workspace → wsAccountIds empty → use global ranked history.
  const ranked = omnibox.rankHistory(scoped.length ? scoped : entries);
  const hidden = new Set(pageOpts.hiddenSuggested);
  const perRow = 5;
  const maxSuggested = pageOpts.mostVisitedRows * perRow;
  const mostVisited = ranked
    .filter((e) => e && e.url && !hidden.has(e.url))
    .slice(0, maxSuggested)
    .map((e) => ({
      id: e.id,
      title: e.title || '',
      url: e.url,
      favicon: localFavicon(e.favicon),
      count: e.count,
      kind: 'suggested',
    }));

  return {
    opts: pageOpts,
    favoritesBar: {
      items: topLevelBar,
      folders: foldersOnBar,
    },
    mostVisited,
    customTiles: pageOpts.customTiles,
    perRow,
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
  const cur = normalizeOpts(state.startPageByWorkspace[workspaceId]);
  const p = patch && typeof patch === 'object' ? patch : {};
  if (typeof p.showFavoritesBar === 'boolean') cur.showFavoritesBar = p.showFavoritesBar;
  if (typeof p.showMostVisited === 'boolean') cur.showMostVisited = p.showMostVisited;
  if (p.mostVisitedRows != null) {
    const rows = Number(p.mostVisitedRows);
    if (Number.isFinite(rows)) cur.mostVisitedRows = Math.min(6, Math.max(1, Math.round(rows)));
  }
  if (Array.isArray(p.hiddenSuggested)) {
    cur.hiddenSuggested = p.hiddenSuggested.map((u) => String(u || '')).filter(Boolean);
  }
  if (Array.isArray(p.customTiles)) {
    cur.customTiles = normalizeOpts({ customTiles: p.customTiles }).customTiles;
  }
  state.startPageByWorkspace[workspaceId] = cur;
  return cur;
}

module.exports = {
  defaultOpts,
  normalizeOpts,
  getData,
  applyPatch,
  localFavicon,
};
