# Avisos de terceiros — MultiHeiz

Este arquivo lista dependências de runtime e listas de filtros usadas pelo MultiHeiz.

## Dependências de runtime

| Pacote | Licença | Notas |
|--------|---------|--------|
| [Electron](https://www.electronjs.org/) | MIT | Shell Chromium + Node |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT | Atualizações via GitHub Releases |
| [adm-zip](https://github.com/cthackers/adm-zip) | MIT | Extração de arquivos `.crx` |
| [exceljs](https://github.com/exceljs/exceljs) | MIT | Exportação XLSX do módulo Planilha |
| [@ghostery/adblocker-electron](https://github.com/ghostery/adblocker) | MPL-2.0 | Motor de bloqueio embutido (e pacotes `@ghostery/*` / `@cliqz` relacionados, também MPL-2.0) |
| [@adguard/agtree](https://github.com/AdguardTeam/agtree) | MIT (AdGuard Software Ltd.) | Parser/conversor de regras AdGuard → sintaxe uBO (`##+js`); usado só no pré-processamento de listas ABU opcionais. **Não** se usam `@adguard/tswebextension`, `@adguard/tsurlfilter` nem `@adguard/scriptlets` (GPL). |

### Ghostery adblocker (MPL-2.0)

O código do bloqueador é usado **sem modificações** a partir do pacote npm. O código-fonte está disponível em [github.com/ghostery/adblocker](https://github.com/ghostery/adblocker). A licença MPL-2.0 exige disponibilizar o código-fonte dessas partes MPL; o projeto upstream já o faz.

## Listas de filtros (baixadas em runtime)

As listas **não** são empacotadas no instalador. São baixadas sob demanda para a pasta de dados do usuário (`%APPDATA%\MultiHeiz\adblock\` / `~/.config/MultiHeiz/adblock/`) conforme as opções em Configurações → Bloqueador.

| Lista | Licença (típica) |
|-------|------------------|
| uBlock Origin / uAssets (filters, badware, privacy, etc.) | GPLv3 |
| EasyList | GPLv3 |
| EasyPrivacy | GPLv3 |
| EasyList Portuguese | GPLv3 / CC BY-SA |
| Peter Lowe’s Ad and tracking server list | Ver [yoyo.org](https://pgl.yoyo.org/) |
| AdGuard filters | GPLv3 |

### AdBlocker Ultimate filter lists (AdAvoid Ltd.)

Fonte: [adblockultimate.net/filters](https://adblockultimate.net/filters). Listas opcionais do catálogo embutido (todas `defaultOn: false`), baixadas em runtime sob demanda — **não** distribuídas com o instalador MultiHeiz. O código do MultiHeiz permanece MIT.

| Lista (id) | URL | Licença |
|------------|-----|---------|
| Ultimate Ad Filter (`abu_ad`) | https://filters.adavoid.org/ultimate-ad-filter.txt | GNU GPLv3 / CC BY 3.0 |
| Ultimate Privacy Filter (`abu_privacy`) | https://filters.adavoid.org/ultimate-privacy-filter.txt | GNU GPLv3 / CC BY 3.0 |
| Ultimate Security Filter (`abu_security`) | https://filters.adavoid.org/ultimate-security-filter.txt | MIT / CC0 1.0 |
| Anti-circumvention (`abu_anticircumvention`) | https://filters.adavoid.org/filters/Anticircumvention.txt | GNU GPLv3 |
| EasyList Spanish ES/PT (`abu_spanish_portuguese`) | https://filters.adavoid.org/filters/EasyListSpanish.txt | GNU GPLv3 / CC BY 3.0 |

Não há lista portuguesa dedicada em filters.adavoid.org; a EasyList Spanish é a opção regional ABU indicada para sites ES/PT.

## Ícones

Ícones Lucide — ISC ([lucide.dev](https://lucide.dev)).

## Extensões de terceiros

A camada de carregamento em `src/main/extensions/` é MIT (código próprio do MultiHeiz). O MultiHeiz **não** empacota `electron-chrome-extensions` (GPL-3). Se no futuro essa biblioteca for adotada, o app distribuído precisaria ser GPL-3 ou usar licença proprietária do autor.

Extensões instaladas pelo usuário (Chrome Web Store, Edge Add-ons, `.crx` ou pasta) mantêm as licenças dos respectivos autores.
