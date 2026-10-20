'use strict';

/**
 * Electron allows only ONE listener per webRequest event per session.
 * This hub is that listener and multiplexes app handlers (adblock, UA, future).
 *
 * Observers are pure taps: they never cancel/redirect/modify and must not change
 * hub behaviour for built-in adblock / DNR handlers. They work even when no
 * mutating handlers are registered (e.g. built-in adblock OFF).
 */

/** @typedef {(details: Electron.OnBeforeRequestListenerDetails, callback: (r: Electron.CallbackResponse) => void) => void} BeforeRequestHandler */
/** @typedef {(details: Electron.OnHeadersReceivedListenerDetails, callback: (r: Electron.HeadersReceivedResponse) => void) => void} HeadersReceivedHandler */
/** @typedef {(details: Electron.OnBeforeSendHeadersListenerDetails, callback: (r: Electron.BeforeSendResponse) => void) => void} BeforeSendHeadersHandler */
/** @typedef {(details: object) => void} ObserverFn */

/** @type {WeakMap<Electron.Session, SessionHub>} */
const hubs = new WeakMap();

/**
 * @typedef {object} SessionHub
 * @property {Map<string, BeforeRequestHandler>} beforeRequest
 * @property {Map<string, HeadersReceivedHandler>} headersReceived
 * @property {Map<string, BeforeSendHeadersHandler>} beforeSendHeaders
 * @property {Map<string, ObserverFn>} beforeRequestObservers
 * @property {Map<string, ObserverFn>} beforeSendHeadersObservers
 * @property {Map<string, ObserverFn>} headersReceivedObservers
 * @property {Map<string, ObserverFn>} responseStartedObservers
 * @property {Map<string, ObserverFn>} completedObservers
 * @property {Map<string, ObserverFn>} errorOccurredObservers
 * @property {boolean} attached
 * @property {boolean} passiveAttached
 */

/**
 * @param {Electron.Session} ses
 * @returns {SessionHub}
 */
function ensureHub(ses) {
  let hub = hubs.get(ses);
  if (hub) return hub;
  hub = {
    beforeRequest: new Map(),
    headersReceived: new Map(),
    beforeSendHeaders: new Map(),
    beforeRequestObservers: new Map(),
    beforeSendHeadersObservers: new Map(),
    headersReceivedObservers: new Map(),
    responseStartedObservers: new Map(),
    completedObservers: new Map(),
    errorOccurredObservers: new Map(),
    attached: false,
    passiveAttached: false,
  };
  hubs.set(ses, hub);
  return hub;
}

/**
 * @param {Map<string, ObserverFn>} map
 * @param {object} details
 */
function notifyObservers(map, details) {
  if (!map || !map.size) return;
  for (const fn of map.values()) {
    try {
      fn(details);
    } catch (err) {
      console.warn('[webRequestHub] observer error', err && err.message ? err.message : err);
    }
  }
}

/**
 * @param {Electron.Session} ses
 */
function attachIfNeeded(ses) {
  const hub = ensureHub(ses);
  if (hub.attached) {
    attachPassiveIfNeeded(ses, hub);
    return;
  }
  hub.attached = true;

  // Run all beforeRequest handlers; block (cancel) wins over redirect (coexistence).
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    notifyObservers(hub.beforeRequestObservers, details);
    const handlers = [...hub.beforeRequest.values()];
    if (!handlers.length) {
      callback({});
      return;
    }
    let i = 0;
    let cancel = false;
    /** @type {string|null} */
    let redirectURL = null;
    const next = (response) => {
      if (response && response.cancel) cancel = true;
      if (response && response.redirectURL && !redirectURL) {
        redirectURL = response.redirectURL;
      }
      i += 1;
      if (i >= handlers.length) {
        if (cancel) callback({ cancel: true });
        else if (redirectURL) callback({ redirectURL });
        else callback({});
        return;
      }
      try {
        handlers[i](details, next);
      } catch (err) {
        console.warn('[webRequestHub] onBeforeRequest handler error', err);
        next({});
      }
    };
    try {
      handlers[0](details, next);
    } catch (err) {
      console.warn('[webRequestHub] onBeforeRequest handler error', err);
      callback({});
    }
  });

  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    notifyObservers(hub.headersReceivedObservers, details);
    const handlers = [...hub.headersReceived.values()];
    if (!handlers.length) {
      callback({});
      return;
    }
    let i = 0;
    /** @type {Electron.HeadersReceivedResponse} */
    let merged = {};
    const next = (response) => {
      if (response && response.responseHeaders) {
        merged = {
          ...merged,
          ...response,
          responseHeaders: {
            ...(merged.responseHeaders || details.responseHeaders || {}),
            ...response.responseHeaders,
          },
        };
      } else if (response && response.cancel) {
        callback(response);
        return;
      }
      i += 1;
      if (i >= handlers.length) {
        callback(Object.keys(merged).length ? merged : {});
        return;
      }
      try {
        handlers[i](details, next);
      } catch (err) {
        console.warn('[webRequestHub] onHeadersReceived handler error', err);
        next({});
      }
    };
    try {
      handlers[0](details, next);
    } catch (err) {
      console.warn('[webRequestHub] onHeadersReceived handler error', err);
      callback({});
    }
  });

  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    notifyObservers(hub.beforeSendHeadersObservers, details);
    const handlers = [...hub.beforeSendHeaders.values()];
    if (!handlers.length) {
      callback({});
      return;
    }
    let i = 0;
    /** @type {Electron.BeforeSendResponse} */
    let merged = { requestHeaders: { ...(details.requestHeaders || {}) } };
    const next = (response) => {
      if (response && response.cancel) {
        callback(response);
        return;
      }
      if (response && response.requestHeaders) {
        merged.requestHeaders = {
          ...(merged.requestHeaders || {}),
          ...response.requestHeaders,
        };
      }
      if (response && response.redirectURL) {
        callback(response);
        return;
      }
      i += 1;
      if (i >= handlers.length) {
        callback(merged);
        return;
      }
      try {
        handlers[i](details, next);
      } catch (err) {
        console.warn('[webRequestHub] onBeforeSendHeaders handler error', err);
        next({});
      }
    };
    try {
      handlers[0](details, next);
    } catch (err) {
      console.warn('[webRequestHub] onBeforeSendHeaders handler error', err);
      callback({});
    }
  });

  attachPassiveIfNeeded(ses, hub);
}

/**
 * Pure observer listeners (no response callback). Safe to own exclusively via hub.
 * @param {Electron.Session} ses
 * @param {SessionHub} hub
 */
function attachPassiveIfNeeded(ses, hub) {
  if (hub.passiveAttached) return;
  hub.passiveAttached = true;

  ses.webRequest.onResponseStarted({ urls: ['<all_urls>'] }, (details) => {
    notifyObservers(hub.responseStartedObservers, details);
  });
  ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
    notifyObservers(hub.completedObservers, details);
  });
  ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (details) => {
    notifyObservers(hub.errorOccurredObservers, details);
  });
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 * @param {BeforeRequestHandler} handler
 */
function addBeforeRequest(ses, id, handler) {
  const hub = ensureHub(ses);
  hub.beforeRequest.set(id, handler);
  attachIfNeeded(ses);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 */
function removeBeforeRequest(ses, id) {
  const hub = hubs.get(ses);
  if (!hub) return;
  hub.beforeRequest.delete(id);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 * @param {HeadersReceivedHandler} handler
 */
function addHeadersReceived(ses, id, handler) {
  const hub = ensureHub(ses);
  hub.headersReceived.set(id, handler);
  attachIfNeeded(ses);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 */
function removeHeadersReceived(ses, id) {
  const hub = hubs.get(ses);
  if (!hub) return;
  hub.headersReceived.delete(id);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 * @param {BeforeSendHeadersHandler} handler
 */
function addBeforeSendHeaders(ses, id, handler) {
  const hub = ensureHub(ses);
  hub.beforeSendHeaders.set(id, handler);
  attachIfNeeded(ses);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 */
function removeBeforeSendHeaders(ses, id) {
  const hub = hubs.get(ses);
  if (!hub) return;
  hub.beforeSendHeaders.delete(id);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 * @param {ObserverFn} fn
 */
function addBeforeRequestObserver(ses, id, fn) {
  const hub = ensureHub(ses);
  hub.beforeRequestObservers.set(id, fn);
  attachIfNeeded(ses);
}

/** @param {Electron.Session} ses @param {string} id */
function removeBeforeRequestObserver(ses, id) {
  const hub = hubs.get(ses);
  if (hub) hub.beforeRequestObservers.delete(id);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 * @param {ObserverFn} fn
 */
function addBeforeSendHeadersObserver(ses, id, fn) {
  const hub = ensureHub(ses);
  hub.beforeSendHeadersObservers.set(id, fn);
  attachIfNeeded(ses);
}

/** @param {Electron.Session} ses @param {string} id */
function removeBeforeSendHeadersObserver(ses, id) {
  const hub = hubs.get(ses);
  if (hub) hub.beforeSendHeadersObservers.delete(id);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 * @param {ObserverFn} fn
 */
function addHeadersReceivedObserver(ses, id, fn) {
  const hub = ensureHub(ses);
  hub.headersReceivedObservers.set(id, fn);
  attachIfNeeded(ses);
}

/** @param {Electron.Session} ses @param {string} id */
function removeHeadersReceivedObserver(ses, id) {
  const hub = hubs.get(ses);
  if (hub) hub.headersReceivedObservers.delete(id);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 * @param {ObserverFn} fn
 */
function addResponseStartedObserver(ses, id, fn) {
  const hub = ensureHub(ses);
  hub.responseStartedObservers.set(id, fn);
  attachIfNeeded(ses);
}

/** @param {Electron.Session} ses @param {string} id */
function removeResponseStartedObserver(ses, id) {
  const hub = hubs.get(ses);
  if (hub) hub.responseStartedObservers.delete(id);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 * @param {ObserverFn} fn
 */
function addCompletedObserver(ses, id, fn) {
  const hub = ensureHub(ses);
  hub.completedObservers.set(id, fn);
  attachIfNeeded(ses);
}

/** @param {Electron.Session} ses @param {string} id */
function removeCompletedObserver(ses, id) {
  const hub = hubs.get(ses);
  if (hub) hub.completedObservers.delete(id);
}

/**
 * @param {Electron.Session} ses
 * @param {string} id
 * @param {ObserverFn} fn
 */
function addErrorOccurredObserver(ses, id, fn) {
  const hub = ensureHub(ses);
  hub.errorOccurredObservers.set(id, fn);
  attachIfNeeded(ses);
}

/** @param {Electron.Session} ses @param {string} id */
function removeErrorOccurredObserver(ses, id) {
  const hub = hubs.get(ses);
  if (hub) hub.errorOccurredObservers.delete(id);
}

module.exports = {
  addBeforeRequest,
  removeBeforeRequest,
  addHeadersReceived,
  removeHeadersReceived,
  addBeforeSendHeaders,
  removeBeforeSendHeaders,
  addBeforeRequestObserver,
  removeBeforeRequestObserver,
  addBeforeSendHeadersObserver,
  removeBeforeSendHeadersObserver,
  addHeadersReceivedObserver,
  removeHeadersReceivedObserver,
  addResponseStartedObserver,
  removeResponseStartedObserver,
  addCompletedObserver,
  removeCompletedObserver,
  addErrorOccurredObserver,
  removeErrorOccurredObserver,
  ensureHub,
};
