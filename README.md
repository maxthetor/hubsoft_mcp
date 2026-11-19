# hubsoft-mcp

**MCP, skill e CLI** não oficiais para o **[Hubsoft](https://hubsoft.io/)**, o ERP de provedores de internet. Com eles, a equipe do provedor pergunta em linguagem natural, em qualquer agente de IA, e recebe dados de clientes, serviços bloqueados, sessões RADIUS, ONUs, faturas, atendimentos, OS e notas fiscais.

> Projeto da comunidade, **sem vínculo com a Hubsoft Brasil LTDA**.
> Documentação oficial da API: <https://docs.hubsoft.com.br/>

```
"Como está o cliente 123.456.789-00?"
  → cadastro, plano e status, PPPoE, ONU/VLAN, sessão RADIUS e faturas vencidas, numa resposta só
"Quem está bloqueado por débito e quanto deve?"
  → lista filtrada no próprio Hubsoft, com dias suspenso e débito vencido de cada um
"Quanto recebemos por mês este ano, em cada base e no total?"
  → hubsoft_resumo_financeiro soma no servidor e devolve só os totais
"Procure o CPF 123… em todas as bases" / "…só na minha base pessoa física"
  → consulta várias bases Hubsoft em paralelo, ou só a base citada
```

## O que vem no projeto

| Peça | O que é | Para quem |
|---|---|---|
| **Servidor MCP** (`server/hubsoft-mcp.mjs`) | As ferramentas `hubsoft_*` pelo protocolo aberto MCP | Qualquer agente com suporte a MCP |
| **Skill** (`skills/hubsoft/`) | Conhecimento do domínio no padrão aberto [Agent Skills](https://agentskills.io): qual ferramenta usar, armadilhas da API, regras de LGPD | Agentes com suporte a skills |
| **CLI** (`skills/hubsoft/scripts/hubsoft.mjs`) | As mesmas ferramentas pela linha de comando; vem dentro da skill | Agentes com terminal, mas sem MCP, e scripts |
| **Plugin do Claude** (`.claude-plugin/`) | MCP + skill num pacote, com configuração guiada | Claude Code e Cowork |
| **Extensão `.mcpb`** | MCP com instalação de um clique | Claude Desktop |

O servidor e a CLI são **arquivos únicos**: só precisam de Node.js 18+, sem `npm install`. A extensão `.mcpb` nem isso, porque o Claude Desktop já traz o Node.

## Compatibilidade

| Agente | Plugin | MCP | Skill (+CLI) | Como instalar |
|---|:-:|:-:|:-:|---|
| **Claude Code** | ✅ | ✅ | ✅ | [Plugin](#claude-code-plugin) (MCP + skill juntos) |
| **Cowork** (Claude Desktop) | ✅ | ✅ | ✅ | Plugin |
| **Claude Desktop** (chat) | — | ✅ | — | [Extensão `.mcpb`](#claude-desktop) |
| **OpenCode** | — | ✅ | ✅ | [MCP + skill](#opencode) |
| **Cursor** | — | ✅ | ✅ | [MCP + skill](#cursor-lm-studio-gemini-cli) |
| **VS Code / GitHub Copilot** | — | ✅ | ✅ | [MCP + skill](#vs-code--github-copilot) |
| **Codex CLI** | — | ✅ | ✅ | [MCP + skill](#codex-cli) |
| **Gemini CLI** | — | ✅ | ✅ | [MCP + skill](#cursor-lm-studio-gemini-cli) |
| **LM Studio** | — | ✅ | — | [MCP](#cursor-lm-studio-gemini-cli) |
| **n8n** | — | ⚠️ | — | MCP local (stdio) via nó comunitário ou gateway stdio→HTTP |
| Outro agente com terminal | — | — | ✅ | [Skill + CLI](#skill--cli-qualquer-agente) |

**Regra geral:** use o plugin onde existir. Fora dele, instale **MCP + skill**: a skill traz o conhecimento e o MCP traz a execução. Sem MCP, a skill usa a CLI.

## Pré-requisitos no Hubsoft

O administrador do provedor precisa:

1. criar um **cliente de API** (client ID e secret) e marcar **"Permite acesso à API GraphQL"**;
2. fornecer a cada pessoa um **usuário com acesso à API**.

### Usuários com 2FA

Funciona do mesmo jeito que no MCP oficial do Hubsoft. O código do app autenticador vai no campo `one_time_password` do login OAuth, e **só é pedido no primeiro acesso**:

1. Na primeira vez, quando o Hubsoft recusa o login (HTTP 401), **o MCP abre uma janela pedindo o código**, com o nome e o endereço da base. Digite o código e clique em Conectar. A mesma consulta continua normalmente.
   - **Windows:** uma caixa de diálogo sempre na frente. **macOS:** um `display dialog`. **Linux:** zenity ou kdialog, se houver interface gráfica.
   - **Sem interface gráfica:** usa o formulário MCP (*elicitation*) do cliente, se ele suportar (Claude Code CLI, VS Code). O Claude Desktop/Cowork ainda não mostra elicitation, por isso a janela vem antes.
   - **Na CLI com terminal:** pergunta no próprio terminal.
   - Com várias bases, as janelas aparecem uma de cada vez. Um código recusado é pedido de novo, até 3 vezes. Se você **cancelar**, a base não pergunta de novo por 10 minutos.
   - **Alternativa manual:** `hubsoft_conectar { servidor: "base_pf", codigo_2fa: "123456" }`, ou pela CLI `hubsoft conectar --servidor base_pf --codigo_2fa 123456`.
2. O access token (30 dias) e o `refresh_token` ficam salvos em `~/.config/hubsoft/tokens.json` (permissão 0600). Quando o token vence, o MCP renova pelo refresh, sem pedir código. O refresh é de uso único: o novo é gravado na hora.
3. O código só volta a ser pedido se o refresh expirar ou for revogado.

**Opcional, login sem interação:** informe a semente TOTP em `HUBSOFT_OTP_SECRET` (por base: `HUBSOFT_2_OTP_SECRET`… ou `"otp_secret"` no `servidores.json`). Aceita o texto base32 ou a URI `otpauth://` do QR code, e o código é gerado sozinho. Atenção: com a semente no mesmo computador que a senha, o segundo fator deixa de ser independente. Prefira `hubsoft_conectar`, a menos que precise de uso sem ninguém por perto.

`hubsoft_servidores` mostra o estado de cada base (token válido até quando, refresh salvo, 2FA automático), sem expor tokens.

Cada pessoa usa **o próprio login**. Não há "super usuário" compartilhado, e as credenciais ficam só no computador dela.

## Várias bases (multi-servidor)

Provedores com mais de uma base Hubsoft (ex.: `base_pf`, `base_pj`, `base_vtal`) configuram todas de uma vez. Cada base tem:

- **nome** curto: usado no parâmetro `servidor`;
- **descrição**: o agente usa para escolher a base. "Procure na minha base pessoa física" consulta só a base cuja descrição diz "pessoa física".

Comportamento:

- **Sem indicar base**, a consulta roda em **todas em paralelo** e o resultado vem agrupado por base (`resultados.<base>`, `nao_encontrado_em`, `erros`). Uma base fora do ar não derruba as outras.
- **Indicando base** (`servidor: "base_pf"`, `"base_pf,base_pj"` ou pela descrição), consulta só as bases citadas.
- **Ações que alteram dados** (desbloqueio, envio de fatura) exigem uma única base.
- `hubsoft_servidores` lista as bases e, com `testar=true`, verifica o login em cada uma.

Como configurar:

| Onde | Como |
|---|---|
| Plugin do Claude e extensão `.mcpb` | A tela de configuração tem **3 servidores** (o 1º obrigatório, o 2º e o 3º opcionais). Para mais de 3, aponte um `servidores.json` no campo "Arquivo com mais servidores". |
| Variáveis de ambiente | Servidor 1: `HUBSOFT_NOME`, `HUBSOFT_DESCRICAO`, `HUBSOFT_URL`, …. Servidores 2 a 9: `HUBSOFT_2_NOME`, `HUBSOFT_2_URL`, `HUBSOFT_2_CLIENT_ID`, …. |
| Arquivo (sem limite) | `~/.config/hubsoft/servidores.json`, ou o caminho em `HUBSOFT_CONFIG`. Exemplo abaixo. |

```json
{
  "servidores": [
    { "nome": "base_pf", "descricao": "Clientes pessoa física", "url": "https://api.pf.seuprovedor.com.br",
      "client_id": "1", "client_secret": "{env:HS_PF_SECRET}", "usuario": "voce.api@provedor.com.br", "senha": "{env:HS_PF_SENHA}" },
    { "nome": "base_pj", "descricao": "Clientes pessoa jurídica", "url": "https://api.pj.seuprovedor.com.br",
      "client_id": "7", "client_secret": "{env:HS_PJ_SECRET}", "usuario": "voce.api@provedor.com.br", "senha": "{env:HS_PJ_SENHA}" }
  ]
}
```

`{env:VAR}` lê o valor de uma variável de ambiente, para não gravar segredos no arquivo. Se gravar, proteja com `chmod 600`.

Com uma base só, nada muda: as respostas são as mesmas da v0.3.

## Instalação

Nos exemplos abaixo, `HUBSOFT_MCP` é o comando do servidor:

```
npx -y github:maxthetor/hubsoft_mcp#v0.9.0
```

Ou clone o repositório e use `node /caminho/hubsoft_mcp/server/hubsoft-mcp.mjs`.

Variáveis: `HUBSOFT_URL`, `HUBSOFT_CLIENT_ID`, `HUBSOFT_CLIENT_SECRET`, `HUBSOFT_USERNAME`, `HUBSOFT_PASSWORD` ([todas as opções](#configuração)).

### Claude Code (plugin)

```
/plugin install hubsoft --marketplace maxthetor/hubsoft_mcp
```

Em versões anteriores à 2.1.275: `/plugin marketplace add maxthetor/hubsoft_mcp` e depois `/plugin install hubsoft@hubsoft-mcp`. O Claude Code pede URL, client ID, secret, usuário e senha; os campos secretos vão para o armazenamento seguro do sistema.

### Claude Desktop

Baixe o `hubsoft-mcp.mcpb` da [última release](https://github.com/maxthetor/hubsoft_mcp/releases/latest), dê dois cliques e preencha os campos.

### OpenCode

`~/.config/opencode/opencode.json` (ou `opencode.json` no projeto):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hubsoft": {
      "type": "local",
      "command": ["npx", "-y", "github:maxthetor/hubsoft_mcp#v0.9.0"],
      "enabled": true,
      "environment": {
        "HUBSOFT_URL": "https://api.seuprovedor.hubsoft.com.br",
        "HUBSOFT_CLIENT_ID": "...",
        "HUBSOFT_CLIENT_SECRET": "{env:HUBSOFT_CLIENT_SECRET}",
        "HUBSOFT_USERNAME": "voce.api@provedor.com.br",
        "HUBSOFT_PASSWORD": "{env:HUBSOFT_PASSWORD}"
      }
    }
  }
}
```

Skill: copie `skills/hubsoft/` para `~/.config/opencode/skills/hubsoft/`. O OpenCode também lê `.claude/skills/`.

### Cursor, LM Studio, Gemini CLI

`~/.cursor/mcp.json`, `mcp.json` do LM Studio ou `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "hubsoft": {
      "command": "npx",
      "args": ["-y", "github:maxthetor/hubsoft_mcp#v0.9.0"],
      "env": {
        "HUBSOFT_URL": "https://api.seuprovedor.hubsoft.com.br",
        "HUBSOFT_CLIENT_ID": "...",
        "HUBSOFT_CLIENT_SECRET": "...",
        "HUBSOFT_USERNAME": "voce.api@provedor.com.br",
        "HUBSOFT_PASSWORD": "..."
      }
    }
  }
}
```

Skill: `.cursor/skills/hubsoft/` (Cursor) ou `~/.gemini/skills/hubsoft/` (Gemini CLI).

### VS Code / GitHub Copilot

`.vscode/mcp.json`. O VS Code pede o secret e a senha e os guarda com segurança:

```json
{
  "inputs": [
    { "id": "hs-secret", "type": "promptString", "description": "Hubsoft client secret", "password": true },
    { "id": "hs-pass", "type": "promptString", "description": "Sua senha do Hubsoft", "password": true }
  ],
  "servers": {
    "hubsoft": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:maxthetor/hubsoft_mcp#v0.9.0"],
      "env": {
        "HUBSOFT_URL": "https://api.seuprovedor.hubsoft.com.br",
        "HUBSOFT_CLIENT_ID": "...",
        "HUBSOFT_CLIENT_SECRET": "${input:hs-secret}",
        "HUBSOFT_USERNAME": "voce.api@provedor.com.br",
        "HUBSOFT_PASSWORD": "${input:hs-pass}"
      }
    }
  }
}
```

Skill: `.github/skills/hubsoft/`.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.hubsoft]
command = "npx"
args = ["-y", "github:maxthetor/hubsoft_mcp#v0.9.0"]
env = { HUBSOFT_URL = "https://api.seuprovedor.hubsoft.com.br", HUBSOFT_CLIENT_ID = "...", HUBSOFT_CLIENT_SECRET = "...", HUBSOFT_USERNAME = "voce.api@provedor.com.br", HUBSOFT_PASSWORD = "..." }
```

Skill: `~/.codex/skills/hubsoft/` (ou `.agents/skills/hubsoft/` no projeto).

### Skill + CLI (qualquer agente)

1. Copie a pasta `skills/hubsoft/` para o diretório de skills do seu agente. Ou baixe `hubsoft-skill.zip` da [release](https://github.com/maxthetor/hubsoft_mcp/releases/latest).
2. Crie `~/.config/hubsoft/.env` com as variáveis (`chmod 600`).
3. Teste: `node skills/hubsoft/scripts/hubsoft.mjs consulta --rota configuracao/servico_status`.

```bash
node scripts/hubsoft.mjs ferramentas
node scripts/hubsoft.mjs situacao_cliente --cpf_cnpj 12345678900
node scripts/hubsoft.mjs servicos_por_status --status suspenso_debito --incluir_faturas_vencidas
node scripts/hubsoft.mjs graphql --query '{ pops(first: 10) { data { id_pop } } }'
```

## Ferramentas

| Ferramenta | Descrição |
|---|---|
| `hubsoft_servidores` | Lista as bases configuradas; `testar=true` verifica o login em cada uma |
| `hubsoft_situacao_cliente` | **Visão 360°:** cadastro, serviços, endereço, PPPoE, ONU/VLAN/OLT, RADIUS e resumo financeiro (vencidas com dias de atraso, PIX e linha digitável; próxima a vencer) |
| `hubsoft_resumo_financeiro` | **Totais por período** (dia/mês/ano): faturas pagas ou vencidas, total pago, faturado, em aberto e vencido. Pagina e soma no servidor; com várias bases, consolida |
| `hubsoft_clientes_ativos_sem_servico_ativo` | Clientes com **cadastro ativo e nenhum serviço ativo**: varre a base inteira no servidor e devolve código, nome, CPF/CNPJ e status dos serviços |
| `hubsoft_servicos_por_status` | **Bloqueados/suspensos** ou qualquer status, filtrado no servidor, com débito vencido opcional |
| `hubsoft_buscar_cliente` | Busca por CPF/CNPJ, código, nome, login, telefone… |
| `hubsoft_faturas_cliente` | Faturas, em resumo enxuto ou com `detalhado=true` |
| `hubsoft_atendimentos_cliente` | Atendimentos do cliente |
| `hubsoft_ordens_servico_cliente` | Ordens de serviço do cliente |
| `hubsoft_consulta` | GET genérico em `/api/v1/integracao/...` |
| `hubsoft_graphql_consultas` | Consultas GraphQL disponíveis **no seu Hubsoft**, lidas ao vivo |
| `hubsoft_graphql_tipo` | Campos de um tipo do esquema |
| `hubsoft_graphql` | Relatórios por período, POPs, CPEs, NFS-e, sessões RADIUS… |
| `hubsoft_conectar` | Login com 2FA manual (normalmente não é preciso: uma janela pede o código sozinha) |
| `hubsoft_cpe_iniciar_gerenciamento` | Parâmetros gerenciáveis da CPE via ACS (Wi-Fi etc.), senhas mascaradas |
| `hubsoft_desbloqueio_confianca` ✏️ | Desbloqueio em confiança |
| `hubsoft_enviar_fatura_email` ✏️ | Envia fatura por e-mail |
| `hubsoft_configurar_autenticacao` ✏️ | `phy_addr`, interface (PON), login, senha e observações da autenticação |
| `hubsoft_vincular_cpe` ✏️ | Vincula a CPE ao serviço; o Hubsoft preenche OLT, PON e roteamento sozinho |
| `hubsoft_desvincular_cpe` ✏️⚠️ | Desvincula CPE(s); zera o `phy_addr` se for a CPE da autenticação |
| `hubsoft_reiniciar_cpe` ✏️⚠️ | Reinicia a CPE (cliente fica sem conexão durante o reboot) |
| `hubsoft_restaurar_cpe` ✏️⚠️ | Restaura a CPE para fábrica (exige `confirmar_phy_addr`) |
| `hubsoft_cpe_gerenciar` ✏️ | Altera parâmetros da CPE via ACS (SSID, senha Wi-Fi…) |

Com 2 ou mais bases, todas as ferramentas aceitam o parâmetro `servidor` (padrão: todas).

✏️ = escrita/controle, **desligada por padrão**. ⚠️ = destrutiva. Detalhes em [Escrita e controle de CPE](#escrita-e-controle-de-cpe). Todas as ferramentas têm `title` e `readOnlyHint`/`destructiveHint`/`idempotentHint`.

**Atualizações do Hubsoft:** as ferramentas GraphQL leem o esquema **ao vivo**. Consultas novas que o Hubsoft lançar ficam disponíveis na hora, sem atualizar este projeto.

## Escrita e controle de CPE

Serve para vincular ONTs/ONUs **já autorizadas na OLT** aos serviços do Hubsoft **sem desprovisionar**, e para controlar a CPE pelo Hubsoft. As regras valem para todas as ferramentas ✏️:

1. **Desligada por padrão.** As ferramentas só existem com `HUBSOFT_PERMITIR_ESCRITA=true`, global ou por base.
2. **Uma base por vez.** `servidor` é obrigatório e precisa ser o nome exato de uma base. `"todos"`, listas e vazio são recusados, mesmo com uma base só.
3. **Simulação primeiro.** Com `confirmar=false` (padrão), **nada é enviado**: a ferramenta lê o estado atual e mostra método, URL e corpo exatos, o efeito esperado e os avisos. Com `confirmar=true` ela executa, lê de novo e devolve o **diff antes/depois**.
4. **Leitura antes e depois.** O serviço é lido com as relações `interface`, `equipamento_conexao`, `interface_roteamento`, `equipamento_roteamento` e `cpes`. A CPE é lida pelo `phy_addr` em `rede/cpe/todos`.
5. **Erros visíveis.** O status HTTP e a resposta do Hubsoft vêm na íntegra (`status`, `msg`, `data`).
6. **Sem nova tentativa em POST.** Única exceção: um 401 renova o token **uma vez** e reenvia. Um 429 devolve o `retry_after` e não repete.
7. **Auditoria.** Cada execução (`confirmar=true`) vira uma linha em `HUBSOFT_AUDITORIA`, com data/hora, base, ferramenta, URL, corpo, status, resposta e diff. Tokens, `client_secret` e senhas aparecem como `***`.
8. **Senhas.** A `password` da autenticação nunca é exibida. Senhas de Wi-Fi vêm mascaradas; só aparecem com `mostrar_senhas=true`.

### Exemplo: vincular uma ONU já autorizada

```
1. hubsoft_configurar_autenticacao { servidor: "base_pf", id_cliente_servico: 1373, phy_addr: "ALCLFC203278" }
   → simulação: phy_addr atual → "ALCLFC203278"; avisa se a CPE já estiver vinculada a outro serviço
2. (mesma chamada) + confirmar: true
   → "Parâmetros de autenticação modificados com sucesso." + diff
3. hubsoft_vincular_cpe { servidor: "base_pf", id_cliente_servico: 1373 }            → simulação
4. hubsoft_vincular_cpe { servidor: "base_pf", id_cliente_servico: 1373, confirmar: true }
   → "CPE vinculada com sucesso à autenticação do cliente!" e o diff mostra OLT, PON e BNG/VLAN preenchidos
```

Na simulação, `hubsoft_desvincular_cpe` mostra o rollback pronto: `configurar_autenticacao` com o `phy_addr` e o `id_interface_conexao` atuais, seguido de `vincular_cpe`.

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `HUBSOFT_NOME` | `principal` | Nome curto da base (com várias bases) |
| `HUBSOFT_DESCRICAO` | — | Descrição da base, ex.: "Clientes pessoa física" |
| `HUBSOFT_URL` | — | URL da API, ex.: `https://api.seuprovedor.hubsoft.com.br` |
| `HUBSOFT_CLIENT_ID` | — | Client ID do provedor |
| `HUBSOFT_CLIENT_SECRET` | — | Client secret do provedor |
| `HUBSOFT_USERNAME` | — | **Seu** usuário de API |
| `HUBSOFT_PASSWORD` | — | **Sua** senha |
| `HUBSOFT_OTP_SECRET` | — | Opcional: semente 2FA (base32 ou `otpauth://`) para gerar o código sozinho. Sem ela, use `hubsoft_conectar` |
| `HUBSOFT_2FA_DIALOGO` | `auto` | Como pedir o código 2FA: `auto` (comando → terminal → janela → elicitation), `janela`, `elicitation` ou `off` |
| `HUBSOFT_2FA_COMANDO` | — | Comando que imprime o código, ex.: `op item get "Hubsoft" --otp` (1Password). Recebe `HUBSOFT_2FA_BASE`, `HUBSOFT_2FA_HOST` e `HUBSOFT_2FA_USUARIO` |
| `HUBSOFT_TOKENS` | `~/.config/hubsoft/tokens.json` | Onde os tokens OAuth ficam salvos; `off` guarda só em memória (o 2FA será pedido a cada reinício) |
| `HUBSOFT_PERMITIR_ESCRITA` | `false` | `true` habilita as ferramentas ✏️ em todas as bases. Por base: `HUBSOFT_2_PERMITIR_ESCRITA`… ou `"permitir_escrita"` no `servidores.json` (a configuração por base vence a global). O legado `HUBSOFT_READ_ONLY=false` continua aceito |
| `HUBSOFT_AUDITORIA` | `~/.config/hubsoft/auditoria.jsonl` | Log JSONL das escritas executadas; `off` desativa |
| `HUBSOFT_GRAPHQL_PATH` | `/graphql/v1` | `off` desativa o GraphQL |
| `HUBSOFT_EXPOR_SENHAS` | `false` | `true` mostra senhas (ex.: PPPoE) nas respostas |
| `HUBSOFT_MAX_RESPONSE_CHARS` | `60000` | Limite de tamanho das respostas |
| `HUBSOFT_2_*` … `HUBSOFT_9_*` | — | Bases adicionais (mesmos sufixos: `NOME`, `DESCRICAO`, `URL`, `CLIENT_ID`, `CLIENT_SECRET`, `USERNAME`, `PASSWORD`, `OTP_SECRET`, `GRAPHQL_PATH`, `PERMITIR_ESCRITA`) |
| `HUBSOFT_CONFIG` | `~/.config/hubsoft/servidores.json` | Arquivo com a lista de bases |
| `HUBSOFT_SERVIDOR` | primeira | Base usada por `npm run probe` e `npm run schema` |

## Desenvolvimento

```bash
npm install
npm test          # build + bundles + testes ponta a ponta (MCP e CLI) com um Hubsoft simulado
npm run probe     # diagnóstico contra um Hubsoft real (sem exibir dados de clientes)
npm run schema    # exporta o esquema GraphQL para hubsoft-schema.json
npm run inspect   # MCP Inspector
```

O código-fonte fica em `src/`. Os arquivos `server/hubsoft-mcp.mjs` e `skills/hubsoft/scripts/hubsoft.mjs` são **gerados** pelo `npm run build` e versionados; o CI confere se estão em dia.

**Release:** altere `version` no `package.json`, no `manifest.json` e no `.claude-plugin/plugin.json`, rode `npm run build` e faça push na `main`. O GitHub Actions testa, cria a tag e publica `hubsoft-mcp.mcpb` e `hubsoft-skill.zip`.

## Privacidade

O projeto roda **no seu computador**, não tem servidor próprio e não coleta dados nem telemetria. Os dados trafegam só entre o seu computador, a API do Hubsoft do seu provedor e o agente de IA que você escolheu. Senhas retornadas pelo Hubsoft (ex.: PPPoE) são mascaradas por padrão. Veja a [Política de Privacidade](PRIVACY.md).

## Suporte

Abra uma [issue](https://github.com/maxthetor/hubsoft_mcp/issues).

## Licença

[MIT](LICENSE)
