'use strict';

/**
 * AdGuard-syntax preprocessing for AdBlocker Ultimate (ABU) filter lists.
 * Ghostery understands network + ## / #@# cosmetics + ##+js(...) scriptlets.
 * ABU ships #%#//scriptlet(...) and other AdGuard-only forms — convert or drop.
 *
 * Never executes raw #%# JavaScript.
 */

/** @type {typeof import('@adguard/agtree') | null} */
let agtreeMod = null;
let agtreeLoadAttempted = false;
let agtreeUnavailable = false;

/**
 * @returns {Promise<typeof import('@adguard/agtree') | null>}
 */
async function loadAgtree() {
  if (agtreeMod) return agtreeMod;
  if (agtreeUnavailable) return null;
  agtreeLoadAttempted = true;
  try {
    agtreeMod = await import('@adguard/agtree');
    return agtreeMod;
  } catch (err) {
    agtreeUnavailable = true;
    console.warn(
      '[adblock] @adguard/agtree import failed — ABU scriptlets will be skipped:',
      err && err.message ? err.message : err
    );
    return null;
  }
}

/** Reset lazy-load state (tests). */
function resetAgtreeCache() {
  agtreeMod = null;
  agtreeLoadAttempted = false;
  agtreeUnavailable = false;
}

/**
 * Empty stats bag.
 * @returns {{
 *   scriptletsConverted: number,
 *   scriptletsDropped: number,
 *   adguardOnlyDropped: number,
 *   linesIn: number,
 *   linesOut: number,
 *   agtreeAvailable: boolean,
 * }}
 */
function emptyStats() {
  return {
    scriptletsConverted: 0,
    scriptletsDropped: 0,
    adguardOnlyDropped: 0,
    linesIn: 0,
    linesOut: 0,
    agtreeAvailable: !agtreeUnavailable,
  };
}

/**
 * @param {object} a
 * @param {object} b
 */
function mergeStats(a, b) {
  if (!b) return a;
  a.scriptletsConverted += b.scriptletsConverted || 0;
  a.scriptletsDropped += b.scriptletsDropped || 0;
  a.adguardOnlyDropped += b.adguardOnlyDropped || 0;
  a.linesIn += b.linesIn || 0;
  a.linesOut += b.linesOut || 0;
  if (b.agtreeAvailable === false) a.agtreeAvailable = false;
  return a;
}

/**
 * Detect AdGuard-only line kinds that Ghostery cannot run safely.
 * @param {string} trimmed
 * @returns {'pass'|'scriptlet'|'drop'|null} null = empty/comment handled by caller
 */
function classifyAbuLine(trimmed) {
  if (!trimmed) return null;
  // Keep normal comments / headers; drop AdGuard preprocessor conditionals.
  if (trimmed.startsWith('!') || trimmed.startsWith('[')) {
    if (/^!#(?:if|else|endif|include|safari_cb_affinity)\b/i.test(trimmed)) {
      return 'drop';
    }
    return 'pass';
  }

  // Scriptlet (exception form #@%#//scriptlet also)
  if (trimmed.includes('#%#//scriptlet') || trimmed.includes('#@%#//scriptlet')) {
    return 'scriptlet';
  }

  // Raw JS injection — never execute
  if (trimmed.includes('#%#') || trimmed.includes('#@%#')) {
    return 'drop';
  }

  // CSS injection / extended CSS / HTML filtering
  if (
    trimmed.includes('#$#') ||
    trimmed.includes('#@$#') ||
    trimmed.includes('#$?#') ||
    trimmed.includes('#@$?#') ||
    trimmed.includes('#?#') ||
    trimmed.includes('#@?#') ||
    trimmed.includes('$$') ||
    trimmed.includes('$@$')
  ) {
    return 'drop';
  }

  // Network + ## / #@# cosmetics pass through
  return 'pass';
}

/**
 * Convert one AdGuard scriptlet line to uBO ##+js(...) via agtree.
 * @param {string} line
 * @param {typeof import('@adguard/agtree')} agtree
 * @returns {string[]} generated lines (may be empty on failure)
 */
function convertScriptletLine(line, agtree) {
  const { RuleParser, RuleConverter, RuleGenerator } = agtree;
  try {
    const node = RuleParser.parse(line);
    const converted = RuleConverter.convertToUbo(node);
    const results = converted && Array.isArray(converted.result) ? converted.result : [];
    const out = [];
    for (const r of results) {
      try {
        const gen = RuleGenerator.generate(r);
        if (gen && String(gen).trim()) out.push(String(gen).trim());
      } catch {
        /* drop this variant */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Preprocess ABU (AdGuard-syntax) filter list text for Ghostery.
 * @param {string} text
 * @param {{ forceAgtree?: boolean }} [opts] forceAgtree=false skips import (tests)
 * @returns {Promise<{ text: string, stats: ReturnType<typeof emptyStats> }>}
 */
async function preprocessAbuList(text, opts = {}) {
  const stats = emptyStats();
  const lines = String(text || '').split(/\r?\n/);
  stats.linesIn = lines.length;

  let agtree = null;
  const needsScriptlets = lines.some((l) => {
    const t = l.trim();
    return t.includes('#%#//scriptlet') || t.includes('#@%#//scriptlet');
  });
  if (needsScriptlets && opts.forceAgtree !== false) {
    agtree = await loadAgtree();
  }
  // Unavailable only when scriptlets were needed and import/load failed.
  stats.agtreeAvailable = needsScriptlets ? !!agtree : !agtreeUnavailable;

  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const kind = classifyAbuLine(trimmed);
    if (kind === null) {
      out.push(line);
      continue;
    }
    if (kind === 'pass') {
      out.push(line);
      continue;
    }
    if (kind === 'drop') {
      stats.adguardOnlyDropped += 1;
      continue;
    }
    if (kind === 'scriptlet') {
      if (!agtree) {
        stats.scriptletsDropped += 1;
        continue;
      }
      const converted = convertScriptletLine(trimmed, agtree);
      if (converted.length) {
        for (const c of converted) out.push(c);
        stats.scriptletsConverted += 1;
      } else {
        stats.scriptletsDropped += 1;
      }
      continue;
    }
  }

  stats.linesOut = out.length;
  return { text: out.join('\n'), stats };
}

/**
 * Whether a catalog entry should go through ABU preprocessing.
 * @param {{ vendor?: string } | null | undefined} def
 */
function shouldPreprocessList(def) {
  return !!(def && def.vendor === 'AdBlocker Ultimate');
}

module.exports = {
  preprocessAbuList,
  shouldPreprocessList,
  classifyAbuLine,
  convertScriptletLine,
  loadAgtree,
  resetAgtreeCache,
  emptyStats,
  mergeStats,
  getAgtreeLoadState: () => ({
    loaded: !!agtreeMod,
    attempted: agtreeLoadAttempted,
    unavailable: agtreeUnavailable,
  }),
};
