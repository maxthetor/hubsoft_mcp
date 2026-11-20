// Testes de hubsoft_vincular_lote, hubsoft_equipamento_inativar/reativar e da máscara de CPF/CNPJ,
// contra um Hubsoft simulado. Nenhuma chamada vai à API real.
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const norm = (s) => String(s ?? "").replace(/[^0-9a-z]/gi, "").toUpperCase();
const CPF = "98765432100";
const CPF_FMT = "987.654.321-00";
const CNPJ = "11222333000181";
const API = "/api/v1/integracao";

let st, reqs, flags;
function servico(id, extra = {}) {
  return { id_cliente_servico: id, status: "Serviço Habilitado", status_prefixo: "servico_habilitado", login: `login${id}`, senha: "pppoe-secreta",
    mac_addr: `AA:BB:CC:DD:EE:${String(id).slice(-2)}`, phy_addr: null, interface: null, equipamento_conexao: null, interface_roteamento: null, equipamento_roteamento: null, cpes: [], ...extra };
}
function reset() {
  st = {
    servicos: new Map([
      [601, servico(601)],
      [602, servico(602, { status: "Cancelado", status_prefixo: "cancelado" })],
      [603, servico(603)],
      [604, servico(604)],
      [605, servico(605, { phy_addr: "FHTT00000605", cpes: [{ id_cpe: 65, phy_addr: "FHTT00000605" }] })],
      [606, servico(606, { phy_addr: "FHTT0000OLD6", cpes: [{ id_cpe: 66, phy_addr: "FHTT0000OLD6" }, { id_cpe: 67, phy_addr: "AA:BB:CC:DD:EE:06" }] })],
      [607, servico(607, { phy_addr: "FHTT0000OLD7", cpes: [{ id_cpe: 76, phy_addr: "FHTT0000OLD7" }, { id_cpe: 77, phy_addr: "AABBCCDDEE07" }] })],
      [608, servico(608, { phy_addr: "FHTT00000608" })],
      [609, servico(609)],
      [610, servico(610)],
    ]),
    cpes: [
      ...["601", "605", "607", "608", "609", "610", "611", "612", "613", "614", "615", "616", "617"].map((n, i) => ({ id_cpe: 100 + i, phy_addr: `FHTT00000${n}`, data_ultima_atualizacao: "2026-11-20 08:00:00", servicos: [] })),
      { id_cpe: 90, phy_addr: "FHTT00000604", servicos: [{ id_cliente: 9, cliente: `(1009) OUTRO ${CPF}`, cpf_cnpj: CNPJ, id_cliente_servico: 999, login: "outro" }] },
    ],
    equipamentos: new Map([
      [3, { id_equipamento_conexao: 3, nome: "OLT-CENTRO", ipv4: "192.0.2.3", deleted_at: null, interfaces: [{ id: 1 }, { id: 2 }] }],
      [4, { id_equipamento_conexao: 4, nome: "OLT-VAZIA", ipv4: "192.0.2.4", deleted_at: null, interfaces: [] }],
      [5, { id_equipamento_conexao: 5, nome: "OLT-ANTIGA", ipv4: "192.0.2.5", deleted_at: "2026-10-01 10:00:00", interfaces: [] }],
      [6, { id_equipamento_conexao: 6, nome: "OLT-EXPORTADA", ipv4: "192.0.2.6", deleted_at: null, interfaces: [] }],
    ]),
  };
  reqs = [];
  flags = { latenciaMs: 0, post429: false, vincularFalha: new Set([610]), vincular500: false };
}
reset();
for (let id = 611; id <= 617; id++) st.servicos.set(id, servico(id));
const extras = () => { for (let id = 611; id <= 617; id++) st.servicos.set(id, servico(id)); };

const srv = http.createServer((q, r) => { let b = ""; q.on("data", d => b += d); q.on("end", async () => {
  const send = (o, s = 200) => { r.writeHead(s, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
  const u = new URL(q.url, "http://x"); const p = u.pathname; const qs = u.searchParams;
  if (p === "/oauth/token") return send({ token_type: "Bearer", access_token: "tok", expires_in: 3600 });
  reqs.push({ m: q.method, p, t: Date.now(), body: b ? JSON.parse(b) : null });
  if (flags.latenciaMs) await new Promise(res => setTimeout(res, flags.latenciaMs));
  const body = b ? JSON.parse(b) : {};

  if (p === `${API}/cliente` && q.method === "GET") {
    if (qs.get("busca") === "id_cliente_servico") {
      const sv = st.servicos.get(Number(qs.get("termo_busca")));
      return send({ status: "success", clientes: sv ? [{ codigo_cliente: 55, nome_razaosocial: `MEI FULANO ${CPF}`, cpf_cnpj: CPF, servicos: [structuredClone(sv)] }] : [] });
    }
    // rota genérica para o teste de máscara via hubsoft_consulta
    return send({ status: "success", clientes: [{ id_cliente: 1, cpf_cnpj: CPF, cnpj: Number(CNPJ), nome_razaosocial: `EMPRESA ${CNPJ}`, observacao: `CPF ${CPF_FMT} conferido`, linha_digitavel: "23790 12345678901 91230000010000" }] });
  }
  if (p === `${API}/cliente/financeiro` ) return send({ status: "error", msg: `Cliente ${CPF_FMT} sem faturas` }, 422);
  if (p === `${API}/rede/cpe/todos`) {
    const termo = norm(qs.get("termo_busca"));
    return send({ status: "success", paginacao: { ultima_pagina: 0 }, cpes: st.cpes.filter(c => norm(c.phy_addr).includes(termo)) });
  }
  if (q.method === "POST" && flags.post429) return send({ error: "rate_limit_exceeded", retry_after: 1 }, 429);
  if (p === `${API}/cliente/desvincular_cpe`) {
    const sv = st.servicos.get(body.id_cliente_servico);
    sv.cpes = sv.cpes.filter(c => norm(c.phy_addr) !== norm(body.phy_addr));
    if (norm(sv.phy_addr) === norm(body.phy_addr)) sv.phy_addr = null;
    return send({ status: "success", msg: "CPE desvinculada com sucesso" });
  }
  if (p === `${API}/cliente/configurar_autenticacao`) {
    const sv = st.servicos.get(body.id_cliente_servico);
    if (norm(sv.phy_addr) === norm(body.phy_addr)) return send({ status: "error", msg: "Não é necessário a alteração dos parâmetros de autenticação" }, 422);
    sv.phy_addr = String(body.phy_addr).toUpperCase();
    return send({ status: "success", msg: "Parâmetros de autenticação modificados com sucesso." });
  }
  if (p === `${API}/cliente/vincular_cpe`) {
    const sv = st.servicos.get(body.id_cliente_servico);
    if (flags.vincular500) return send({ status: "error", msg: "erro interno" }, 500);
    if (flags.vincularFalha.has(sv.id_cliente_servico)) return send({ status: "error", msg: `CPE não encontrada para o cliente ${CPF_FMT}` }, 422);
    const cpe = st.cpes.find(c => norm(c.phy_addr) === norm(sv.phy_addr));
    sv.cpes.push({ id_cpe: cpe.id_cpe, phy_addr: cpe.phy_addr });
    sv.equipamento_conexao = { nome: "OLT-CENTRO", ipv4: "192.0.2.3" }; sv.interface = { nome: "GPON 0/1/3", tipo: "gpon" };
    return send({ status: "success", msg: "CPE vinculada com sucesso" });
  }
  // rotas internas de equipamento
  const m = p.match(/^\/api\/v1\/rede\/equipamento_conexao\/(\d+)(\/restore)?$/);
  if (m) {
    const eq = st.equipamentos.get(Number(m[1]));
    if (m[2] && q.method === "GET") { if (!eq) return send({ msg: "not found" }, 404); eq.deleted_at = null; return send({ status: "success", msg: "Equipamento restaurado" }); }
    if (q.method === "DELETE") { if (!eq || eq.deleted_at) return send({ msg: "not found" }, 404); eq.deleted_at = "2026-11-20 14:00:00"; return send({ status: "success", msg: "Equipamento removido" }); }
    if (q.method === "GET") { if (!eq || eq.deleted_at) return send({ message: "No query results" }, 404); return send({ status: "success", equipamento_conexao: structuredClone(eq) }); }
  }
  if (p === `${API}/cliente/todos`) {
    assert.equal(qs.get("relacoes"), "equipamento_conexao");
    const pagina = Number(qs.get("pagina"));
    const cl = [
      [{ id_cliente: 1, servicos: [{ status_prefixo: "servico_habilitado", equipamento_conexao: { nome: "OLT-CENTRO", ipv4: "192.0.2.3" } }, { status_prefixo: "cancelado", equipamento_conexao: { nome: "OLT-VAZIA", ipv4: "192.0.2.4" } }] }],
      [{ id_cliente: 2, servicos: [{ status_prefixo: "suspenso_debito", equipamento_conexao: { nome: "olt-centro", ipv4: "192.0.2.3" } }] }],
    ][pagina] ?? [];
    return send({ status: "success", paginacao: { ultima_pagina: 1, total_registros: 2 }, clientes: cl });
  }
  send({ status: "error", msg: "rota inexistente " + p }, 404);
}); }).listen(0);
await new Promise(r => srv.listening ? r() : srv.once("listening", r));
const url = `http://127.0.0.1:${srv.address().port}`;

const raiz = mkdtempSync(join(tmpdir(), "hs-lote-"));
const loteDir = join(raiz, "lotes"); mkdirSync(loteDir);
const exportDir = join(raiz, "export"); mkdirSync(exportDir);
const auditoria = join(raiz, "auditoria.jsonl");
writeFileSync(join(raiz, "fora.csv"), "base;id_cliente_servico;sn\r\n");
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUBSOFT_")));
const cred = (pfx) => ({ [`${pfx}URL`]: url, [`${pfx}CLIENT_ID`]: "1", [`${pfx}CLIENT_SECRET`]: "s", [`${pfx}USERNAME`]: "u", [`${pfx}PASSWORD`]: "p" });
async function conectar(extra = {}) {
  const t = new StdioClientTransport({ command: "node", args: ["server/hubsoft-mcp.mjs"], stderr: "pipe", env: { ...baseEnv,
    HUBSOFT_TOKENS: "off", HUBSOFT_2FA_DIALOGO: "off", HUBSOFT_PERMITIR_ESCRITA: "true", HUBSOFT_AUDITORIA: auditoria,
    HUBSOFT_LOTE_DIR: loteDir, HUBSOFT_EXPORT_DIR: exportDir, HUBSOFT_EXPORT_ESPERA_MS: "10",
    HUBSOFT_NOME: "base_pf", ...cred("HUBSOFT_"), HUBSOFT_2_NOME: "base_pj", ...cred("HUBSOFT_2_"), ...extra } });
  const c = new Client({ name: "lote", version: "0" }); await c.connect(t); return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return { err: r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const semDoc = (texto, onde) => { for (const x of [CPF, CPF_FMT, CNPJ]) assert.ok(!texto.includes(x), `${onde} não pode conter ${x}`); };
const csv = (nome, linhas) => writeFileSync(join(loteDir, nome), "﻿" + linhas.join("\r\n") + "\r\n", "utf8");
const lerResultado = (arquivo) => {
  const [cab, ...ls] = readFileSync(arquivo, "utf8").replace(/^﻿/, "").trimEnd().split("\r\n").map(l => l.split(";"));
  return ls.map(l => Object.fromEntries(cab.map((k, i) => [k, l[i]])));
};
const posts = () => reqs.filter(x => x.m === "POST");

// ───────────────────────── 0. máscara de CPF/CNPJ
let c = await conectar();
let r = await call(c, "hubsoft_consulta", { servidor: "base_pf", rota: "cliente" });
assert.ok(!r.err, r.text);
semDoc(r.text, "resultado de hubsoft_consulta");
assert.ok(r.text.includes('"cpf_cnpj":"********100"'), r.text);
assert.ok(r.text.includes('"cnpj":"***********181"'));
assert.ok(r.text.includes("EMPRESA ***********181") && r.text.includes("CPF ********100 conferido"));
assert.ok(r.text.includes("23790 12345678901 91230000010000"), "linha digitável preservada");
r = await call(c, "hubsoft_consulta", { servidor: "base_pf", rota: "cliente/financeiro" });
assert.equal(r.err, true); semDoc(r.text, "mensagem de erro");
// diff/estado de uma escrita individual: a CPE de outro serviço traz cpf_cnpj e o nome com CPF
r = await call(c, "hubsoft_configurar_autenticacao", { servidor: "base_pf", id_cliente_servico: 601, phy_addr: "FHTT00000604" });
assert.ok(!r.err, r.text); semDoc(r.text, "simulação de configurar_autenticacao");
assert.match(r.text, /\*{11}181/);

// ───────────────────────── 1. vincular_lote: caminhos
const tools = (await c.listTools()).tools.map(t => t.name);
for (const n of ["hubsoft_vincular_lote", "hubsoft_equipamento_inativar", "hubsoft_equipamento_reativar"]) assert.ok(tools.includes(n), n);
for (const arquivo of ["../fora.csv", join(raiz, "fora.csv"), "nao_existe.csv", "lote.txt"]) {
  r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo });
  assert.equal(r.err, true, `arquivo ${arquivo} deve ser recusado`);
}
r = await call(c, "hubsoft_vincular_lote", { servidor: "todos", arquivo: "x.csv" });
assert.equal(r.err, true);
csv("sem_coluna.csv", ["base;id_cliente_servico", "base_pf;601"]);
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "sem_coluna.csv" });
assert.equal(r.err, true); assert.match(r.text, /obrigatórias ausentes no CSV: sn/);

// ───────────────────────── 1. vincular_lote: simulação
csv("lote1.csv", [
  "base;id_cliente_servico;sn;aprovar;desvincular_antes",
  "base_pf;601;FHTT00000601;S;N",       // 2  executaria
  "base_pf;602;FHTT00000614;S;N",       // 3  cancelado
  "base_pf;603;FHTT0000NONE;S;N",       // 4  fora do inventário
  "base_pf;604;FHTT00000604;S;N",       // 5  SN em outro serviço
  "base_pf;605;fhtt-0000-0605;S;N",     // 6  já vinculado (separadores e caixa diferentes)
  "base_pf;606;FHTT00000615;S;N",       // 7  outra CPE não-MAC, sem desvincular
  "base_pf;607;FHTT00000607;S;S",       // 8  troca (desvincula a antiga)
  "base_pf;608;FHTT00000608;S;",        // 9  configurar devolve 422 "não é necessário"
  "base_pf;609;FHTT00000609;N;N",       // 10 não aprovada
  "base_pj;610;FHTT00000610;S;N",       // 11 outra base
  "base_pf;610;FHTT00000610;S;N",       // 12 vincular falha (422)
  "base_pf;601;FHTT00000611;S;N",       // 13 duplicado (mesmo serviço)
  "base_pf;abc;FHTT00000612;S;N",       // 14 dados inválidos
]);
reqs = [];
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "lote1.csv" });
assert.ok(!r.err, r.text);
assert.equal(r.json.modo, "simulacao"); assert.equal(r.json.nada_foi_enviado, true);
assert.equal(posts().length, 0, "simulação não envia nada");
assert.match(r.json.arquivo_resultado, /lote1_simulacao_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
assert.deepEqual(r.json.contagem, { EXECUTARIA: 4, PULADO: 9 });
assert.equal(r.json.por_motivo.VINCULARIA, 3); assert.equal(r.json.por_motivo.DESVINCULARIA_E_VINCULARIA, 1);
semDoc(r.text, "resumo da simulação"); assert.ok(!r.text.includes("FULANO") && !r.text.includes("pppoe"), "resumo sem dados pessoais");
let res = lerResultado(r.json.arquivo_resultado);
assert.deepEqual(res.map(l => [l.linha, l.resultado, l.motivo]), [
  ["2", "EXECUTARIA", "VINCULARIA"], ["3", "PULADO", "SERVICO_CANCELADO"], ["4", "PULADO", "SN_FORA_DO_INVENTARIO"],
  ["5", "PULADO", "SN_EM_OUTRO_SERVICO"], ["6", "PULADO", "JA_VINCULADO"], ["7", "PULADO", "OUTRA_CPE_VINCULADA"],
  ["8", "EXECUTARIA", "DESVINCULARIA_E_VINCULARIA"], ["9", "EXECUTARIA", "VINCULARIA"], ["10", "PULADO", "NAO_APROVADA"],
  ["11", "PULADO", "OUTRA_BASE"], ["12", "EXECUTARIA", "VINCULARIA"], ["13", "PULADO", "DUPLICADO_NO_ARQUIVO"], ["14", "PULADO", "DADOS_INVALIDOS"],
]);
semDoc(readFileSync(r.json.arquivo_resultado, "utf8"), "CSV de simulação");

// ───────────────────────── 1. vincular_lote: execução
reqs = [];
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "lote1.csv", confirmar: true });
assert.ok(!r.err, r.text);
assert.equal(r.json.modo, "execucao");
assert.deepEqual(r.json.contagem, { OK: 3, PULADO: 9, ERRO: 1 });
assert.equal(r.json.por_motivo.VINCULADO, 2); assert.equal(r.json.por_motivo.TROCADO, 1); assert.equal(r.json.por_motivo.FALHA_VINCULAR, 1);
assert.match(r.json.arquivo_resultado, /lote1_resultado_.*\.csv$/);
assert.equal(r.json.primeiras_falhas[0].resultado, "ERRO", "ERRO vem primeiro");
assert.ok(r.json.primeiras_falhas.length <= 10 && r.json.primeiras_falhas.every(f => !["OUTRA_BASE", "NAO_APROVADA", "JA_VINCULADO"].includes(f.motivo)));
semDoc(r.text, "resumo da execução"); assert.ok(!r.text.includes("FULANO"));
// sequência de POSTs: 607 desvincula SÓ a antiga (não a CPE MAC), depois configura e vincula
const p = posts().map(x => `${x.p.split("/").pop()}:${x.body.id_cliente_servico}${x.body.phy_addr ? ":" + x.body.phy_addr : ""}`);
assert.deepEqual(p, [
  "configurar_autenticacao:601:FHTT00000601", "vincular_cpe:601",
  "desvincular_cpe:607:FHTT0000OLD7", "configurar_autenticacao:607:FHTT00000607", "vincular_cpe:607",
  "configurar_autenticacao:608:FHTT00000608", "vincular_cpe:608",
  "configurar_autenticacao:610:FHTT00000610", "vincular_cpe:610",
]);
assert.ok(!reqs.some(x => x.m === "POST" && /60[2-6]|609/.test(String(x.body?.id_cliente_servico))), "linhas puladas não recebem POST");
res = lerResultado(r.json.arquivo_resultado);
const l607 = res.find(l => l.id_cliente_servico === "607");
assert.equal(l607.resultado, "OK"); assert.equal(l607.cpe_desvinculada, "FHTT0000OLD7");
assert.equal(l607.olt_depois, "OLT-CENTRO"); assert.equal(l607.interface_depois, "GPON 0/1/3");
assert.equal(l607.cpes_depois, "AABBCCDDEE07|FHTT00000607");
assert.equal(res.find(l => l.id_cliente_servico === "608").resultado, "OK", "422 'não é necessário' aceito");
const l610 = res.find(l => l.linha === "12");
assert.equal(l610.resultado, "ERRO"); assert.match(l610.mensagem_api, /HTTP 422: CPE não encontrada para o cliente \*{8}100/);
semDoc(readFileSync(r.json.arquivo_resultado, "utf8"), "CSV de resultado");
// auditoria: uma linha por linha executada, sem CPF/CNPJ nem senha
const aud = readFileSync(auditoria, "utf8").trim().split("\n").map(JSON.parse).filter(x => x.ferramenta === "hubsoft_vincular_lote");
assert.equal(aud.length, 4);
assert.deepEqual(aud.map(a => a.id_cliente_servico), [601, 607, 608, 610]);
assert.equal(aud[1].passos.length, 3);
semDoc(readFileSync(auditoria, "utf8"), "auditoria"); assert.ok(!readFileSync(auditoria, "utf8").includes("pppoe-secreta"));
// segunda execução do mesmo arquivo: tudo já vinculado, nada é enviado de novo
reqs = [];
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "lote1.csv", confirmar: true });
assert.equal(r.json.por_motivo.JA_VINCULADO, 4, "601, 605, 607 e 608");
assert.deepEqual(posts().map(x => x.body.id_cliente_servico), [610, 610], "só a linha que falhou é tentada de novo");
assert.equal(readdirSync(loteDir).filter(f => f.startsWith("lote1_resultado_")).length, 2, "nunca sobrescreve");

// ───────────────────────── 1. limite, retomada, 5 erros seguidos, 429 em POST
extras();
csv("lote2.csv", ["base;id_cliente_servico;sn;aprovar", ...[611, 612, 613, 614, 615, 616, 617].map(id => `base_pf;${id};FHTT00000${id};S`)]);
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "lote2.csv", confirmar: true, limite: 2 });
assert.equal(r.json.contagem.OK, 2); assert.equal(r.json.por_motivo.ACIMA_DO_LIMITE, 5); assert.equal(r.json.retomar_a_partir_da_linha, 4);
flags.vincular500 = true; reqs = [];
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "lote2.csv", confirmar: true, a_partir_da_linha: 4, limite: 300 });
assert.equal(r.json.linhas_lidas, 5);
assert.equal(r.json.contagem.ERRO, 5); assert.equal(r.json.interrompido, "5 erros seguidos");
assert.equal(posts().filter(x => x.p.endsWith("vincular_cpe")).length, 5, "POST com 500 não é repetido");
flags.vincular500 = false; extras();
csv("lote3.csv", ["base;id_cliente_servico;sn;aprovar", "base_pf;611;FHTT00000611;S", "base_pf;612;FHTT00000612;S"]);
flags.post429 = true; reqs = [];
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "lote3.csv", confirmar: true });
assert.equal(r.json.contagem.ERRO, 2); assert.equal(r.json.esperas_429, 2);
assert.match(r.json.primeiras_falhas[0].mensagem, /HTTP 429.*não repetido/);
assert.equal(posts().length, 2, "um POST por linha, sem nova tentativa");
const tPosts = posts().map(x => x.t);
assert.ok(tPosts[1] - tPosts[0] >= 950, "a linha seguinte esperou o retry_after");
flags.post429 = false;
// so_aprovadas=false processa também aprovar vazio
csv("lote4.csv", ["base;id_cliente_servico;sn", "base_pf;613;FHTT00000613"]);
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "lote4.csv" });
assert.equal(r.json.por_motivo.NAO_APROVADA, 1);
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "lote4.csv", so_aprovadas: false });
assert.equal(r.json.contagem.EXECUTARIA, 1);
await c.close();

// tempo esgotado: para entre linhas e diz de onde retomar
extras();
c = await conectar({ HUBSOFT_LOTE_TEMPO_MAX_S: "0.3" });
flags.latenciaMs = 120;
r = await call(c, "hubsoft_vincular_lote", { servidor: "base_pf", arquivo: "lote2.csv" });
flags.latenciaMs = 0;
assert.ok(r.json.por_motivo.TEMPO_ESGOTADO >= 4, JSON.stringify(r.json.por_motivo));
assert.equal(r.json.retomar_a_partir_da_linha, 2 + r.json.processadas);
await c.close();

// ───────────────────────── 2. equipamento: inativar / reativar
c = await conectar();
reqs = [];
r = await call(c, "hubsoft_equipamento_inativar", { servidor: "base_pf", id_equipamento: 3 });
assert.ok(!r.err, r.text);
assert.equal(r.json.modo, "simulacao");
assert.equal(r.json.estado_atual.equipamento.nome, "OLT-CENTRO"); assert.equal(r.json.estado_atual.equipamento.qtd_interfaces, 2);
assert.equal(r.json.contagem_servicos.fonte, "api"); assert.equal(r.json.contagem_servicos.servicos_vinculados, 2, "habilitado + suspenso; cancelado não conta");
assert.match(r.json.bloqueado[0], /2 serviço/);
r = await call(c, "hubsoft_equipamento_inativar", { servidor: "base_pf", id_equipamento: 3, confirmar: true, confirmar_nome: "OLT-CENTRO" });
assert.equal(r.err, true, "recusa com serviços vinculados");
assert.equal(reqs.filter(x => x.m === "DELETE").length, 0);
// sem serviços: nome errado é recusado; nome certo executa
r = await call(c, "hubsoft_equipamento_inativar", { servidor: "base_pf", id_equipamento: 4, confirmar: true, confirmar_nome: "OLT-ERRADA" });
assert.equal(r.err, true); assert.match(r.text, /confirmar_nome/);
assert.equal(reqs.filter(x => x.m === "DELETE").length, 0);
r = await call(c, "hubsoft_equipamento_inativar", { servidor: "base_pf", id_equipamento: 4, confirmar: true, confirmar_nome: "OLT-VAZIA" });
assert.ok(!r.err, r.text);
assert.equal(r.json.modo, "execucao"); assert.equal(r.json.resultado.sucesso, true);
assert.equal(reqs.filter(x => x.m === "DELETE" && x.p === "/api/v1/rede/equipamento_conexao/4").length, 1);
assert.equal(st.equipamentos.get(4).deleted_at, "2026-11-20 14:00:00");
assert.equal(r.json.estado_depois.encontrado, false);
assert.equal(r.json.reverter.ferramenta, "hubsoft_equipamento_reativar");
// forcar=true inativa mesmo com serviços
r = await call(c, "hubsoft_equipamento_inativar", { servidor: "base_pf", id_equipamento: 3, confirmar: true, confirmar_nome: "OLT-CENTRO", forcar: true });
assert.equal(r.json.resultado.sucesso, true);
// contagem pela última exportação de serviços (≤ 24 h)
writeFileSync(join(exportDir, "servicos_base_pf_2026-11-20_10-00-00.csv"), "﻿base;equipamento_conexao_nome;equipamento_conexao_ip\r\nbase_pf;OLT-EXPORTADA;192.0.2.6\r\nbase_pf;OUTRA;192.0.2.9\r\n");
reqs = [];
r = await call(c, "hubsoft_equipamento_inativar", { servidor: "base_pf", id_equipamento: 6 });
assert.equal(r.json.contagem_servicos.fonte, "exportacao"); assert.equal(r.json.contagem_servicos.servicos_vinculados, 1);
assert.ok(!reqs.some(x => x.p.endsWith("cliente/todos")), "não varre a API quando há exportação recente");
r = await call(c, "hubsoft_equipamento_inativar", { servidor: "base_pf", id_equipamento: 6, fonte_contagem: "api" });
assert.equal(r.json.contagem_servicos.fonte, "api"); assert.equal(r.json.contagem_servicos.servicos_vinculados, 0);
// já inativo
r = await call(c, "hubsoft_equipamento_inativar", { servidor: "base_pf", id_equipamento: 5, confirmar: true, confirmar_nome: "OLT-ANTIGA" });
assert.equal(r.err, true);
// reativar: leitura prévia dá 404 (inativo); restore é um GET enviado uma vez; nome conferido depois
reqs = [];
r = await call(c, "hubsoft_equipamento_reativar", { servidor: "base_pf", id_equipamento: 4 });
assert.equal(r.json.modo, "simulacao"); assert.equal(reqs.filter(x => x.p.endsWith("/restore")).length, 0);
r = await call(c, "hubsoft_equipamento_reativar", { servidor: "base_pf", id_equipamento: 4, confirmar: true });
assert.equal(r.err, true, "confirmar_nome obrigatório");
r = await call(c, "hubsoft_equipamento_reativar", { servidor: "base_pf", id_equipamento: 4, confirmar: true, confirmar_nome: "OLT-VAZIA" });
assert.ok(!r.err, r.text);
assert.equal(r.json.resultado.sucesso, true); assert.equal(st.equipamentos.get(4).deleted_at, null);
assert.equal(r.json.estado_depois.equipamento.nome, "OLT-VAZIA");
assert.equal(reqs.filter(x => x.p.endsWith("/restore")).length, 1);
r = await call(c, "hubsoft_equipamento_reativar", { servidor: "base_pf", id_equipamento: 5, confirmar: true, confirmar_nome: "OUTRO-NOME" });
assert.ok(r.json.avisos.some(a => /ATENÇÃO.*OLT-ANTIGA/.test(a)), "nome divergente apontado após reativar");
r = await call(c, "hubsoft_equipamento_reativar", { servidor: "base_pf", id_equipamento: 4, confirmar: true, confirmar_nome: "OLT-VAZIA" });
assert.equal(r.err, true, "já ativo");
const audEq = readFileSync(auditoria, "utf8").trim().split("\n").map(JSON.parse).filter(x => /equipamento_/.test(x.ferramenta));
assert.deepEqual(audEq.map(a => a.ferramenta), ["hubsoft_equipamento_inativar", "hubsoft_equipamento_inativar", "hubsoft_equipamento_reativar", "hubsoft_equipamento_reativar"]);
await c.close();

// sem permissão de escrita, as ferramentas não existem
c = await conectar({ HUBSOFT_PERMITIR_ESCRITA: "false" });
const ro = (await c.listTools()).tools.map(t => t.name);
for (const n of ["hubsoft_vincular_lote", "hubsoft_equipamento_inativar", "hubsoft_equipamento_reativar"]) assert.ok(!ro.includes(n), `${n} sem escrita`);
await c.close();

srv.close();
console.log(`✅ lote ok — ${aud.length} linhas auditadas no lote, ${audEq.length} operações de equipamento`);
