# MultiHeiz

Navegador multi-janelas com sessões separadas para produtividade no Windows e no Linux. Cada janela (painel) tem cookies, login e cache próprios, lado a lado, com workspaces para organizar o que você usa no dia a dia.

## Funcionalidades

- Várias janelas com sessões independentes e workspaces
- Barra de título integrada (workspaces + minimizar / maximizar / fechar)
- Favoritos, histórico e downloads
- Bloqueador de anúncios embutido, com listas atualizáveis e listas por URL
- Módulos Planilha, Alarmes e Notas
- Modo leve / desempenho e temas (Escuro, Claro, Grafite)
- Atualizações automáticas (instalador NSIS no Windows e AppImage no Linux)

## Recursos experimentais (em testes)

Estes recursos estão disponíveis, mas ainda em testes e podem falhar em alguns sites:

- **Extensões de terceiros** (pasta descompactada, `.crx`, Chrome Web Store ou Edge Add-ons): o Electron não oferece todas as APIs do Chrome/Edge. Extensões de bloqueio aplicam sobretudo as regras de rede; esconder elementos na página (cosmético) é limitado.
- **Bloquear anúncios do YouTube** (opção do bloqueador embutido): o YouTube muda com frequência; o bloqueio pode ser parcial.

## Download

Baixe a versão mais recente em [Releases](https://github.com/leoheiz/MultiHeiz/releases/latest):

| Plataforma | Arquivo |
|------------|---------|
| Windows | `MultiHeiz-<versão>-setup.exe` (instalador) ou `MultiHeiz-<versão>-portable.exe` |
| Linux | `MultiHeiz-<versão>.AppImage` ou `multiheiz_<versão>_amd64.deb` |

## Atualizações

Nas versões instaladas (NSIS no Windows, AppImage no Linux), o app verifica atualizações no GitHub Releases (Configurações → Atualizações). As versões portable e `.deb` avisam quando há versão nova e abrem a página de downloads.

## Dados do usuário

- Windows: `%APPDATA%\MultiHeiz\`
- Linux: `~/.config/MultiHeiz/`

Arquivo principal: `multiheiz-state.json`.

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

## Licença

MIT — ver [LICENSE](LICENSE). Avisos de terceiros: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Apoie o desenvolvedor

O MultiHeiz é grátis. Se quiser ajudar o desenvolvedor: [Ko-fi / HeiZz](https://ko-fi.com/HeiZz) (opcional).
