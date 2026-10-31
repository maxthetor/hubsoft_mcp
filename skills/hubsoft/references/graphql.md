# API GraphQL do Hubsoft (`/graphql/v1`)

Somente leitura (não há mutations). Exige a opção "Permite acesso à API GraphQL" no cliente de API. O esquema pode mudar com atualizações do Hubsoft: confirme com `graphql_consultas` e `graphql_tipo` antes de montar consultas.

## Consultas (referência de 2026-10)

**Por chave** (retornam um objeto):
`clienteById(id_cliente)`, `clienteByCodigo(codigo_cliente: Int!)`, `clienteByCpfCnpj(cpf_cnpj: String!)`,
`atendimentoById`, `atendimentoByProtocolo(protocolo)`, `ordemServicoById`, `ordemServicoByNumero(numero_ordem_servico)`,
`faturaById`, `cobrancaById`, `notaFiscalById`, `nfseById`, `nfeById`, `popById`, `cpeById(id_cpe: ID!)`,
`cpeByPhyAddr(phy_addr: String!)`, `prospectoById`, `equipamentoConexaoById`.

**Listas paginadas** (`first` padrão 250, `page`, `orderBy`); retornam `{ paginatorInfo { total lastPage hasMorePages } data { ... } }`:
`clientes`, `servicos` (catálogo de planos), `logins`, `faturas`, `cobrancas`, `atendimentos`, `ordensServico`,
`notasFiscais`, `nfses`, `nfes`, `pops`, `cpes`, `equipamentosConexao`, `statusConexaoRadius`, `prospectos`,
`clienteByNomeRazaoSocial(nome_razaosocial: String!)`.

**Por intervalo de datas** (`DateRange { de: Date!, ate: Date! }`, formato `aaaa-mm-dd`):
`faturasByDataVencimento(data_vencimento)`, `faturasByDataPagamento(data_pagamento)`,
`cobrancasByDataVencimento`, `cobrancasByDataPagamento`, `atendimentosByDataCadastro(data_cadastro)`,
`ordensServicoByDataCadastro(data_cadastro)`, `notasFiscaisByDataEmissao(data_emissao)`,
`nfsesByDataEmissao`, `nfesByDataEmissao`, `prospectoByDataCadastro(created_at)`.

## Grafo útil

```
Cliente ─ servicos ─▶ ClienteServico ─ servico { descricao }
                                     ├ servico_status { prefixo descricao }
                                     ├ endereco_instalacao { endereco_numero { endereco numero bairro cidade { nome } } }
                                     └ cliente_servico_autenticacao ─▶ login mac_addr phy_addr vlan
                                           ├ interface_conexao { nome equipamento_conexao { nome } }
                                           └ status_conexao_radius { status ipv4 ipv6_wan ip_nas data_inicio_sessao }
Fatura ─ cliente_servico ─▶ cliente { codigo_cliente nome_razaosocial }
```

## Exemplos

Faturas pagas ontem:
```graphql
{ faturasByDataPagamento(data_pagamento: { de: "2026-10-30", ate: "2026-10-30" }, first: 250) {
    paginatorInfo { total }
    data { id_fatura valor valor_pago data_pagamento cliente_servico { cliente { codigo_cliente } } } } }
```

ONU pelo serial/MAC:
```graphql
{ cpeByPhyAddr(phy_addr: "ALCLFC203278") { id_cpe offline descricao data_ultima_atualizacao } }
```

Atendimentos abertos no mês:
```graphql
{ atendimentosByDataCadastro(data_cadastro: { de: "2026-10-01", ate: "2026-10-31" }, first: 250) {
    paginatorInfo { total }
    data { protocolo data_cadastro data_fechamento tipo_atendimento { descricao } } } }
```

## Cuidados

- Peça só os campos necessários; `first` alto com muitos campos gera respostas enormes.
- `ClienteServicoAutenticacao.password` contém a senha PPPoE e é mascarada pelo cliente. Não a solicite.
- Para varrer todas as páginas, itere `page` até `hasMorePages = false`, e só quando realmente necessário.
