// Teste multi-servidor: 3 Hubsofts simulados (slot 1, slot 2 e arquivo JSON).
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function hubsoft(nome, { cpf, suspensos = 0, senha = "p" }) {
  const srv = http.createServer((q, r) => { let b = ""; q.on("data", d => b += d); q.on("end", () => {
    const send = (o, s = 200) => { r.writeHead(s, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
    if (q.url === "/oauth/token") {
      const j = b.trim().startsWith("{") ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b));
      return j.password === senha ? send({ token_type: "Bearer", access_token: nome, expires_in: 3600 }) : send({ status: "error", msg: "Os dados de autenticação enviados não são válidos" }, 401);
    }
    if (q.headers.authorization !== `Bearer ${nome}`) return send({ msg: "token de outra base!" }, 401);
    if (q.url === "/graphql/v1") {
      const j = JSON.parse(b);
      const achou = j.variables?.v === cpf;
      return send({ data: { cliente: achou ? { codigo_cliente: 10, nome_razaosocial: "Cliente " + nome, servicos: [] } : null } });
    }
    if (q.url.startsWith("/api/v1/integracao/cliente/financeiro")) return send({ status: "success", faturas: [] });
    if (q.url.startsWith("/api/v1/integracao/cliente/todos")) {
      const st = new URL(q.url, "http://x").searchParams.get("servico_status");
      const clientes = st === "suspenso_debito" ? Array.from({ length: suspensos }, (_, i) => ({ codigo_cliente: i + 1, nome_razaosocial: `${nome}-${i}`, servicos: [{ id_cliente_servico: i + 1, status_prefixo: "suspenso_debito", status: "Suspenso por Débito" }] })) : [];
      return send({ status: "success", paginacao: { ultima_pagina: 0 }, clientes });
    }
    if (q.url.startsWith("/api/v1/integracao/cliente/desbloqueio_confianca")) return send({ status: "success", msg: `desbloqueado em ${nome}` });
    send({ status: "error", msg: "rota" }, 404);
  }); }).listen(0);
  return srv;
}

const pf = hubsoft("base_pf", { cpf: "11111111111", suspensos: 2 });
const pj = hubsoft("base_pj", { cpf: "22222222222", suspensos: 1 });
const vtal = hubsoft("base_vtal", { cpf: "33333333333", suspensos: 0, senha: "certa" });
await Promise.all([pf, pj, vtal].map(s => new Promise(r => s.listening ? r() : s.once("listening", r))));
const url = s => `http://127.0.0.1:${s.address().port}`;

const dir = mkdtempSync(join(tmpdir(), "hs-multi-"));
const arquivo = join(dir, "servidores.json");
writeFileSync(arquivo, JSON.stringify({ servidores: [
  { nome: "base_vtal", descricao: "Clientes da rede neutra V.tal", url: url(vtal), client_id: "3", client_secret: "s", usuario: "u", senha: "{env:SENHA_VTAL}" },
] }));

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUBSOFT_")));
async function conectar(extra = {}) {
  const t = new StdioClientTransport({ command: "node", args: ["server/hubsoft-mcp.mjs"], stderr: "pipe", env: { ...baseEnv,
    HUBSOFT_NOME: "base_pf", HUBSOFT_DESCRICAO: "Clientes pessoa física", HUBSOFT_URL: url(pf), HUBSOFT_CLIENT_ID: "1", HUBSOFT_CLIENT_SECRET: "s", HUBSOFT_USERNAME: "u", HUBSOFT_PASSWORD: "p",
    HUBSOFT_2_NOME: "Base PJ", HUBSOFT_2_DESCRICAO: "Clientes pessoa jurídica", HUBSOFT_2_URL: url(pj), HUBSOFT_2_CLIENT_ID: "2", HUBSOFT_2_CLIENT_SECRET: "s", HUBSOFT_2_USERNAME: "u", HUBSOFT_2_PASSWORD: "p",
    HUBSOFT_3_URL: "${user_config.url_3}", // slot vazio do plugin: deve ser ignorado
    HUBSOFT_CONFIG: arquivo, SENHA_VTAL: "certa", ...extra } });
  const c = new Client({ name: "multi", version: "0" }); await c.connect(t); return c;
}
const call = async (c, name, args = {}) => { const r = await c.callTool({ name, arguments: args }); return { err: r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() }; };

let c = await conectar();
const tools = (await c.listTools()).tools;
assert.equal(tools[0].name, "hubsoft_servidores");
const sit = tools.find(t => t.name === "hubsoft_situacao_cliente");
assert.ok(sit.inputSchema.properties.servidor, "parâmetro servidor presente");
assert.match(sit.inputSchema.properties.servidor.description, /base_pf \(Clientes pessoa física\)/);

let r = await call(c, "hubsoft_servidores", { testar: true });
assert.deepEqual(r.json.map(s => s.nome), ["base_pf", "base_pj", "base_vtal"], "nomes normalizados (Base PJ → base_pj)");
assert.ok(r.json.every(s => s.login === "ok"), "login ok nas 3 (senha do vtal veio de {env:SENHA_VTAL})");
assert.ok(!r.text.includes('"s"') && !r.text.includes("certa"), "sem segredos na listagem");

r = await call(c, "hubsoft_servidores", { diagnostico: true });
assert.match(r.json.versao, /^\d+\.\d+\.\d+$/);
assert.equal(r.json.variaveis.HUBSOFT_2_URL, "preenchida");
assert.match(r.json.variaveis.HUBSOFT_3_URL, /não substituída/);
assert.ok(!r.text.includes("127.0.0.1") || r.text.includes("endereco"), "diagnóstico não expõe valores");
assert.ok(!JSON.stringify(r.json.variaveis).includes("certa"));

// "pesquise" → todas as bases
r = await call(c, "hubsoft_situacao_cliente", { cpf_cnpj: "222.222.222-22" });
assert.deepEqual(r.json.servidores_consultados, ["base_pf", "base_pj", "base_vtal"]);
assert.deepEqual(Object.keys(r.json.resultados), ["base_pj"]);
assert.equal(r.json.resultados.base_pj.cliente.nome_razaosocial, "Cliente base_pj");
assert.deepEqual(r.json.nao_encontrado_em.sort(), ["base_pf", "base_vtal"]);

// "na minha base pessoa física" → só base_pf (por nome ou por descrição)
r = await call(c, "hubsoft_situacao_cliente", { cpf_cnpj: "11111111111", servidor: "base_pf" });
assert.equal(r.json.servidor, "base_pf"); assert.equal(r.json.encontrado, true);
r = await call(c, "hubsoft_situacao_cliente", { cpf_cnpj: "11111111111", servidor: "pessoa física" });
assert.equal(r.json.servidor, "base_pf");
r = await call(c, "hubsoft_situacao_cliente", { cpf_cnpj: "1", servidor: "pessoa" });
assert.equal(r.err, true); assert.match(r.text, /ambíguo/);
r = await call(c, "hubsoft_situacao_cliente", { cpf_cnpj: "1", servidor: "base_xyz" });
assert.equal(r.err, true); assert.match(r.text, /não encontrado.*base_pf/);

// agregação por base
r = await call(c, "hubsoft_servicos_por_status", { status: ["suspenso_debito"], servidor: "base_pf,base_pj" });
assert.equal(r.json.resultados.base_pf.total, 2); assert.equal(r.json.resultados.base_pj.total, 1);
assert.equal(r.json.resultados.base_vtal, undefined);
await c.close();

// escrita exige uma base; erro de login numa base não derruba as outras
c = await conectar({ HUBSOFT_READ_ONLY: "false", SENHA_VTAL: "errada" });
r = await call(c, "hubsoft_desbloqueio_confianca", { id_cliente_servico: 1 });
assert.equal(r.err, true); assert.match(r.text, /única base/);
r = await call(c, "hubsoft_desbloqueio_confianca", { id_cliente_servico: 1, servidor: "base_pj" });
assert.equal(r.json.servidor, "base_pj"); assert.match(r.json.msg, /base_pj/);
r = await call(c, "hubsoft_servicos_por_status", {});
assert.equal(r.json.resultados.base_pf.total, 2);
assert.match(r.json.erros.base_vtal, /autenticação/);
await c.close();

// nomes repetidos são rejeitados na inicialização
await assert.rejects(conectar({ HUBSOFT_2_NOME: "base_pf" }));

[pf, pj, vtal].forEach(s => s.close());
console.log("✅ multi ok");
