'use strict';

/**
 * Minimal MV3 service-worker IPC bridge (extensions.abuCompat).
 * Hooks ServiceWorkerMain.ipc, waits for shim `ready` (+50ms), and answers
 * invoke('dnr.*'), cookies, getAllFrames/getFrame. Full event feeding is a
 * later step — this only establishes the handshake and handlers.
 *
 * Security: handlers are attached only to workers whose scope is
 * chrome-extension://<runtimeId>/ for an extension loaded in that session
 * with abuCompat. ipcMain is not used for SW traffic (Electron routes SW
 * preload IPC to ServiceWorkerMain.ipc).
 */

const path = require('node:path');
const { webContents } = require('electron');
const dnr = require('./dnr-shim');
const { resolvePreloadPath } = require('../preload-path');
const { abuCompatApplies, extensionIdFromScope } = require('./abu-compat');

const SW_SHIM_FILE = resolvePreloadPath(
  path.join(__dirname, 'sw-shim-preload.js')
).path;

const READY_FLUSH_DELAY_MS = 50;

/** @type {WeakMap<Electron.Session, SessionBridge>} */
const bySession = new WeakMap();

/**
 * @typedef {object} ExtBinding
 * @property {string} installId
 * @property {string} runtimeId
 * @property {string} accountId
 * @property {object} record
 */

/**
 * @typedef {object} SessionBridge
 * @property {string} accountId
 * @property {Electron.Session} ses
 * @property {boolean} preloadRegistered
 * @property {Map<string, ExtBinding>} byRuntimeId
 * @property {Map<string, ExtBinding>} byInstallId
 * @property {Set<number>} hookedVersionIds
 * @property {Map<number, WorkerState>} workers
 * @property {boolean} statusHooked
 */

/**
 * @typedef {object} WorkerState
 * @property {object} worker
 * @property {string} runtimeId
 * @property {string} installId
 * @property {boolean} ready
 * @property {object[]} queue
 * @property {object[]} dynamicRaw
 * @property {object[]} sessionRaw
 * @property {Record<string, number[]>} disabledStatic
 */

/**
 * @param {Electron.Session} ses
 * @param {string} accountId
 * @returns {SessionBridge}
 */
function ensureSession(ses, accountId) {
  let br = bySession.get(ses);
  if (br) {
    br.accountId = accountId || br.accountId;
    return br;
  }
  br = {
    accountId: accountId || '',
    ses,
    preloadRegistered: false,
    byRuntimeId: new Map(),
    byInstallId: new Map(),
    /** @type {Map<string, { worker: object, versionId: number }[]>} */
    pendingByRuntimeId: new Map(),
    hookedVersionIds: new Set(),
    workers: new Map(),
    statusHooked: false,
  };
  bySession.set(ses, br);
  return br;
}

/**
 * Register the SW preload once per session (before loadExtension).
 * @param {Electron.Session} ses
 * @param {string} accountId
 */
function registerSwPreload(ses, accountId) {
  const br = ensureSession(ses, accountId);
  if (br.preloadRegistered) return;
  try {
    ses.registerPreloadScript({
      type: 'service-worker',
      id: 'mh-ext-sw-shim',
      filePath: SW_SHIM_FILE,
    });
    br.preloadRegistered = true;
    console.log('[sw-bridge] registered SW preload', SW_SHIM_FILE);
  } catch (err) {
    console.warn(
      '[sw-bridge] registerPreloadScript failed',
      err && err.message ? err.message : err,
      SW_SHIM_FILE
    );
  }
  ensureStatusHook(br);
}

/**
 * @param {SessionBridge} br
 * @param {object} record
 * @param {string} runtimeId
 * @param {string} accountId
 */
function noteExtension(br, record, runtimeId, accountId) {
  if (!record || !runtimeId) return;
  const binding = {
    installId: record.id,
    runtimeId: String(runtimeId),
    accountId: accountId || br.accountId,
    record,
  };
  br.byRuntimeId.set(binding.runtimeId, binding);
  br.byInstallId.set(binding.installId, binding);
  // Workers that started before binding existed
  const pending = br.pendingByRuntimeId.get(binding.runtimeId) || [];
  br.pendingByRuntimeId.delete(binding.runtimeId);
  for (const item of pending) {
    if (!br.hookedVersionIds.has(item.versionId)) {
      br.hookedVersionIds.add(item.versionId);
      hookWorker(br, item.worker, item.versionId, binding);
    }
  }
}

/**
 * @param {SessionBridge} br
 */
function ensureStatusHook(br) {
  if (br.statusHooked) return;
  br.statusHooked = true;
  const sw = br.ses.serviceWorkers;
  if (!sw || typeof sw.on !== 'function') {
    console.warn('[sw-bridge] session.serviceWorkers unavailable');
    return;
  }
  sw.on('running-status-changed', (details) => {
    try {
      onRunningStatusChanged(br, details);
    } catch (err) {
      console.warn('[sw-bridge] status handler', err && err.message);
    }
  });
}

/**
 * @param {SessionBridge} br
 * @param {{ versionId: number, runningStatus: string }} details
 */
function onRunningStatusChanged(br, details) {
  const versionId = details && details.versionId;
  if (versionId == null) return;
  const worker =
    typeof br.ses.serviceWorkers.getWorkerFromVersionID === 'function'
      ? br.ses.serviceWorkers.getWorkerFromVersionID(versionId)
      : null;
  if (!worker) return;

  const scope = String(worker.scope || worker.scriptURL || '');
  const runtimeId = extensionIdFromScope(scope);
  if (!runtimeId) return; // not a chrome-extension SW
  if (br.hookedVersionIds.has(versionId)) return;

  const binding = br.byRuntimeId.get(runtimeId);
  if (!binding) {
    // Extension may still be loading; queue until noteExtension.
    let list = br.pendingByRuntimeId.get(runtimeId);
    if (!list) {
      list = [];
      br.pendingByRuntimeId.set(runtimeId, list);
    }
    if (!list.some((x) => x.versionId === versionId)) {
      list.push({ worker, versionId });
    }
    return;
  }

  br.hookedVersionIds.add(versionId);
  hookWorker(br, worker, versionId, binding);
}

/**
 * @param {SessionBridge} br
 * @param {object} worker
 * @param {number} versionId
 * @param {ExtBinding} binding
 */
function hookWorker(br, worker, versionId, binding) {
  const state = {
    worker,
    runtimeId: binding.runtimeId,
    installId: binding.installId,
    ready: false,
    queue: [],
    dynamicRaw: [],
    sessionRaw: [],
    disabledStatic: {},
  };
  br.workers.set(versionId, state);

  const ipc = worker.ipc;
  if (!ipc) {
    console.warn('[sw-bridge] worker has no ipc', binding.runtimeId);
    return;
  }

  const guard = (fn) => {
    return (event, ...args) => {
      if (!isTrustedWorkerEvent(br, worker, binding)) {
        console.warn('[sw-bridge] rejected invoke from untrusted SW', binding.runtimeId);
        return undefined;
      }
      return fn(event, ...args);
    };
  };

  const markReady = () => {
    if (state.ready) return;
    state.ready = true;
    while (state.queue.length) {
      try {
        worker.send('mh-sw:event', state.queue.shift());
      } catch {
        break;
      }
    }
  };

  ipc.on(
    'mh-sw:ready',
    guard((_e, payload) => {
      console.log('[sw-bridge] shim ready', binding.runtimeId, payload && payload.id);
      setTimeout(markReady, READY_FLUSH_DELAY_MS);
    })
  );
  // If ready was sent before we hooked (race with loadExtension), don't stall.
  setTimeout(() => {
    if (!state.ready) {
      console.log('[sw-bridge] ready fallback', binding.runtimeId);
      markReady();
    }
  }, 150);

  ipc.on('mh-sw:scripting.observed', guard((_e, meta) => {
    // Early-replay cache is filled in a later step; acknowledge only.
    void meta;
  }));

  ipc.on('mh-sw:dnr.enabledRulesets', guard((_e, ids) => {
    if (Array.isArray(ids)) {
      dnr.updateEnabledRulesets(binding.installId, {
        enableRulesetIds: ids,
        disableRulesetIds: [],
      });
    }
  }));

  ipc.handle(
    'mh-sw:scripting.shouldSkip',
    guard(async () => ({ skip: false }))
  );

  ipc.handle(
    'mh-sw:dnr.updateEnabledRulesets',
    guard(async (_e, o) => {
      return dnr.updateEnabledRulesets(binding.installId, {
        enableRulesetIds: (o && o.enableRulesetIds) || [],
        disableRulesetIds: (o && o.disableRulesetIds) || [],
      });
    })
  );

  ipc.handle(
    'mh-sw:dnr.updateDynamicRules',
    guard(async (_e, o) => {
      applyRawRules(state, 'dynamic', o);
      return dnr.updateRules(binding.installId, 'dynamic', {
        removeRuleIds: (o && o.removeRuleIds) || [],
        addRules: (o && o.addRules) || [],
      });
    })
  );

  ipc.handle(
    'mh-sw:dnr.updateSessionRules',
    guard(async (_e, o) => {
      applyRawRules(state, 'session', o);
      return dnr.updateRules(binding.installId, 'session', {
        removeRuleIds: (o && o.removeRuleIds) || [],
        addRules: (o && o.addRules) || [],
      });
    })
  );

  ipc.handle(
    'mh-sw:dnr.updateStaticRules',
    guard(async (_e, o) => {
      if (o && o.rulesetId) {
        const id = String(o.rulesetId);
        const cur = new Set(state.disabledStatic[id] || []);
        (o.disableRuleIds || []).forEach((n) => cur.add(Number(n)));
        (o.enableRuleIds || []).forEach((n) => cur.delete(Number(n)));
        state.disabledStatic[id] = [...cur];
      }
      return { ok: true };
    })
  );

  ipc.handle(
    'mh-sw:dnr.getDynamicRules',
    guard(async () => state.dynamicRaw.slice())
  );
  ipc.handle(
    'mh-sw:dnr.getSessionRules',
    guard(async () => state.sessionRaw.slice())
  );
  ipc.handle(
    'mh-sw:dnr.getDisabledRuleIds',
    guard(async (_e, opts) => {
      const id = opts && opts.rulesetId ? String(opts.rulesetId) : '';
      return (state.disabledStatic[id] || []).slice();
    })
  );
  ipc.handle(
    'mh-sw:dnr.getAvailableStaticRuleCount',
    guard(async () => {
      const eng = dnr.getEngine(binding.installId);
      const used = eng ? eng.ruleCount : 0;
      return Math.max(0, 300000 - used);
    })
  );

  ipc.handle(
    'mh-sw:cookies.getAll',
    guard(async (_e, q) => cookiesGetAll(br.ses, q))
  );
  ipc.handle(
    'mh-sw:cookies.get',
    guard(async (_e, d) => cookiesGet(br.ses, d))
  );
  ipc.handle(
    'mh-sw:cookies.set',
    guard(async (_e, d) => cookiesSet(br.ses, d))
  );
  ipc.handle(
    'mh-sw:cookies.remove',
    guard(async (_e, d) => cookiesRemove(br.ses, d))
  );

  ipc.handle(
    'mh-sw:getAllFrames',
    guard(async (_e, q) => framesForTab(q && q.tabId))
  );
  ipc.handle(
    'mh-sw:getFrame',
    guard(async (_e, q) => {
      const all = framesForTab(q && q.tabId);
      return all.find((f) => f.frameId === (q && q.frameId)) || null;
    })
  );

  ipc.handle(
    'mh-sw:tabs.create',
    guard(async (_e, props) => {
      // Full panel open comes later; return a Tab-shaped stub for now.
      return {
        id: -1,
        url: (props && props.url) || '',
        active: true,
        windowId: 0,
        index: 0,
        status: 'complete',
      };
    })
  );
  ipc.handle(
    'mh-sw:tabs.remove',
    guard(async () => undefined)
  );
  ipc.handle(
    'mh-sw:tabs.detectLanguage',
    guard(async () => 'und')
  );
}

/**
 * @param {SessionBridge} br
 * @param {object} worker
 * @param {ExtBinding} binding
 */
function isTrustedWorkerEvent(br, worker, binding) {
  if (!worker || !binding) return false;
  const scope = String(worker.scope || '');
  const id = extensionIdFromScope(scope);
  if (!id || id !== binding.runtimeId) return false;
  if (!br.byRuntimeId.has(id)) return false;
  if (!abuCompatApplies(binding.record)) return false;
  return true;
}

/**
 * @param {WorkerState} state
 * @param {'dynamic'|'session'} which
 * @param {{ removeRuleIds?: number[], addRules?: object[] }} o
 */
function applyRawRules(state, which, o) {
  const key = which === 'session' ? 'sessionRaw' : 'dynamicRaw';
  const remove = new Set((o && o.removeRuleIds ? o.removeRuleIds : []).map(Number));
  let list = state[key].filter((r) => !remove.has(Number(r.id)));
  for (const raw of (o && o.addRules) || []) {
    if (!raw || raw.id == null) continue;
    list = list.filter((r) => Number(r.id) !== Number(raw.id));
    list.push(raw);
  }
  state[key] = list;
}

/**
 * @param {number} tabId
 */
function framesForTab(tabId) {
  const wc = webContents.fromId(Number(tabId));
  if (!wc || wc.isDestroyed()) return [];
  try {
    const frames = wc.mainFrame.framesInSubtree || [];
    return frames.map((f) => ({
      frameId: f.parent ? f.frameTreeNodeId : 0,
      parentFrameId: f.parent ? (f.parent.parent ? f.parent.frameTreeNodeId : 0) : -1,
      url: f.url || '',
      errorOccurred: false,
    }));
  } catch {
    return [];
  }
}

/**
 * @param {Electron.Session} ses
 * @param {object} q
 */
async function cookiesGetAll(ses, q) {
  try {
    const filter = {};
    if (q && q.url) filter.url = q.url;
    if (q && q.domain) filter.domain = q.domain;
    if (q && q.name) filter.name = q.name;
    if (q && q.path) filter.path = q.path;
    if (q && typeof q.secure === 'boolean') filter.secure = q.secure;
    if (q && typeof q.session === 'boolean') filter.session = q.session;
    const list = await ses.cookies.get(filter);
    return list.map(cookieToChrome);
  } catch {
    return [];
  }
}

async function cookiesGet(ses, d) {
  const all = await cookiesGetAll(ses, d || {});
  return all[0] || null;
}

async function cookiesSet(ses, d) {
  if (!d || !d.url || !d.name) return null;
  try {
    const details = {
      url: d.url,
      name: d.name,
      value: d.value != null ? String(d.value) : '',
    };
    if (d.domain) details.domain = d.domain;
    if (d.path) details.path = d.path;
    if (typeof d.secure === 'boolean') details.secure = d.secure;
    if (typeof d.httpOnly === 'boolean') details.httpOnly = d.httpOnly;
    if (d.expirationDate != null) details.expirationDate = d.expirationDate;
    if (d.sameSite) details.sameSite = d.sameSite;
    await ses.cookies.set(details);
    return cookiesGet(ses, { url: d.url, name: d.name });
  } catch {
    return null;
  }
}

async function cookiesRemove(ses, d) {
  if (!d || !d.url || !d.name) return null;
  try {
    await ses.cookies.remove(d.url, d.name);
    return { url: d.url, name: d.name };
  } catch {
    return null;
  }
}

function cookieToChrome(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    hostOnly: !!c.hostOnly,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    session: !!c.session,
    expirationDate: c.expirationDate,
    sameSite: c.sameSite || 'unspecified',
  };
}

/**
 * Emit a chrome.* event into a ready worker (queued until ready).
 * Used by later event-feeder steps.
 * @param {SessionBridge} br
 * @param {string} runtimeId
 * @param {string} ns
 * @param {string} name
 * @param {...any} args
 */
function emit(br, runtimeId, ns, name, ...args) {
  const ev = { ns, name, args };
  for (const state of br.workers.values()) {
    if (state.runtimeId !== runtimeId) continue;
    if (state.ready && state.worker) {
      try {
        state.worker.send('mh-sw:event', ev);
      } catch {
        /* ignore */
      }
    } else {
      state.queue.push(ev);
    }
  }
}

/**
 * Prepare session for an abuCompat extension load (preload + bookkeeping).
 * Call BEFORE ses.extensions.loadExtension.
 * @param {Electron.Session} ses
 * @param {string} accountId
 * @param {object} record
 */
function prepareForLoad(ses, accountId, record) {
  if (!abuCompatApplies(record)) return;
  registerSwPreload(ses, accountId);
}

/**
 * After successful loadExtension, bind runtime id.
 * @param {Electron.Session} ses
 * @param {string} accountId
 * @param {object} record
 * @param {string} runtimeId
 */
function afterLoad(ses, accountId, record, runtimeId) {
  if (!abuCompatApplies(record)) return;
  const br = ensureSession(ses, accountId);
  noteExtension(br, record, runtimeId, accountId);
  // Retry hook for workers that started before noteExtension
  try {
    const infos =
      typeof ses.serviceWorkers.getAllRunning === 'function'
        ? ses.serviceWorkers.getAllRunning()
        : {};
    for (const versionId of Object.keys(infos || {})) {
      onRunningStatusChanged(br, {
        versionId: Number(versionId),
        runningStatus: 'running',
      });
    }
  } catch {
    /* ignore */
  }
}

function getBridge(ses) {
  return bySession.get(ses) || null;
}

module.exports = {
  SW_SHIM_FILE,
  prepareForLoad,
  afterLoad,
  ensureSession,
  registerSwPreload,
  emit,
  getBridge,
};
