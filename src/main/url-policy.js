'use strict';

/**
 * URL / scheme policy for panel navigation and window.open.
 * classifyScheme => 'web' | 'external' | 'blocked'
 */

const EXTERNAL_SCHEMES = new Set([
  'mailto',
  'tel',
  'sms',
  'smsto',
  'mms',
  'mmsto',
  'magnet',
  'callto',
  'facetime',
  'facetime-audio',
  'geo',
  'maps',
  'webcal',
  'news',
  'feed',
  'steam',
  'spotify',
  'zoommtg',
  'zoomus',
  'slack',
  'discord',
  'tg',
  'telegram',
  'whatsapp',
  'viber',
  'skype',
  'market',
  'intent',
  'itms',
  'itms-apps',
  'ms-windows-store',
  'ms-settings',
  'outlook',
]);

/**
 * Known identity providers. Match by parsed URL (https + hostname + pathname).
 * Generic hosts require expected path prefixes/patterns.
 * @type {Array<{
 *   hosts?: string[],
 *   hostSuffixes?: string[],
 *   pathPrefixes?: string[],
 *   pathPatterns?: RegExp[],
 * }>}
 */
const IDP_RULES = [
  { hosts: ['accounts.google.com'] },
  {
    hosts: ['www.google.com', 'google.com'],
    pathPrefixes: ['/o/oauth2', '/accounts/oauth'],
    pathPatterns: [/^\/signin/i, /^\/ServiceLogin/i],
  },
  {
    hostSuffixes: ['.google.com'],
    pathPrefixes: ['/o/oauth2', '/signin', '/ServiceLogin'],
  },
  { hosts: ['login.microsoftonline.com', 'login.live.com', 'login.microsoft.com'] },
  { hosts: ['appleid.apple.com'] },
  { hosts: ['github.com'], pathPrefixes: ['/login/oauth'] },
  {
    hosts: ['www.facebook.com', 'facebook.com', 'm.facebook.com'],
    pathPrefixes: ['/dialog/oauth'],
    pathPatterns: [/^\/v\d+(?:\.\d+)?\/dialog\/oauth/i],
  },
  { hosts: ['api.twitter.com'], pathPrefixes: ['/oauth'] },
  { hosts: ['x.com', 'twitter.com'], pathPrefixes: ['/i/oauth2', '/oauth'] },
  { hosts: ['discord.com', 'discordapp.com'], pathPrefixes: ['/oauth2'] },
  { hosts: ['id.twitch.tv'] },
  { hosts: ['accounts.spotify.com'] },
  { hosts: ['login.yahoo.com'] },
  { hosts: ['auth0.com'], hostSuffixes: ['.auth0.com'] },
  { hosts: ['okta.com'], hostSuffixes: ['.okta.com'] },
  { hosts: ['login.salesforce.com'] },
  { hosts: ['slack.com', 'www.slack.com'], pathPrefixes: ['/oauth'] },
  { hosts: ['oauth.telegram.org'] },
  { hosts: ['account.battle.net'] },
  { hosts: ['auth.riotgames.com'] },
];

/**
 * @param {string} url
 * @returns {URL|null}
 */
function parseUrl(url) {
  try {
    return new URL(String(url || ''));
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAboutBlank(url) {
  const s = String(url || '').trim().toLowerCase();
  // GIS often window.open('') then navigates the blank popup.
  return !s || s === 'about:blank' || s === 'about:blank/';
}

/**
 * data: startUrl is only for internal selftest probes, never for user-typed URLs.
 * @returns {boolean}
 */
function allowInternalDataUrls() {
  return !!process.env.MULTIHEIZ_SELFTEST;
}

/**
 * Only http(s) (and about:blank when needed internally) may load in a panel.
 * Optional allowData: trusted internal loads (selftest probe startUrl) — never from window.open
 * and never for startUrl digitado pelo usuário fora de MULTIHEIZ_SELFTEST.
 * @param {string} url
 * @param {{ allowData?: boolean }} [opts]
 * @returns {boolean}
 */
function isNavigableUrl(url, opts = {}) {
  if (isAboutBlank(url)) return true;
  const u = parseUrl(url);
  if (!u) return false;
  if (u.protocol === 'http:' || u.protocol === 'https:') return true;
  if (opts.allowData && u.protocol === 'data:') return true;
  return false;
}

/**
 * view-source: of an http(s) page — allowed for "Ver código-fonte" (detached window).
 * Still classified blocked / not navigable for address-bar / open-in-new-panel policy.
 * @param {string} url
 * @returns {boolean}
 */
function isViewSourceOfHttpUrl(url) {
  const s = String(url || '');
  if (!/^view-source:/i.test(s)) return false;
  const inner = s.replace(/^view-source:/i, '');
  return isNavigableUrl(inner);
}

/**
 * Selftests catalog/badges: não acessar a internet real — só loopback / data / about:blank.
 * @returns {boolean}
 */
function isSelftestOfflineMode() {
  const m = String(process.env.MULTIHEIZ_SELFTEST || '');
  return m === 'catalog' || m === 'badges';
}

/**
 * URL permitida quando isSelftestOfflineMode().
 * @param {string} url
 * @returns {boolean}
 */
function isSelftestAllowedUrl(url) {
  if (isAboutBlank(url)) return true;
  const u = parseUrl(url);
  if (!u) return false;
  if (u.protocol === 'data:') return allowInternalDataUrls();
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = String(u.hostname || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
}

/**
 * Host permitido para URL inicial digitada pelo usuário.
 * Exige TLD (ex.: exemplo.com); rejeita "www" / "https://www".
 * Exceções: localhost e IP (v4/v6).
 * @param {string} hostname
 * @returns {boolean}
 */
function isValidUserStartHost(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!h) return false;
  if (h === 'localhost') return true;
  // IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const parts = h.split('.').map((n) => Number(n));
    return parts.every((n) => n >= 0 && n <= 255);
  }
  // IPv6 (URL.hostname sem colchetes)
  if (h.includes(':')) {
    return /^[0-9a-f:]+$/i.test(h);
  }
  // Domínio com pelo menos um ponto e TLD alfabético (≥2)
  if (!h.includes('.')) return false;
  const labels = h.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)) return false;
  }
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/i.test(tld)) return false;
  return true;
}

/**
 * Normaliza e valida URL inicial (site personalizado / editar URL).
 * Aceita exemplo.com, www.exemplo.com/x, https://…, http://… (url-policy).
 * @param {string} raw
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
/**
 * Detecta scheme real vs host:porta (ex.: exemplo.test:8080/abc).
 * @param {string} s
 * @returns {boolean}
 */
function hasExplicitUrlScheme(s) {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(String(s || ''));
  if (!m) return false;
  // Dígito após ':' → porta, não scheme (exemplo.test:8080)
  if (/^\d/.test(m[2])) return false;
  return true;
}

function validateAndNormalizeStartUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || /\s/.test(s)) {
    return { ok: false, error: 'Endereço inválido' };
  }
  // data: só em selftest interno — nunca de digitação do usuário neste caminho
  if (/^data:/i.test(s) || /^javascript:/i.test(s) || /^file:/i.test(s)) {
    return { ok: false, error: 'Endereço inválido' };
  }
  let candidate = s;
  if (!hasExplicitUrlScheme(s)) {
    candidate = 'https://' + s;
  }
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, error: 'Endereço inválido' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Endereço inválido' };
  }
  if (!isValidUserStartHost(u.hostname)) {
    return { ok: false, error: 'Endereço inválido' };
  }
  return { ok: true, url: u.href };
}

/**
 * Sanitize account startUrl / homepage from UI: http(s) or bare host; block file/data/javascript/…
 * Em selftest, data: continua permitido para probes.
 * @param {string} url
 * @param {string} [fallback]
 * @returns {string}
 */
function sanitizeUserStartUrl(url, fallback = 'https://www.google.com') {
  const raw = String(url || '').trim();
  if (!raw) return fallback;
  if (allowInternalDataUrls() && /^data:/i.test(raw) && isNavigableUrl(raw, { allowData: true })) {
    return raw;
  }
  const validated = validateAndNormalizeStartUrl(raw);
  if (validated.ok) return validated.url;
  return fallback;
}

/**
 * @param {string} url
 * @returns {'web'|'external'|'blocked'}
 */
function classifyScheme(url) {
  if (isAboutBlank(url)) return 'web';
  const u = parseUrl(url);
  if (!u) return 'blocked';
  const scheme = String(u.protocol || '')
    .replace(/:$/, '')
    .toLowerCase();
  if (scheme === 'http' || scheme === 'https') return 'web';
  if (EXTERNAL_SCHEMES.has(scheme)) return 'external';
  return 'blocked';
}

/**
 * @param {string} hostname
 * @param {string} expected
 */
function hostEquals(hostname, expected) {
  return String(hostname || '').toLowerCase() === String(expected || '').toLowerCase();
}

/**
 * Suffix match with leading-dot semantics: foo.auth0.com matches .auth0.com; auth0.com does not.
 * @param {string} hostname
 * @param {string} suffix  e.g. ".auth0.com"
 */
function hostHasSuffix(hostname, suffix) {
  const h = String(hostname || '').toLowerCase();
  const s = String(suffix || '').toLowerCase();
  if (!s.startsWith('.')) return false;
  return h.endsWith(s) && h.length > s.length;
}

/**
 * @param {string} pathname
 * @param {{ pathPrefixes?: string[], pathPatterns?: RegExp[] }} rule
 */
function pathMatches(pathname, rule) {
  const p = String(pathname || '') || '/';
  const prefixes = rule.pathPrefixes || [];
  const patterns = rule.pathPatterns || [];
  if (!prefixes.length && !patterns.length) return true;
  for (const pref of prefixes) {
    if (p === pref || p.startsWith(pref + '/') || p.startsWith(pref + '?')) return true;
    if (p.startsWith(pref)) return true;
  }
  for (const re of patterns) {
    if (re.test(p)) return true;
  }
  return false;
}

/**
 * Strict IdP allowlist (replaces broad /oauth heuristics).
 * @param {string} url
 * @returns {boolean}
 */
function isKnownIdentityProviderUrl(url) {
  const u = parseUrl(url);
  if (!u) return false;
  if (u.protocol !== 'https:') return false;
  const hostname = u.hostname.toLowerCase();
  const pathname = u.pathname || '/';

  for (const rule of IDP_RULES) {
    let hostOk = false;
    for (const h of rule.hosts || []) {
      if (hostEquals(hostname, h)) {
        hostOk = true;
        break;
      }
    }
    if (!hostOk) {
      for (const suf of rule.hostSuffixes || []) {
        if (hostHasSuffix(hostname, suf) || hostEquals(hostname, suf.replace(/^\./, ''))) {
          hostOk = true;
          break;
        }
      }
    }
    if (!hostOk) continue;
    if (pathMatches(pathname, rule)) return true;
  }
  return false;
}

module.exports = {
  classifyScheme,
  isNavigableUrl,
  isViewSourceOfHttpUrl,
  allowInternalDataUrls,
  sanitizeUserStartUrl,
  validateAndNormalizeStartUrl,
  isValidUserStartHost,
  isKnownIdentityProviderUrl,
  isAboutBlank,
  isSelftestOfflineMode,
  isSelftestAllowedUrl,
  EXTERNAL_SCHEMES,
  IDP_RULES,
};
