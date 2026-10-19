# MultiHeiz

Navegador multi-janela / multi-conta para produtividade no Windows e Linux. Cada janela tem sessão própria (cookies, login, cache) em painéis lado a lado.

## Funcionalidades

- Várias janelas com sessões independentes e workspaces
- Barra de título integrada (workspaces + minimizar/maximizar/fechar)
- Favoritos, histórico e downloads
- Bloqueador de anúncios embutido com listas por URL
- Extensões (pasta, `.crx`, Chrome Web Store / Edge Add-ons)
- Módulos Planilha, Alarmes e Notas
- Modo leve / desempenho e temas
- Atualizações automáticas (instalador NSIS e AppImage)
- Botão Ko-fi para apoiar o projeto

## Download e instalação

Baixe a versão mais recente em [Releases](https://github.com/leoheiz/MultiHeiz/releases/latest):

| Plataforma | Artefato |
|------------|----------|
| Windows | `MultiHeiz-<versão>-setup.exe` (NSIS) ou `MultiHeiz-<versão>-portable.exe` |
| Linux | `MultiHeiz-<versão>.AppImage` ou `multiheiz_<versão>_amd64.deb` |

## Desenvolvimento

```bash
npm ci
npm start
```

### Build

```bash
npm ci
npm run dist:win    # NSIS + portable
npm run dist:linux  # AppImage + deb
```

Antes do build, `check:encoding` e limpeza de `dist/` rodam automaticamente. Depois, `tools/release.js` copia artefatos para `releases/<versão>/` (no-op em CI).

## Atualizações automáticas

Nas versões instaladas (NSIS no Windows, AppImage no Linux), o app verifica atualizações no GitHub Releases (Configurações → Atualizações). Portable e `.deb` só informam que há nova versão e abrem a página de downloads.

**Repositório privado:** enquanto o repositório (ou o de releases) for privado, os atualizadores dos usuários finais **não** conseguem ver as releases. As atualizações passam a funcionar para todos quando o repositório (ou um repositório público de releases) for público. Nenhum token do GitHub é embutido no app.

## Dados do usuário

- Windows: `%APPDATA%\MultiHeiz\`
- Linux: `~/.config/MultiHeiz/`

Arquivo principal: `multiheiz-state.json`.

## Apoiar

[Ko-fi — HeiZz](https://ko-fi.com/HeiZz)

## Licença

MIT — ver [LICENSE](LICENSE). Avisos de terceiros: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
