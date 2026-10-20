'use strict';

/**
 * MV3 service-worker IPC bridge (extensions.abuCompat).
 * One bridge per (session, extension): hooks ServiceWorkerMain.ipc, queues until
 * ready (+50ms), feeds webNavigation/tabs/webRequest events, answers invoke
 * handlers (dnr/cookies/frames/tabs stubs).
 *
 * Security: handlers only for workers whose scope is chrome-extension://<id>/
 * for abuCompat extensions in that session. SW IPC uses ServiceWorkerMain.ipc
 * (not ipcMain).
 */

const path = require('node:path');
const { app, webContents, webFrameMain } = require('electron');
const dnr = require('./dnr-shim');
const hub = require('../adblock/web-request-hub');
const { resolvePreloadPath } = require('../preload-path');
const { abuCompatApplies, extensionIdFromScope } = require('./abu-compat');

const SW_SHIM_FILE = resolvePreloadPath(
  path.join(__dirname, 'sw-shim-preload.js')
).path;

const READY_FLUSH_DELAY_MS = 50;

/** Electron resourceType → chrome.webRequest type */
const RESOURCE_TYPE_MAP = {
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

/** Phase 1: cosmetics only need document navigations. */
const PHASE1_DOC_TYPES = new Set(['main_frame', 'sub_frame']);

/** @type {WeakMap<Electron.Session, SessionBridge>} */
const bySession = new WeakMap();

/** @type {boolean} */
let appContentsHooked = false;

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
 * @property {boolean} contentsHooked
 * @property {boolean} webRequestHooked
 * @property {Set<number>} hookedWcIds
 * @property {Map<string, object[]>} pendingByRuntimeId
 * @property {Map<string, object[]>} pendingEventsByRuntimeId
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
 * @property {string} scope
 */

/**
 * @param {Electron.WebFrameMain|null|undefined} f
 */
function frameIdOf(f) {
  if (!f) return -1;
  return f.parent ? f.frameTreeNodeId : 0;
}

/**
 * @param {Electron.WebFrameMain|null|undefined} f
 */
function parentFrameIdOf(f) {
  if (!f || !f.parent) return -1;
  return f.parent.parent ? f.parent.frameTreeNodeId : 0;
}

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
    pendingEventsByRuntimeId: new Map(),
    hookedVersionIds: new Set(),
    workers: new Map(),
    statusHooked: false,
    contentsHooked: false,
    webRequestHooked: false,
    hookedWcIds: new Set(),
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
  ensureContentsHook(br);
  ensureWebRequestObservers(br);
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
  const status = String((details && details.runningStatus) || '');

  if (status && status !== 'running') {
    const state = br.workers.get(versionId);
    if (state) state.ready = false;
    return;
  }

  const worker =
    typeof br.ses.serviceWorkers.getWorkerFromVersionID === 'function'
      ? br.ses.serviceWorkers.getWorkerFromVersionID(versionId)
      : null;
  if (!worker) return;

  const scope = String(worker.scope || worker.scriptURL || '');
  const runtimeId = extensionIdFromScope(scope);
  if (!runtimeId) return;
  if (br.hookedVersionIds.has(versionId)) {
    const existing = br.workers.get(versionId);
    if (existing) existing.worker = worker;
    return;
  }

  const binding = br.byRuntimeId.get(runtimeId);
  if (!binding) {
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
  const scope = String(worker.scope || `chrome-extension://${binding.runtimeId}/`);
  const state = {
    worker,
    runtimeId: binding.runtimeId,
    installId: binding.installId,
    ready: false,
    queue: [],
    dynamicRaw: [],
    sessionRaw: [],
    disabledStatic: {},
    scope,
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
    // Drain per-worker queue
    while (state.queue.length) {
      try {
        worker.send('mh-sw:event', state.queue.shift());
      } catch {
        break;
      }
    }
    // Drain session-level pending for this runtime
    const pending = br.pendingEventsByRuntimeId.get(binding.runtimeId) || [];
    br.pendingEventsByRuntimeId.set(binding.runtimeId, []);
    for (const ev of pending) {
      try {
        worker.send('mh-sw:event', ev);
      } catch {
        break;
      }
    }
    // Re-announce live panels so ABU rebuilds tab state after SW restart.
    reannounceLivePanels(br, binding.runtimeId);
  };

  ipc.on(
    'mh-sw:ready',
    guard((_e, payload) => {
      console.log('[sw-bridge] shim ready', binding.runtimeId, payload && payload.id);
      setTimeout(markReady, READY_FLUSH_DELAY_MS);
    })
  );
  setTimeout(() => {
    if (!state.ready) {
      console.log('[sw-bridge] ready fallback', binding.runtimeId);
      markReady();
    }
  }, 150);

  ipc.on(
    'mh-sw:scripting.observed',
    guard((_e, meta) => {
      // Early-replay cache filled in step 5.
      void meta;
    })
  );

  ipc.on(
    'mh-sw:dnr.enabledRulesets',
    guard((_e, ids) => {
      if (Array.isArray(ids)) {
        dnr.updateEnabledRulesets(binding.installId, {
          enableRulesetIds: ids,
          disableRulesetIds: [],
        });
      }
    })
  );

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
      // Full panel open in step 4; Tab-shaped stub for now.
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
      frameId: frameIdOf(f),
      parentFrameId: parentFrameIdOf(f),
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
 * @param {Electron.WebContents} wc
 */
function tabShape(wc) {
  let url = '';
  let title = '';
  let status = 'complete';
  try {
    url = wc.getURL() || '';
    title = wc.getTitle() || '';
    status = wc.isLoading() ? 'loading' : 'complete';
  } catch {
    /* ignore */
  }
  return {
    id: wc.id,
    url,
    title,
    active: true,
    windowId: 0,
    index: 0,
    status,
    discarded: false,
  };
}

/**
 * Wake a stopped SW and queue until ready.
 * @param {SessionBridge} br
 * @param {string} runtimeId
 */
function wakeWorker(br, runtimeId) {
  const scope = `chrome-extension://${runtimeId}/`;
  const sw = br.ses.serviceWorkers;
  if (!sw || typeof sw.startWorkerForScope !== 'function') return;
  try {
    const p = sw.startWorkerForScope(scope);
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

/**
 * Emit a chrome.* event into ready workers (queued until ready; wakes SW if needed).
 * @param {SessionBridge} br
 * @param {string} runtimeId
 * @param {string} ns
 * @param {string} name
 * @param {...any} args
 */
function emit(br, runtimeId, ns, name, ...args) {
  const ev = { ns, name, args };
  let delivered = false;
  let queued = false;
  for (const state of br.workers.values()) {
    if (state.runtimeId !== runtimeId) continue;
    if (state.ready && state.worker) {
      try {
        state.worker.send('mh-sw:event', ev);
        delivered = true;
      } catch {
        state.ready = false;
        state.queue.push(ev);
        queued = true;
      }
    } else {
      state.queue.push(ev);
      queued = true;
    }
  }
  if (!delivered && !queued) {
    let list = br.pendingEventsByRuntimeId.get(runtimeId);
    if (!list) {
      list = [];
      br.pendingEventsByRuntimeId.set(runtimeId, list);
    }
    list.push(ev);
    queued = true;
  }
  if (!delivered) {
    wakeWorker(br, runtimeId);
  }
}

/**
 * Emit to every abuCompat extension bound in this session.
 * @param {SessionBridge} br
 * @param {string} ns
 * @param {string} name
 * @param {...any} args
 */
function emitAll(br, ns, name, ...args) {
  for (const runtimeId of br.byRuntimeId.keys()) {
    emit(br, runtimeId, ns, name, ...args);
  }
}

/**
 * @param {SessionBridge} br
 * @param {string} runtimeId
 */
function reannounceLivePanels(br, runtimeId) {
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (!wc || wc.isDestroyed() || wc.session !== br.ses) continue;
      // Skip extension pages / service worker clients without a real URL
      let url = '';
      try {
        url = wc.getURL() || '';
      } catch {
        continue;
      }
      if (!url || url === 'about:blank') continue;
      if (url.startsWith('chrome-extension://')) continue;

      emit(br, runtimeId, 'tabs', 'onCreated', tabShape(wc));
      const f = wc.mainFrame;
      emit(br, runtimeId, 'webNavigation', 'onCommitted', {
        tabId: wc.id,
        frameId: 0,
        parentFrameId: -1,
        url,
        timeStamp: Date.now(),
        transitionType: 'link',
        transitionQualifiers: [],
        frameType: 'outermost_frame',
        documentLifecycle: 'active',
      });
      void f;
    } catch {
      /* ignore */
    }
  }
}

/**
 * Global web-contents-created → route to session bridges.
 */
function ensureAppContentsHook() {
  if (appContentsHooked) return;
  appContentsHooked = true;
  app.on('web-contents-created', (_e, wc) => {
    try {
      const br = bySession.get(wc.session);
      if (!br) return;
      attachWebContents(br, wc);
    } catch (err) {
      console.warn('[sw-bridge] web-contents-created', err && err.message);
    }
  });
}

/**
 * @param {SessionBridge} br
 */
function ensureContentsHook(br) {
  if (br.contentsHooked) return;
  br.contentsHooked = true;
  ensureAppContentsHook();
  for (const wc of webContents.getAllWebContents()) {
    try {
      if (wc.session === br.ses) attachWebContents(br, wc);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {SessionBridge} br
 * @param {Electron.WebContents} wc
 */
function attachWebContents(br, wc) {
  if (!wc || wc.isDestroyed()) return;
  if (br.hookedWcIds.has(wc.id)) return;
  br.hookedWcIds.add(wc.id);

  const navDetails = (url, f) => ({
    tabId: wc.id,
    frameId: frameIdOf(f),
    parentFrameId: parentFrameIdOf(f),
    url: url || '',
    timeStamp: Date.now(),
    frameType: f && f.parent ? 'sub_frame' : 'outermost_frame',
    documentLifecycle: 'active',
  });

  wc.on('did-start-navigation', (...args) => {
    try {
      const first = args[0];
      let sameDoc = false;
      let f = null;
      let navUrl = '';
      // Electron 25+: Event<Params> with isSameDocument/frame; older: (e, url, isInPlace, …)
      if (
        first &&
        typeof first === 'object' &&
        ('isSameDocument' in first || 'frame' in first)
      ) {
        sameDoc = !!first.isSameDocument;
        f = first.frame || null;
        navUrl = first.url || '';
      } else {
        const url = args[1];
        const isInPlace = args[2];
        const isMainFrame = args[3];
        const frameProcessId = args[4];
        const frameRoutingId = args[5];
        sameDoc = !!isInPlace;
        navUrl = typeof url === 'string' ? url : '';
        if (frameProcessId != null && frameRoutingId != null) {
          f = webFrameMain.fromId(frameProcessId, frameRoutingId);
        }
        if (!f && isMainFrame) {
          try {
            f = wc.mainFrame;
          } catch {
            f = null;
          }
        }
      }
      if (sameDoc) return;
      if (!f) return;
      emitAll(br, 'webNavigation', 'onBeforeNavigate', navDetails(navUrl, f));
      if (!f.parent) {
        emitAll(
          br,
          'tabs',
          'onUpdated',
          wc.id,
          { status: 'loading', url: navUrl },
          { ...tabShape(wc), url: navUrl, status: 'loading' }
        );
      }
    } catch (err) {
      console.warn('[sw-bridge] did-start-navigation', err && err.message);
    }
  });

  wc.on('did-frame-navigate', (_e, url, _code, _text, _isMain, pid, rid) => {
    try {
      const f = webFrameMain.fromId(pid, rid);
      emitAll(br, 'webNavigation', 'onCommitted', {
        ...navDetails(url, f),
        transitionType: 'link',
        transitionQualifiers: [],
      });
    } catch (err) {
      console.warn('[sw-bridge] did-frame-navigate', err && err.message);
    }
  });

  wc.on('dom-ready', () => {
    try {
      emitAll(br, 'webNavigation', 'onDOMContentLoaded', {
        tabId: wc.id,
        frameId: 0,
        parentFrameId: -1,
        url: wc.getURL() || '',
        timeStamp: Date.now(),
        frameType: 'outermost_frame',
        documentLifecycle: 'active',
      });
    } catch {
      /* ignore */
    }
  });

  wc.on('did-frame-finish-load', (_e, _isMain, pid, rid) => {
    try {
      const f = webFrameMain.fromId(pid, rid);
      emitAll(br, 'webNavigation', 'onCompleted', navDetails(f ? f.url : '', f));
      if (f && !f.parent) {
        emitAll(
          br,
          'tabs',
          'onUpdated',
          wc.id,
          { status: 'complete', url: f.url || '' },
          { ...tabShape(wc), status: 'complete' }
        );
      }
    } catch {
      /* ignore */
    }
  });

  const onFail = (_e, _code, _desc, validatedURL, isMainFrame, pid, rid) => {
    try {
      let f = null;
      if (pid != null && rid != null) f = webFrameMain.fromId(pid, rid);
      if (!f && isMainFrame) {
        try {
          f = wc.mainFrame;
        } catch {
          f = null;
        }
      }
      emitAll(br, 'webNavigation', 'onErrorOccurred', {
        ...navDetails(validatedURL || '', f),
        error: 'net::ERR_FAILED',
      });
    } catch {
      /* ignore */
    }
  };
  wc.on('did-fail-load', onFail);
  wc.on('did-fail-provisional-load', onFail);

  wc.on('did-navigate-in-page', (_e, url, _isMain, pid, rid) => {
    try {
      const f =
        pid != null && rid != null ? webFrameMain.fromId(pid, rid) : wc.mainFrame;
      emitAll(br, 'webNavigation', 'onHistoryStateUpdated', {
        ...navDetails(url, f),
        transitionType: 'link',
        transitionQualifiers: [],
      });
    } catch {
      /* ignore */
    }
  });

  wc.on('did-create-window', (_child, details) => {
    try {
      emitAll(br, 'webNavigation', 'onCreatedNavigationTarget', {
        sourceTabId: wc.id,
        sourceProcessId: 0,
        sourceFrameId: 0,
        url: (details && details.url) || '',
        tabId: _child && _child.webContents ? _child.webContents.id : -1,
        timeStamp: Date.now(),
      });
    } catch {
      /* ignore */
    }
  });

  wc.on('destroyed', () => {
    br.hookedWcIds.delete(wc.id);
    emitAll(br, 'tabs', 'onRemoved', wc.id, {
      windowId: 0,
      isWindowClosing: false,
    });
  });

  wc.on('focus', () => {
    try {
      emitAll(br, 'tabs', 'onActivated', {
        tabId: wc.id,
        windowId: 0,
      });
    } catch {
      /* ignore */
    }
  });
}

/**
 * Convert Electron webRequest details → chrome.webRequest details (phase 1 docs).
 * @param {object} d
 * @returns {object|null}
 */
function toChromeWebRequestDetails(d) {
  if (!d) return null;
  const electronType = String(d.resourceType || '');
  const type = RESOURCE_TYPE_MAP[electronType] || 'other';
  if (!PHASE1_DOC_TYPES.has(type)) return null;

  const f = d.frame || null;
  const isMain = type === 'main_frame';
  let initiator = '';
  let documentUrl = '';
  try {
    if (d.referrer) initiator = String(d.referrer);
  } catch {
    /* ignore */
  }
  try {
    if (f && f.url) documentUrl = String(f.url);
  } catch {
    /* ignore */
  }

  /** @type {{ name: string, value: string }[]} */
  const responseHeaders = [];
  const rh = d.responseHeaders;
  if (rh && typeof rh === 'object') {
    for (const [name, value] of Object.entries(rh)) {
      if (Array.isArray(value)) {
        for (const v of value) responseHeaders.push({ name, value: String(v) });
      } else if (value != null) {
        responseHeaders.push({ name, value: String(value) });
      }
    }
  }

  return {
    requestId: String(d.id),
    url: d.url || '',
    method: d.method || 'GET',
    tabId: d.webContentsId != null ? d.webContentsId : -1,
    frameId: isMain ? 0 : f ? frameIdOf(f) : -1,
    parentFrameId: isMain ? -1 : f ? parentFrameIdOf(f) : 0,
    type,
    timeStamp: Date.now(),
    frameType: isMain ? 'outermost_frame' : 'sub_frame',
    documentLifecycle: 'active',
    initiator: initiator || undefined,
    documentUrl: documentUrl || undefined,
    statusCode: d.statusCode,
    fromCache: !!d.fromCache,
    responseHeaders,
  };
}

/**
 * @param {SessionBridge} br
 */
function ensureWebRequestObservers(br) {
  if (br.webRequestHooked) return;
  br.webRequestHooked = true;
  const id = 'mh-abu-sw-' + (br.accountId || 'ses');

  const feed = (eventName, details) => {
    const chrome = toChromeWebRequestDetails(details);
    if (!chrome) return;
    emitAll(br, 'webRequest', eventName, chrome);
  };

  hub.addBeforeRequestObserver(br.ses, id, (d) => feed('onBeforeRequest', d));
  hub.addBeforeSendHeadersObserver(br.ses, id, (d) => feed('onBeforeSendHeaders', d));
  hub.addHeadersReceivedObserver(br.ses, id, (d) => feed('onHeadersReceived', d));
  hub.addResponseStartedObserver(br.ses, id, (d) => feed('onResponseStarted', d));
  hub.addCompletedObserver(br.ses, id, (d) => feed('onCompleted', d));
  hub.addErrorOccurredObserver(br.ses, id, (d) => feed('onErrorOccurred', d));
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
  ensureContentsHook(br);
  ensureWebRequestObservers(br);
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
  emitAll,
  getBridge,
  frameIdOf,
  parentFrameIdOf,
  toChromeWebRequestDetails,
  tabShape,
};
