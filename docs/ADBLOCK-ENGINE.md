# Adblock engine research (v1.7)

Electron **37.10.3** (installed). Verified against `node_modules/electron/electron.d.ts` and
[Electron Extensions docs](https://www.electronjs.org/docs/latest/api/extensions).

## Chrome extensions in Electron

Electron supports only a **subset** of Chrome extension APIs (DevTools-oriented; not a Chromium browser substitute).

| API | Status in Electron 37 |
|-----|------------------------|
| `chrome.declarativeNetRequest` | **Not listed / not implemented** — uBlock Origin Lite (MV3) cannot filter network |
| `chrome.webRequest` | Supported with caveat: **app `session.webRequest` takes precedence** over extension handlers |
| `session.webRequest.*` | **One listener per event per session** — last registration wins; `null` clears |
| `ses.extensions.loadExtension` | Unpacked only; per-session; not remembered across restarts |

### Spike (uBO / uBOL) — not shipped

- **uBOL (MV3)**: depends on `declarativeNetRequest` → cannot block network in Electron.
- **uBO classic (MV2)**: uses `chrome.webRequest` blocking. Even if loaded via `loadExtension`, any
  app-level `session.webRequest.onBeforeRequest` (future hub / Ghostery) **overrides** the extension.
  Electron also documents that only one `webRequest` listener is effective per event.
- Conclusion: do **not** ship uBlock as an extension for MultiHeiz network filtering. Keep
  `session.extensions.loadExtension` as a future hook for non-network extensions
  (`src/main/extensions/`).

## Chosen engine: `@ghostery/adblocker-electron` (MPL-2.0)

| Property | Detail |
|----------|--------|
| License | MPL-2.0 (file-level copyleft) — fine to bundle unmodified; list in Sobre > licenças |
| Network | `session.webRequest.onBeforeRequest` + `onHeadersReceived` |
| Cosmetic | Preload via `session.registerPreloadScript` + IPC inject CSS/scriptlets |
| Cache | `FiltersEngine.serialize()` / `deserialize()` → `userData/adblock/engine.bin` |
| Lists | `fromLists(fetch, urls)` or `parse(raw)` + prebuilt ads/tracking fallbacks |
| Main-frame | Library **skips** cancelling main-frame navigations in `onBeforeRequest` (login-safe) |

### Conflict with MultiHeiz (pre-v1.7)

- **No** existing `session.webRequest.*` handlers in MultiHeiz (UA via `webContents.setUserAgent`;
  downloads via `session.on('will-download')` — separate API).
- Panel preload is set per `WebContentsView` (`panel-preload.js` for FPS). Ghostery adds a
  **session-level** preload with `registerPreloadScript` — does **not** replace the view preload.
- Still: Ghostery’s `enableBlockingInSession` **owns** `onBeforeRequest` / `onHeadersReceived`.
  `disableBlockingInSession` clears those listeners entirely. MultiHeiz therefore uses a
  **`webRequestHub`** that is the single registered listener and multiplexes adblock + future handlers.

### Integration design (`src/main/adblock/`)

```
enable(session) / disable(session) / isAllowed(url, site) / stats
  → lists download + engine.bin cache
  → webRequestHub(session): onBeforeRequest / onHeadersReceived
  → cosmetic: registerPreloadScript (Ghostery) alongside panel view preload
```

Future extensions (`src/main/extensions/`) can share the hub and load unpacked extensions per
`persist:acc-*` partition without fighting adblock.

## Filter lists (download + cache)

| List | URL | License |
|------|-----|---------|
| EasyList | `https://easylist.to/easylist/easylist.txt` | GPL-3.0+ / CC BY-SA 3.0+ |
| EasyPrivacy | `https://easylist.to/easylist/easyprivacy.txt` | same (EasyList authors) |
| EasyList Portuguese | `https://easylist-downloads.adblockplus.org/easylistportuguese.txt` | EasyList licence |
| (optional) Fanboy/other | only if needed; prefer EasyList family |

Auto-update every **24 h** (and on start if stale). Offline: use cached raw lists + `engine.bin`.
If no cache and offline: try library prebuilt (`fromPrebuiltAdsAndTracking`); else disable with
clear status (no crash).

## YouTube ads (experimental)

Ghostery supports scriptlets / cosmetic rules. YouTube’s ad pipeline changes often; network filters
alone are incomplete. MultiHeiz exposes an optional “Bloquear anúncios do YouTube (experimental)”
toggle that enables extra scriptlet / cosmetic aggressiveness where the engine allows it.
**Expectation:** partial / unreliable; document as experimental. Prefer EasyList + cosmetics for
general sites.

## Preload coexistence

1. Panel FPS: `WebContentsView` `webPreferences.preload` = `panel-preload.js`.
2. Adblock cosmetics: `session.registerPreloadScript({ type: 'frame', filePath })` — MultiHeiz
   `cosmetic-preload.js` (all frames; Ghostery’s stock preload only ran on `window.top`).
3. Hub never calls `setPreloads([])` in a way that drops either; unregister only adblock’s script id
   on disable.
4. Cosmetics/scriptlets inject via `event.senderFrame.insertCSS` /
   `executeJavaScript` when available (iframe-correct).

## v1.7.1 diagnóstico

Leo: bloqueio “fraco”; anúncios do Google (Search / AdSense / DoubleClick) e YouTube não
sumiam na prática. Causas reais encontradas e corrigidas:

| Bug | Efeito | Correção |
|-----|--------|----------|
| `ElectronBlocker.parse()` **sem** `resources.json` | `##+js(...)` scriptlets (críticos no YouTube) não rodavam | Baixar/cachear `resources.json` + `updateResources` antes de serializar |
| Listas só EasyList/EasyPrivacy/PT | Cobertura fraca vs uBO | Catálogo amplo (uBlock filters/badware/privacy/quick-fixes/unbreak/resource-abuse, Peter Lowe, AdGuard Base sem EasyList; Tracking OFF por padrão ~11 MB) |
| `referrer` vazio no `webRequest` | Filtros `$domain=` falhavam | `enrichDetails`: page URL / `frame.url` como `sourceUrl` |
| Engine pronto **depois** dos painéis | Primeira navegação sem hub/preload | `await init` antes de `createWindow`; fingerprint invalida `engine.bin` stale |
| Preload Ghostery só `window.top` + inject no `webContents` | Cosmético/scriptlet em iframe não aplicava | Preload próprio em todos os frames + inject em `senderFrame` |
| Parse options incompletas | Cosméticos genéricos / HTML / CSP | `loadGenericCosmeticsFilters`, `enableHtmlFiltering`, `enableCompression`, `guessRequestTypeFromUrl` |
| Sem painel de diagnóstico | Difícil ver fallback prebuilt / contagens | Diagnósticos > Bloqueador + log `[adblock]` |

### Listas default (HTTP 200 verificado) e medidas

Defaults ON: uBlock (filters, badware, privacy, quick-fixes, unbreak, resource-abuse), EasyList,
EasyPrivacy, EasyList Portuguese, Peter Lowe, AdGuard Base `2_without_easylist` (~4 MB).
Default OFF: AdGuard Tracking `3.txt` (~11 MB). Auto-update 6/12/24/48 h (default 24).

Números de build (listas default, com resources) são registrados em
`docs/adblock-real-results.md` / `TASK-v1.7.1.result.md` após `check:adblock-real`.


## v1.8 early MAIN WORLD scriptlets (phase 1)

**Root cause (leaks):** Ghostery session cosmetic preload + async IPC meant scriptlets often ran after page head scripts (YouTube ytInitialPlayerResponse etc.).

**Fix:**
- panel-preload.js (and session cosmetic-preload.js) call ipcRenderer.sendSync('@ghostery/adblocker/early-scriptlets', url) then contextBridge.executeInMainWorld synchronously at document start (main frame + iframes via nodeIntegrationInSubFrames).
- Payload cached per hostname in main; includes scriptlets, early CSS, UA patch, light-mode CSS.
- Never document.appendChild(style) when documentElement is missing — that made the style the document root and wiped page body (broke light mode + slow-load tests). Always document.head || document.documentElement, with MutationObserver deferral.

**Measured (selftest:v18 local):** syncMs ~0.3–1.7 ms, injectMs ~0–0.7 ms, scripts injected before page probe globals.

**Resources:** Ghostery resources.json cached; YouTube-oriented scriptlet behaviours use Ghostery MPL resources (no uBO GPL copies).

**Network:** EasyList/uBO lists + webRequestHub; pagead/doubleclick/midroll style URLs match with xhr/fetch/media/ping.

**Relatar anuncio:** writes userData/adblock/reports/<time>.json (page URL, UA, engine, recent requests) — no upload.

**Real-site:** npm run check:adblock-real once per phase; see docs/adblock-real-results.md (screenshots históricos em `_local/reference/screenshots/`).
