'use strict';

/**
 * Electron allows only ONE listener per webRequest event per session.
 * This hub is that listener and multiplexes app handlers (adblock, UA, future).
 */

/** @typedef {(details: Electron.OnBeforeRequestListenerDetails, callback: (r: Electron.CallbackResponse) => void) => void} BeforeRequestHandler */
/** @typedef {(details: Electron.OnHeadersReceivedListenerDetails, callback: (r: Electron.HeadersReceivedResponse) => void) => void} HeadersReceivedHandler */
/** @typedef {(details: Electron.OnBeforeSendHeadersListenerDetails, callback: (r: Electron.BeforeSendResponse) => void) => void} BeforeSendHeadersHandler */

/** @type {WeakMap<Electron.Session, SessionHub>} */
const hubs = new WeakMap();

/**
 * @typedef {object} SessionHub
 * @property {Map<string, BeforeRequestHandler>} beforeRequest
 * @property {Map<string, HeadersReceivedHandler>} headersReceived
 * @property {Map<string, BeforeSendHeadersHandler>} beforeSendHeaders
 * @property {boolean} attached
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
    attached: false,
  };
  hubs.set(ses, hub);
  return hub;
}

/**
 * @param {Electron.Session} ses
 */
function attachIfNeeded(ses) {
  const hub = ensureHub(ses);
  if (hub.attached) return;
  hub.attached = true;

  // Run all beforeRequest handlers; block (cancel) wins over redirect (coexistence).
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
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

module.exports = {
  addBeforeRequest,
  removeBeforeRequest,
  addHeadersReceived,
  removeHeadersReceived,
  addBeforeSendHeaders,
  removeBeforeSendHeaders,
  ensureHub,
};
