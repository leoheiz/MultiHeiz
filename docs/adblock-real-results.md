# Adblock real-site results (v1.8 phase 1)

Gerado: 2026-10-19T01:10:36.153Z

## Motor

- Fonte: **lists**
- Filtros rede: **147643**
- Filtros cosméticos: **61732**
- Resources (scriptlets/redirects): **212**
- Build: **3470 ms**, ΔRSS ~**20 MB**
- Mensagem: Listas atualizadas · 147643 rede + 61732 cosmético
- Regras YouTube (aprox.): rede **114**, cosmético **16**, scriptlets **4**

## Captcha

**captcha — tentar mais tarde**

## Google Search (seguro+auto)

Throttle: no máx. 1 SERP + 2 YouTube loads. Janela off-screen; screenshot do painel.

| | Bloqueados | Notas |
|--|--|--|
| OFF | 0 | homepage only; ads visibles: {"[data-text-ad]":null,"#tads":null,"#bottomads":null,"#tadsb":null,".uEierd":null,"[aria-label=\"Anúncios\"]":null} |
| ON | 0 | single SERP; doubleclick/pagead recent: 0; found: {"[data-text-ad]":null,"#tads":null,"#bottomads":null,"#tadsb":null,".uEierd":null,"[aria-label=\"Anúncios\"]":null} |

Screenshot (painel): `_local/reference/screenshots/v1.8-google.png`

## Notícias (UOL)

- ON blocked: 11, ad-network hits blocked: 0

## YouTube (~45 s muted playback)

- ON blocked: 13, ad-related blocked: 7, ad-showing samples: 0
- Contagem regras YT: {"network":114,"cosmetic":16,"scriptlets":4}

Screenshot (painel): `_local/reference/screenshots/v1.8-youtube.png`

## Limitações

- Consent/cookie walls podem alterar o DOM (best effort).
- Anúncios de texto do Google Search dependem sobretudo de cosméticos.
- YouTube: scriptlets early MAIN WORLD (v1.8) + listas; pipeline muda com frequência.
- Se aparecer `google.com/sorry`, a corrida para com "captcha — tentar mais tarde".

```json
{
  "engine": {
    "enabled": true,
    "ready": true,
    "antiTracking": true,
    "cosmetic": true,
    "youtubeExperimental": true,
    "lists": {
      "ublock_filters": true,
      "ublock_badware": true,
      "ublock_privacy": true,
      "ublock_quick_fixes": true,
      "ublock_unbreak": true,
      "ublock_resource_abuse": true,
      "easylist": true,
      "easyprivacy": true,
      "portuguese": true,
      "peter_lowe": true,
      "adguard_base": true,
      "adguard_tracking": false
    },
    "allowlist": [],
    "customLists": [],
    "userRules": "",
    "updateIntervalHours": 24,
    "updateIntervalHoursOptions": [
      6,
      12,
      24,
      48
    ],
    "lastUpdateAt": 1792372156336,
    "listStatus": {
      "ublock_filters": "ok",
      "ublock_badware": "ok",
      "ublock_privacy": "ok",
      "ublock_quick_fixes": "ok",
      "ublock_unbreak": "ok",
      "ublock_resource_abuse": "ok",
      "easylist": "ok",
      "easyprivacy": "ok",
      "portuguese": "ok",
      "peter_lowe": "ok",
      "adguard_base": "ok"
    },
    "listMeta": {
      "ublock_filters": {
        "ruleCount": 6078,
        "lastUpdateAt": 1792372152851,
        "status": "ok",
        "error": null,
        "bytes": 471622
      },
      "ublock_badware": {
        "ruleCount": 4418,
        "lastUpdateAt": 1792372152859,
        "status": "ok",
        "error": null,
        "bytes": 261790
      },
      "ublock_privacy": {
        "ruleCount": 1776,
        "lastUpdateAt": 1792372152868,
        "status": "ok",
        "error": null,
        "bytes": 183849
      },
      "ublock_quick_fixes": {
        "ruleCount": 494,
        "lastUpdateAt": 1792372152875,
        "status": "ok",
        "error": null,
        "bytes": 88911
      },
      "ublock_unbreak": {
        "ruleCount": 2567,
        "lastUpdateAt": 1792372152883,
        "status": "ok",
        "error": null,
        "bytes": 280985
      },
      "ublock_resource_abuse": {
        "ruleCount": 78,
        "lastUpdateAt": 1792372152890,
        "status": "ok",
        "error": null,
        "bytes": 9223
      },
      "easylist": {
        "ruleCount": 83680,
        "lastUpdateAt": 1792372152948,
        "status": "ok",
        "error": null,
        "bytes": 2194649
      },
      "easyprivacy": {
        "ruleCount": 56350,
        "lastUpdateAt": 1792372152991,
        "status": "ok",
        "error": null,
        "bytes": 1509977
      },
      "portuguese": {
        "ruleCount": 1673,
        "lastUpdateAt": 1792372153039,
        "status": "ok",
        "error": null,
        "bytes": 75173
      },
      "peter_lowe": {
        "ruleCount": 3569,
        "lastUpdateAt": 1792372154102,
        "status": "ok",
        "error": null,
        "bytes": 70628
      },
      "adguard_base": {
        "ruleCount": 54094,
        "lastUpdateAt": 1792372155524,
        "status": "ok",
        "error": null,
        "bytes": 4327998
      }
    },
    "statusMessage": "Listas atualizadas · 147643 rede + 61732 cosmético",
    "sessionTotal": 0,
    "engine": "ghostery",
    "engineSource": "lists",
    "networkFilterCount": 147643,
    "cosmeticFilterCount": 61732,
    "totalFilterCount": 209375,
    "resourcesLoaded": 212,
    "lastBuildMs": 3470,
    "lastBuildRssMb": 20,
    "rebuilding": false,
    "progress": "",
    "catalog": [
      {
        "id": "ublock_filters",
        "name": "uBlock filters",
        "group": "ads",
        "groupLabel": "Anúncios",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 6078,
        "lastUpdateAt": 1792372152851,
        "error": null
      },
      {
        "id": "ublock_badware",
        "name": "uBlock badware",
        "group": "malware",
        "groupLabel": "Malware/badware",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 4418,
        "lastUpdateAt": 1792372152859,
        "error": null
      },
      {
        "id": "ublock_privacy",
        "name": "uBlock privacy",
        "group": "privacy",
        "groupLabel": "Privacidade",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 1776,
        "lastUpdateAt": 1792372152868,
        "error": null
      },
      {
        "id": "ublock_quick_fixes",
        "name": "uBlock quick fixes",
        "group": "fixes",
        "groupLabel": "Correções",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 494,
        "lastUpdateAt": 1792372152875,
        "error": null
      },
      {
        "id": "ublock_unbreak",
        "name": "uBlock unbreak",
        "group": "fixes",
        "groupLabel": "Correções",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 2567,
        "lastUpdateAt": 1792372152883,
        "error": null
      },
      {
        "id": "ublock_resource_abuse",
        "name": "uBlock resource abuse",
        "group": "ads",
        "groupLabel": "Anúncios",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 78,
        "lastUpdateAt": 1792372152890,
        "error": null
      },
      {
        "id": "easylist",
        "name": "EasyList",
        "group": "ads",
        "groupLabel": "Anúncios",
        "url": "https://easylist.to/easylist/easylist.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 83680,
        "lastUpdateAt": 1792372152948,
        "error": null
      },
      {
        "id": "easyprivacy",
        "name": "EasyPrivacy",
        "group": "privacy",
        "groupLabel": "Privacidade",
        "url": "https://easylist.to/easylist/easyprivacy.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 56350,
        "lastUpdateAt": 1792372152991,
        "error": null
      },
      {
        "id": "portuguese",
        "name": "EasyList Portuguese (Lista PT-BR)",
        "group": "regional",
        "groupLabel": "Regional",
        "url": "https://easylist-downloads.adblockplus.org/easylistportuguese.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 1673,
        "lastUpdateAt": 1792372153039,
        "error": null
      },
      {
        "id": "peter_lowe",
        "name": "Peter Lowe's Ad and tracking server list",
        "group": "ads",
        "groupLabel": "Anúncios",
        "url": "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext",
        "enabled": true,
        "defaultOn": true,
        "note": "",
        "status": "ok",
        "ruleCount": 3569,
        "lastUpdateAt": 1792372154102,
        "error": null
      },
      {
        "id": "adguard_base",
        "name": "AdGuard Base (sem EasyList)",
        "group": "ads",
        "groupLabel": "Anúncios",
        "url": "https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt",
        "enabled": true,
        "defaultOn": true,
        "note": "~4 MB; variante leve sem duplicar EasyList",
        "status": "ok",
        "ruleCount": 54094,
        "lastUpdateAt": 1792372155524,
        "error": null
      },
      {
        "id": "adguard_tracking",
        "name": "AdGuard Tracking Protection",
        "group": "privacy",
        "groupLabel": "Privacidade",
        "url": "https://filters.adtidy.org/extension/ublock/filters/3.txt",
        "enabled": false,
        "defaultOn": false,
        "note": "~11 MB; opcional (memória/tempo de build)",
        "status": "—",
        "ruleCount": 0,
        "lastUpdateAt": 1792372156336,
        "error": null
      }
    ],
    "groupLabels": {
      "ads": "Anúncios",
      "privacy": "Privacidade",
      "malware": "Malware/badware",
      "regional": "Regional",
      "fixes": "Correções",
      "custom": "Personalizadas"
    }
  },
  "google": {
    "off": {
      "probe": {
        "title": "Google",
        "url": "https://www.google.com/?hl=pt-BR&zx=1792372158540",
        "found": {
          "[data-text-ad]": null,
          "#tads": null,
          "#bottomads": null,
          "#tadsb": null,
          ".uEierd": null,
          "[aria-label=\"Anúncios\"]": null
        },
        "consent": false
      },
      "blocked": 0,
      "recent": [],
      "note": "homepage only (no SERP) to avoid captcha"
    },
    "on": {
      "probe": {
        "title": "https://www.google.com/search?q=seguro+auto&hl=pt-BR&sei=4m3VaqTBGoCu1sQPrYmt6Ak",
        "url": "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dseguro%2Bauto%26hl%3Dpt-BR%26sei%3D4m3VaqTBGoCu1sQPrYmt6Ak&hl=pt-BR&q=EgS64Q19GOLb1dYGIjAY9bEjvGZUhvL-3bLHcLYdsj0lWwzTfdYKlv4jloMZHjbjI6dxCrvwSDC0z02pbWcyAnJSWgFDYNvIyeTKgPfOXA",
        "found": {
          "[data-text-ad]": null,
          "#tads": null,
          "#bottomads": null,
          "#tadsb": null,
          ".uEierd": null,
          "[aria-label=\"Anúncios\"]": null
        },
        "consent": false
      },
      "blocked": 0,
      "recent": [],
      "doubleclick": 0,
      "note": "single SERP query this run"
    }
  },
  "news": {
    "on": {
      "probe": {
        "title": "UOL - Seu universo online",
        "url": "https://www.uol.com.br/",
        "adSlots": 14
      },
      "blocked": 11,
      "recent": [
        "https://cdn.cxense.com/cx.cce.js",
        "https://me.jsuol.com.br/aud/uolplayer.js",
        "https://sb.scorecardresearch.com/cs/6036356/beacon.js",
        "https://tm.jsuol.com.br/modules/external/admanager/homeuol_ads.js",
        "https://sdk.mrf.io/statics/marfeel-sdk.js?id=4196",
        "https://conteudo.imguol.com.br/c/home/layout/vueland/icons/publicidade/selo-pagbank-horizontal-rende.png",
        "https://4b91477e-f67b-4d81-86db-a9742bd41e9c.edge.permutive.app/4b91477e-f67b-4d81-86db-a9742bd41e9c-web.js",
        "https://me.jsuol.com.br/aud/uolhome.js",
        "https://tm.jsuol.com.br/modules/dmp-uol-sync.js",
        "https://tm.jsuol.com.br/uoltm.js?id=xe9bur&version=788",
        "https://tm.jsuol.com.br/modules/external/Prebid.js"
      ],
      "adNetwork": []
    }
  },
  "youtube": {
    "lastProbe": {
      "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster) - YouTube",
      "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "adShowing": false,
      "adOverlay": false,
      "adCountdown": "",
      "hasAdModule": true,
      "paused": false,
      "currentTime": 45.786872,
      "consent": false,
      "sorry": false
    },
    "on": {
      "blocked": 13,
      "recent": [
        "https://www.youtube.com/api/stats/qoe?fmt=397&afmt=251&cpn=0eWCSoOsm21qgqvy&el=detailpage&ns=yt&fexp=v1%2C100673025%2C-76668381%2C15321210%2C11737789%2C31835%2C2821%2C124674%2C77203%2C65%2C13917%2C26504%2C9252%2C16509%2C23206%2C69841%2C8206%2C2625%2C1904%2C18126%2C15105%2C25059%2C4174%2C12720%2C17726%2C18706%2C26008%2C13015%2C14666%2C1422%2C6621%2C2783%2C23826%2C9500%2C1840%2C24559%2C70279%2C20588%2C2364%2C1835%2C30114%2C6491%2C2690%2C7242%2C45741%2C6032%2C1168%2C8131%2C34320%2C38306%2C1355%2C10362%2C3361%2C4366%2C9717%2C587%2C3026%2C24247%2C2292%2C3843%2C17160%2C1340%2C31377%2C111%2C12385%2C24505%2C3%2C17953%2C12554%2C2835%2C9177%2C4923%2C3113%2C1658%2C4596%2C7475%2C704%2C1100%2C1215%2C2424%2C5325%2C2266%2C715%2C1214%2C2854%2C12148%2C19%2C35%2C1879%2C2800%2C2747%2C1504%2C3362%2C8803%2C8814%2C3%2C2%2C79%2C2788%2C2439%2C9%2C3465%2C805%2C164%2C4585%2C14984%2C612%2C3383%2C1400%2C9139%2C3980&cl=998936191&dai=unspecified&seq=3&docid=dQw4w9WgXcQ&ei=9G3VapzGH_ejobIP1pzPyQ8&event=streamingstats&plid=AAZeJy0IafjsADB8&sdetail=rv%3AdQw4w9WgXcQ&sourceid=yw&cbr=Chrome&cbrver=138.0.7204.251&c=WEB&cver=2.20261016.01.00&cplayer=UNIPLAYER&cos=Windows&cosver=10.0&cplatform=DESKTOP&vps=40.018:PL&bwm=40.018:3869879:0.142&bwe=40.018:25484987&bat=40.018:1:1&cmt=40.018:39.422&bh=40.018:51.934",
        "https://www.youtube.com/youtubei/v1/log_event?alt=json",
        "https://www.youtube.com/youtubei/v1/log_event?alt=json",
        "https://googleads.g.doubleclick.net/pagead/id",
        "https://www.youtube.com/api/stats/qoe?fmt=397&afmt=251&cpn=0eWCSoOsm21qgqvy&el=detailpage&ns=yt&fexp=v1%2C100673025%2C-76668381%2C15321210%2C11737789%2C31835%2C2821%2C124674%2C77203%2C65%2C13917%2C26504%2C9252%2C16509%2C23206%2C69841%2C8206%2C2625%2C1904%2C18126%2C15105%2C25059%2C4174%2C12720%2C17726%2C18706%2C26008%2C13015%2C14666%2C1422%2C6621%2C2783%2C23826%2C9500%2C1840%2C24559%2C70279%2C20588%2C2364%2C1835%2C30114%2C6491%2C2690%2C7242%2C45741%2C6032%2C1168%2C8131%2C34320%2C38306%2C1355%2C10362%2C3361%2C4366%2C9717%2C587%2C3026%2C24247%2C2292%2C3843%2C17160%2C1340%2C31377%2C111%2C12385%2C24505%2C3%2C17953%2C12554%2C2835%2C9177%2C4923%2C3113%2C1658%2C4596%2C7475%2C704%2C1100%2C1215%2C2424%2C5325%2C2266%2C715%2C1214%2C2854%2C12148%2C19%2C35%2C1879%2C2800%2C2747%2C1504%2C3362%2C8803%2C8814%2C3%2C2%2C79%2C2788%2C2439%2C9%2C3465%2C805%2C164%2C4585%2C14984%2C612%2C3383%2C1400%2C9139%2C3980&cl=998936191&dai=unspecified&seq=2&docid=dQw4w9WgXcQ&ei=9G3VapzGH_ejobIP1pzPyQ8&event=streamingstats&plid=AAZeJy0IafjsADB8&sdetail=rv%3AdQw4w9WgXcQ&sourceid=yw&cbr=Chrome&cbrver=138.0.7204.251&c=WEB&cver=2.20261016.01.00&cplayer=UNIPLAYER&cos=Windows&cosver=10.0&cplatform=DESKTOP&bh=0.638:20.720,10.018:22.296&cmt=0.638:0.021,1.392:0.786,10.018:9.390&vps=0.638:PL,10.018:PL&cfs=0.676:.en:::s&bwm=10.018:1154233:0.040&bwe=10.018:1704102&bat=10.018:1:1&df=10.018:0",
        "https://www.google.com.br/pagead/lvz?evtid=ACd6KtygkyqF_FJyrtTz5Lj-x_SPvGsdGRpDbb8jxVt5GQTKZtx1DlLMS8ztmOQxkXjQaPD_WF-jcHESdX3prcqMuRVimN0yIQ&req_ts=1792372212&pg=MainAppBootstrap%3AWatch&az=1&sigh=AB9vU43DTJjG5KYf5_jR2Lq8aCnnEw-0LA",
        "https://www.google.com/pagead/lvz?evtid=ACd6KtygkyqF_FJyrtTz5Lj-x_SPvGsdGRpDbb8jxVt5GQTKZtx1DlLMS8ztmOQxkXjQaPD_WF-jcHESdX3prcqMuRVimN0yIQ&req_ts=1792372212&pg=MainAppBootstrap%3AWatch&az=1&sigh=AB9vU43DTJjG5KYf5_jR2Lq8aCnnEw-0LA",
        "https://www.google.com/pagead/1p-user-list/962985656/?backend=innertube&cname=1&cver=2_20261016&data=backend%3Dinnertube%3Bcname%3D1%3Bcver%3D2_20261016%3Bm%3D1%3Bptype%3Df_view%3Btype%3Dview%3Butuid%3DuAXFkgsw1L7xaCfnd5JJOw%3Butvid%3DdQw4w9WgXcQ%3Bw%3D1&is_vtc=0&ptype=f_view&random=1001766122&utuid=uAXFkgsw1L7xaCfnd5JJOw",
        "https://www.youtube.com/pagead/viewthroughconversion/962985656/?backend=innertube&cname=1&cver=2_20261016&data=backend%3Dinnertube%3Bcname%3D1%3Bcver%3D2_20261016%3Bm%3D1%3Bptype%3Df_view%3Btype%3Dview%3Butuid%3DuAXFkgsw1L7xaCfnd5JJOw%3Butvid%3DdQw4w9WgXcQ%3Bw%3D1&foc_id=uAXFkgsw1L7xaCfnd5JJOw&label=followon_view&ptype=f_view&random=24480270&utuid=uAXFkgsw1L7xaCfnd5JJOw",
        "https://www.youtube.com/ptracking?html5=1&video_id=dQw4w9WgXcQ&cpn=0eWCSoOsm21qgqvy&ei=9G3VapzGH_ejobIP1pzPyQ8&ptk=youtube_single&oid=QuEoptyF_C_7jHTEUMsRjA&ptchn=uAXFkgsw1L7xaCfnd5JJOw&pltype=content",
        "https://www.youtube.com/generate_204?uGPTow",
        "https://googleads.g.doubleclick.net/pagead/id",
        "https://www.youtube.com/api/stats/qoe?fmt=397&afmt=251&cpn=0eWCSoOsm21qgqvy&el=detailpage&ns=yt&fexp=v1%2C100673025%2C-76668381%2C15321210%2C11737789%2C31835%2C2821%2C124674%2C77203%2C65%2C13917%2C26504%2C9252%2C16509%2C23206%2C69841%2C8206%2C2625%2C1904%2C18126%2C15105%2C25059%2C4174%2C12720%2C17726%2C18706%2C26008%2C13015%2C14666%2C1422%2C6621%2C2783%2C23826%2C9500%2C1840%2C24559%2C70279%2C20588%2C2364%2C1835%2C30114%2C6491%2C2690%2C7242%2C45741%2C6032%2C1168%2C8131%2C34320%2C38306%2C1355%2C10362%2C3361%2C4366%2C9717%2C587%2C3026%2C24247%2C2292%2C3843%2C17160%2C1340%2C31377%2C111%2C12385%2C24505%2C3%2C17953%2C12554%2C2835%2C9177%2C4923%2C3113%2C1658%2C4596%2C7475%2C704%2C1100%2C1215%2C2424%2C5325%2C2266%2C715%2C1214%2C2854%2C12148%2C19%2C35%2C1879%2C2800%2C2747%2C1504%2C3362%2C8803%2C8814%2C3%2C2%2C79%2C2788%2C2439%2C9%2C3465%2C805%2C164%2C4585%2C14984%2C612%2C3383%2C1400%2C9139%2C3980&cl=998936191&dai=unspecified&seq=1&docid=dQw4w9WgXcQ&ei=9G3VapzGH_ejobIP1pzPyQ8&event=streamingstats&plid=AAZeJy0IafjsADB8&sdetail=rv%3AdQw4w9WgXcQ&sourceid=yw&cbr=Chrome&cbrver=138.0.7204.251&c=WEB&cver=2.20261016.01.00&cplayer=UNIPLAYER&cos=Windows&cosver=10.0&cplatform=DESKTOP&vps=0.000:N,0.026:B,0.334:B,0.334:B&cat=streaming,sabr&cmt=0.026:0.000,0.334:0.000&afs=0.332:251::i:fl.-13.02;tl.-14;vg.-0.9900000000000002;nm.1;sms.2:CAEoAQ&vfs=0.334:397:396::a:sms.2:CAEoAQ&view=0.334:427:240&bwm=0.334:1101570:0.315&bwe=0.334:603716&bat=0.334:1:1&vis=0.334:3&bh=0.334:0.000"
      ],
      "adRelatedBlocked": [
        "https://googleads.g.doubleclick.net/pagead/id",
        "https://www.google.com.br/pagead/lvz?evtid=ACd6KtygkyqF_FJyrtTz5Lj-x_SPvGsdGRpDbb8jxVt5GQTKZtx1DlLMS8ztmOQxkXjQaPD_WF-jcHESdX3prcqMuRVimN0yIQ&req_ts=1792372212&pg=MainAppBootstrap%3AWatch&az=1&sigh=AB9vU43DTJjG5KYf5_jR2Lq8aCnnEw-0LA",
        "https://www.google.com/pagead/lvz?evtid=ACd6KtygkyqF_FJyrtTz5Lj-x_SPvGsdGRpDbb8jxVt5GQTKZtx1DlLMS8ztmOQxkXjQaPD_WF-jcHESdX3prcqMuRVimN0yIQ&req_ts=1792372212&pg=MainAppBootstrap%3AWatch&az=1&sigh=AB9vU43DTJjG5KYf5_jR2Lq8aCnnEw-0LA",
        "https://www.google.com/pagead/1p-user-list/962985656/?backend=innertube&cname=1&cver=2_20261016&data=backend%3Dinnertube%3Bcname%3D1%3Bcver%3D2_20261016%3Bm%3D1%3Bptype%3Df_view%3Btype%3Dview%3Butuid%3DuAXFkgsw1L7xaCfnd5JJOw%3Butvid%3DdQw4w9WgXcQ%3Bw%3D1&is_vtc=0&ptype=f_view&random=1001766122&utuid=uAXFkgsw1L7xaCfnd5JJOw",
        "https://www.youtube.com/pagead/viewthroughconversion/962985656/?backend=innertube&cname=1&cver=2_20261016&data=backend%3Dinnertube%3Bcname%3D1%3Bcver%3D2_20261016%3Bm%3D1%3Bptype%3Df_view%3Btype%3Dview%3Butuid%3DuAXFkgsw1L7xaCfnd5JJOw%3Butvid%3DdQw4w9WgXcQ%3Bw%3D1&foc_id=uAXFkgsw1L7xaCfnd5JJOw&label=followon_view&ptype=f_view&random=24480270&utuid=uAXFkgsw1L7xaCfnd5JJOw",
        "https://www.youtube.com/ptracking?html5=1&video_id=dQw4w9WgXcQ&cpn=0eWCSoOsm21qgqvy&ei=9G3VapzGH_ejobIP1pzPyQ8&ptk=youtube_single&oid=QuEoptyF_C_7jHTEUMsRjA&ptchn=uAXFkgsw1L7xaCfnd5JJOw&pltype=content",
        "https://googleads.g.doubleclick.net/pagead/id"
      ],
      "adRelatedAllowed": [
        {
          "url": "https://static.doubleclick.net/instream/ad_status.js",
          "type": "script",
          "blocked": false,
          "filter": null,
          "at": 1792372192617
        }
      ],
      "adShowingSamples": 0,
      "samples": [
        {
          "t": 1,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 1.416313
        },
        {
          "t": 2,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 2.418479
        },
        {
          "t": 3,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 3.433961
        },
        {
          "t": 4,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 4.450003
        },
        {
          "t": 5,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 5.450721
        },
        {
          "t": 6,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 6.466327
        },
        {
          "t": 7,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 7.469245
        },
        {
          "t": 8,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 8.494158
        },
        {
          "t": 9,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 9.495027
        },
        {
          "t": 10,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 10.510165
        },
        {
          "t": 11,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 11.525831
        },
        {
          "t": 12,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 12.56036
        },
        {
          "t": 13,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 13.577614
        },
        {
          "t": 14,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 14.592984
        },
        {
          "t": 15,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 15.594881
        },
        {
          "t": 16,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 16.596636
        },
        {
          "t": 17,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 17.611303
        },
        {
          "t": 18,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 18.614092
        },
        {
          "t": 19,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 19.617257
        },
        {
          "t": 20,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 20.618552
        },
        {
          "t": 21,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 21.622919
        },
        {
          "t": 22,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 22.625803
        },
        {
          "t": 23,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 23.641429
        },
        {
          "t": 24,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 24.644077
        },
        {
          "t": 25,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 25.645632
        },
        {
          "t": 26,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 26.647091
        },
        {
          "t": 27,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 27.66324
        },
        {
          "t": 28,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 28.66569
        },
        {
          "t": 29,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 29.669377
        },
        {
          "t": 30,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 30.669885
        },
        {
          "t": 31,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 31.672243
        },
        {
          "t": 32,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 32.6751
        },
        {
          "t": 33,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 33.678465
        },
        {
          "t": 34,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 34.681916
        },
        {
          "t": 35,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 35.695957
        },
        {
          "t": 36,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 36.711439
        },
        {
          "t": 37,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 37.713925
        },
        {
          "t": 38,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 38.717695
        },
        {
          "t": 39,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 39.721011
        },
        {
          "t": 40,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 40.73764
        },
        {
          "t": 41,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 41.738513
        },
        {
          "t": 42,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 42.753994
        },
        {
          "t": 43,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 43.770186
        },
        {
          "t": 44,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 44.773144
        },
        {
          "t": 45,
          "adShowing": false,
          "adOverlay": false,
          "adCountdown": "",
          "currentTime": 45.786872
        }
      ],
      "probe": {
        "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster) - YouTube",
        "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "adShowing": false,
        "adOverlay": false,
        "adCountdown": "",
        "hasAdModule": true,
        "paused": false,
        "currentTime": 45.786872,
        "consent": false,
        "sorry": false
      },
      "youtubeRuleCounts": {
        "network": 114,
        "cosmetic": 16,
        "scriptlets": 4
      },
      "ytLoads": 1
    }
  },
  "captcha": "captcha — tentar mais tarde"
}
```
