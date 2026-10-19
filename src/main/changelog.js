'use strict';

/**
 * Novidades / changelog (v1.8 B9) + detecção de relógio desalinhado via HTTP Date.
 */

const fs = require('node:fs');
const path = require('node:path');

const SKEW_MS = 5 * 60 * 1000;
const TAGS = new Set(['Novo', 'Melhoria', 'Correção']);

/** @type {{ versions: Array<{ version: string, date?: string, entries: Array<{ tag: string, text: string }> }> } | null} */
let cached = null;

/** @type {{ skewed: boolean, skewMs: number, httpDate: string|null, checkedAt: number|null }} */
let clockState = {
  skewed: false,
  skewMs: 0,
  httpDate: null,
  checkedAt: null,
};

/** @type {((payload: object) => void) | null} */
let emitFn = null;

function changelogPath() {
  return path.join(__dirname, '..', 'changelog.json');
}

function loadChangelog() {
  if (cached) return cached;
  const raw = fs.readFileSync(changelogPath(), 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.versions)) {
    cached = { versions: [] };
    return cached;
  }
  cached = data;
  return cached;
}

function reloadChangelogForTest() {
  cached = null;
  return loadChangelog();
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b
 */
function compareSemver(a, b) {
  const pa = String(a || '0.0.0')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b || '0.0.0')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  const aa = pa ? [Number(pa[1]), Number(pa[2]), Number(pa[3])] : [0, 0, 0];
  const bb = pb ? [Number(pb[1]), Number(pb[2]), Number(pb[3])] : [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return 0;
}

/**
 * Show Novidades once after an update (last seen version differs from current).
 * @param {string|null|undefined} lastSeen
 * @param {string} currentVersion
 */
function shouldShowNovidades(lastSeen, currentVersion) {
  const cur = String(currentVersion || '').trim();
  if (!cur) return false;
  const seen = lastSeen == null || lastSeen === '' ? null : String(lastSeen).trim();
  if (!seen) return true;
  return compareSemver(seen, cur) !== 0;
}

/**
 * @param {string} version
 * @param {(fn: (s: any) => void) => void} updateState
 */
function markChangelogSeen(version, updateState) {
  const v = String(version || '').trim();
  if (!v || typeof updateState !== 'function') return false;
  updateState((s) => {
    if (!s.ui || typeof s.ui !== 'object') s.ui = {};
    s.ui.lastSeenChangelogVersion = v;
  });
  return true;
}

function getLastSeen(getState) {
  try {
    const st = typeof getState === 'function' ? getState() : null;
    const v = st && st.ui && st.ui.lastSeenChangelogVersion;
    return v == null || v === '' ? null : String(v);
  } catch {
    return null;
  }
}

/**
 * Validate structure used by selftest.
 */
function validateChangelog(data) {
  const d = data || loadChangelog();
  const versions = (d && d.versions) || [];
  const semvers = versions.map((v) => String(v.version || ''));
  const need = ['1.0.0', '1.0.1'];
  const missing = need.filter((v) => !semvers.includes(v));
  let badTag = null;
  let entryCount = 0;
  for (const ver of versions) {
    if (!Array.isArray(ver.entries)) continue;
    for (const e of ver.entries) {
      entryCount += 1;
      if (!TAGS.has(String(e.tag || ''))) {
        badTag = e.tag;
        break;
      }
      if (!e.text || typeof e.text !== 'string') {
        badTag = '(empty text)';
        break;
      }
    }
    if (badTag) break;
  }
  return {
    ok: missing.length === 0 && !badTag && entryCount > 0,
    missing,
    badTag,
    entryCount,
    versionCount: versions.length,
  };
}

/**
 * @param {string} dateHeaderValue HTTP Date header
 * @returns {{ skewed: boolean, skewMs: number }}
 */
function noteHttpDate(dateHeaderValue) {
  const raw = String(dateHeaderValue || '').trim();
  if (!raw) return { skewed: clockState.skewed, skewMs: clockState.skewMs };
  const remote = Date.parse(raw);
  if (!Number.isFinite(remote)) {
    return { skewed: clockState.skewed, skewMs: clockState.skewMs };
  }
  const skewMs = Date.now() - remote;
  const skewed = Math.abs(skewMs) > SKEW_MS;
  const was = clockState.skewed;
  clockState = {
    skewed,
    skewMs,
    httpDate: raw,
    checkedAt: Date.now(),
  };
  if (skewed && !was && typeof emitFn === 'function') {
    emitFn({
      type: 'clock:skew',
      skewed: true,
      skewMs,
      message:
        'Relógio do sistema incorreto — logins e certificados podem falhar',
    });
  } else if (!skewed && was && typeof emitFn === 'function') {
    emitFn({ type: 'clock:skew', skewed: false, skewMs: 0 });
  }
  return { skewed, skewMs };
}

function getClockSkew() {
  return { ...clockState };
}

function resetClockSkewForTest() {
  clockState = {
    skewed: false,
    skewMs: 0,
    httpDate: null,
    checkedAt: null,
  };
}

function setEmit(fn) {
  emitFn = typeof fn === 'function' ? fn : null;
}

function maybeEmitNovidades(opts) {
  const {
    getState,
    appVersion,
    emit,
    force = false,
  } = opts || {};
  const current = String(appVersion || '').trim();
  const lastSeen = getLastSeen(getState);
  if (!force && !shouldShowNovidades(lastSeen, current)) return false;
  if (typeof emit === 'function') {
    emit({
      type: 'ui:novidades',
      reason: force ? 'manual' : 'update',
      version: current,
      lastSeen,
      auto: !force,
    });
  }
  return true;
}

module.exports = {
  SKEW_MS,
  TAGS,
  loadChangelog,
  reloadChangelogForTest,
  compareSemver,
  shouldShowNovidades,
  markChangelogSeen,
  getLastSeen,
  validateChangelog,
  noteHttpDate,
  getClockSkew,
  resetClockSkewForTest,
  setEmit,
  maybeEmitNovidades,
  changelogPath,
};
