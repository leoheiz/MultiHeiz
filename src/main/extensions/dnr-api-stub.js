'use strict';

/**
 * Stub chrome.declarativeNetRequest dynamic/session/updateEnabledRulesets.
 * Injected into extension pages (popup/options) via executeJavaScript when opened.
 *
 * Kept as a fallback (not removed in step 6): MV3 service workers get DNR through
 * sw-shim-preload → sw-bridge → dnr-shim, but popup/options pages still need this
 * page stub + multiheizDnrBridge for updateEnabledRulesets / updateDynamicRules /
 * getEnabledRulesets when the user opens the extension UI.
 */

const dnr = require('./dnr-shim');

/**
 * Build a script that patches chrome.declarativeNetRequest in an extension page.
 * @param {string} installId
 */
function pageStubSource(installId) {
  const idLit = JSON.stringify(installId);
  return `(() => {
  try {
    if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest) {
      // Electron may leave DNR undefined — create a minimal stub
      if (typeof chrome === 'undefined') return;
      chrome.declarativeNetRequest = chrome.declarativeNetRequest || {};
    }
    const DNR = chrome.declarativeNetRequest;
    const installId = ${idLit};
    const post = (method, payload) => {
      try {
        if (window.multiheizDnrBridge && typeof window.multiheizDnrBridge === 'function') {
          return window.multiheizDnrBridge(method, payload);
        }
      } catch (e) {}
      return Promise.resolve({ ok: false, error: 'no bridge' });
    };
    const wrap = (name, fn) => {
      try {
        DNR[name] = fn;
      } catch (e) {
        try { Object.defineProperty(DNR, name, { value: fn, configurable: true }); } catch (_) {}
      }
    };
    wrap('updateEnabledRulesets', (options, cb) => {
      const p = post('updateEnabledRulesets', { installId, options: options || {} });
      if (typeof cb === 'function') p.then(() => cb()).catch(() => cb());
      return p;
    });
    wrap('updateDynamicRules', (options, cb) => {
      const p = post('updateDynamicRules', { installId, options: options || {} });
      if (typeof cb === 'function') p.then(() => cb()).catch(() => cb());
      return p;
    });
    wrap('updateSessionRules', (options, cb) => {
      const p = post('updateSessionRules', { installId, options: options || {} });
      if (typeof cb === 'function') p.then(() => cb()).catch(() => cb());
      return p;
    });
    wrap('getEnabledRulesets', (cb) => {
      const p = post('getEnabledRulesets', { installId });
      if (typeof cb === 'function') {
        p.then((r) => cb((r && r.ids) || [])).catch(() => cb([]));
      }
      return p;
    });
  } catch (e) {}
})();`;
}

/**
 * Apply update from bridge / IPC.
 * @param {string} method
 * @param {{ installId: string, options?: object }} payload
 */
function handleBridge(method, payload) {
  const installId = payload && payload.installId;
  const options = (payload && payload.options) || {};
  if (!installId) return { ok: false, error: 'missing installId' };
  if (method === 'updateEnabledRulesets') {
    return dnr.updateEnabledRulesets(installId, {
      enableRulesetIds: options.enableRulesetIds || options.enable || [],
      disableRulesetIds: options.disableRulesetIds || options.disable || [],
    });
  }
  if (method === 'updateDynamicRules') {
    return dnr.updateRules(installId, 'dynamic', {
      removeRuleIds: options.removeRuleIds || [],
      addRules: options.addRules || [],
    });
  }
  if (method === 'updateSessionRules') {
    return dnr.updateRules(installId, 'session', {
      removeRuleIds: options.removeRuleIds || [],
      addRules: options.addRules || [],
    });
  }
  if (method === 'getEnabledRulesets') {
    const eng = dnr.getEngine(installId);
    if (!eng) return { ok: false, ids: [] };
    const ids = [...eng.rulesets.entries()].filter(([, rs]) => rs.enabled).map(([id]) => id);
    return { ok: true, ids };
  }
  return { ok: false, error: 'unknown method' };
}

module.exports = {
  pageStubSource,
  handleBridge,
};
