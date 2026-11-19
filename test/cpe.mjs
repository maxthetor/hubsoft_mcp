// Testes das ferramentas de escrita/controle de CPE contra um Hubsoft simulado.
// Nenhuma chamada vai à API real.
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const norm = (s) => String(s ?? "").replace(/[^0-9a-z]/gi, "").toUpperCase();
let estado, posts, tokens, flags;
function reset() {
  estado = {
    servico: { id_cliente_servico: 501, status: "Serviço Habilitado", status_prefixo: "servico_habilitado", login: "joao", senha: "pppoe!", mac_addr: null, phy_addr: "ALCL0001", interface: null, equipamento_conexao: null, interface_roteamento: null, equipamento_roteamento: null, cpes: [] },
    cpes: [
      { id_cpe: 9, phy_addr: "ALCL0001", data_ultima_atualizacao: "2026-11-18 10:00:00", servicos: [] },
      { id_cpe: 10, phy_addr: "ALCL0099", data_ultima_atualizacao: "2026-11-18 09:00:00", servicos: [{ id_cliente_servico: 777 }] },
    ],
    params: [
      { descricao: "SSID 2.4", prefixo: "wifi_ssid", parametro: "IGD.WLAN.1.SSID", valor: "Casa" },
      { descricao: "Senha 2.4", prefixo: "wifi_password", parametro: "IGD.WLAN.1.KeyPassphrase", valor: "segredo123" },
      { descricao: "Canal", prefixo: "wifi_canal", parametro: "IGD.WLAN.1.Channel", valor: "6" },
    ],
  };
  posts = []; tokens = 0; flags = { revogarUmaVez: false, limitar: false };
}
reset();

const srv = http.createServer((q, r) => { let b = ""; q.on("data", d => b += d); q.on("end", () => {
  const send = (o, s = 200, h = {}) => { r.writeHead(s, { "Content-Type": "application/json", ...h }); r.end(JSON.stringify(o)); };
  const u = new URL(q.url, "http://x"); const p = u.pathname; const qs = u.searchParams;
  if (p === "/oauth/token") { tokens++; return send({ token_type: "Bearer", access_token: "tok" + tokens, expires_in: 3600 }); }
  if (q.method === "POST") posts.push(p);
  if (q.method === "POST" && flags.revogarUmaVez) { flags.revogarUmaVez = false; return send({ msg: "Unauthenticated." }, 401); }
  if (q.method === "POST" && flags.limitar) return send({ error: "rate_limit_exceeded", retry_after: 30 }, 429);
  const body = b ? JSON.parse(b) : null;
  const sv = estado.servico;
  if (p === "/api/v1/integracao/cliente" && q.method === "GET") {
    assert.equal(qs.get("relacoes"), "interface,equipamento_conexao,interface_roteamento,equipamento_roteamento,cpes");
    const achou = qs.get("busca") === "id_cliente_servico" && Number(qs.get("termo_busca")) === sv.id_cliente_servico;
    return send({ status: "success", clientes: achou ? [{ codigo_cliente: 55, nome_razaosocial: "JOAO", servicos: [structuredClone(sv)] }] : [] });
  }
  if (p === "/api/v1/integracao/rede/cpe/todos") {
    assert.equal(qs.get("somente_assinante_associado"), "nao");
    return send({ status: "success", cpes: estado.cpes.filter(c => norm(c.phy_addr).includes(norm(qs.get("termo_busca")))) });
  }
  if (p === "/api/v1/integracao/cliente/configurar_autenticacao") {
    if (body.phy_addr && norm(body.phy_addr) === "ALCL0099") return send({ status: "error", msg: "O phy_addr informado já está em uso por outro assinante.", data: { campo: "phy_addr" } }, 422);
    if (body.phy_addr) sv.phy_addr = body.phy_addr.toUpperCase();
    if (body.login) sv.login = body.login;
    return send({ status: "success", msg: "Parâmetros de autenticação modificados com sucesso.", alteracoes_realizadas: "As alterações realizadas foram em: MAC Layer2" });
  }
  if (p === "/api/v1/integracao/cliente/vincular_cpe") {
    const cpe = estado.cpes.find(c => norm(c.phy_addr) === norm(sv.phy_addr));
    if (!cpe) return send({ status: "error", msg: "CPE não encontrada para o MAC informado" }, 422);
    sv.cpes = [{ id_cpe: cpe.id_cpe, phy_addr: cpe.phy_addr }];
    sv.equipamento_conexao = { id_equipamento_conexao: 3, nome: "OLT-CENTRO" };
    sv.interface = { id_interface_conexao: 44, nome: "GPON 0/1/3" };
    sv.interface_roteamento = { id: 7, vlan: 1203 }; sv.equipamento_roteamento = { id: 2, nome: "BNG-01" };
    cpe.servicos = [{ id_cliente_servico: 501 }];
    return send({ status: "success", msg: "CPE vinculada com sucesso à autenticação do cliente!" });
  }
  if (p === "/api/v1/integracao/cliente/desvincular_cpe") {
    sv.cpes = []; if (!body.phy_addr || norm(body.phy_addr) === norm(sv.phy_addr)) sv.phy_addr = "";
    return send({ status: "success", msg: "CPE desvinculada." });
  }
  if (p.startsWith("/api/v1/integracao/rede/reiniciar_cpe/") || p.startsWith("/api/v1/integracao/rede/restaurar_cpe/")) {
    assert.equal(b, "[]", "corpo deve ser []");
    return send({ status: "success", msg: "Comando enviado para a CPE " + decodeURIComponent(p.split("/").pop()) });
  }
  if (p === "/api/v1/integracao/rede/cpe/iniciar_gerenciamento") {
    if (qs.get("id_cpe") && qs.get("phy_addr")) return send({ status: "error", msg: "Informe apenas um" }, 422);
    return send({ status: "success", cpe: { id_cpe: 9, phy_addr: "ALCL0001", parametros: structuredClone(estado.params) } });
  }
  if (p === "/api/v1/integracao/rede/cpe/gerenciar") {
    for (const x of body.parametros) estado.params.find(y => y.prefixo === x.prefixo).valor = x.valor;
    return send({ status: "success", msg: "Parâmetros enviados para a CPE." });
  }
  send({ status: "error", msg: "rota inexistente " + p }, 404);
}); }).listen(0);
await new Promise(r => srv.once("listening", r));
const URL_ = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(join(tmpdir(), "hs-cpe-"));
const AUD = join(dir, "auditoria.jsonl");
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUBSOFT_")));
const cred = (pre) => ({ [`${pre}URL`]: URL_, [`${pre}CLIENT_ID`]: "1", [`${pre}CLIENT_SECRET`]: "SEGREDO-CLIENTE", [`${pre}USERNAME`]: "u", [`${pre}PASSWORD`]: "SENHA-API" });

async function conectar(env) {
  const t = new StdioClientTransport({ command: "node", args: ["server/hubsoft-mcp.mjs"], stderr: "pipe", env: { ...baseEnv, HUBSOFT_AUDITORIA: AUD, ...env } });
  const c = new Client({ name: "cpe", version: "0" }); await c.connect(t); return c;
}
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content[0].text; let json = null; try { json = JSON.parse(text); } catch {}
  return { err: !!r.isError, text, json };
};
const ESCRITAS = ["hubsoft_configurar_autenticacao", "hubsoft_vincular_cpe", "hubsoft_desvincular_cpe", "hubsoft_reiniciar_cpe", "hubsoft_restaurar_cpe", "hubsoft_cpe_gerenciar"];

// 1) Sem permissão: escritas não existem; leitura ACS existe e exige servidor
let c = await conectar({ HUBSOFT_NOME: "base_a", ...cred("HUBSOFT_") });
let nomes = (await c.listTools()).tools.map(t => t.name);
for (const n of ESCRITAS) assert.ok(!nomes.includes(n), `${n} não deve existir sem HUBSOFT_PERMITIR_ESCRITA`);
assert.ok(nomes.includes("hubsoft_cpe_iniciar_gerenciamento"));
let r = await call(c, "hubsoft_cpe_iniciar_gerenciamento", { servidor: "todos", id_cpe: 9 });
assert.equal(r.err, true); assert.match(r.text, /UMA base/);
r = await call(c, "hubsoft_cpe_iniciar_gerenciamento", { servidor: "base_a", id_cpe: 9 });
assert.equal(r.json.servidor, "base_a"); assert.equal(r.json.cpe.parametros.find(x => x.prefixo === "wifi_password").valor, "***");
r = await call(c, "hubsoft_cpe_iniciar_gerenciamento", { servidor: "base_a", id_cpe: 9, mostrar_senhas: true });
assert.equal(r.json.cpe.parametros.find(x => x.prefixo === "wifi_password").valor, "segredo123");
r = await call(c, "hubsoft_cpe_iniciar_gerenciamento", { servidor: "base_a", id_cpe: 9, phy_addr: "ALCL0001" });
assert.equal(r.err, true); assert.match(r.text, /exatamente um/);
await c.close();

// 2) Duas bases: escrita global ligada, mas desligada na base_b
c = await conectar({ HUBSOFT_PERMITIR_ESCRITA: "true", HUBSOFT_NOME: "base_a", ...cred("HUBSOFT_"), HUBSOFT_2_NOME: "base_b", HUBSOFT_2_PERMITIR_ESCRITA: "false", ...cred("HUBSOFT_2_") });
nomes = (await c.listTools()).tools;
const tConf = nomes.find(t => t.name === "hubsoft_configurar_autenticacao");
assert.ok(tConf.inputSchema.required.includes("servidor"));
assert.equal(tConf.annotations.idempotentHint, true); assert.equal(tConf.annotations.destructiveHint, false);
assert.equal(nomes.find(t => t.name === "hubsoft_desvincular_cpe").annotations.destructiveHint, true);
assert.equal(nomes.find(t => t.name === "hubsoft_reiniciar_cpe").annotations.idempotentHint, false);

for (const servidor of ["todos", "base_a,base_b", ""]) {
  r = await call(c, "hubsoft_vincular_cpe", { servidor, id_cliente_servico: 501 });
  assert.equal(r.err, true, `servidor="${servidor}" deve ser recusado`);
}
r = await call(c, "hubsoft_vincular_cpe", { servidor: "base_b", id_cliente_servico: 501 });
assert.equal(r.err, true); assert.match(r.text, /escrita não habilitada/);
assert.equal(posts.length, 0, "nada enviado nas recusas");

// 3) configurar_autenticacao: validações locais
r = await call(c, "hubsoft_configurar_autenticacao", { servidor: "base_a", id_cliente_servico: 501 });
assert.equal(r.err, true); assert.match(r.text, /pelo menos um/);
r = await call(c, "hubsoft_configurar_autenticacao", { servidor: "base_a", id_cliente_servico: 501, phy_addr: "AB C" });
assert.equal(r.err, true);
r = await call(c, "hubsoft_configurar_autenticacao", { servidor: "base_a", id_cliente_servico: 501, login: "ab" });
assert.equal(r.err, true);

// simulação: nada enviado, mostra estado, requisição e efeito; senha mascarada
r = await call(c, "hubsoft_configurar_autenticacao", { servidor: "base_a", id_cliente_servico: 501, phy_addr: "alcl0002", password: "senhaNova123", observacoes: null });
assert.equal(r.json.modo, "simulacao"); assert.equal(r.json.nada_foi_enviado, true);
assert.equal(posts.length, 0, "simulação não envia POST");
assert.equal(r.json.requisicao_que_seria_enviada.metodo, "POST");
assert.match(r.json.requisicao_que_seria_enviada.url, /\/api\/v1\/integracao\/cliente\/configurar_autenticacao$/);
assert.equal(r.json.requisicao_que_seria_enviada.corpo.password, "***");
assert.equal(r.json.requisicao_que_seria_enviada.corpo.observacoes, null);
assert.equal(r.json.estado_atual.servico.servico.phy_addr, "ALCL0001");
assert.ok(r.json.efeito_esperado.some(e => e.includes('"ALCL0002"')), "mostra o phy em maiúsculas");
assert.ok(r.json.avisos.some(a => /não está no inventário/.test(a)));
assert.ok(!r.text.includes("senhaNova123"));

// aviso de CPE vinculada a outro serviço + erro 4xx exibido na íntegra
r = await call(c, "hubsoft_configurar_autenticacao", { servidor: "base_a", id_cliente_servico: 501, phy_addr: "ALCL0099" });
assert.ok(r.json.avisos.some(a => /vinculada a outro/.test(a) && a.includes("777")));
r = await call(c, "hubsoft_configurar_autenticacao", { servidor: "base_a", id_cliente_servico: 501, phy_addr: "ALCL0099", confirmar: true });
assert.equal(r.err, true); assert.equal(r.json.resultado.http_status, 422);
assert.equal(r.json.resultado.resposta.msg, "O phy_addr informado já está em uso por outro assinante.");
assert.deepEqual(r.json.resultado.resposta.data, { campo: "phy_addr" });

// execução com diff
r = await call(c, "hubsoft_configurar_autenticacao", { servidor: "base_a", id_cliente_servico: 501, login: "joao.silva", confirmar: true });
assert.equal(r.json.modo, "execucao"); assert.equal(r.json.resultado.sucesso, true);
assert.equal(r.json.resultado.resposta.alteracoes_realizadas, "As alterações realizadas foram em: MAC Layer2");
assert.ok(r.json.diff.some(d => d.campo === "servico.servico.login" && d.antes === "joao" && d.depois === "joao.silva"));

// 4) vincular_cpe: exatamente um parâmetro; simulação; execução preenche OLT/PON/BNG no diff
r = await call(c, "hubsoft_vincular_cpe", { servidor: "base_a", id_cliente_servico: 501, phy_addr: "ALCL0001" });
assert.equal(r.err, true); assert.match(r.text, /exatamente um/);
let antes = posts.length;
r = await call(c, "hubsoft_vincular_cpe", { servidor: "base_a", id_cliente_servico: 501 });
assert.equal(r.json.modo, "simulacao"); assert.equal(posts.length, antes);
r = await call(c, "hubsoft_vincular_cpe", { servidor: "base_a", id_cliente_servico: 501, confirmar: true });
assert.equal(r.json.resultado.resposta.msg, "CPE vinculada com sucesso à autenticação do cliente!");
const campos = r.json.diff.map(d => d.campo).join(" ");
for (const k of ["equipamento_conexao", "interface", "interface_roteamento", "equipamento_roteamento", "cpes"]) assert.match(campos, new RegExp(k), `diff mostra ${k}`);

// 5) desvincular_cpe: simulação com efeito e rollback
antes = posts.length;
r = await call(c, "hubsoft_desvincular_cpe", { servidor: "base_a", id_cliente_servico: 501, phy_addr: "alcl-0001" });
assert.equal(posts.length, antes);
assert.ok(r.json.efeito_esperado.some(e => /ZERADO/.test(e)));
assert.equal(r.json.cpes_afetadas.length, 1);
assert.equal(r.json.rollback[0].ferramenta, "hubsoft_configurar_autenticacao");
assert.equal(r.json.rollback[0].argumentos.phy_addr, "ALCL0001");
assert.equal(r.json.rollback[0].argumentos.id_interface_conexao, 44);
assert.equal(r.json.rollback[1].ferramenta, "hubsoft_vincular_cpe");
r = await call(c, "hubsoft_desvincular_cpe", { servidor: "base_a", id_cliente_servico: 501, confirmar: true });
assert.ok(r.json.diff.some(d => d.campo === "servico.servico.phy_addr" && d.depois === ""));

// 6) reiniciar: CPE inexistente bloqueia; 401 renova token uma vez e reenvia
r = await call(c, "hubsoft_reiniciar_cpe", { servidor: "base_a", phy_addr: "NAOEXISTE1", confirmar: true });
assert.equal(r.err, true); assert.match(r.json.bloqueado, /não encontrada/); 
antes = posts.length; const tokAntes = tokens; flags.revogarUmaVez = true;
r = await call(c, "hubsoft_reiniciar_cpe", { servidor: "base_a", phy_addr: "ALCL0001", confirmar: true });
assert.equal(r.json.resultado.sucesso, true); assert.equal(r.json.resultado.token_renovado, true);
assert.equal(posts.length - antes, 2, "POST reenviado exatamente uma vez após o 401");
assert.equal(tokens - tokAntes, 1, "token renovado uma vez");
assert.ok(r.json.estado_antes.cpe.encontradas[0].id_cpe === 9);

// 7) restaurar: exige confirmar_phy_addr igual
antes = posts.length;
r = await call(c, "hubsoft_restaurar_cpe", { servidor: "base_a", phy_addr: "ALCL0001", confirmar: true, confirmar_phy_addr: "ALCL0002" });
assert.equal(r.err, true); assert.match(r.json.bloqueado, /MESMO valor/); assert.equal(posts.length, antes);
r = await call(c, "hubsoft_restaurar_cpe", { servidor: "base_a", phy_addr: "ALCL0001" });
assert.ok(r.json.avisos.some(a => /FÁBRICA/.test(a))); assert.equal(posts.length, antes);
r = await call(c, "hubsoft_restaurar_cpe", { servidor: "base_a", phy_addr: "ALCL0001", confirmar: true, confirmar_phy_addr: "alcl0001" });
assert.equal(r.json.resultado.sucesso, true);

// 8) cpe_gerenciar: valida prefixo e formato; simulação mascarada; 429 sem retry
r = await call(c, "hubsoft_cpe_gerenciar", { servidor: "base_a", id_cpe: 9, parametros: [{ prefixo: "wifi_inexistente", valor: "x" }] });
assert.equal(r.err, true); assert.match(r.text, /prefixo inexistente/);
r = await call(c, "hubsoft_cpe_gerenciar", { servidor: "base_a", id_cpe: 9, parametros: [{ prefixo: "wifi_canal", valor: "auto" }, { prefixo: "wifi_password", valor: "curta" }] });
assert.equal(r.err, true); assert.ok(r.json.erros_de_validacao.length === 2);
antes = posts.length;
r = await call(c, "hubsoft_cpe_gerenciar", { servidor: "base_a", id_cpe: 9, parametros: [{ prefixo: "wifi_ssid", valor: "Casa_Nova" }, { prefixo: "wifi_password", valor: "novaSenha2026" }] });
assert.equal(posts.length, antes, "simulação não envia");
const alt = Object.fromEntries(r.json.alteracoes.map(a => [a.prefixo, a]));
assert.equal(alt.wifi_ssid.atual, "Casa"); assert.equal(alt.wifi_ssid.novo, "Casa_Nova");
assert.equal(alt.wifi_password.atual, "***"); assert.equal(alt.wifi_password.novo, "***");
assert.ok(!r.text.includes("novaSenha2026") && !r.text.includes("segredo123"));
flags.limitar = true; antes = posts.length;
r = await call(c, "hubsoft_cpe_gerenciar", { servidor: "base_a", id_cpe: 9, parametros: [{ prefixo: "wifi_ssid", valor: "Casa_Nova" }], confirmar: true });
flags.limitar = false;
assert.equal(r.err, true); assert.equal(r.json.resultado.http_status, 429); assert.equal(r.json.resultado.retry_after, 30);
assert.equal(posts.length - antes, 1, "429 não é repetido");
r = await call(c, "hubsoft_cpe_gerenciar", { servidor: "base_a", id_cpe: 9, parametros: [{ prefixo: "wifi_ssid", valor: "Casa_Nova" }, { prefixo: "wifi_password", valor: "novaSenha2026" }], confirmar: true });
assert.equal(r.json.resultado.sucesso, true);
assert.ok(r.json.diff.some(d => d.campo === "wifi_ssid" && d.depois === "Casa_Nova"));
assert.ok(!r.text.includes("novaSenha2026"));
await c.close();

// 9) Uma base só: servidor continua obrigatório nas escritas
c = await conectar({ HUBSOFT_PERMITIR_ESCRITA: "true", HUBSOFT_NOME: "unica", ...cred("HUBSOFT_") });
r = await call(c, "hubsoft_reiniciar_cpe", { servidor: "todos", phy_addr: "ALCL0001" });
assert.equal(r.err, true); assert.match(r.text, /UMA base/);
r = await call(c, "hubsoft_reiniciar_cpe", { servidor: "unica", phy_addr: "ALCL0001" });
assert.equal(r.json.modo, "simulacao");
await c.close();

// 10) Auditoria: só execuções, sem segredos
assert.ok(existsSync(AUD));
const linhas = readFileSync(AUD, "utf8").trim().split("\n").map(l => JSON.parse(l));
const ferr = linhas.map(l => l.ferramenta);
for (const n of ["hubsoft_configurar_autenticacao", "hubsoft_vincular_cpe", "hubsoft_desvincular_cpe", "hubsoft_reiniciar_cpe", "hubsoft_restaurar_cpe", "hubsoft_cpe_gerenciar"]) assert.ok(ferr.includes(n), `auditoria de ${n}`);
assert.ok(linhas.every(l => l.data_hora && l.base && "http_status" in l && "resposta" in l && "diff" in l && "corpo" in l));
const bruto = readFileSync(AUD, "utf8");
for (const s of ["SEGREDO-CLIENTE", "SENHA-API", "novaSenha2026", "segredo123", "senhaNova123", "tok1", "tok2", "pppoe!"]) assert.ok(!bruto.includes(s), `auditoria não pode conter ${s}`);
assert.equal(linhas.filter(l => l.http_status === 429).length, 1);

srv.close();
console.log(`✅ cpe ok — ${linhas.length} execuções auditadas, ${posts.length} POSTs no simulador`);
