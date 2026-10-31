# Configuração de credenciais

O administrador do provedor cria no Hubsoft:

1. um **cliente de API** (client ID e client secret), com "Permite acesso à API GraphQL" marcado;
2. para cada pessoa, um **usuário com acesso à API**.

> Usuários com **2FA** não autenticam pela API (o login OAuth não tem campo para o código). Use um usuário de API por pessoa, sem 2FA, com senha forte e o mesmo perfil de permissões do usuário dela.

## Variáveis

| Variável | Obrigatória | Descrição |
|---|---|---|
| `HUBSOFT_URL` | sim | Ex.: `https://api.seuprovedor.hubsoft.com.br` |
| `HUBSOFT_CLIENT_ID` | sim | Client ID |
| `HUBSOFT_CLIENT_SECRET` | sim | Client secret |
| `HUBSOFT_USERNAME` | sim | Usuário de API da pessoa |
| `HUBSOFT_PASSWORD` | sim | Senha |
| `HUBSOFT_READ_ONLY` | não | `true` (padrão); `false` habilita desbloqueio e envio de fatura |
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
