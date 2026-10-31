# hubsoft-mcp

**MCP, skill e CLI** não oficiais para o **[Hubsoft](https://hubsoft.io/)**, o ERP de provedores de internet. Com eles, a equipe do provedor pergunta em linguagem natural, em qualquer agente de IA, e recebe dados de clientes, serviços bloqueados, sessões RADIUS, ONUs, faturas, atendimentos, OS e notas fiscais.

> Projeto da comunidade, **sem vínculo com a Hubsoft Brasil LTDA**.
> Documentação oficial da API: <https://docs.hubsoft.com.br/>

```
"Como está o cliente 123.456.789-00?"
  → cadastro, plano e status, PPPoE, ONU/VLAN, sessão RADIUS e faturas vencidas, numa resposta só
"Quem está bloqueado por débito e quanto deve?"
  → lista filtrada no próprio Hubsoft, com dias suspenso e débito vencido de cada um
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

> ⚠️ **Usuários com 2FA não autenticam pela API.** O login OAuth do Hubsoft não tem campo para o código. Crie um usuário de API por pessoa (ex.: `fulano.api@provedor.com.br`), sem 2FA, com senha forte e **o mesmo perfil de permissões** do usuário dela.

Cada pessoa usa **o próprio login**. Não há "super usuário" compartilhado, e as credenciais ficam só no computador dela.

## Instalação

Nos exemplos abaixo, `HUBSOFT_MCP` é o comando do servidor:

```
npx -y github:maxthetor/hubsoft_mcp#v0.3.0
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
      "command": ["npx", "-y", "github:maxthetor/hubsoft_mcp#v0.3.0"],
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
      "args": ["-y", "github:maxthetor/hubsoft_mcp#v0.3.0"],
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
      "args": ["-y", "github:maxthetor/hubsoft_mcp#v0.3.0"],
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
args = ["-y", "github:maxthetor/hubsoft_mcp#v0.3.0"]
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
| `hubsoft_situacao_cliente` | **Visão 360°:** cadastro, serviços, endereço, PPPoE, ONU/VLAN/OLT, RADIUS e resumo financeiro (vencidas com dias de atraso, PIX e linha digitável; próxima a vencer) |
| `hubsoft_servicos_por_status` | **Bloqueados/suspensos** ou qualquer status, filtrado no servidor, com débito vencido opcional |
| `hubsoft_buscar_cliente` | Busca por CPF/CNPJ, código, nome, login, telefone… |
| `hubsoft_faturas_cliente` | Faturas, em resumo enxuto ou com `detalhado=true` |
| `hubsoft_atendimentos_cliente` | Atendimentos do cliente |
| `hubsoft_ordens_servico_cliente` | Ordens de serviço do cliente |
| `hubsoft_consulta` | GET genérico em `/api/v1/integracao/...` |
| `hubsoft_graphql_consultas` | Consultas GraphQL disponíveis **no seu Hubsoft**, lidas ao vivo |
| `hubsoft_graphql_tipo` | Campos de um tipo do esquema |
| `hubsoft_graphql` | Relatórios por período, POPs, CPEs, NFS-e, sessões RADIUS… |
| `hubsoft_desbloqueio_confianca` ✏️ | Desbloqueio em confiança |
| `hubsoft_enviar_fatura_email` ✏️ | Envia fatura por e-mail |

✏️ As ferramentas de escrita ficam **desligadas por padrão** (`HUBSOFT_READ_ONLY=true`). Quando ligadas, vêm marcadas como destrutivas, para o agente pedir confirmação. Todas as ferramentas têm `title` e `readOnlyHint`/`destructiveHint`.

**Atualizações do Hubsoft:** as ferramentas GraphQL leem o esquema **ao vivo**. Consultas novas que o Hubsoft lançar ficam disponíveis na hora, sem atualizar este projeto.

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `HUBSOFT_URL` | — | URL da API, ex.: `https://api.seuprovedor.hubsoft.com.br` |
| `HUBSOFT_CLIENT_ID` | — | Client ID do provedor |
| `HUBSOFT_CLIENT_SECRET` | — | Client secret do provedor |
| `HUBSOFT_USERNAME` | — | **Seu** usuário de API |
| `HUBSOFT_PASSWORD` | — | **Sua** senha |
| `HUBSOFT_READ_ONLY` | `true` | `false` habilita as ferramentas de escrita |
| `HUBSOFT_GRAPHQL_PATH` | `/graphql/v1` | `off` desativa o GraphQL |
| `HUBSOFT_EXPOR_SENHAS` | `false` | `true` mostra senhas (ex.: PPPoE) nas respostas |
| `HUBSOFT_MAX_RESPONSE_CHARS` | `60000` | Limite de tamanho das respostas |

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
