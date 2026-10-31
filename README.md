# hubsoft-mcp

Servidor **MCP** não oficial para o **[Hubsoft](https://hubsoft.io/)**, o ERP de provedores de internet. Com ele, a equipe do provedor pergunta ao Claude (ou a outro cliente MCP) em linguagem natural e recebe dados de clientes, serviços, sessões RADIUS, ONUs, faturas, atendimentos, OS e notas fiscais.

> Projeto da comunidade, **sem vínculo com a Hubsoft Brasil LTDA**.
> Documentação oficial da API: <https://docs.hubsoft.com.br/>

```
"Como está o cliente 123.456.789-00?"
  → cadastro, plano e status, login PPPoE, ONU e VLAN, sessão RADIUS (online, IP, NAS)
    e faturas em aberto, numa resposta só.
```

## Como funciona

```
Claude  ⇄  hubsoft-mcp (no seu computador)  ⇄  API do Hubsoft do seu provedor
```

O MCP roda **no computador de quem usa** e faz login no Hubsoft com **o usuário dessa pessoa**:

- não há um "super usuário" compartilhado;
- o acesso segue o perfil de permissões que o Hubsoft aplica à API para aquele usuário;
- as credenciais ficam só naquele computador (no Claude Desktop, guardadas no cofre do sistema operacional).

## Instalação

### Claude Desktop (recomendado, não precisa de Node.js)

1. Baixe o `hubsoft-mcp.mcpb` da [última release](https://github.com/maxthetor/hubsoft_mcp/releases/latest).
2. Dê dois cliques no arquivo (ou arraste para *Configurações → Extensões*).
3. Preencha URL da API, client ID, client secret, **seu** usuário e **sua** senha.

O Claude Desktop já traz o Node.js embutido para rodar extensões.

### Claude Code

```bash
claude mcp add hubsoft \
  -e HUBSOFT_URL=https://api.seuprovedor.hubsoft.com.br \
  -e HUBSOFT_CLIENT_ID=... -e HUBSOFT_CLIENT_SECRET=... \
  -e HUBSOFT_USERNAME=voce@provedor.com.br -e HUBSOFT_PASSWORD=... \
  -- npx -y github:maxthetor/hubsoft_mcp
```

## Pré-requisitos no Hubsoft

O administrador do provedor precisa:

1. Criar um **cliente de API** (client ID e secret) e marcar **"Permite acesso à API GraphQL"**.
2. Fornecer a cada pessoa um **usuário com acesso à API**.

> ⚠️ **Usuários com 2FA não autenticam pela API.** O login OAuth do Hubsoft não tem campo para o código. Crie um usuário de API por pessoa (ex.: `fulano.api@provedor.com.br`), sem 2FA, com senha forte e **o mesmo perfil de permissões** do usuário dela.

## Ferramentas

| Ferramenta | Descrição |
|---|---|
| `hubsoft_situacao_cliente` | **Visão 360°:** cadastro, serviços, endereço, PPPoE, ONU/VLAN/OLT, RADIUS e faturas em aberto |
| `hubsoft_buscar_cliente` | Busca por CPF/CNPJ, código, nome, login, telefone… |
| `hubsoft_faturas_cliente` | Faturas em aberto ou histórico |
| `hubsoft_atendimentos_cliente` | Atendimentos do cliente |
| `hubsoft_ordens_servico_cliente` | Ordens de serviço do cliente |
| `hubsoft_consulta` | GET genérico em `/api/v1/integracao/...` |
| `hubsoft_graphql_consultas` | Lista as consultas GraphQL disponíveis **no seu Hubsoft** |
| `hubsoft_graphql_tipo` | Campos de um tipo do esquema |
| `hubsoft_graphql` | Executa consultas: relatórios por período, POPs, CPEs, NFS-e, sessões RADIUS… |
| `hubsoft_desbloqueio_confianca` ✏️ | Desbloqueio em confiança |
| `hubsoft_enviar_fatura_email` ✏️ | Envia fatura por e-mail |

✏️ As ferramentas de escrita ficam **desligadas por padrão** (`HUBSOFT_READ_ONLY=true`). Quando ligadas, vêm marcadas como destrutivas, para o cliente pedir confirmação antes de executar.

**Atualizações do Hubsoft:** as ferramentas GraphQL leem o esquema **ao vivo** no servidor do provedor. Consultas novas que o Hubsoft lançar ficam disponíveis na hora, sem atualizar este projeto.

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

## Diagnóstico

```bash
git clone https://github.com/maxthetor/hubsoft_mcp && cd hubsoft_mcp && npm install
# defina as variáveis HUBSOFT_* e rode:
npm run probe     # valida login, rotas REST e GraphQL (sem exibir dados de clientes)
npm run schema    # exporta o esquema GraphQL para hubsoft-schema.json
```

## Desenvolvimento

```bash
npm install
npm test          # build + teste ponta a ponta com um Hubsoft simulado
npm run inspect   # MCP Inspector
npm run pack      # gera hubsoft-mcp.mcpb
```

**Release:** altere `version` no `package.json` e no `manifest.json` e faça push na `main`. O GitHub Actions roda os testes, cria a tag e publica o `.mcpb` na página de releases.

## Segurança e LGPD

- Senhas retornadas pelo Hubsoft (ex.: PPPoE) são **mascaradas por padrão**.
- As respostas contêm dados pessoais de assinantes. Prefira o modo somente leitura e peça só o necessário.
- Nunca versione credenciais. O `.gitignore` já ignora `.env` e `hubsoft-schema.json`.

## Limites da API

- Autenticação: 30 req/min por IP. O token (válido por 30 dias) fica em cache.
- Demais rotas: 20 req/s por IP.

## Licença

[MIT](LICENSE)
