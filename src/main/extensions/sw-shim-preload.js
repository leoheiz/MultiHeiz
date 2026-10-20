'use strict';

/**
 * Service-worker preload for MV3 extension compatibility (extensions.abuCompat).
 * Runs in the SW preload realm before the extension's background.service_worker.
 * Only patches chrome-extension:// scopes; website SWs are left alone.
 *
 * Do not copy GPL extension code here — we only emulate missing chrome.* APIs.
 */

const { contextBridge, ipcRenderer } = require('electron');

(function mhExtSwShimPreload() {
  /*
   * This preload is registered for every SW in the account session. The
   * isolated preload realm may not expose chrome-extension:// on location, so
   * we always install the IPC bridge and gate the chrome.* patches inside
   * executeInMainWorld on chrome.runtime.id (website SWs have no extension id).
   */
  const listeners = [];
  contextBridge.exposeInMainWorld('__mhExt', {
    onEvent: (cb) => {
      if (typeof cb === 'function') listeners.push(cb);
    },
    send: (ch, d) => ipcRenderer.send('mh-sw:' + ch, d),
    invoke: (ch, d) => ipcRenderer.invoke('mh-sw:' + ch, d),
  });
  ipcRenderer.on('mh-sw:event', (_e, ev) => {
    for (const cb of listeners) {
      try {
        cb(ev);
      } catch {
        /* ignore */
      }
    }
  });

  contextBridge.executeInMainWorld({
    func: () => {
      const B = self.__mhExt;
      if (!B) return;
      // Gate: only extension service workers (chrome.runtime.id is a–p id).
      try {
        const id = self.chrome && chrome.runtime && chrome.runtime.id;
        if (!id || !/^[a-p]{32}$/.test(String(id))) return;
        let proto = '';
        try {
          proto = String((self.location && self.location.protocol) || '');
        } catch {
          proto = '';
        }
        if (proto && proto !== 'chrome-extension:') return;
      } catch {
        return;
      }

      const mkEvent = (name) => {
        /** @type {Map<Function, { filter?: object }>} */
        const ls = new Map();
        return {
          addListener: (f, filter) => {
            if (typeof f === 'function') ls.set(f, { filter: filter || null });
          },
          removeListener: (f) => {
            ls.delete(f);
          },
          hasListener: (f) => ls.has(f),
          hasListeners: () => ls.size > 0,
          __fire: (details, ...rest) => {
            for (const [f, meta] of [...ls.entries()]) {
              try {
                if (meta.filter && details && typeof details === 'object') {
                  const filter = meta.filter;
                  if (
                    Array.isArray(filter.types) &&
                    filter.types.length &&
                    details.type != null &&
                    !filter.types.includes(details.type)
                  ) {
                    continue;
                  }
                  if (
                    filter.tabId != null &&
                    filter.tabId !== -1 &&
                    details.tabId != null &&
                    details.tabId !== filter.tabId
                  ) {
                    continue;
                  }
                  if (Array.isArray(filter.urls) && filter.urls.length) {
                    const url = String(details.url || '');
                    const ok = filter.urls.some((pat) => {
                      if (pat === '<all_urls>' || pat === '*://*/*') return true;
                      if (typeof pat !== 'string') return false;
                      // Lightweight match: scheme+host wildcards
                      try {
                        const esc = pat
                          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                          .replace(/\*/g, '.*');
                        return new RegExp('^' + esc + '$').test(url);
                      } catch {
                        return url.indexOf(pat.replace(/\*/g, '')) >= 0;
                      }
                    });
                    if (!ok) continue;
                  }
                }
                f(details, ...rest);
              } catch (e) {
                console.error('[mh-ext] listener error ' + name, e && e.stack);
              }
            }
          },
        };
      };

      const def = (obj, k, v) => {
        try {
          Object.defineProperty(obj, k, {
            value: v,
            configurable: true,
            writable: true,
            enumerable: true,
          });
        } catch (e) {
          console.error('[mh-ext] define fail ' + k, e && e.message);
        }
      };

      const events = {};
      const ev = (ns, name) => {
        const key = ns + '.' + name;
        if (!events[key]) events[key] = mkEvent(ns + '.' + name);
        return events[key];
      };

      // --- webNavigation ---
      const wn = {};
      for (const n of [
        'onBeforeNavigate',
        'onCommitted',
        'onDOMContentLoaded',
        'onCompleted',
        'onErrorOccurred',
        'onHistoryStateUpdated',
        'onReferenceFragmentUpdated',
        'onCreatedNavigationTarget',
        'onTabReplaced',
      ]) {
        wn[n] = ev('webNavigation', n);
      }
      wn.getAllFrames = (q, cb) => {
        const p = B.invoke('getAllFrames', q);
        if (cb) p.then(cb);
        return p;
      };
      wn.getFrame = (q, cb) => {
        const p = B.invoke('getFrame', q);
        if (cb) p.then(cb);
        return p;
      };
      def(chrome, 'webNavigation', wn);

      // --- webRequest (native events never fire for MV3 SWs in Electron 44) ---
      const wr = {
        handlerBehaviorChanged: (cb) => {
          if (cb) cb();
          return Promise.resolve();
        },
        MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
      };
      for (const n of [
        'onBeforeRequest',
        'onBeforeSendHeaders',
        'onSendHeaders',
        'onHeadersReceived',
        'onAuthRequired',
        'onResponseStarted',
        'onBeforeRedirect',
        'onCompleted',
        'onErrorOccurred',
      ]) {
        wr[n] = ev('webRequest', n);
      }
      def(chrome, 'webRequest', wr);

      // --- tabs ---
      const nativeTabs = chrome.tabs || {};
      const tabs = Object.create(nativeTabs);
      tabs.create = (props, cb) => {
        const p = B.invoke('tabs.create', props);
        if (cb) p.then(cb);
        return p;
      };
      tabs.remove = (ids, cb) => {
        const p = B.invoke('tabs.remove', ids);
        if (cb) p.then(() => cb());
        return p;
      };
      tabs.detectLanguage = (id, cb) => {
        const p = B.invoke('tabs.detectLanguage', id).catch(() => 'und');
        if (cb) p.then(cb);
        return p;
      };
      for (const n of Object.keys(nativeTabs)) {
        if (['create', 'remove', 'detectLanguage'].includes(n)) continue;
        try {
          const v = nativeTabs[n];
          tabs[n] = typeof v === 'function' && v.bind ? v.bind(nativeTabs) : v;
        } catch {
          /* ignore */
        }
      }
      for (const n of ['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onReplaced']) {
        tabs[n] = ev('tabs', n);
      }
      def(chrome, 'tabs', tabs);

      // --- stubs ---
      const noop = (...a) => {
        const cb = a.find((x) => typeof x === 'function');
        if (cb) cb();
        return Promise.resolve();
      };
      if (!chrome.contextMenus) {
        def(chrome, 'contextMenus', {
          create: () => 0,
          update: noop,
          remove: noop,
          removeAll: noop,
          onClicked: ev('contextMenus', 'onClicked'),
        });
      }
      if (!chrome.action) {
        def(chrome, 'action', {
          setIcon: noop,
          setBadgeText: noop,
          setBadgeBackgroundColor: noop,
          setTitle: noop,
          setPopup: noop,
          openPopup: noop,
          isEnabled: () => Promise.resolve(true),
          onClicked: ev('action', 'onClicked'),
        });
      }
      if (!chrome.windows) {
        def(chrome, 'windows', {
          create: (p) => B.invoke('tabs.create', p),
          update: noop,
          getAll: () => Promise.resolve([]),
          getLastFocused: () => Promise.resolve({ id: 0 }),
          onFocusChanged: ev('windows', 'onFocusChanged'),
          WINDOW_ID_NONE: -1,
          WINDOW_ID_CURRENT: -2,
        });
      }
      if (!chrome.cookies) {
        def(chrome, 'cookies', {
          get: (d) => B.invoke('cookies.get', d),
          getAll: (q) => B.invoke('cookies.getAll', q),
          set: (d) => B.invoke('cookies.set', d),
          remove: (d) => B.invoke('cookies.remove', d),
          onChanged: ev('cookies', 'onChanged'),
        });
      }
      const setting = {
        get: (_d, cb) => {
          const r = {
            value: 'default',
            levelOfControl: 'controllable_by_this_extension',
          };
          if (cb) cb(r);
          return Promise.resolve(r);
        },
        set: noop,
        clear: noop,
        onChange: ev('privacy', 'onChange'),
      };
      if (!chrome.privacy) {
        def(chrome, 'privacy', {
          network: { webRTCIPHandlingPolicy: setting },
          websites: {
            hyperlinkAuditingEnabled: setting,
            thirdPartyCookiesAllowed: setting,
          },
          IPHandlingPolicy: {
            DEFAULT: 'default',
            DISABLE_NON_PROXIED_UDP: 'disable_non_proxied_udp',
          },
        });
      }
      if (!chrome.permissions) {
        def(chrome, 'permissions', {
          contains: (p, cb) => {
            if (cb) cb(true);
            return Promise.resolve(true);
          },
          request: (p, cb) => {
            if (cb) cb(true);
            return Promise.resolve(true);
          },
          getAll: () => Promise.resolve({ permissions: [], origins: ['<all_urls>'] }),
          onAdded: ev('permissions', 'onAdded'),
          onRemoved: ev('permissions', 'onRemoved'),
        });
      } else if (typeof chrome.permissions.contains !== 'function') {
        try {
          chrome.permissions.contains = (p, cb) => {
            if (cb) cb(true);
            return Promise.resolve(true);
          };
        } catch {
          /* ignore */
        }
      }

      // --- declarativeNetRequest ---
      const DNR_KEY = '__mh_dnr';
      const manifest0 = chrome.runtime.getManifest();
      const defaultEnabled = ((manifest0.declarative_net_request || {}).rule_resources || [])
        .filter((r) => r.enabled)
        .map((r) => r.id);

      const dnrState = {
        enabled: new Set(defaultEnabled),
        disabledStatic: /** @type {Record<string, number[]>} */ ({}),
      };

      const persistDnr = () => {
        try {
          const payload = {
            enabled: [...dnrState.enabled],
            disabledStatic: dnrState.disabledStatic,
          };
          chrome.storage.local.set({ [DNR_KEY]: payload }).catch(() => {});
        } catch {
          /* ignore */
        }
      };

      try {
        chrome.storage.local.get(DNR_KEY).then((r) => {
          const s = r && r[DNR_KEY];
          if (!s) return;
          if (Array.isArray(s.enabled)) {
            dnrState.enabled = new Set(s.enabled.map(String));
          }
          if (s.disabledStatic && typeof s.disabledStatic === 'object') {
            dnrState.disabledStatic = s.disabledStatic;
          }
        }).catch(() => {});
      } catch {
        /* ignore */
      }

      const DNR_CONST = {
        MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
        MAX_NUMBER_OF_SESSION_RULES: 5000,
        MAX_NUMBER_OF_REGEX_RULES: 1000,
        MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
        MAX_NUMBER_OF_STATIC_RULESETS: 100,
        GUARANTEED_MINIMUM_STATIC_RULES: 30000,
        DYNAMIC_RULESET_ID: '_dynamic',
        SESSION_RULESET_ID: '_session',
        ResourceType: {
          MAIN_FRAME: 'main_frame',
          SUB_FRAME: 'sub_frame',
          STYLESHEET: 'stylesheet',
          SCRIPT: 'script',
          IMAGE: 'image',
          FONT: 'font',
          OBJECT: 'object',
          XMLHTTPREQUEST: 'xmlhttprequest',
          PING: 'ping',
          CSP_REPORT: 'csp_report',
          MEDIA: 'media',
          WEBSOCKET: 'websocket',
          OTHER: 'other',
        },
        RuleActionType: {
          BLOCK: 'block',
          ALLOW: 'allow',
          UPGRADE_SCHEME: 'upgradeScheme',
          REDIRECT: 'redirect',
          MODIFY_HEADERS: 'modifyHeaders',
          ALLOW_ALL_REQUESTS: 'allowAllRequests',
        },
        HeaderOperation: {
          APPEND: 'append',
          SET: 'set',
          REMOVE: 'remove',
        },
        DomainType: {
          FIRST_PARTY: 'firstParty',
          THIRD_PARTY: 'thirdParty',
        },
      };

      const patchDnr = (dnr) => {
        if (!dnr) return;
        for (const [k, v] of Object.entries(DNR_CONST)) {
          if (dnr[k] == null) {
            try {
              dnr[k] = v;
            } catch {
              try {
                Object.defineProperty(dnr, k, { value: v, configurable: true });
              } catch {
                /* ignore */
              }
            }
          }
        }
        dnr.getEnabledRulesets = (cb) => {
          const r = [...dnrState.enabled];
          if (cb) cb(r);
          return Promise.resolve(r);
        };
        dnr.updateEnabledRulesets = (o, cb) => {
          (o && o.disableRulesetIds ? o.disableRulesetIds : []).forEach((i) =>
            dnrState.enabled.delete(String(i))
          );
          (o && o.enableRulesetIds ? o.enableRulesetIds : []).forEach((i) =>
            dnrState.enabled.add(String(i))
          );
          persistDnr();
          const p = B.invoke('dnr.updateEnabledRulesets', o || {});
          if (cb) p.then(() => cb(), () => cb());
          return p.then(() => undefined);
        };
        dnr.updateDynamicRules = (o, cb) => {
          const p = B.invoke('dnr.updateDynamicRules', o || {});
          if (cb) p.then(() => cb(), () => cb());
          return p.then(() => undefined);
        };
        dnr.updateSessionRules = (o, cb) => {
          const p = B.invoke('dnr.updateSessionRules', o || {});
          if (cb) p.then(() => cb(), () => cb());
          return p.then(() => undefined);
        };
        dnr.updateStaticRules = (o, cb) => {
          if (o && o.rulesetId) {
            const id = String(o.rulesetId);
            const cur = new Set(dnrState.disabledStatic[id] || []);
            (o.disableRuleIds || []).forEach((n) => cur.add(Number(n)));
            (o.enableRuleIds || []).forEach((n) => cur.delete(Number(n)));
            dnrState.disabledStatic[id] = [...cur];
            persistDnr();
          }
          const p = B.invoke('dnr.updateStaticRules', o || {});
          if (cb) p.then(() => cb(), () => cb());
          return p.then(() => undefined);
        };
        dnr.getDynamicRules = (cb) => {
          const p = B.invoke('dnr.getDynamicRules', {});
          if (cb) p.then(cb);
          return p;
        };
        dnr.getSessionRules = (cb) => {
          const p = B.invoke('dnr.getSessionRules', {});
          if (cb) p.then(cb);
          return p;
        };
        dnr.getDisabledRuleIds = (opts, cb) => {
          const id = opts && opts.rulesetId ? String(opts.rulesetId) : '';
          const r = (dnrState.disabledStatic[id] || []).slice();
          if (cb) cb(r);
          const p = B.invoke('dnr.getDisabledRuleIds', opts || {}).catch(() => r);
          return p;
        };
        dnr.getAvailableStaticRuleCount = (cb) => {
          const p = B.invoke('dnr.getAvailableStaticRuleCount', {}).catch(() => 300000);
          if (cb) p.then(cb);
          return p;
        };
        dnr.isRegexSupported = (opts, cb) => {
          const r = { isSupported: true };
          if (cb) cb(r);
          return Promise.resolve(r);
        };
      };

      if (!chrome.declarativeNetRequest) {
        def(chrome, 'declarativeNetRequest', {});
      }
      patchDnr(chrome.declarativeNetRequest);
      if (self.browser && self.browser.declarativeNetRequest) {
        patchDnr(self.browser.declarativeNetRequest);
      }

      // --- scripting.executeScript: observe + optional early-replay skip ---
      const scriptletKey = (funcSrc, args) => {
        try {
          const a = Array.isArray(args) ? args.slice() : [];
          // ABU/tswebextension: args[0] = { name, args, uniqueId, ... }
          if (a[0] && typeof a[0] === 'object' && !Array.isArray(a[0]) && typeof a[0].name === 'string') {
            const copy = Object.assign({}, a[0]);
            delete copy.uniqueId;
            delete copy.verbose;
            delete copy.domainName;
            return 's:' + copy.name + ':' + JSON.stringify(copy.args || []);
          }
          // Legacy / other: args[0] is scriptlet name string
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
      };

      const wrapScripting = (sc) => {
        if (!sc || typeof sc.executeScript !== 'function') return;
        const origExec = sc.executeScript.bind(sc);
        sc.executeScript = (inj, cb) => {
          const run = async () => {
            try {
              if (inj && inj.world === 'MAIN' && typeof inj.func === 'function') {
                const funcSrc = inj.func.toString();
                const args = inj.args || [];
                const key = scriptletKey(funcSrc, args);
                const target = inj.target || {};
                const meta = {
                  tabId: target.tabId,
                  frameIds: target.frameIds,
                  func: funcSrc,
                  args,
                  key,
                };
                let skip = false;
                try {
                  const ans = await B.invoke('scripting.shouldSkip', meta);
                  skip = !!(ans && ans.skip);
                } catch {
                  skip = false;
                }
                // Always observe — even when skipping — so the per-host early
                // cache is not wiped after a warm navigation (empty collection
                // would look like an allowlist and delete the entry).
                try {
                  B.send('scripting.observed', meta);
                } catch {
                  /* ignore */
                }
                if (skip) {
                  const frameId =
                    Array.isArray(target.frameIds) && target.frameIds.length
                      ? target.frameIds[0]
                      : 0;
                  return [{ frameId, documentId: '', result: null }];
                }
              }
            } catch {
              /* ignore observation errors */
            }
            return origExec(inj);
          };
          const p = run();
          if (cb) p.then(cb, () => cb());
          return p;
        };
      };
      wrapScripting(chrome.scripting);
      if (self.browser && self.browser.scripting) wrapScripting(self.browser.scripting);

      // Allowlist / filter config changes → main wipes early-replay cache
      try {
        if (chrome.storage && chrome.storage.onChanged) {
          chrome.storage.onChanged.addListener((changes, area) => {
            try {
              if (area && area !== 'local') return;
              const keys = changes ? Object.keys(changes) : [];
              // Ignore our DNR bookkeeping key
              if (keys.length === 1 && keys[0] === DNR_KEY) return;
              if (!keys.length) return;
              B.send('config-changed', { keys });
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }

      B.onEvent((e) => {
        const t = events[e.ns + '.' + e.name];
        if (t) t.__fire(...e.args);
      });

      // Mirror onto native browser namespace (webextension-polyfill uses it)
      if (self.browser && self.browser !== chrome) {
        for (const k of [
          'webNavigation',
          'webRequest',
          'tabs',
          'contextMenus',
          'action',
          'windows',
          'cookies',
          'privacy',
          'permissions',
        ]) {
          if (chrome[k]) def(self.browser, k, chrome[k]);
        }
        if (chrome.declarativeNetRequest) {
          patchDnr(self.browser.declarativeNetRequest || chrome.declarativeNetRequest);
          if (!self.browser.declarativeNetRequest) {
            def(self.browser, 'declarativeNetRequest', chrome.declarativeNetRequest);
          }
        }
        if (chrome.scripting) wrapScripting(self.browser.scripting);
      }

      B.send('ready', { id: chrome.runtime && chrome.runtime.id });
    },
  });
})();
