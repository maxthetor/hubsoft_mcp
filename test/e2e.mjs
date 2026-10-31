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
const srv = http.createServer((q, r) => { let b = ""; q.on("data", d => b += d); q.on("end", () => {
  const send = o => { r.writeHead(200, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
  calls.push(`${q.method} ${q.url}`);
  if (q.url === "/oauth/token") return send({ token_type: "Bearer", access_token: "t", expires_in: 2592000 });
  if (q.url === "/graphql/v1") { const j = JSON.parse(b);
    if (j.variables?.v === "12345678900") return send({ data: { cliente: null } }); // só acha com máscara
    return send({ data: { cliente: { codigo_cliente: 77, nome_razaosocial: "Fulano", servicos: [
      { id_cliente_servico: 1, data_cancelamento: null, cliente_servico_autenticacao: { login: "fulano", password: "segredo123", status_conexao_radius: { status: "online", ipv4: "100.64.0.9" } } },
      { id_cliente_servico: 2, data_cancelamento: "2025-01-01" } ] } } }); }
  if (q.url.startsWith("/api/v1/integracao/cliente/financeiro")) return send({ status: "success", faturas: [
    faturaReal(10, dia(-3), "vencido"),                                   // vencida
    ...Array.from({ length: 11 }, (_, i) => faturaReal(20 + i, dia(5 + 30 * i), "aguardando")), // carnê futuro
  ] });
  send({ status: "success" });
}); }).listen(0);
await new Promise(r => srv.once("listening", r));

const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "pipe", env: { ...process.env,
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

const g = await c.callTool({ name: "hubsoft_graphql", arguments: { query: "mutation { x }" } });
assert.equal(g.isError, true, "mutation deve ser bloqueada");

await c.close(); srv.close();
console.log("✅ e2e ok —", names.length, "ferramentas:", names.join(", "));
