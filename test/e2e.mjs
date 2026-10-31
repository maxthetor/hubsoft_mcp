// Teste ponta a ponta contra um Hubsoft simulado: node test/e2e.mjs (após npm run build)
import http from "node:http";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const hoje = new Date(); const ontem = new Date(hoje - 864e5).toISOString().slice(0,10); const amanha = new Date(+hoje + 864e5).toISOString().slice(0,10);
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
    { id_fatura: 10, valor: 99.9, data_vencimento: ontem }, { id_fatura: 11, valor: 99.9, data_vencimento: amanha } ] });
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
assert.equal(out.faturas_em_aberto.quantidade, 2);
assert.equal(out.faturas_em_aberto.vencidas, 1);
assert.equal(out.faturas_em_aberto.valor_total, 199.8);
assert.ok(!r.content[0].text.includes("segredo123"));
assert.ok(calls.some(x => x.includes("financeiro?busca=codigo_cliente&termo_busca=77&apenas_pendente=sim")));

const g = await c.callTool({ name: "hubsoft_graphql", arguments: { query: "mutation { x }" } });
assert.equal(g.isError, true, "mutation deve ser bloqueada");

await c.close(); srv.close();
console.log("✅ e2e ok —", names.length, "ferramentas:", names.join(", "));
