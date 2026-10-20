'use strict';

/**
 * DNS over HTTPS (DoH) via app.configureHostResolver.
 * App-wide; windows with an HTTP(S)/SOCKS proxy resolve DNS through that proxy.
 */

const { app } = require('electron');
const { envGet } = require('./config');

const PROVIDERS = Object.freeze({
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query',
  quad9: 'https://dns.quad9.net/dns-query',
  adguard: 'https://dns.adguard-dns.com/dns-query',
});

const MODES = new Set(['off', 'automatic', 'secure']);
const PROVIDER_IDS = new Set(['cloudflare', 'google', 'quad9', 'adguard', 'custom']);

/** @type {Array<{ secureDnsMode: string, secureDnsServers: string[], at: number }>} */
const selftestCalls = [];

/** @type {{ secureDnsMode: string, secureDnsServers: string[] } | null} */
let lastAppliedOptions = null;

function defaultDohSettings() {
  return {
    mode: 'off',
    provider: 'cloudflare',
    customUrl: '',
  };
}

/**
 * @param {unknown} url
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function validateCustomUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return { ok: false, error: 'Informe uma URL https para o DNS personalizado.' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'URL personalizada inválida.' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, error: 'A URL do DNS personalizado deve usar https.' };
  }
  if (!u.hostname || u.hostname.includes(' ')) {
    return { ok: false, error: 'URL personalizada sem host válido.' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'A URL do DNS não pode incluir usuário ou senha.' };
  }
  // Template DoH (RFC8484): URI https simples (POST) ou com {?dns} — aceitamos https URI.
  return { ok: true, url: u.toString() };
}

/**
 * @param {unknown} input
 * @returns {{ mode: string, provider: string, customUrl: string }}
 */
function normalizeDoh(input) {
  const base = defaultDohSettings();
  const src = input && typeof input === 'object' ? input : {};
  const mode = MODES.has(src.mode) ? src.mode : base.mode;
  const provider = PROVIDER_IDS.has(src.provider) ? src.provider : base.provider;
  const customUrl = typeof src.customUrl === 'string' ? src.customUrl.trim() : '';
  return { mode, provider, customUrl };
}

/**
 * @param {{ mode: string, provider: string, customUrl: string }} doh
 * @returns {{ ok: true, options: { secureDnsMode: string, secureDnsServers: string[] } } | { ok: false, error: string }}
 */
function buildHostResolverOptions(doh) {
  const cfg = normalizeDoh(doh);
  if (cfg.mode === 'off') {
    return {
      ok: true,
      options: { secureDnsMode: 'off', secureDnsServers: [] },
    };
  }
  if (cfg.provider === 'custom') {
    const v = validateCustomUrl(cfg.customUrl);
    if (!v.ok) return { ok: false, error: v.error };
    return {
      ok: true,
      options: { secureDnsMode: cfg.mode, secureDnsServers: [v.url] },
    };
  }
  const server = PROVIDERS[cfg.provider] || PROVIDERS.cloudflare;
  return {
    ok: true,
    options: { secureDnsMode: cfg.mode, secureDnsServers: [server] },
  };
}

/**
 * Validate a candidate doh settings object (for UI / IPC) without applying.
 * @param {unknown} input
 */
function validateDohSettings(input) {
  const cfg = normalizeDoh(input);
  const built = buildHostResolverOptions(cfg);
  if (!built.ok) return { ok: false, error: built.error, doh: cfg };
  return { ok: true, doh: cfg, options: built.options };
}

/**
 * @param {{ secureDnsMode: string, secureDnsServers: string[] }} a
 * @param {{ secureDnsMode: string, secureDnsServers: string[] } | null} b
 */
function sameResolverOptions(a, b) {
  if (!b) return false;
  if (a.secureDnsMode !== b.secureDnsMode) return false;
  const as = a.secureDnsServers || [];
  const bs = b.secureDnsServers || [];
  if (as.length !== bs.length) return false;
  for (let i = 0; i < as.length; i++) {
    if (as[i] !== bs[i]) return false;
  }
  return true;
}

/**
 * @param {{ secureDnsMode: string, secureDnsServers: string[] }} options
 * @param {{ force?: boolean }} [opts]
 */
function configure(options, opts = {}) {
  const conf = {
    secureDnsMode: options.secureDnsMode,
    secureDnsServers: Array.isArray(options.secureDnsServers) ? options.secureDnsServers.slice() : [],
  };
  if (!opts.force && sameResolverOptions(conf, lastAppliedOptions)) {
    return { ...conf, skipped: true };
  }
  if (envGet('MULTIHEIZ_SELFTEST')) {
    selftestCalls.push({ ...conf, at: Date.now() });
  }
  if (typeof app.configureHostResolver === 'function') {
    app.configureHostResolver(conf);
  }
  lastAppliedOptions = {
    secureDnsMode: conf.secureDnsMode,
    secureDnsServers: conf.secureDnsServers.slice(),
  };
  return conf;
}

/**
 * Apply DoH from current app settings (after ready / on change).
 * Skips configureHostResolver when options are unchanged (no panel reload).
 * @param {{ mode?: string, provider?: string, customUrl?: string } | null | undefined} dohSettings
 * @param {{ force?: boolean }} [opts]
 */
function applyDohSettings(dohSettings, opts = {}) {
  const cfg = normalizeDoh(dohSettings || defaultDohSettings());
  const built = buildHostResolverOptions(cfg);
  if (!built.ok) {
    // Fall back to off so a bad custom URL never leaves the resolver in a half state.
    return {
      ok: false,
      error: built.error,
      applied: configure({ secureDnsMode: 'off', secureDnsServers: [] }, { force: !!opts.force }),
      doh: cfg,
    };
  }
  return {
    ok: true,
    applied: configure(built.options, { force: !!opts.force }),
    doh: cfg,
  };
}

/**
 * Merge + validate + persist doh settings, then apply host resolver.
 * @param {unknown} partial
 * @param {{ getState: () => any, updateState: (fn: (s: any) => void) => void }} ctx
 */
function setDohSettings(partial, ctx) {
  const prev = normalizeDoh(ctx.getState().settings && ctx.getState().settings.doh);
  const merged = normalizeDoh({ ...prev, ...(partial && typeof partial === 'object' ? partial : {}) });
  const check = validateDohSettings(merged);
  if (!check.ok) {
    return { ok: false, error: check.error, doh: prev, state: null };
  }
  ctx.updateState((s) => {
    s.settings = { ...(s.settings || {}), doh: check.doh };
  });
  const applied = applyDohSettings(check.doh);
  return {
    ok: true,
    doh: check.doh,
    applied: applied.applied,
    options: check.options,
  };
}

function getSelftestCalls() {
  return selftestCalls.slice();
}

function clearSelftestCalls() {
  selftestCalls.length = 0;
}

module.exports = {
  PROVIDERS,
  defaultDohSettings,
  normalizeDoh,
  validateCustomUrl,
  validateDohSettings,
  buildHostResolverOptions,
  applyDohSettings,
  setDohSettings,
  configure,
  getSelftestCalls,
  clearSelftestCalls,
};
