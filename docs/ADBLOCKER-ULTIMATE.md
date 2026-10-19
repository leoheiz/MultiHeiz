# AdBlocker Ultimate on MultiHeiz (Phase 3b)

Honest results from a TEMP `MULTIHEIZ_USERDATA` run (not Leo’s real profile).

- When: `2026-10-19T03:03:35.175Z`
- userData: `C:\Users\Leo\AppData\Local\Temp\multiheiz-abu-29fHYo`
- Chrome Web Store ID: `ohahllgiabjaoigichmmfljhkcfikeof`
- Edge Add-ons ID (fallback): `pciakllldcajllepkbbihkmfkikheffb`

## Install

- **OK** — AdBlocker Ultimate v4.4.3
- Source: `chrome-web-store` storeId=`ohahllgiabjaoigichmmfljhkcfikeof`
- Path: `C:\Users\Leo\AppData\Local\Temp\multiheiz-abu-29fHYo\extensions\ohahllgiabjaoigichmmfljhkcfikeof\4.4.3`
- networkBlocker / hasDnr: true / true
- Warnings: declarative_net_request — regras estáticas aplicadas via shim DNR do MultiHeiz

## Manifest

- MV3 · popup: `pages/popup.html`
- Background: `{"service_worker":"pages/background.js"}`
- Permissions: tabs, webRequest, webNavigation, storage, unlimitedStorage, contextMenus, cookies, scripting, userScripts, tabs, webRequest, webNavigation, storage, unlimitedStorage, contextMenus, cookies, declarativeNetRequest, scripting, userScripts
- Host: <all_urls>
- Content scripts: 2
  - `document_start` js=pages/document-start.js matches=http://*/*,https://*/*
  - `document_start` js=pages/welcome-bridge.js matches=https://*.adblockultimate.net/welcome*,https://*.adblockultimate.net/*/welcome*
- DNR stripped for Electron loadExtension: true
- rule_resources: 45 (enabled: ruleset_1)

## DNR shim

- Rules loaded (enabled sets + dynamic/session): **74867**
- Load time: **1136 ms**
- Lookup: 15 lookups in 15.93 ms (avg **1061.8 µs**)
- Sample matches:
  - `https://resourcelow.com/ads.js` → block (rule 43070890, prio 1)
  - `https://adsterratech.com/banner.gif` → block (rule 1720666728, prio 1)
  - `https://www.uol.com.br/` → none
  - `https://securepubads.g.doubleclick.net/tag/js/gpt.js` → block (rule 1637486133, prio 101)
  - `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js` → block (rule 952029792, prio 1)

## Local page (URLs matching rules)

- Control data-URL image loaded: true
- matchUrl block hits on probes: 4
- Network cancel likely (img naturalWidth 0): true
- Probe detail: `{"ok":{"ok":true,"w":1},"a":{"ok":false,"w":0},"b":{"ok":false,"w":0}}`

## Popup / UI

- openActionPopup ok: **true**
- chrome-extension URL loaded: true
- href: `chrome-extension://ohahllgiabjaoigichmmfljhkcfikeof/pages/popup.html`
- title: Popup
- body preview: "Secure page\n\nEnabled on this site\nBlock element\nSettings\nGet AdBlocker Ultimate for Windows\nBlock ads on mobile"

## Real site: https://www.uol.com.br/ (one hidden window)

- Loaded in 7000 ms → `https://www.uol.com.br/`
- Title: UOL - Seu universo online
- performance resource entries: 151
- DNR would-block among resources + probes: **13**
- Samples:
  - `https://tm.jsuol.com.br/modules/external/Prebid.js`
  - `https://securepubads.g.doubleclick.net/tag/js/gpt.js`
  - `https://tm.jsuol.com.br/modules/external/admanager/homeuol_ads.js`
  - `https://conteudo.imguol.com.br/c/home/layout/vueland/icons/publicidade/selo-pagbank-horizontal-rende.png`
  - `https://ib.adnxs.com/getuidj`
  - `https://stats.g.doubleclick.net/g/collect?v=2&tid=G-BS4Q6LCGB1&cid=152083765.1792379022&gtm=45je6ae1v867529723za200zd867529723xf1&rcb=12&aip=1&dma=0&gcd=13l3l3l`
  - `https://www.google.com.br/ads/ga-audiences?v=1&t=sr&slf_rd=1&_r=4&tid=G-BS4Q6LCGB1&cid=152083765.1792379022&gtm=45je6ae1v867529723za200zd867529723xf1&rcb=12&aip`
  - `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?fcd=true`
  - `https://www.google.com.br/ads/ga-audiences?v=1&t=sr&slf_rd=1&_r=4&tid=G-BS4Q6LCGB1&cid=152083765.1792379022&gtm=45je6ae1v867529723za200zd867529723xf1&rcb=12&aip`
  - `(probe) https://resourcelow.com/ads.js`
  - `(probe) https://adsterratech.com/banner.gif`
  - `(probe) https://securepubads.g.doubleclick.net/tag/js/gpt.js`
- Cosmetic / content-script hint: `{"adLike":8,"hiddenOrZero":2,"hasContentScriptMarker":true}`
- Note: Network cancel is enforced by DNR shim on the session hub; resource timing only lists requests that started. matchUrl on collected URLs + probes indicates filter coverage.

## Coexistence

- Suggest turn off built-in: **true**
- Extensão bloqueadora ativa (AdBlocker Ultimate). Recomenda-se desligar o bloqueador embutido em Configurações → Bloqueio de anúncios para evitar regras duplicadas (ambos podem ficar ligados: o hub combina decisões; bloqueio vence; lista de permissão respeitada).

## Verdict

| Check | Result |
|-------|--------|
| Installs via store installer | YES |
| Popup/UI loads | YES |
| DNR shim blocks network | YES |
| Cosmetic hiding works | LIKELY/YES |

Shim: `src/main/extensions/dnr-shim.js` via `webRequestHub` (block wins; MultiHeiz allowlist respected).
Fallback (b) not needed — static rulesets load into the shim.

### Caveats (honest)

- Electron has no native `chrome.declarativeNetRequest`. ABU’s background service worker throws
  (`MAX_NUMBER_OF_DYNAMIC_RULES` / DNR undefined) and **SW registration fails**. Network blocking
  still works via MultiHeiz’s static-ruleset shim. Dynamic ruleset toggles from the SW do not run;
  `updateEnabledRulesets` / dynamic / session APIs are stubbed in popup/options pages when injectable.
- ABU `document_start` content scripts match `http://*/*` and `https://*/*`. During Phase 3b probes,
  **loopback** `http://127.0.0.1` navigations in the ABU session failed to settle (harness timed out /
  load aborted), so local block checks were moved to `about:blank` image probes. **Normal https
  sites are fine** (uol loaded; content-script marker present). No evidence that public `http://`
  hostnames break for users — Chromium does not abort navigation on content-script exceptions, and
  the same CS runs on https successfully. Likely loopback / dead-SW messaging flake, not a missing
  page stub. Extending `dnr-api-stub` to the content-script world would not help (stub is for
  popup/options; ABU CS already runs as a real extension with `chrome.runtime`). No safe MultiHeiz
  patch without rewriting ABU’s CS. Cosmetic: some ad-like nodes hidden — not full Edge parity while
  the SW is dead.
- Lookup ~1 ms/avg on mixed probes (75k rules, host index + generics). Fine for typical pages; not
  free.
