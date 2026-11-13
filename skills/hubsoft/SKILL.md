---
name: hubsoft
description: Consulta o ERP Hubsoft de provedores de internet — clientes, planos, status de serviço (bloqueados/suspensos), login PPPoE, ONU, sessão RADIUS, faturas, atendimentos, ordens de serviço, notas fiscais e POPs. Use quando o usuário perguntar sobre clientes, cobrança, inadimplência, bloqueios ou conexão de assinantes de um provedor que usa Hubsoft.
license: MIT
compatibility: Requer acesso de rede à API do Hubsoft do provedor e credenciais de API. Com MCP, usa as ferramentas hubsoft_*; sem MCP, usa a CLI em scripts/hubsoft.mjs (Node.js 18+).
metadata:
  repository: https://github.com/maxthetor/hubsoft_mcp
---

# Hubsoft

Guia para operar o ERP **Hubsoft** (provedores de internet) de forma correta e econômica.

## Como acessar

Escolha o primeiro modo disponível:

1. **Ferramentas MCP `hubsoft_*`** (servidor `hubsoft-mcp`). Use-as diretamente.
2. **CLI** (sem MCP): execute `node scripts/hubsoft.mjs <ferramenta> [--param valor]`. O caminho é relativo à pasta desta skill; use o caminho absoluto dela. A CLI tem as mesmas ferramentas, sem o prefixo `hubsoft_`:
   ```bash
   node scripts/hubsoft.mjs ferramentas                         # lista
   node scripts/hubsoft.mjs situacao_cliente --help             # parâmetros
   node scripts/hubsoft.mjs situacao_cliente --cpf_cnpj 12345678900
   node scripts/hubsoft.mjs servicos_por_status --status suspenso_debito --incluir_faturas_vencidas
   node scripts/hubsoft.mjs graphql --query '{ pops(first: 10) { data { id_pop } } }'
   node scripts/hubsoft.mjs situacao_cliente --cpf_cnpj 12345678900 --servidor base_pf
   ```
   A saída é JSON no stdout. Erros vão para o stderr, com código de saída 1.
   As credenciais vêm de variáveis `HUBSOFT_*`, de `./.env`, de `~/.config/hubsoft/.env` ou de `--env-file`. Se faltarem, peça ao usuário que configure (veja [referências/configuracao.md](references/configuracao.md)). **Nunca** peça a senha no chat nem a escreva em comandos.

## Várias bases (servidores)

Alguns provedores têm mais de uma base Hubsoft (ex.: `base_pf`, `base_pj`, `base_vtal`). Com 2 ou mais configuradas:

- `servidores` lista as bases, com nome e descrição. Use `testar=true` para checar o login em cada uma.
- Toda ferramenta aceita `servidor`: um nome, uma lista separada por vírgula ou `todos`.
- **Sem `servidor`**, a consulta roda em **todas** as bases e o resultado vem agrupado em `resultados.<base>`, com `nao_encontrado_em` e `erros` por base.
- Quando o usuário citar uma base ("na base pessoa física", "na PJ"), escolha pelo **nome ou pela descrição** e passe só ela.
- Ações que alteram dados exigem **uma** base: use a base onde o cliente foi encontrado, porque IDs e códigos não valem entre bases.
- Ao responder com dados de várias bases, diga de qual base veio cada cliente.

## Qual ferramenta usar

| Pergunta do usuário | Ferramenta |
|---|---|
| "Como está o cliente X?" (CPF/CNPJ ou código) | `situacao_cliente`: cadastro, serviços, PPPoE, ONU, RADIUS e resumo financeiro numa chamada |
| Buscar por nome, login, telefone… | `buscar_cliente` (`busca`: `nome_razaosocial`, `login_radius`, `telefone`, `cpf_cnpj`, `codigo_cliente`, `id_cliente_servico`) |
| "Quem está bloqueado/suspenso?", clientes por status | `servicos_por_status`. Filtra no servidor; **nunca** varra a base cliente a cliente |
| Faturamento, recebimentos ou inadimplência de um período ("quanto recebemos em outubro?", "faturado x pago por mês no ano") | `resumo_financeiro`: soma no servidor e devolve só os totais por dia/mês/ano (`data=pagamento` ou `vencimento`). **Nunca** pagine faturas para somar |
| "Clientes ativos sem serviço ativo", cadastros para inativar, ex-clientes para recuperar | `clientes_ativos_sem_servico_ativo`: varre a base no servidor e devolve só a lista final. `criterio=vigente` (padrão) ou `habilitado` |
| Faturas de um cliente | `faturas_cliente` (resumo enxuto; `detalhado=true` só se pedirem itens/descontos/NF) |
| Atendimentos / OS de um cliente | `atendimentos_cliente` / `ordens_servico_cliente` |
| Relatórios por período, POPs, CPEs/ONUs, NF-e/NFS-e, sessões RADIUS, logins | GraphQL: `graphql_consultas` → `graphql_tipo` → `graphql` ([referências/graphql.md](references/graphql.md)) |
| Rota REST sem ferramenta própria | `consulta` (GET em `/api/v1/integracao/<rota>`) |

## Regras de negócio (armadilhas reais)

- **Fatura vencida ≠ fatura em aberto.** Status `aguardando` com vencimento futuro (ex.: parcelas de carnê) **não** está vencida. As ferramentas já calculam `vencida` e `dias_atraso`; use esses campos e não recalcule.
- **Datas:** a API REST usa `dd/mm/aaaa`; o GraphQL usa `aaaa-mm-dd`. Nunca compare datas como texto sem normalizar.
- **Listas GraphQL não filtram** por cliente nem por status (só paginação, ordenação e intervalo de datas). Para "faturas do cliente" use a REST (`faturas_cliente`). Para status de serviço use `servicos_por_status`.
- **Status de serviço** (prefixos): veja [referências/status.md](references/status.md). "Bloqueado" costuma significar `suspenso_debito`; confirme se o usuário quer incluir `suspenso_parcialmente`, `suspenso_pedido_cliente` e `franquia_excedida`.
- **Totais de período:** use `resumo_financeiro`. Com `data=pagamento`, as faturas pagas no período. Com `data=vencimento`, as que vencem no período, com pago, em aberto e vencido. Com várias bases, `consolidado_todas_bases` traz a soma geral.
- **Tamanho:** peça só o necessário (`limit`, `first`, campos específicos no GraphQL). Respostas grandes são truncadas.

## Ações que alteram dados

`desbloqueio_confianca` e `enviar_fatura_email` só existem com `HUBSOFT_READ_ONLY=false`. Antes de executar:
1. confirme cliente, serviço (`id_cliente_servico`) e quantidade de dias com o usuário;
2. execute uma única vez e relate o retorno do Hubsoft. O limite de dias do desbloqueio é definido no painel do provedor.

## Privacidade (LGPD)

- Mostre só os dados pessoais necessários para a pergunta. Em listas, prefira nome, código e status.
- Senhas (ex.: PPPoE) vêm mascaradas (`***`). Não tente obtê-las por outro caminho.
- Não copie dados de clientes para arquivos, planilhas ou mensagens sem pedido explícito do usuário.
