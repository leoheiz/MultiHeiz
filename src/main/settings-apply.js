'use strict';

/**
 * Helpers for settings:update — diff, profiling, which side-effects to run.
 */

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function stableEqual(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Deep-diff of adblock settings so toggling `enabled` alone does not ship lists/cosmetic
 * (those would wrongly trigger a full engine rebuild).
 * @param {object} prevAb
 * @param {object} nextAb
 * @returns {object} only changed adblock keys
 */
function diffAdblockPartial(prevAb, nextAb) {
  const p = prevAb && typeof prevAb === 'object' ? prevAb : {};
  const n = nextAb && typeof nextAb === 'object' ? nextAb : {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(n)) {
    if (key === 'lists') {
      const pl = p.lists && typeof p.lists === 'object' ? p.lists : {};
      const nl = n.lists && typeof n.lists === 'object' ? n.lists : {};
      /** @type {Record<string, unknown>} */
      const listsOut = {};
      for (const id of new Set([...Object.keys(pl), ...Object.keys(nl)])) {
        if (!stableEqual(pl[id], nl[id])) listsOut[id] = nl[id];
      }
      if (Object.keys(listsOut).length) out.lists = listsOut;
      continue;
    }
    if (!stableEqual(p[key], n[key])) out[key] = n[key];
  }
  return out;
}

/**
 * Keys that require recompiling the adblock engine (parse lists).
 * `enabled` alone must NOT rebuild — only attach/detach sessions.
 */
const ADBLOCK_REBUILD_KEYS = new Set([
  'lists',
  'antiTracking',
  'cosmetic',
  'youtubeExperimental',
  'userRules',
  'customLists',
]);

/**
 * @param {object} adblockPartial  already deep-diffed adblock keys
 * @returns {boolean}
 */
function adblockPartialNeedsRebuild(adblockPartial) {
  const c = adblockPartial && typeof adblockPartial === 'object' ? adblockPartial : {};
  for (const k of Object.keys(c)) {
    if (ADBLOCK_REBUILD_KEYS.has(k)) return true;
  }
  return false;
}

/**
 * Strip unchanged keys from a settings partial vs previous settings.
 * Nested objects (doh, modules, extensions, languageTool, aiWrite) compared as wholes;
 * adblock is deep-diffed so enable/disable does not look like a lists change.
 * @param {object} prev
 * @param {object} nextPartial  candidate full-or-partial from UI
 * @returns {object} only changed keys
 */
function diffSettingsPartial(prev, nextPartial) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const n = nextPartial && typeof nextPartial === 'object' ? nextPartial : {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(n)) {
    if (key === 'adblock') {
      const d = diffAdblockPartial(p.adblock, n.adblock);
      if (Object.keys(d).length) out.adblock = d;
      continue;
    }
    if (
      key === 'doh' ||
      key === 'modules' ||
      key === 'extensions' ||
      key === 'languageTool' ||
      key === 'aiWrite'
    ) {
      if (!stableEqual(p[key], n[key])) out[key] = n[key];
      continue;
    }
    if (!stableEqual(p[key], n[key])) out[key] = n[key];
  }
  return out;
}

const PANEL_SYNC_KEYS = new Set([
  'keepBackgroundRunning',
  'suspendHidden',
  'suspendDelayMs',
  'backgroundThrottling',
  'backgroundFps',
  'backgroundPreset',
  'frameCapHidden',
  'frameCapAll',
]);

const UA_KEYS = new Set(['uaIdentity', 'preferHighPerfGpu']);

/**
 * @param {object} changedPartial  already-diffed keys being applied
 * @returns {{ needPanelSync: boolean, needUa: boolean, needAdblock: boolean, needDoh: boolean, needLanguageTool: boolean, needAiWrite: boolean }}
 */
function classifySettingsSideEffects(changedPartial) {
  const c = changedPartial && typeof changedPartial === 'object' ? changedPartial : {};
  let needPanelSync = false;
  let needUa = false;
  for (const k of Object.keys(c)) {
    if (PANEL_SYNC_KEYS.has(k)) needPanelSync = true;
    if (UA_KEYS.has(k)) needUa = true;
  }
  return {
    needPanelSync,
    needUa,
    needAdblock: !!(c.adblock && typeof c.adblock === 'object'),
    needDoh: !!(c.doh && typeof c.doh === 'object'),
    needLanguageTool: !!(c.languageTool && typeof c.languageTool === 'object'),
    needAiWrite: !!(c.aiWrite && typeof c.aiWrite === 'object'),
  };
}

function shouldProfileSettings() {
  return !!(
    process.env.MULTIHEIZ_PROFILE ||
    process.env.MULTIHEIZ_SELFTEST === 'settings-perf' ||
    process.env.MULTIHEIZ_SELFTEST === '1'
  );
}

/**
 * @returns {{ mark: (name: string) => void, finish: () => Record<string, number>, start: number }}
 */
function createSettingsProfile() {
  const start = performance.now();
  /** @type {Record<string, number>} */
  const marks = { start: 0 };
  return {
    start,
    mark(name) {
      marks[name] = performance.now() - start;
    },
    finish() {
      marks.total = performance.now() - start;
      return { ...marks };
    },
  };
}

module.exports = {
  stableEqual,
  diffSettingsPartial,
  diffAdblockPartial,
  adblockPartialNeedsRebuild,
  ADBLOCK_REBUILD_KEYS,
  classifySettingsSideEffects,
  shouldProfileSettings,
  createSettingsProfile,
  PANEL_SYNC_KEYS,
  UA_KEYS,
};
