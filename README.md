# MultiHeiz

Navegador multi-janelas com sessões separadas para produtividade no Windows e no Linux. Cada janela (painel) tem cookies, login e cache próprios, lado a lado, com áreas de trabalho para organizar o que você usa no dia a dia.

## Funcionalidades

- Várias janelas lado a lado, organizadas em áreas de trabalho, com layout próprio por área
- **Tipo de sessão por área**: **Sessão independente** (cada janela com o próprio login, padrão) ou **Navegador convencional** (todas as janelas da área com a mesma sessão, como abas; começa vazia ou importa a sessão de uma janela existente)
- **Abrir nova janela com a mesma sessão** (mesmas contas, cookies e dados). Apagar uma janela não apaga a sessão enquanto outra ainda a usa
- Catálogo de apps prontos ao criar uma janela (WhatsApp, Gmail, X, etc.) ou site personalizado
- Proxy por janela (HTTP/HTTPS/SOCKS) e DNS criptografado (DoH)
- Permissões por site (microfone, câmera, notificações) com aviso dentro do app
- Volume por janela de 0 a 200%, contador de mensagens não lidas e menu do botão direito
- Barra lateral com seta (compacta/expandida) e pino (auto-esconder), ou modo legado
- Favoritos, histórico e downloads
- Bloqueador de anúncios embutido, com listas atualizáveis e listas por URL
- Ferramentas: Notas (estilo Keep), Alarmes e lembretes, Planilha
- Corretor LanguageTool nos campos de texto (campos de senha ficam de fora)
- Diagnóstico com um clique: relatório sem dados pessoais para anexar em issues
- Modo leve / desempenho e temas (Escuro, Claro, Grafite)
- Iniciar com o sistema (opcional, desligado por padrão)
- Atualizações automáticas e diferenciais (baixa só o que mudou) na versão instalada

## Recursos experimentais (em testes)

Estes recursos estão disponíveis, mas ainda em testes e podem falhar em alguns sites:

- **Extensões de terceiros** (Chrome Web Store, loja do Edge, `.crx` ou pasta): o Electron não oferece todas as APIs do Chrome/Edge. Extensões de bloqueio aplicam sobretudo as regras de rede; esconder elementos na página é limitado.
- **Bloquear anúncios do YouTube** (opção do bloqueador embutido): o YouTube muda com frequência; o bloqueio pode ser parcial.
- **IA para escrever** (corrigir, melhorar, reformular), desligada por padrão: usa a sua própria chave de API (Gemini, Groq, OpenRouter ou compatível com OpenAI) ou um modelo local (Ollama / LM Studio). As chaves ficam guardadas com a criptografia do sistema. Baixar o modelo pelo app: em breve.

## Download

Baixe a versão mais recente em [Releases](https://github.com/leoheiz/MultiHeiz/releases/latest):

| Plataforma | Arquivo |
|------------|---------|
| Windows | `MultiHeiz-<versão>-setup.exe` (instalador, recomendado) ou `MultiHeiz-<versão>-portable.exe` |
| Linux | `MultiHeiz-<versão>.AppImage` ou `multiheiz_<versão>_amd64.deb` |

Os hashes de todos os arquivos estão em `SHA256SUMS.txt` no release.

### Instalar ou atualizar por comando

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/leoheiz/MultiHeiz/main/install.ps1 | iex
```

Instala ou atualiza para o seu usuário e confere o SHA256 antes de instalar. Se o MultiHeiz já estiver instalado para todos os usuários, use (pede administrador):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/leoheiz/MultiHeiz/main/install.ps1))) -AllUsers
```

**winget (em breve, aguardando aprovação da Microsoft):**

```powershell
winget install leoheiz.MultiHeiz
winget upgrade leoheiz.MultiHeiz
```

**Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/leoheiz/MultiHeiz/main/install.sh | bash
```

Instala o AppImage em `~/.local/bin` com atalho no menu de aplicativos. Use `--deb` para instalar o pacote `.deb` e `--uninstall` para remover.

### Aviso "arquivo perigoso" (SmartScreen)

O MultiHeiz ainda não tem assinatura digital, por isso o Edge pode dizer que o arquivo "não é baixado com frequência" e o Windows pode mostrar "O Windows protegeu o seu PC". O aviso não significa que foi encontrado algo no arquivo, e sim que ele ainda não tem assinatura nem histórico de downloads. O código é aberto e você pode conferir o hash em `SHA256SUMS.txt`. Para continuar: no Edge, **Manter**; no Windows, **Mais informações → Executar assim mesmo**. A assinatura digital está nos planos.

## Atualizações

Na versão instalada (setup no Windows, AppImage no Linux), o app verifica atualizações no GitHub Releases (Configurações → Atualizações) e baixa só a parte que mudou. A versão portátil e o `.deb` avisam quando há versão nova; o portátil pode baixar o `.exe` novo pela tela de Atualizações.

## Dados do usuário

- Windows: `%APPDATA%\MultiHeiz\`
- Linux: `~/.config/MultiHeiz/`

Arquivo principal: `multiheiz-state.json`. Ao desinstalar, o instalador pergunta se você quer apagar esses dados (o padrão é manter).

## Problemas e sugestões

Em **Configurações → Diagnósticos**, gere o relatório de diagnóstico (sem dados pessoais, com prévia antes de salvar) e anexe na [issue](https://github.com/leoheiz/MultiHeiz/issues).

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
