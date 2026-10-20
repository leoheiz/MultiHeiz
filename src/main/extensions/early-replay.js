'use strict';

/**
 * Early-replay cache for MV3 abuCompat extensions (ABU YouTube timing).
 * Per (installId, accountId): Map<host, Map<key, {func,args,ts}>>.
 * Persisted to <extensionsRoot>/<installId>/multiheiz-early-cache.json.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ipcMain, webContents, WebContentsView } = require('electron');
const store = require('./store');

/**
 * @param {Electron.WebFrameMain|null|undefined} f
 */
function frameIdOf(f) {
  if (!f) return -1;
  return f.parent ? f.frameTreeNodeId : 0;
}

const CACHE_FILE = 'multiheiz-early-cache.json';
const COLLECT_MS = 1500;
const PERSIST_DEBOUNCE_MS = 800;
const WARM_URLS_PRIMARY = ['https://www.youtube.com/robots.txt'];
const WARM_URLS_EXTRA = [
  'https://m.youtube.com/robots.txt',
  'https://www.youtube-nocookie.com/robots.txt',
];

/**
 * @typedef {object} CacheItem
 * @property {string} func
 * @property {any[]} args
 * @property {number} ts
 */

/**
 * @typedef {object} CacheState
 * @property {string} installId
 * @property {string} accountId
 * @property {string} versionStr
 * @property {Map<string, Map<string, CacheItem>>} hosts
 * @property {ReturnType<typeof setTimeout>|null} persistTimer
 * @property {Map<string, { items: Map<string, CacheItem>, timer: ReturnType<typeof setTimeout>|null }>} collecting
 * @property {boolean} warming
 * @property {string} lastWarmVersion
 */

/** @type {Map<string, CacheState>} */
const caches = new Map();

/** Replayed keys for current document: `${tabId}:${frameId}` -> Set<key> */
/** @type {Map<string, Set<string>>} */
const replayedByFrame = new Map();

let ipcRegistered = false;

/**
 * @param {string} installId
 * @param {string} accountId
 */
function cacheId(installId, accountId) {
  return String(installId) + '::' + String(accountId || '');
}

/**
 * @param {string} installId
 */
function cachePath(installId) {
  return path.join(store.extensionsRoot(), installId, CACHE_FILE);
}

/**
 * @param {string} installId
 * @param {string} accountId
 * @returns {CacheState}
 */
function getCache(installId, accountId) {
  const id = cacheId(installId, accountId);
  let c = caches.get(id);
  if (c) return c;
  c = {
    installId: String(installId),
    accountId: String(accountId || ''),
    versionStr: '',
    hosts: new Map(),
    persistTimer: null,
    collecting: new Map(),
    warming: false,
    lastWarmVersion: '',
  };
  loadFromDisk(c);
  caches.set(id, c);
  return c;
}

/**
 * @param {CacheState} c
 */
function loadFromDisk(c) {
  try {
    const p = cachePath(c.installId);
    if (!fs.existsSync(p)) return;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    c.versionStr = String(raw.versionStr || '');
    c.hosts = new Map();
    const hosts = raw.hosts && typeof raw.hosts === 'object' ? raw.hosts : {};
    for (const [host, entries] of Object.entries(hosts)) {
      if (!entries || typeof entries !== 'object') continue;
      const m = new Map();
      for (const [key, item] of Object.entries(entries)) {
        if (!item || typeof item.func !== 'string') continue;
        m.set(String(key), {
          func: item.func,
          args: Array.isArray(item.args) ? item.args : [],
          ts: Number(item.ts) || 0,
        });
      }
      if (m.size) c.hosts.set(String(host), m);
    }
  } catch (err) {
    console.warn('[early-replay] load', err && err.message);
  }
}

/**
 * @param {CacheState} c
 */
function schedulePersist(c) {
  if (c.persistTimer) clearTimeout(c.persistTimer);
  c.persistTimer = setTimeout(() => {
    c.persistTimer = null;
    persistNow(c);
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * @param {CacheState} c
 */
function persistNow(c) {
  try {
    const dir = path.join(store.extensionsRoot(), c.installId);
    fs.mkdirSync(dir, { recursive: true });
    /** @type {Record<string, Record<string, CacheItem>>} */
    const hosts = {};
    for (const [host, m] of c.hosts) {
      /** @type {Record<string, CacheItem>} */
      const entries = {};
      for (const [key, item] of m) {
        entries[key] = { func: item.func, args: item.args, ts: item.ts };
      }
      hosts[host] = entries;
    }
    const payload = {
      versionStr: c.versionStr,
      hosts,
      savedAt: Date.now(),
    };
    const p = cachePath(c.installId);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    console.warn('[early-replay] persist', err && err.message);
  }
}

/**
 * @param {string} extVersion
 * @param {string[]} enabledRulesets
 * @param {object[]} dynamicRaw
 */
function makeVersionStr(extVersion, enabledRulesets, dynamicRaw) {
  const sets = [...(enabledRulesets || [])].map(String).sort().join(',');
  const dyn = JSON.stringify(dynamicRaw || []);
  const hash = crypto.createHash('sha256').update(dyn).digest('hex').slice(0, 16);
  return String(extVersion || '0') + '|' + sets + '|' + hash;
}

/**
 * Wipe host cache when ruleset/config version changes.
 * @param {string} installId
 * @param {string} accountId
 * @param {string} versionStr
 * @returns {boolean} true if wiped
 */
function ensureVersion(installId, accountId, versionStr) {
  const c = getCache(installId, accountId);
  const v = String(versionStr || '');
  if (c.versionStr === v) return false;
  c.versionStr = v;
  c.hosts.clear();
  c.collecting.clear();
  schedulePersist(c);
  console.log('[early-replay] cache wiped (version change)', installId);
  return true;
}

/**
 * Force wipe (dnr.update* / config-changed).
 * @param {string} installId
 * @param {string} [accountId]
 */
function invalidate(installId, accountId) {
  if (accountId) {
    const c = getCache(installId, accountId);
    c.hosts.clear();
    c.collecting.clear();
    c.versionStr = '';
    schedulePersist(c);
    return;
  }
  for (const c of caches.values()) {
    if (c.installId !== installId) continue;
    c.hosts.clear();
    c.collecting.clear();
    c.versionStr = '';
    schedulePersist(c);
  }
  // Also clear on-disk for accounts not yet loaded
  try {
    const p = cachePath(installId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/**
 * @param {number} tabId
 * @param {number} frameId
 */
function hostFromTabFrame(tabId, frameId) {
  try {
    const wc = webContents.fromId(Number(tabId));
    if (!wc || wc.isDestroyed()) return '';
    const want = Number(frameId) || 0;
    const frames = wc.mainFrame.framesInSubtree || [];
    for (const f of frames) {
      if (frameIdOf(f) === want) {
        try {
          return new URL(f.url || '').hostname || '';
        } catch {
          return '';
        }
      }
    }
    try {
      return new URL(wc.getURL() || '').hostname || '';
    } catch {
      return '';
    }
  } catch {
    return '';
  }
}

/**
 * Start/reset 1.5s collection window after a committed document.
 * @param {string} installId
 * @param {string} accountId
 * @param {string} url
 */
function noteCommitted(installId, accountId, url) {
  let host = '';
  try {
    host = new URL(url || '').hostname || '';
  } catch {
    host = '';
  }
  if (!host) return;
  const c = getCache(installId, accountId);
  const prev = c.collecting.get(host);
  if (prev && prev.timer) clearTimeout(prev.timer);
  const bucket = { items: new Map(), timer: null };
  c.collecting.set(host, bucket);
  bucket.timer = setTimeout(() => {
    bucket.timer = null;
    c.collecting.delete(host);
    if (bucket.items.size === 0) {
      if (c.hosts.has(host)) {
        c.hosts.delete(host);
        schedulePersist(c);
      }
    } else {
      c.hosts.set(host, bucket.items);
      schedulePersist(c);
    }
  }, COLLECT_MS);
}

/**
 * Observe ABU executeScript (MAIN world).
 * @param {string} installId
 * @param {string} accountId
 * @param {{ tabId?: number, frameIds?: number[], func?: string, args?: any[], key?: string }} meta
 */
function observe(installId, accountId, meta) {
  if (!meta || typeof meta.func !== 'string') return;
  const frameId =
    Array.isArray(meta.frameIds) && meta.frameIds.length ? Number(meta.frameIds[0]) : 0;
  const host = hostFromTabFrame(meta.tabId, frameId);
  if (!host) return;
  const key =
    meta.key ||
    scriptletKey(meta.func, Array.isArray(meta.args) ? meta.args : []);
  const item = {
    func: meta.func,
    args: Array.isArray(meta.args) ? meta.args : [],
    ts: Date.now(),
  };
  const c = getCache(installId, accountId);
  let bucket = c.collecting.get(host);
  if (!bucket) {
    // Outside collection window: still seed cache (warm-up / late inject)
    let m = c.hosts.get(host);
    if (!m) {
      m = new Map();
      c.hosts.set(host, m);
    }
    m.set(key, item);
    schedulePersist(c);
    return;
  }
  bucket.items.set(key, item);
}

/**
 * Same key scheme as sw-shim-preload (scriptlet name+args or func hash).
 * @param {string} funcSrc
 * @param {any[]} args
 */
function scriptletKey(funcSrc, args) {
  try {
    const a = Array.isArray(args) ? args.slice() : [];
    if (typeof a[0] === 'string' && a[0].length < 80 && /^[a-z0-9_-]+$/i.test(a[0])) {
      const name = a[0];
      const rest = a.slice(1).map((x) => {
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          const copy = Object.assign({}, x);
          delete copy.uniqueId;
          delete copy.verbose;
          delete copy.domainName;
          return copy;
        }
        return x;
      });
      return 's:' + name + ':' + JSON.stringify(rest);
    }
  } catch {
    /* fall through */
  }
  let h = 0;
  const s = String(funcSrc || '');
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return 'f:' + h + ':' + s.length;
}

/**
 * @param {string} installId
 * @param {string} accountId
 * @param {{ tabId?: number, frameIds?: number[], key?: string, func?: string, args?: any[] }} meta
 */
function shouldSkip(installId, accountId, meta) {
  void installId;
  void accountId;
  if (!meta) return { skip: false };
  const frameId =
    Array.isArray(meta.frameIds) && meta.frameIds.length ? Number(meta.frameIds[0]) : 0;
  const tabId = Number(meta.tabId) || 0;
  const key =
    meta.key ||
    scriptletKey(meta.func || '', Array.isArray(meta.args) ? meta.args : []);
  const set = replayedByFrame.get(tabId + ':' + frameId);
  if (set && set.has(key)) return { skip: true };
  return { skip: false };
}

/**
 * @param {number} tabId
 * @param {number} frameId
 */
function clearReplayed(tabId, frameId) {
  replayedByFrame.delete(Number(tabId) + ':' + Number(frameId || 0));
}

/**
 * Items for a URL hostname from all abuCompat caches in a session bridge.
 * @param {import('./sw-bridge').SessionBridge|null} br
 * @param {string} href
 * @returns {{ func: string, args: any[], key: string }[]}
 */
function itemsForHref(br, href) {
  let host = '';
  try {
    host = new URL(href || '').hostname || '';
  } catch {
    return [];
  }
  if (!host || !br) return [];
  /** @type {{ func: string, args: any[], key: string }[]} */
  const out = [];
  const seen = new Set();
  for (const binding of br.byRuntimeId.values()) {
    const c = getCache(binding.installId, binding.accountId);
    const m = c.hosts.get(host);
    if (!m) continue;
    for (const [key, item] of m) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ func: item.func, args: item.args, key });
    }
  }
  return out;
}

/**
 * Register ipcMain handlers (after ipcGuard.install).
 */
function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on('multiheiz/ext-early', (event, href) => {
    try {
      const swBridge = require('./sw-bridge');
      const br = event.sender && event.sender.session
        ? swBridge.getBridge(event.sender.session)
        : null;
      const items = itemsForHref(br, String(href || ''));
      event.returnValue = items;
    } catch {
      event.returnValue = [];
    }
  });

  ipcMain.on('multiheiz/ext-early-done', (event, payload) => {
    try {
      const keys = payload && Array.isArray(payload.keys) ? payload.keys : [];
      if (!keys.length || !event.sender) return;
      const tabId = event.sender.id;
      // Frame id: best-effort from senderFrame
      let frameId = 0;
      try {
        const f = event.senderFrame;
        if (f) frameId = frameIdOf(f);
      } catch {
        frameId = 0;
      }
      const id = tabId + ':' + frameId;
      let set = replayedByFrame.get(id);
      if (!set) {
        set = new Set();
        replayedByFrame.set(id, set);
      }
      for (const k of keys) set.add(String(k));
    } catch {
      /* ignore */
    }
  });
}

/**
 * Warm-up: hidden WebContentsView loads youtube robots.txt to fill cache.
 * Never shows a window. Repeats only when cache version changes.
 *
 * @param {object} ses
 * @param {string} accountId
 * @param {object} record
 * @param {string} versionStr
 */
async function warmUp(ses, accountId, record, versionStr) {
  if (!record || !record.id) return;
  const c = getCache(record.id, accountId);
  ensureVersion(record.id, accountId, versionStr);
  if (c.warming) return;
  if (c.lastWarmVersion === versionStr && c.hosts.size > 0) return;
  c.warming = true;
  /** @type {Electron.WebContentsView|null} */
  let view = null;
  try {
    view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
      },
    });
    // Keep off-screen; never add to a window.
    try {
      view.setBounds({ x: -10000, y: -10000, width: 64, height: 64 });
    } catch {
      /* ignore */
    }

    const urls = [...WARM_URLS_PRIMARY];
    if (c.hosts.size === 0) urls.push(...WARM_URLS_EXTRA);

    for (const url of urls) {
      try {
        noteCommitted(record.id, accountId, url);
        await view.webContents.loadURL(url);
        await new Promise((r) => setTimeout(r, COLLECT_MS + 200));
      } catch (err) {
        console.warn(
          '[early-replay] warm-up load',
          url,
          err && err.message ? err.message : err
        );
      }
      if (c.hosts.size > 0 && urls.length > 1 && url === WARM_URLS_PRIMARY[0]) {
        // Primary filled — skip extras
        break;
      }
    }
    c.lastWarmVersion = versionStr;
    console.log(
      '[early-replay] warm-up done',
      record.id,
      'hosts=',
      c.hosts.size
    );
  } catch (err) {
    console.warn('[early-replay] warm-up', err && err.message);
  } finally {
    c.warming = false;
    try {
      if (view && view.webContents && !view.webContents.isDestroyed()) {
        view.webContents.close();
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} installId
 * @param {string} accountId
 */
function hostCount(installId, accountId) {
  return getCache(installId, accountId).hosts.size;
}

module.exports = {
  registerIpc,
  getCache,
  makeVersionStr,
  ensureVersion,
  invalidate,
  noteCommitted,
  observe,
  shouldSkip,
  clearReplayed,
  itemsForHref,
  warmUp,
  hostCount,
  scriptletKey,
  COLLECT_MS,
};
