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

## Ícones

Ícones Lucide — ISC ([lucide.dev](https://lucide.dev)).

## Extensões de terceiros

A camada de carregamento em `src/main/extensions/` é MIT (própria). Extensões instaladas pelo usuário mantêm as licenças dos respectivos autores.
