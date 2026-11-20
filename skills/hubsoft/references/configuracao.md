# Configuração de credenciais

O administrador do provedor cria no Hubsoft:

1. um **cliente de API** (client ID e client secret), com "Permite acesso à API GraphQL" marcado;
2. para cada pessoa, um **usuário com acesso à API**.

> Usuários com **2FA**: no primeiro acesso a CLI pergunta o código no terminal (ou abre uma janela). Também dá para rodar `hubsoft conectar --servidor <base> --codigo_2fa <código do app>`. O token e o refresh ficam em `~/.config/hubsoft/tokens.json` e são renovados sozinhos. Alternativa sem interação: `HUBSOFT_OTP_SECRET` com a semente TOTP.

## Variáveis

| Variável | Obrigatória | Descrição |
|---|---|---|
| `HUBSOFT_URL` | sim | Ex.: `https://api.seuprovedor.hubsoft.com.br` |
| `HUBSOFT_CLIENT_ID` | sim | Client ID |
| `HUBSOFT_CLIENT_SECRET` | sim | Client secret |
| `HUBSOFT_USERNAME` | sim | Usuário de API da pessoa |
| `HUBSOFT_PASSWORD` | sim | Senha |
| `HUBSOFT_OTP_SECRET` | não | Semente 2FA (base32 ou otpauth://) para gerar o código sozinho |
| `HUBSOFT_2FA_DIALOGO` | não | `auto` (padrão), `navegador`, `janela`, `elicitation` ou `off` |
| `HUBSOFT_2FA_COMANDO` | não | Comando que imprime o código 2FA (ex.: `op item get "Hubsoft" --otp`) |
| `HUBSOFT_TOKENS` | não | Arquivo dos tokens salvos (padrão `~/.config/hubsoft/tokens.json`; `off` = só memória) |
| `HUBSOFT_PERMITIR_ESCRITA` | não | `true` habilita as ferramentas de escrita/CPE (padrão: desligado). Por base: `HUBSOFT_2_PERMITIR_ESCRITA` ou `"permitir_escrita": true` no servidores.json |
| `HUBSOFT_AUDITORIA` | não | Log JSONL das escritas (padrão `~/.config/hubsoft/auditoria.jsonl`; `off` desativa) |
| `HUBSOFT_EXPORT_DIR` | não | Pasta dos CSV das ferramentas `exportar_*` (padrão `~/hubsoft-exportacoes`) |
| `HUBSOFT_EXPORT_REQ_S` | não | Limite de requisições por segundo por base nas exportações (padrão `20`, usado com 10% de folga) |
| `HUBSOFT_EXPORT_PARALELO` | não | Páginas buscadas ao mesmo tempo nas exportações (padrão `4`, máx. `10`) |
| `HUBSOFT_GRAPHQL_PATH` | não | Padrão `/graphql/v1`; `off` desativa |
| `HUBSOFT_EXPOR_SENHAS` | não | `true` mostra senhas PPPoE (padrão: mascaradas) |

## Para a CLI

Crie `~/.config/hubsoft/.env` (permissão restrita, ex.: `chmod 600`):

```
HUBSOFT_URL=https://api.seuprovedor.hubsoft.com.br
HUBSOFT_CLIENT_ID=...
HUBSOFT_CLIENT_SECRET=...
HUBSOFT_USERNAME=voce.api@provedor.com.br
HUBSOFT_PASSWORD=...
```

Teste com `node scripts/hubsoft.mjs consulta --rota configuracao/servico_status`.

## Várias bases (servidores)

Cada base tem um **nome** curto (usado no parâmetro `servidor`) e uma **descrição** (o agente usa para escolher a base certa).

**Por variáveis** (até 9 bases):

```
HUBSOFT_NOME=base_pf
HUBSOFT_DESCRICAO=Clientes pessoa física
HUBSOFT_URL=...            # + CLIENT_ID, CLIENT_SECRET, USERNAME, PASSWORD
HUBSOFT_2_NOME=base_pj
HUBSOFT_2_DESCRICAO=Clientes pessoa jurídica
HUBSOFT_2_URL=...          # + HUBSOFT_2_CLIENT_ID, HUBSOFT_2_CLIENT_SECRET, …
```

**Por arquivo** (`~/.config/hubsoft/servidores.json`, ou o caminho em `HUBSOFT_CONFIG`), sem limite de bases:

```json
{
  "servidores": [
    { "nome": "base_pf", "descricao": "Clientes pessoa física", "url": "https://api.pf.exemplo.com.br",
      "client_id": "1", "client_secret": "{env:HS_PF_SECRET}", "usuario": "voce.api@exemplo.com.br", "senha": "{env:HS_PF_SENHA}" },
    { "nome": "base_vtal", "descricao": "Clientes da rede neutra V.tal", "url": "https://api.vtal.exemplo.com.br",
      "client_id": "2", "client_secret": "...", "usuario": "voce.api@exemplo.com.br", "senha": "..." }
  ]
}
```

`{env:VAR}` lê o valor de uma variável de ambiente, para não gravar segredos no arquivo. Se gravar, use `chmod 600`.
