'use strict';

/**
 * Diagnóstico com um clique: relatório sanitizado (.txt) + issue no GitHub (só versão/OS).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, dialog, BrowserWindow, shell } = require('electron');
const logger = require('./logger');
const diagLog = require('./diag-log');
const { getState } = require('./state');

const GITHUB_ISSUES_NEW = 'https://github.com/leoheiz/MultiHeiz/issues/new';

/** Filter-list / update hosts whose scheme+host may be kept (path stripped). */
const KNOWN_FILTER_HOSTS = new Set([
  'easylist.to',
  'easylist-downloads.adblockplus.org',
  'filters.adtidy.org',
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
  'ublockorigin.github.io',
  'pgl.yoyo.org',
  'malware-filter.gitlab.io',
  'secure.fanboy.co.nz',
  'gitlab.com',
  'github.com',
  'api.github.com',
]);

function stripQuery(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return String(url || '').split('?')[0];
  }
}

function sanitizeState(state) {
  const s = JSON.parse(JSON.stringify(state || {}));
  delete s._cookies;
  if (Array.isArray(s.accounts)) {
    for (const a of s.accounts) {
      if (a.lastUrl) a.lastUrl = stripQuery(a.lastUrl);
      if (a.startUrl) a.startUrl = stripQuery(a.startUrl);
      delete a.cookies;
      delete a.cookie;
      delete a.proxyPassword;
      if (a.proxy && typeof a.proxy === 'object') {
        delete a.proxy.password;
        delete a.proxy.passwordEnc;
        a.proxy.passwordSaved = false;
      }
    }
  }
  if (s.settings && s.settings.aiWrite && typeof s.settings.aiWrite === 'object') {
    delete s.settings.aiWrite.apiKeyEnc;
    delete s.settings.aiWrite.apiKey;
    s.settings.aiWrite.apiKeySaved = false;
  }
  return s;
}

/**
 * Username for path redaction (never log the raw name elsewhere).
 */
function currentUsername() {
  try {
    return os.userInfo().username || process.env.USERNAME || process.env.USER || '';
  } catch {
    return process.env.USERNAME || process.env.USER || '';
  }
}

/**
 * Sanitize free text for diagnostic export (no personal data).
 * @param {string} text
 * @param {{ username?: string, homedir?: string }} [opts]
 */
function sanitizeText(text, opts = {}) {
  let out = String(text || '');
  const username = opts.username != null ? opts.username : currentUsername();
  const homedir = opts.homedir != null ? opts.homedir : os.homedir();

  // URLs: keep scheme+host only for known filter hosts; else <url>
  out = out.replace(/\b((?:https?|wss?):\/\/[^\s"'<>]+)/gi, (full) => {
    try {
      const u = new URL(full);
      const host = u.hostname.toLowerCase();
      if (KNOWN_FILTER_HOSTS.has(host) || [...KNOWN_FILTER_HOSTS].some((h) => host.endsWith('.' + h))) {
        return u.protocol + '//' + u.host;
      }
    } catch {
      /* fall through */
    }
    return '<url>';
  });

  // Emails
  out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<email>');

  // JWT / long base64 / long hex tokens
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<token>');
  out = out.replace(/\b(?:sk-|sk_|ghp_|github_pat_)[A-Za-z0-9_-]{16,}\b/g, '<token>');
  out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '<token>');
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '<token>');

  // Home / username paths (current user + generic Users/home patterns)
  if (homedir) {
    const esc = homedir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(esc, 'gi'), process.platform === 'win32' ? '%USERPROFILE%' : '~');
    const forward = homedir.replace(/\\/g, '/');
    if (forward !== homedir) {
      const esc2 = forward.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(esc2, 'gi'), process.platform === 'win32' ? '%USERPROFILE%' : '~');
    }
  }
  // C:\Users\<name>\... (also JSON-escaped \\) or /home/<name>/...
  out = out.replace(/([A-Za-z]:)(?:\\|\/|\\\\)+Users(?:\\|\/|\\\\)+[^\\/\s"'<>]+/gi, '$1\\Users\\<user>');
  out = out.replace(/Users(?:\\|\/|\\\\)+[^\\/\s"'<>]+/gi, 'Users\\<user>');
  out = out.replace(/\/home\/[^/\s"'<>]+/g, '/home/<user>');
  out = out.replace(/\/Users\/[^/\s"'<>]+/g, '/Users/<user>');
  if (username && username.length >= 2) {
    const escU = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('\\b' + escU + '\\b', 'g'), '<user>');
  }

  return out;
}

/**
 * Settings flags: names + booleans/enums only (no URLs, secrets, free text).
 * @param {object} settings
 */
function settingsFlagsOnly(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const out = {};

  const SECRET_KEY_RE =
    /password|passwd|secret|token|apiKey|apikey|credential|cookie|authorization|proxyPass/i;

  const takeBoolEnum = (obj, prefix) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEY_RE.test(k)) continue;
      const key = prefix ? prefix + '.' + k : k;
      if (typeof v === 'boolean' || typeof v === 'number') {
        out[key] = v;
      } else if (typeof v === 'string') {
        // enums / short tokens only — skip URLs, secrets, free text
        if (/^https?:\/\//i.test(v) || v.length > 64) continue;
        if (/^(sk-|sk_|ghp_|github_pat_)/i.test(v)) continue;
        if (/^[a-z0-9_.:-]{1,64}$/i.test(v)) out[key] = v;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        // nested: adblock.lists -> only enabled map as bools; skip allowlist URLs
        if (k === 'lists' && prefix === 'adblock') {
          for (const [lk, lv] of Object.entries(v)) {
            if (typeof lv === 'boolean') out['adblock.lists.' + lk] = lv;
          }
        } else if (
          k === 'modules' ||
          k === 'doh' ||
          k === 'languageTool' ||
          k === 'aiWrite' ||
          k === 'extensions' ||
          k === 'adblock'
        ) {
          takeBoolEnum(v, key);
        } else if (k === 'migrations') {
          takeBoolEnum(v, key);
        }
      }
    }
  };

  takeBoolEnum(s, '');
  // Never include these even if short
  delete out['doh.customUrl'];
  delete out['languageTool.serverUrl'];
  delete out['aiWrite.baseUrl'];
  delete out['aiWrite.apiKey'];
  delete out['aiWrite.apiKeyEnc'];
  delete out.homepage;
  delete out.searchTemplate;
  return out;
}

/**
 * Panel counts by catalogId (or custom).
 * @param {Array<{catalogId?: string}>} accounts
 */
function panelCountsByType(accounts) {
  const counts = {};
  for (const a of accounts || []) {
    const t = (a && a.catalogId) || 'custom';
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

/**
 * Adblock list status: names, rule counts, last update (no list URLs).
 */
function adblockListSummary(adblockMod) {
  try {
    const st = adblockMod.getStatus ? adblockMod.getStatus() : adblockMod.getDiagnostics();
    const lists = [];
    const catalog = (st && st.catalog) || [];
    for (const c of catalog) {
      lists.push({
        id: c.id,
        name: c.name,
        enabled: !!c.enabled,
        ruleCount: c.ruleCount || 0,
        lastUpdateAt: c.lastUpdateAt || null,
        status: c.status || null,
      });
    }
    return {
      enabled: !!(st && st.enabled),
      ready: !!(st && st.ready),
      networkFilterCount: (st && st.networkFilterCount) || 0,
      cosmeticFilterCount: (st && st.cosmeticFilterCount) || 0,
      lastUpdateAt: (st && st.lastUpdateAt) || null,
      lists,
    };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
}

/**
 * Build full diagnostic report text (already sanitized).
 * @param {object} [extra]
 */
function buildDiagnosticReport(extra = {}) {
  const state = getState();
  const settings = (state && state.settings) || {};
  let gpu = {};
  try {
    gpu = app.getGPUFeatureStatus ? app.getGPUFeatureStatus() : {};
  } catch {
    gpu = { error: 'unavailable' };
  }

  let adblock = {};
  try {
    const ab = require('./adblock');
    adblock = adblockListSummary(ab);
  } catch (err) {
    adblock = { error: (err && err.message) || String(err) };
  }

  const modules = settings.modules || {};
  const enabledModules = Object.entries(modules)
    .filter(([, v]) => v !== false)
    .map(([k]) => k);

  const locale = (() => {
    try {
      return app.getLocale ? app.getLocale() : Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      return 'unknown';
    }
  })();

  const recentErrors = diagLog.readRecent(60);
  // Also fold logger error lines
  let loggerErrs = [];
  try {
    loggerErrs = logger
      .readRecent(100)
      .filter((l) => /"level"\s*:\s*"error"|"level":"error"/i.test(l))
      .slice(-40);
  } catch {
    loggerErrs = [];
  }

  const sections = [];
  sections.push('=== MultiHeiz diagnóstico ===');
  sections.push('exportedAt: ' + new Date().toISOString());
  sections.push('');
  sections.push('## Versão');
  sections.push('app: ' + app.getVersion());
  sections.push('electron: ' + process.versions.electron);
  sections.push('chromium: ' + process.versions.chrome);
  sections.push('node: ' + process.versions.node);
  sections.push('');
  sections.push('## Sistema');
  sections.push('platform: ' + process.platform);
  sections.push('arch: ' + process.arch);
  sections.push('os: ' + os.type() + ' ' + os.release());
  sections.push('locale: ' + locale);
  sections.push('');
  sections.push('## GPU (getGPUFeatureStatus)');
  sections.push(JSON.stringify(gpu, null, 2));
  sections.push('');
  sections.push('## Settings (flags)');
  sections.push(JSON.stringify(settingsFlagsOnly(settings), null, 2));
  sections.push('');
  sections.push('## Módulos habilitados');
  sections.push(enabledModules.join(', ') || '(nenhum)');
  sections.push('');
  sections.push('## Painéis por tipo');
  sections.push(JSON.stringify(panelCountsByType(state.accounts || []), null, 2));
  sections.push('');
  sections.push('## Crash count');
  sections.push(String(diagLog.getCrashCount()));
  sections.push('');
  sections.push('## Adblock');
  sections.push(JSON.stringify(adblock, null, 2));
  sections.push('');
  sections.push('## Erros recentes (diag-log)');
  sections.push(recentErrors.length ? recentErrors.join('\n') : '(vazio)');
  sections.push('');
  sections.push('## Erros recentes (logger)');
  sections.push(loggerErrs.length ? loggerErrs.join('\n') : '(vazio)');
  if (extra && Object.keys(extra).length) {
    sections.push('');
    sections.push('## Extra');
    sections.push(JSON.stringify(extra, null, 2));
  }

  const raw = sections.join('\n') + '\n';
  return sanitizeText(raw);
}

/**
 * GitHub new-issue URL with title/body containing only version + OS (never report body).
 */
function buildGithubIssueUrl(opts = {}) {
  const version = opts.version != null ? opts.version : app.getVersion();
  const platform = opts.platform != null ? opts.platform : process.platform;
  const arch = opts.arch != null ? opts.arch : process.arch;
  const release = opts.release != null ? opts.release : os.release();
  const title = `Diagnóstico MultiHeiz ${version} (${platform})`;
  const body =
    `**Versão:** ${version}\n**SO:** ${platform} ${arch} (${release})\n\n` +
    `<!-- Descreva o problema. Não cole o relatório completo se contiver dados sensíveis. -->\n`;
  const url =
    GITHUB_ISSUES_NEW +
    '?title=' +
    encodeURIComponent(title) +
    '&body=' +
    encodeURIComponent(body);
  return url;
}

function openGithubIssue() {
  const url = buildGithubIssueUrl();
  if (process.env.MULTIHEIZ_SELFTEST) {
    return { ok: true, stubbed: true, url };
  }
  shell.openExternal(url);
  return { ok: true, url };
}

function openDataFolder() {
  return shell.openPath(app.getPath('userData'));
}

/**
 * Save report. Real app → save dialog; selftest → MULTIHEIZ_DIAG_OUT or fixed temp path.
 * @param {import('electron').BrowserWindow|null} mainWindow
 * @param {object} [extra]
 */
async function exportDiagnostics(mainWindow, extra = {}) {
  const report = buildDiagnosticReport(extra);
  const defaultName = `multiheiz-diag-${app.getVersion()}.txt`;

  let dest = null;
  if (process.env.MULTIHEIZ_SELFTEST) {
    dest =
      process.env.MULTIHEIZ_DIAG_OUT ||
      path.join(app.getPath('temp'), defaultName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, report, 'utf8');
    return { ok: true, path: dest, preview: report, selftest: true };
  }

  const win = mainWindow || BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(win || undefined, {
    title: 'Salvar diagnóstico',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    buttonLabel: 'Salvar',
    filters: [
      { name: 'Texto', extensions: ['txt'] },
      { name: 'Todos', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true, preview: report };

  dest = result.filePath;
  fs.writeFileSync(dest, report, 'utf8');
  return { ok: true, path: dest, preview: report };
}

/**
 * Preview only (no dialog).
 */
function previewDiagnostics(extra = {}) {
  const preview = buildDiagnosticReport(extra);
  return { ok: true, preview };
}

module.exports = {
  stripQuery,
  sanitizeState,
  sanitizeText,
  settingsFlagsOnly,
  panelCountsByType,
  adblockListSummary,
  buildDiagnosticReport,
  buildGithubIssueUrl,
  openGithubIssue,
  openDataFolder,
  exportDiagnostics,
  previewDiagnostics,
  GITHUB_ISSUES_NEW,
  KNOWN_FILTER_HOSTS,
};
