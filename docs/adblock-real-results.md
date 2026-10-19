# Adblock real-site results (v1.8 phase 1)

Gerado: 2026-10-19T19:36:49.021Z

## Motor

- Fonte: **lists**
- Filtros rede: **147592**
- Filtros cosméticos: **61744**
- Resources (scriptlets/redirects): **212**
- Build: **1167 ms**, ΔRSS ~**129 MB**
- Mensagem: Listas atualizadas · 147592 rede + 61744 cosmético
- Regras YouTube (aprox.): rede **114**, cosmético **16**, scriptlets **4**

## Captcha

**captcha — tentar mais tarde**

## Google Search (seguro+auto)

Throttle: no máx. 1 SERP + 2 YouTube loads. Janela off-screen; screenshot do painel.

| | Bloqueados | Notas |
|--|--|--|
| OFF | 0 | homepage only; ads visibles: {"[data-text-ad]":null,"#tads":null,"#bottomads":null,"#tadsb":null,".uEierd":null,"[aria-label=\"Anúncios\"]":null} |
| ON | 26 | single SERP; doubleclick/pagead recent: 2; found: {"[data-text-ad]":{"display":"none","visibility":"visible","h":0},"#tads":{"display":"none","visibility":"visible","h":0},"#bottomads":{"display":"none","visibility":"visible","h":0},"#tadsb":{"display":"none","visibility":"visible","h":0},".uEierd":null,"[aria-label=\"Anúncios\"]":{"display":"none","visibility":"visible","h":0}} |

Screenshot (painel): `docs/screenshots/v1.8-google.png`

## Notícias (UOL)

- ON blocked: 11, ad-network hits blocked: 0

## YouTube (~45 s muted playback)

- ON blocked: 0, ad-related blocked: 0, ad-showing samples: 0
- Nota: captcha — tentar mais tarde

Screenshot (painel): `docs/screenshots/v1.8-youtube.png`

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
    "lastUpdateAt": 1792438574620,
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
        "lastUpdateAt": 1792438573337,
        "status": "ok",
        "error": null,
        "bytes": 471622
      },
      "ublock_badware": {
        "ruleCount": 4430,
        "lastUpdateAt": 1792438573340,
        "status": "ok",
        "error": null,
        "bytes": 262123
      },
      "ublock_privacy": {
        "ruleCount": 1776,
        "lastUpdateAt": 1792438573343,
        "status": "ok",
        "error": null,
        "bytes": 183849
      },
      "ublock_quick_fixes": {
        "ruleCount": 494,
        "lastUpdateAt": 1792438573345,
        "status": "ok",
        "error": null,
        "bytes": 88896
      },
      "ublock_unbreak": {
        "ruleCount": 2569,
        "lastUpdateAt": 1792438573348,
        "status": "ok",
        "error": null,
        "bytes": 281130
      },
      "ublock_resource_abuse": {
        "ruleCount": 78,
        "lastUpdateAt": 1792438573349,
        "status": "ok",
        "error": null,
        "bytes": 9223
      },
      "easylist": {
        "ruleCount": 83957,
        "lastUpdateAt": 1792438573362,
        "status": "ok",
        "error": null,
        "bytes": 2201055
      },
      "easyprivacy": {
        "ruleCount": 56367,
        "lastUpdateAt": 1792438573369,
        "status": "ok",
        "error": null,
        "bytes": 1510371
      },
      "portuguese": {
        "ruleCount": 1673,
        "lastUpdateAt": 1792438573371,
        "status": "ok",
        "error": null,
        "bytes": 75173
      },
      "peter_lowe": {
        "ruleCount": 3570,
        "lastUpdateAt": 1792438573373,
        "status": "ok",
        "error": null,
        "bytes": 70650
      },
      "adguard_base": {
        "ruleCount": 53748,
        "lastUpdateAt": 1792438573977,
        "status": "ok",
        "error": null,
        "bytes": 4320325
      }
    },
    "statusMessage": "Listas atualizadas · 147592 rede + 61744 cosmético",
    "sessionTotal": 0,
    "engine": "ghostery",
    "engineSource": "lists",
    "networkFilterCount": 147592,
    "cosmeticFilterCount": 61744,
    "totalFilterCount": 209336,
    "resourcesLoaded": 212,
    "lastBuildMs": 1167,
    "lastBuildRssMb": 129,
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
        "lastUpdateAt": 1792438573337,
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
        "ruleCount": 4430,
        "lastUpdateAt": 1792438573340,
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
        "lastUpdateAt": 1792438573343,
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
        "lastUpdateAt": 1792438573345,
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
        "ruleCount": 2569,
        "lastUpdateAt": 1792438573348,
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
        "lastUpdateAt": 1792438573349,
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
        "ruleCount": 83957,
        "lastUpdateAt": 1792438573362,
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
        "ruleCount": 56367,
        "lastUpdateAt": 1792438573369,
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
        "lastUpdateAt": 1792438573371,
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
        "ruleCount": 3570,
        "lastUpdateAt": 1792438573373,
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
        "ruleCount": 53748,
        "lastUpdateAt": 1792438573977,
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
        "lastUpdateAt": 1792438574620,
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
        "url": "https://www.google.com/?hl=pt-BR&zx=1792438576605",
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
        "title": "seguro auto - Pesquisa Google",
        "url": "https://www.google.com/search?q=seguro+auto&hl=pt-BR&sei=UnHWaorpM_eBhuMP1N7R6A4",
        "found": {
          "[data-text-ad]": {
            "display": "none",
            "visibility": "visible",
            "h": 0
          },
          "#tads": {
            "display": "none",
            "visibility": "visible",
            "h": 0
          },
          "#bottomads": {
            "display": "none",
            "visibility": "visible",
            "h": 0
          },
          "#tadsb": {
            "display": "none",
            "visibility": "visible",
            "h": 0
          },
          ".uEierd": null,
          "[aria-label=\"Anúncios\"]": {
            "display": "none",
            "visibility": "visible",
            "h": 0
          }
        },
        "consent": false
      },
      "blocked": 26,
      "recent": [
        "https://play.google.com/log?format=json&hasfast=true",
        "https://play.google.com/log?format=json&hasfast=true&authuser=0",
        "https://www.google.com/gen_204?s=async&astyp=folsrch&t=all&atyp=csi&ei=U3HWau24G9PT5OUPh9OPsAM&rt=ipf.-448,ipfr.1,ttfb.1,st.1,sirt-mul.3,sirt-mfc.5,sirt-aimc.8,sirt-aimfl.516,sirt-mfl.516,sirt-dfa.1558,sart-mul.3,scrt-mul.3,sart-mfc.1570,scrt-mfc.1570,sart-aimc.1549,scrt-aimc.1549,sart-aimfl.516,scrt-aimfl.516,sart-mfl.516,scrt-mfl.516,sart-dfa.1566,scrt-dfa.1566,ipfrl.1606,acrt.1606,aaft.1606,art.1607,ns.-836&imn=20&ima=0&sv=mul.12,mfc.12,aimc.12,aimfl.12,mfl.12,dfa.12&cb=122432&ucb=546994&folid=B2Jtyd",
        "https://play.google.com/log?hasfast=true&authuser=0&format=json",
        "https://www.google.com/generate_204?D_KcRw",
        "https://www.google.com/gen_204?atyp=i&ct=psnt&cad=&nt=navigate&ei=U3HWatPDA_el5OUPlveb4As&zx=1792438590082&opi=89978449",
        "https://play.google.com/log?format=json&hasfast=true",
        "https://www.google.com/gen_204?atyp=i&ei=U3HWatPDA_el5OUPlveb4As&vet=12ahUKEwitrt6V6saXAxXTKbkGHYfpAzYQ6vcKegQIAhAP.U3HWau24G9PT5OUPh9OPsAM.s&bl=MRvb&s=web&zx=1792438589737&opi=89978449",
        "https://www.google.com/gen_204?s=async&astyp=folsrch&t=sirt-mfl&atyp=csi&ei=U3HWau24G9PT5OUPh9OPsAM&rt=ipf.-448,ipfr.1,ttfb.1,st.1,sirt-mul.3,sirt-mfc.5,sirt-aimc.8,sirt-aimfl.516,sirt-mfl.516,ns.-836&folid=B2Jtyd",
        "https://www.google.com/gen_204?atyp=i&ei=U3HWatPDA_el5OUPlveb4As&vet=12ahUKEwiTucaV6saXAxX3ErkGHZb7BrwQuqMJegQINhAA..s&bl=MRvb&s=web&lpl=CAEYAiABKCwwBTgDYgcIARDgtJwX&zx=1792438589467&opi=89978449",
        "https://www.google.com/gen_204?atyp=i&ei=U3HWatPDA_el5OUPlveb4As&errsrp-main-w=304/12cols&zx=1792438589430&opi=89978449",
        "https://www.google.com/gen_204?atyp=i&ei=U3HWatPDA_el5OUPlveb4As&vet=12ahUKEwiTucaV6saXAxX3ErkGHZb7BrwQuqMJegQINhAA..s&bl=MRvb&s=web&lpl=CAEYAjAFOANiBwgBEOC0nBc&zx=1792438589424&opi=89978449",
        "https://www.google.com/gen_204?atyp=i&ei=U3HWatPDA_el5OUPlveb4As&errsrp-init=init&zx=1792438589418&opi=89978449",
        "https://ep1.adtrafficquality.google/getconfig/sodar?sv=200&tid=oos&tv=2562&st=cr_env&sjk=U3HWatPDA_el5OUPlveb4As",
        "https://www.google.com/gen_204?atyp=i&ei=U3HWatPDA_el5OUPlveb4As&pcon=0&dt19=3&prm23=1&zx=1792438589377&opi=89978449"
      ],
      "doubleclick": 2,
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
        "https://conteudo.imguol.com.br/c/home/layout/vueland/icons/publicidade/selo-pagbank-horizontal-rende.png",
        "https://sb.scorecardresearch.com/cs/6036356/beacon.js",
        "https://tm.jsuol.com.br/modules/external/admanager/homeuol_ads.js",
        "https://sdk.mrf.io/statics/marfeel-sdk.js?id=4196",
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
    "on": {
      "blocked": 0,
      "note": "captcha — tentar mais tarde",
      "probe": {
        "title": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "url": "https://www.google.com/sorry/index?continue=https://www.youtube.com/watch%3Fv%3DdQw4w9WgXcQ&q=EgS64Q19GOPi2dYGIjCmC-NrXOMkkdF2ltV254n_dwKFNdyQ8ul4aUzyGXtOrQMAjrkGAHAChwHCESUvIJgyAnJSWgFDYNPW1J6yx-n7YA",
        "adShowing": false,
        "adOverlay": false,
        "adCountdown": "",
        "hasAdModule": false,
        "paused": null,
        "currentTime": null,
        "consent": false,
        "sorry": true
      },
      "adShowingSamples": 0,
      "samples": []
    }
  },
  "captcha": "captcha — tentar mais tarde"
}
```
