'use strict';

/**
 * Built-in filter list catalog (remote URLs + licenses + UI groups).
 * Defaults chosen after measuring build time/memory (see docs/ADBLOCK-ENGINE.md).
 */

/** @typedef {'ads'|'privacy'|'malware'|'regional'|'fixes'|'custom'} ListGroup */

/**
 * @typedef {object} ListDef
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} license
 * @property {string} file
 * @property {ListGroup} group
 * @property {boolean} defaultOn
 * @property {string} [note]
 * @property {string} [vendor]
 */

/** @type {Record<string, ListDef>} */
const LISTS = {
  ublock_filters: {
    id: 'ublock_filters',
    name: 'uBlock filters',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    license: 'GPL-3.0+ (uBlock Origin / uAssets)',
    file: 'ublock-filters.txt',
    group: 'ads',
    defaultOn: true,
  },
  ublock_badware: {
    id: 'ublock_badware',
    name: 'uBlock badware',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
    license: 'GPL-3.0+ (uBlock Origin / uAssets)',
    file: 'ublock-badware.txt',
    group: 'malware',
    defaultOn: true,
  },
  ublock_privacy: {
    id: 'ublock_privacy',
    name: 'uBlock privacy',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
    license: 'GPL-3.0+ (uBlock Origin / uAssets)',
    file: 'ublock-privacy.txt',
    group: 'privacy',
    defaultOn: true,
  },
  ublock_quick_fixes: {
    id: 'ublock_quick_fixes',
    name: 'uBlock quick fixes',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt',
    license: 'GPL-3.0+ (uBlock Origin / uAssets)',
    file: 'ublock-quick-fixes.txt',
    group: 'fixes',
    defaultOn: true,
  },
  ublock_unbreak: {
    id: 'ublock_unbreak',
    name: 'uBlock unbreak',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt',
    license: 'GPL-3.0+ (uBlock Origin / uAssets)',
    file: 'ublock-unbreak.txt',
    group: 'fixes',
    defaultOn: true,
  },
  ublock_resource_abuse: {
    id: 'ublock_resource_abuse',
    name: 'uBlock resource abuse',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt',
    license: 'GPL-3.0+ (uBlock Origin / uAssets)',
    file: 'ublock-resource-abuse.txt',
    group: 'ads',
    defaultOn: true,
  },
  easylist: {
    id: 'easylist',
    name: 'EasyList',
    url: 'https://easylist.to/easylist/easylist.txt',
    license: 'GPL-3.0+ / CC BY-SA 3.0+ (EasyList authors)',
    file: 'easylist.txt',
    group: 'ads',
    defaultOn: true,
  },
  easyprivacy: {
    id: 'easyprivacy',
    name: 'EasyPrivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    license: 'GPL-3.0+ / CC BY-SA 3.0+ (EasyList authors)',
    file: 'easyprivacy.txt',
    group: 'privacy',
    defaultOn: true,
  },
  portuguese: {
    id: 'portuguese',
    name: 'EasyList Portuguese (Lista PT-BR)',
    url: 'https://easylist-downloads.adblockplus.org/easylistportuguese.txt',
    license: 'GPL-3.0+ / CC BY-SA 3.0+ (EasyList authors)',
    file: 'easylistportuguese.txt',
    group: 'regional',
    defaultOn: true,
  },
  peter_lowe: {
    id: 'peter_lowe',
    name: "Peter Lowe's Ad and tracking server list",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext',
    license: 'McAfee / Peter Lowe (see yoyo.org)',
    file: 'peter-lowe.txt',
    group: 'ads',
    defaultOn: true,
  },
  adguard_base: {
    id: 'adguard_base',
    name: 'AdGuard Base (sem EasyList)',
    url: 'https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt',
    license: 'GPL-3.0+ (AdGuard)',
    file: 'adguard-base-no-easylist.txt',
    group: 'ads',
    defaultOn: true,
    note: '~4 MB; variante leve sem duplicar EasyList',
  },
  adguard_tracking: {
    id: 'adguard_tracking',
    name: 'AdGuard Tracking Protection',
    url: 'https://filters.adtidy.org/extension/ublock/filters/3.txt',
    license: 'GPL-3.0+ (AdGuard)',
    file: 'adguard-tracking.txt',
    group: 'privacy',
    defaultOn: false,
    note: '~11 MB; opcional (memória/tempo de build)',
  },
  abu_ad: {
    id: 'abu_ad',
    name: 'AdBlocker Ultimate - Ultimate Ad Filter',
    url: 'https://filters.adavoid.org/ultimate-ad-filter.txt',
    license: 'GNU GPLv3 / CC BY 3.0 (AdAvoid Ltd.)',
    file: 'ultimate-ad-filter.txt',
    group: 'ads',
    defaultOn: false,
    vendor: 'AdBlocker Ultimate',
    note: '~6,1 MB; default OFF (+~183 MB RSS). YouTube uses MultiHeiz MIT scriptlets instead.',
  },
  abu_privacy: {
    id: 'abu_privacy',
    name: 'AdBlocker Ultimate - Ultimate Privacy Filter',
    url: 'https://filters.adavoid.org/ultimate-privacy-filter.txt',
    license: 'GNU GPLv3 / CC BY 3.0 (AdAvoid Ltd.)',
    file: 'ultimate-privacy-filter.txt',
    group: 'privacy',
    defaultOn: false,
    vendor: 'AdBlocker Ultimate',
    note: '~12 MB; pesada (memória/tempo de build)',
  },
  abu_security: {
    id: 'abu_security',
    name: 'AdBlocker Ultimate - Ultimate Security Filter',
    url: 'https://filters.adavoid.org/ultimate-security-filter.txt',
    license: 'MIT / CC0 1.0 (AdAvoid Ltd.)',
    file: 'ultimate-security-filter.txt',
    group: 'malware',
    defaultOn: false,
    vendor: 'AdBlocker Ultimate',
    note: '~160 KB',
  },
  abu_anticircumvention: {
    id: 'abu_anticircumvention',
    name: 'AdBlocker Ultimate - Anti-circumvention',
    url: 'https://filters.adavoid.org/filters/Anticircumvention.txt',
    license: 'GNU GPLv3 (AdAvoid Ltd.)',
    file: 'anticircumvention.txt',
    group: 'fixes',
    defaultOn: false,
    vendor: 'AdBlocker Ultimate',
    note: '~1,3 MB',
  },
  abu_spanish_portuguese: {
    id: 'abu_spanish_portuguese',
    name: 'AdBlocker Ultimate - EasyList Spanish (ES/PT)',
    url: 'https://filters.adavoid.org/filters/EasyListSpanish.txt',
    license: 'GNU GPLv3 / CC BY 3.0 (AdAvoid Ltd.)',
    file: 'easylistspanish.txt',
    group: 'regional',
    defaultOn: false,
    vendor: 'AdBlocker Ultimate',
    note: '~128 KB; regional ES/PT (sem lista PT dedicada no ABU)',
  },
};

const GROUP_LABELS = {
  ads: 'Anúncios',
  privacy: 'Privacidade',
  malware: 'Malware/badware',
  regional: 'Regional',
  fixes: 'Correções',
  custom: 'Personalizadas',
};

const RESOURCES_URL =
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';

const RESOURCES_FILE = 'resources.json';

/** Extra network rules when YouTube experimental is on (best-effort). */
const YOUTUBE_EXPERIMENTAL_FILTERS = `
! MultiHeiz YouTube experimental (partial)
||youtube.com/api/stats/ads^
||youtube.com/pagead/
||youtube.com/ptracking
||googlevideo.com/ptracking
||youtube.com/get_video_info?*adformat=
||youtube.com/get_midroll_
||doubleclick.net^$domain=youtube.com|youtu.be|youtube-nocookie.com
||googleads.g.doubleclick.net^$domain=youtube.com|youtu.be|youtube-nocookie.com
||youtube.com/youtubei/v1/player/ad_break^
/pagead/$domain=youtube.com|youtu.be|youtube-nocookie.com
/ptracking$domain=youtube.com|youtu.be|googlevideo.com
`.trim();

/**
 * Small MIT YouTube scriptlet/cosmetic set (written for MultiHeiz — not copied from
 * ABU/AdGuard/uBO). Applied when cosmetics are on so the built-in engine can strip
 * player ads without the ABU extension or the ~6 MB abu_ad list (+~183 MB RSS).
 * Domains: youtube.com (incl. www/m/music subdomains), youtube-nocookie, youtubekids.
 */
const YOUTUBE_BUILTIN_SCRIPTLETS = `
! MultiHeiz YouTube built-in (MIT)
youtube.com,youtube-nocookie.com,youtubekids.com##+js(set-constant, google_ad_status, 1)
youtube.com,youtube-nocookie.com,youtubekids.com##+js(set-constant, ytInitialPlayerResponse.adPlacements, undefined)
youtube.com,youtube-nocookie.com,youtubekids.com##+js(set-constant, ytInitialPlayerResponse.adSlots, undefined)
youtube.com,youtube-nocookie.com,youtubekids.com##+js(set-constant, ytInitialPlayerResponse.playerAds, undefined)
youtube.com,youtube-nocookie.com,youtubekids.com##+js(set-constant, playerResponse.adPlacements, undefined)
youtube.com,youtube-nocookie.com,youtubekids.com##+js(json-prune, playerResponse.adPlacements playerResponse.adSlots playerResponse.playerAds adPlacements playerAds adSlots)
youtube.com,youtube-nocookie.com,youtubekids.com##+js(json-prune-xhr-response, playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots, , /playlist\\?list=|\\/player(?!.*(get_drm_license))|\\/next|watch\\?[tv]=|get_watch\\?/)
youtube.com,youtube-nocookie.com,youtubekids.com##+js(json-prune-fetch-response, playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots, , /playlist\\?list=|player\\?|\\/next|watch\\?[tv]=/)
m.youtube.com,youtube-nocookie.com,youtubekids.com##+js(json-prune, playerResponse.adPlacements playerResponse.playerAds playerResponse.adSlots adPlacements playerAds adSlots)
www.youtube.com##+js(adjust-setTimeout, [native code], 17000, 0.001)
youtube.com,youtube-nocookie.com,youtubekids.com##+js(json-prune, entries.[-].command.reelWatchEndpoint.adClientParams.isAd)
www.youtube.com##+js(json-prune, contents.twoColumnBrowseResultsRenderer.tabs.[].tabRenderer.content.richGridRenderer.contents.[-].richItemRenderer.content.adSlotRenderer)
www.youtube.com##+js(json-prune, ytInitialData.contents.twoColumnBrowseResultsRenderer.tabs.[].tabRenderer.content.richGridRenderer.contents.[-].richItemRenderer.content.adSlotRenderer)
www.youtube.com##+js(set-constant, ytcfg.data_.EXPERIMENT_FLAGS.web_streaming_watch, false)
m.youtube.com##+js(json-prune-fetch-response, $..itemSectionRenderer.contents[?(@.adSlotRenderer)], , /get_watch)
m.youtube.com##+js(json-prune, playerResponse.messages.[].youThereRenderer)
youtube.com##ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)
youtube.com##.ytd-watch-flexy > .ytd-watch-next-secondary-results-renderer > ytd-ad-slot-renderer
youtube.com##.ytd-two-column-browse-results-renderer > ytd-rich-grid-renderer > #masthead-ad
youtube.com##.ytd-section-list-renderer > .ytd-item-section-renderer > ytd-search-pyv-renderer
m.youtube.com##lazy-list > ad-slot-renderer
m.youtube.com##ytm-rich-item-renderer > ad-slot-renderer
youtube-nocookie.com##.ytp-ad-progress-list
`.trim();

/**
 * Supplemental Google Search cosmetics (EasyList usually covers these; keep as
 * safety net + MutationObserver for dynamically inserted sponsored blocks).
 */
const GOOGLE_SEARCH_COSMETICS = `
! MultiHeiz Google Search cosmetics
google.*###tads
google.*###tadsb
google.*###bottomads
google.*##[data-text-ad]
google.*##div[aria-label="Anúncios"]
google.*##div[aria-label="Ads"]
google.*##div[aria-label="Sponsored"]
`.trim();

const UPDATE_INTERVAL_HOURS_OPTIONS = [6, 12, 24, 48];
const DEFAULT_UPDATE_INTERVAL_HOURS = 24;
const UPDATE_INTERVAL_MS = DEFAULT_UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;

function defaultListFlags() {
  /** @type {Record<string, boolean>} */
  const flags = {};
  for (const [id, def] of Object.entries(LISTS)) {
    flags[id] = !!def.defaultOn;
  }
  return flags;
}

/**
 * Count non-comment, non-empty filter lines (approx rule count).
 * @param {string} text
 */
function countFilterLines(text) {
  let n = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t.startsWith('[') || t.startsWith('# ')) continue;
    n += 1;
  }
  return n;
}

module.exports = {
  LISTS,
  GROUP_LABELS,
  RESOURCES_URL,
  RESOURCES_FILE,
  YOUTUBE_EXPERIMENTAL_FILTERS,
  YOUTUBE_BUILTIN_SCRIPTLETS,
  GOOGLE_SEARCH_COSMETICS,
  UPDATE_INTERVAL_HOURS_OPTIONS,
  DEFAULT_UPDATE_INTERVAL_HOURS,
  UPDATE_INTERVAL_MS,
  defaultListFlags,
  countFilterLines,
};
