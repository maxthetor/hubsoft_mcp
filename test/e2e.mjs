// Teste ponta a ponta contra um Hubsoft simulado: node test/e2e.mjs (após npm run build)
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Datas no formato real da REST do Hubsoft: "dd/mm/aaaa"
const br = (d) => d.toISOString().slice(0, 10).split("-").reverse().join("/");
const dia = (n) => new Date(Date.now() + n * 864e5);
const endereco = { completo: "RUA X, 1 - BAIRRO, CIDADE/UF", cep: "00000000", cidade: "CIDADE", uf: "UF" };
const faturaReal = (id, venc, status) => ({
  id_fatura: id, quitado: false, status, valor: 115.4, data_vencimento: br(venc), data_pagamento: null,
  tipo_cobranca: "boleto_bancario", linha_digitavel: "7569...", pix_copia_cola: "000201...", link: "https://x/pdf/" + id,
  beneficiario: "PROVEDOR LTDA", carteira: "1", aceite: "N", local_pagamento: "PAGÁVEL EM QUALQUER BANCO",
  detalhamento: [{ descricao: "SERVICO SCM - PLANO 500M - 05/10/2026 - 04/11/2026", valor: 115.4, desconto_cobranca: [], composicao: [] }],
  cliente: { codigo_cliente: 77, servico: { id_cliente_servico: 1, endereco_cadastral: endereco, endereco_instalacao: endereco, endereco_fiscal: endereco, endereco_cobranca: endereco } },
});
const calls = [];
let paginaInstavelUsada = false;
const CLIENTES = Array.from({ length: 1203 }, (_, k) => { const i = k + 1;
  const sv = (st) => ({ id_cliente_servico: 100000 + i, nome: "PLANO", status_prefixo: st, senha: "pppoe!", data_cancelamento: st === "cancelado" ? "2025-03-01 10:00:00" : null });
  let servicos;
  if (i % 10 === 0) servicos = [sv("cancelado")];
  else if (i % 7 === 0) servicos = [sv("cancelado"), sv("inativo")];
  else if (i % 11 === 0) servicos = [];
  else if (i % 13 === 0) servicos = [sv("suspenso_debito")];
  else servicos = [sv("servico_habilitado")];
  return { id_cliente: i, codigo_cliente: i, nome_razaosocial: "Cliente " + i, cpf_cnpj: String(10000000000 + i), rg: "SECRETO", ativo: i % 10 !== 0, data_cadastro: "2020-01-15 00:00:00", servicos };
});
const TODAS = [
  ...Array.from({ length: 2500 }, (_, i) => ({ id_fatura: String(1000 + i), valor: 100 + (i % 7), valor_pago: 99.5 + (i % 7), ativo: i % 50 !== 0,
    data_vencimento: "2026-10-10", data_pagamento: i < 1500 ? `2026-10-${String(1 + (i % 28)).padStart(2, "0")}` : `2026-11-${String(1 + (i % 28)).padStart(2, "0")}` })),
  ...Array.from({ length: 1500 }, (_, i) => ({ id_fatura: String(9000 + i), valor: 50, valor_pago: 50, ativo: true, data_vencimento: "2026-12-01", data_pagamento: "2026-12-05" })),
];
const esperado = (de, ate) => TODAS.filter(f => f.ativo && f.data_pagamento >= de && f.data_pagamento <= ate);
const soma = (l, k) => Math.round(l.reduce((s, f) => s + f[k], 0) * 100) / 100;
const srv = http.createServer((q, r) => { let b = ""; q.on("data", d => b += d); q.on("end", () => {
  const send = o => { r.writeHead(200, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
  calls.push(`${q.method} ${q.url}`);
  if (q.url === "/oauth/token") return send({ token_type: "Bearer", access_token: "t", expires_in: 2592000 });
  if (q.url === "/graphql/v1" && b.includes("faturasByDataPagamento")) {
    // 2.500 faturas pagas: 1.500 em out/2026 e 1.000 em nov/2026; 1 em cada 50 inativa.
    // Como a API real: SEM orderBy, a ordem muda a cada chamada (páginas se sobrepõem).
    const j = JSON.parse(b); const { de, ate, page } = j.variables;
    let todas = TODAS.filter(f => f.data_pagamento >= de && f.data_pagamento <= ate);
    if (!j.query.includes("orderBy")) todas = [...todas].sort(() => Math.random() - 0.5);
    let pg = todas.slice((page - 1) * 1000, page * 1000);
    if (de === "2026-12-01" && page === 2) pg = [todas[0], ...pg.slice(1)]; // repetida injetada
    return send({ data: { r: { paginatorInfo: { lastPage: Math.max(1, Math.ceil(todas.length / 1000)), total: todas.length }, data: pg } } });
  }
  if (q.url === "/graphql/v1") { const j = JSON.parse(b);
    if (j.variables?.v === "12345678900") return send({ data: { cliente: null } }); // só acha com máscara
    return send({ data: { cliente: { codigo_cliente: 77, nome_razaosocial: "Fulano", servicos: [
      { id_cliente_servico: 1, data_cancelamento: null, cliente_servico_autenticacao: { login: "fulano", password: "segredo123", status_conexao_radius: { status: "online", ipv4: "100.64.0.9" } } },
      { id_cliente_servico: 2, data_cancelamento: "2025-01-01" } ] } } }); }
  if (q.url.startsWith("/api/v1/integracao/cliente/todos") && !q.url.includes("servico_status")) {
    const u = new URL(q.url, "http://x"); const pg = Number(u.searchParams.get("pagina")); const n = Number(u.searchParams.get("itens_por_pagina"));
    if (n > 500) return send({ status: "error", msg: "O campo itens por pagina não deverá conter um valor superior a 500." }, 422);
    // instável: na 1ª vez que a página 1 é pedida, a API devolve de novo os clientes da página 0
    let ini = pg * n; if (pg === 1 && !paginaInstavelUsada) { paginaInstavelUsada = true; ini = 0; }
    return send({ status: "success", paginacao: { primeira_pagina: 0, ultima_pagina: Math.ceil(CLIENTES.length / n) - 1, pagina_atual: pg, total_registros: CLIENTES.length }, clientes: CLIENTES.slice(ini, ini + n) });
  }
  if (q.url.startsWith("/api/v1/integracao/cliente/todos")) {
    const u = new URL(q.url, "http://x"); const st = u.searchParams.get("servico_status"); const pg = Number(u.searchParams.get("pagina"));
    if (st !== "suspenso_debito") return send({ status: "success", paginacao: { ultima_pagina: 0 }, clientes: [] });
    const cli = (cod, id, susp) => ({ codigo_cliente: cod, nome_razaosocial: "Cliente " + cod, telefone_primario: "85999990000", rg: "SECRETO",
      servicos: [{ id_cliente_servico: id, nome: "PLANO 500M", valor: 99.9, status: "Suspenso por Débito", status_prefixo: "suspenso_debito", login: "l" + cod, senha: "pppoe!", phy_addr: "ALCL0001", data_ultima_suspensao: susp },
                 { id_cliente_servico: id + 1000, nome: "OUTRO", status_prefixo: "servico_habilitado" }] });
    const pages = [[cli(77, 1, `${br(dia(-10)).split("/").reverse().join("-")} 08:10:22`)], [cli(78, 2, null)]];
    return send({ status: "success", paginacao: { primeira_pagina: 0, ultima_pagina: 1, pagina_atual: pg, total_registros: 2 }, clientes: pages[pg] ?? [] });
  }
  if (q.url.startsWith("/api/v1/integracao/cliente/financeiro")) return send({ status: "success", faturas: [
    faturaReal(10, dia(-3), "vencido"),                                   // vencida
    ...Array.from({ length: 11 }, (_, i) => faturaReal(20 + i, dia(5 + 30 * i), "aguardando")), // carnê futuro
  ] });
  send({ status: "success" });
}); }).listen(0);
await new Promise(r => srv.once("listening", r));

const t = new StdioClientTransport({ command: "node", args: ["server/hubsoft-mcp.mjs"], stderr: "pipe", env: { ...process.env,
  HUBSOFT_URL: `http://127.0.0.1:${srv.address().port}`, HUBSOFT_CLIENT_ID: "1", HUBSOFT_CLIENT_SECRET: "s", HUBSOFT_USERNAME: "u", HUBSOFT_PASSWORD: "p" } });
const c = new Client({ name: "e2e", version: "0" }); await c.connect(t);
const names = (await c.listTools()).tools.map(x => x.name);
assert.ok(names.includes("hubsoft_situacao_cliente"));
assert.ok(!names.includes("hubsoft_desbloqueio_confianca"), "escrita deve estar desligada por padrão");

const r = await c.callTool({ name: "hubsoft_situacao_cliente", arguments: { cpf_cnpj: "123.456.789-00" } });
const out = JSON.parse(r.content[0].text);
assert.equal(out.encontrado, true);
assert.equal(out.cliente.servicos.length, 1, "serviço cancelado deve ser ocultado");
assert.equal(out.cliente.servicos_cancelados_ocultos, 1);
assert.equal(out.cliente.servicos[0].cliente_servico_autenticacao.password, "***", "senha PPPoE deve ser mascarada");
const fin = out.faturas_em_aberto;
assert.equal(fin.em_aberto.quantidade, 12);
assert.equal(fin.vencidas.quantidade, 1, "só a fatura de 3 dias atrás está vencida");
assert.equal(fin.vencidas.faturas[0].dias_atraso, 3);
assert.equal(fin.vencidas.valor_total, 115.4);
assert.equal(fin.proxima_a_vencer.id_fatura, 20);
assert.equal(fin.demais_a_vencer.quantidade, 10);
assert.ok(fin.vencidas.faturas[0].pix_copia_cola && fin.vencidas.faturas[0].link);
assert.ok(r.content[0].text.length < 8000, `resposta enxuta (atual: ${r.content[0].text.length} caracteres)`);
assert.ok(!r.content[0].text.includes("endereco_fiscal"), "sem blocos repetidos de endereço");

const fr = await c.callTool({ name: "hubsoft_faturas_cliente", arguments: { busca: "codigo_cliente", termo_busca: "77" } });
const fl = JSON.parse(fr.content[0].text).faturas;
assert.equal(fl.length, 12);
assert.equal(fl.filter(f => f.vencida).length, 1);
assert.equal(fl[0].data_vencimento.length, 10, "data normalizada para aaaa-mm-dd");
const fd = await c.callTool({ name: "hubsoft_faturas_cliente", arguments: { busca: "codigo_cliente", termo_busca: "77", detalhado: true } });
assert.ok(JSON.parse(fd.content[0].text).faturas[0].detalhamento, "detalhado=true devolve a fatura completa");
assert.ok(!r.content[0].text.includes("segredo123"));
assert.ok(calls.some(x => x.includes("financeiro?busca=codigo_cliente&termo_busca=77&apenas_pendente=sim&limit=60")));

const st = await c.callTool({ name: "hubsoft_servicos_por_status", arguments: { incluir_faturas_vencidas: true } });
const so = JSON.parse(st.content[0].text);
assert.equal(so.total, 2, "dois serviços suspensos, em duas páginas");
assert.deepEqual(so.por_status, { suspenso_debito: 2 });
assert.equal(so.servicos[0].dias_suspenso, 10, "ordenado por dias suspenso");
assert.equal(so.servicos[0].debito_vencido.faturas, 1);
assert.equal(so.debito_vencido_total, 230.8);
assert.ok(!st.content[0].text.includes("SECRETO") && !st.content[0].text.includes("pppoe!"), "sem RG nem senha na lista");
assert.ok(calls.some(x => x.includes("cliente/todos?servico_status=suspenso_debito&itens_por_pagina=100&pagina=1")));

const rf = await c.callTool({ name: "hubsoft_resumo_financeiro", arguments: { de: "01/10/2026", ate: "2026-11-30" } });
assert.ok(!rf.content[0].text.includes("\n"), "JSON compacto, sem indentação");
const ro = JSON.parse(rf.content[0].text);
assert.equal(ro.faturas_lidas, 2500); assert.equal(ro.total_informado_api, 2500); assert.equal(ro.repetidas_descartadas, 0);
assert.equal(ro.canceladas_ignoradas, 50); assert.equal(ro.completo, true);
assert.deepEqual(ro.grupos.map(g => g.periodo), ["2026-10", "2026-11"]);
const outu = esperado("2026-10-01", "2026-10-31"), nov = esperado("2026-11-01", "2026-11-30");
assert.equal(ro.grupos[0].faturas, outu.length); assert.equal(ro.grupos[0].total_pago, soma(outu, "valor_pago"));
assert.equal(ro.grupos[1].total_pago, soma(nov, "valor_pago"));
assert.equal(ro.totais.total_pago, Math.round((soma(outu, "valor_pago") + soma(nov, "valor_pago")) * 100) / 100, "período inteiro = soma dos meses");
assert.equal(ro.totais.total_faturado, Math.round((soma(outu, "valor") + soma(nov, "valor")) * 100) / 100);
// mesmo período, agrupado no total, tem que dar o mesmo número (o bug dava diferente)
const rt = JSON.parse((await c.callTool({ name: "hubsoft_resumo_financeiro", arguments: { de: "2026-10-01", ate: "2026-11-30", agrupar_por: "total" } })).content[0].text);
assert.equal(rt.totais.total_pago, ro.totais.total_pago);
// fatura repetida pela API: descartada e sinalizada
const rd = JSON.parse((await c.callTool({ name: "hubsoft_resumo_financeiro", arguments: { de: "2026-12-01", ate: "2026-12-31" } })).content[0].text);
assert.equal(rd.repetidas_descartadas, 1); assert.equal(rd.faturas_lidas, 1499); assert.equal(rd.completo, false); assert.match(rd.aviso, /1499 faturas únicas/);
const rerr = await c.callTool({ name: "hubsoft_resumo_financeiro", arguments: { de: "2026-11-30", ate: "2026-10-01" } });
assert.equal(rerr.isError, true);

const esperaSem = (ativoFn) => CLIENTES.filter(c => c.ativo && !c.servicos.some(sv => ativoFn(sv.status_prefixo)));
const hg = JSON.parse((await c.callTool({ name: "hubsoft_clientes_ativos_sem_servico_ativo", arguments: {} })).content[0].text);
const espV = esperaSem(st => st !== "cancelado" && st !== "inativo");
assert.equal(hg.clientes_na_base, 1203); assert.equal(hg.clientes_lidos, 1203); assert.equal(hg.completo, true, "2ª passada completou");
assert.ok(hg.repetidos_descartados >= 500, "página repetida descartada");
assert.equal(hg.total_sem_servico_ativo, espV.length);
assert.equal(hg.clientes[0].cpf_cnpj, espV[0].cpf_cnpj);
assert.ok(hg.por_situacao.sem_servicos > 0 && hg.por_situacao["cancelado+inativo"] > 0);
assert.ok(!JSON.stringify(hg).includes("SECRETO") && !JSON.stringify(hg).includes("pppoe!"), "lista enxuta, sem RG nem senha");
const hh = JSON.parse((await c.callTool({ name: "hubsoft_clientes_ativos_sem_servico_ativo", arguments: { criterio: "habilitado", limite: 5 } })).content[0].text);
assert.equal(hh.total_sem_servico_ativo, esperaSem(st => st === "servico_habilitado").length);
assert.ok(hh.por_situacao.suspenso_debito > 0); assert.equal(hh.clientes.length, 5); assert.equal(hh.lista_truncada_em, 5);

const g = await c.callTool({ name: "hubsoft_graphql", arguments: { query: "mutation { x }" } });
assert.equal(g.isError, true, "mutation deve ser bloqueada");

await c.close(); srv.close();
console.log("✅ e2e ok —", names.length, "ferramentas:", names.join(", "));
