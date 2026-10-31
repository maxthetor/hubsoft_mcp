# Status de serviço do Hubsoft

Prefixos padrão do Hubsoft. Cada provedor pode ter variações; a lista do seu provedor está em `consulta --rota configuracao/servico_status`.

| Prefixo | Descrição | Grupo |
|---|---|---|
| `servico_habilitado` | Serviço Habilitado | ativo |
| `suspenso_debito` | Suspenso por Débito | **bloqueio** |
| `suspenso_parcialmente` | Suspenso Parcialmente (redução de velocidade) | **bloqueio** |
| `suspenso_pedido_cliente` | Suspenso a Pedido do Cliente | **bloqueio** |
| `franquia_excedida` | Utilização de Franquia Excedida | **bloqueio** |
| `agendado_para_instalacao` | Agendado para Instalação | pré-ativação |
| `aguardando_instalacao` | Aguardando Instalação | pré-ativação |
| `aguardando_configuracao` | Aguardando Configuração | pré-ativação |
| `aguardando_assinatura_contrato` | Aguardando Assinatura de Contrato | pré-ativação |
| `aguardando_liberacao_ti` | Aguardando Liberação de TI | pré-ativação |
| `aguardando_migracao` | Aguardando Migração | pré-ativação |
| `inativo` | Inativo | encerrado |
| `cancelado` | Cancelado | encerrado |

## Exemplos

- "Clientes bloqueados": `servicos_por_status` sem parâmetros (grupo **bloqueio**).
- "Bloqueados por débito e quanto devem": `servicos_por_status --status suspenso_debito --incluir_faturas_vencidas`.
- "Instalações pendentes": `servicos_por_status --status agendado_para_instalacao,aguardando_instalacao`.

A REST `cliente/todos` aceita o filtro `servico_status=<prefixo>`, com `itens_por_pagina` e `pagina`. É isso que `servicos_por_status` usa.
