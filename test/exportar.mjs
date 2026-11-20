// Testes das ferramentas de exportação CSV contra um Hubsoft simulado (nenhuma chamada à API real).
// Cobre: paginação, 429 com retry_after, novas tentativas, retomada, limite de req/s, recusa de
// "todos", ausência de dados pessoais no CSV e ausência de linhas no resultado da ferramenta.
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

// Dados pessoais plantados no simulado: nenhum pode aparecer nos CSV nem nos resultados.
const PESSOAIS = ["98765432100", "11222333000181", "MG1234567", "85999990000", "8532221111", "fulano@exemplo.com", "Rua das Flores", "60000-000", "Bairro Centro", "pppoe-secreta", "wifi-secreta"];

const API = "/api/v1/integracao";
let pedidos, flags, contagem429, contagem500;
function reset() {
  pedidos = []; contagem429 = new Map(); contagem500 = new Map();
  flags = { cpePaginaQuebrada: false, cpeTotalPaginas: 2, cpeExtra: 0 };
}
reset();

const cliente = (n) => ({
  id_cliente: n, codigo_cliente: 1000 + n, nome_razaosocial: n === 1 ? 'EMPRESA "X"; LTDA' : `CLIENTE ${n}`, tipo_pessoa: n % 2 ? "pj" : "pf",
  cpf_cnpj: n % 2 ? "11222333000181" : "98765432100", rg: "MG1234567", telefone_primario: "85999990000", telefone_secundario: "8532221111",
  email_principal: "fulano@exemplo.com", endereco_cadastral: { endereco: "Rua das Flores", cep: "60000-000", bairro: "Bairro Centro" },
  servicos: n === 5 ? [] : [{
    id_cliente_servico: 500 + n, numero_plano: n, nome: `PLANO ${n}`, tecnologia: "FTTH", status: "Serviço Habilitado", status_prefixo: "servico_habilitado",
    login: `login${n}`, senha: "pppoe-secreta", mac_addr: "AA:BB:CC:00:00:0" + n, phy_addr: `FHTT000${n}`,
    interface: { nome: `GPON - 1/1/${n}`, tipo: "gpon" }, interface_roteamento: { nome: "VLAN-100", tipo: "vlan" },
    equipamento_conexao: { nome: "OLT-CENTRO", ipv4: "10.0.0.1" }, equipamento_roteamento: { nome: "BNG-01", ipv4: "10.0.0.254" },
    cpes: n === 2 ? [{ id_cpe: 71, phy_addr: "FHTT0002" }, { id_cpe: 72, phy_addr: "FHTT0002B" }] : [],
  }],
});

const srv = http.createServer((q, r) => { let b = ""; q.on("data", d => b += d); q.on("end", () => {
  const send = (o, s = 200) => { r.writeHead(s, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
  const u = new URL(q.url, "http://x"); const p = u.pathname; const qs = u.searchParams;
  if (p === "/oauth/token") return send({ token_type: "Bearer", access_token: "tok", expires_in: 3600 });
  pedidos.push({ t: Date.now(), metodo: q.method, p, pagina: qs.get("pagina") });
  assert.equal(q.method, "GET", "exportação só pode fazer GET");
  const pagina = Number(qs.get("pagina") ?? 0);

  if (p === `${API}/cliente/todos`) {
    assert.equal(qs.get("itens_por_pagina"), "100");
    assert.equal(qs.get("cancelado"), "nao");
    assert.equal(qs.get("relacoes"), "interface,equipamento_conexao,interface_roteamento,equipamento_roteamento,cpes");
    // página 1: um 429 antes de responder; página 2: dois 500 antes de responder
    if (pagina === 1 && !contagem429.get("cli1")) { contagem429.set("cli1", 1); return send({ error: "rate_limit_exceeded", retry_after: 1 }, 429); }
    if (pagina === 2 && (contagem500.get("cli2") ?? 0) < 2) { contagem500.set("cli2", (contagem500.get("cli2") ?? 0) + 1); return send({ msg: "erro interno" }, 500); }
    const porPagina = [[1, 2], [3, 4], [5, 6]][pagina] ?? [];
    return send({ status: "success", paginacao: { primeira_pagina: 0, ultima_pagina: 2, pagina_atual: pagina, total_registros: 6 }, clientes: porPagina.map(cliente) });
  }
  if (p === `${API}/rede/cpe/todos`) {
    assert.equal(qs.get("itens_por_pagina"), "500");
    assert.equal(qs.get("somente_assinante_associado"), "nao");
    if (flags.cpePaginaQuebrada && pagina === 1) return send({ msg: "Bad Gateway" }, 502);
    const ultima = flags.cpeTotalPaginas - 1;
    const cpes = pagina === 0
      ? [
          { id_cpe: 71, phy_addr: "FHTT0002", data_ultima_atualizacao: "2026-11-20 08:00:00", historico_parametros: [{ parametros: { rx_signal: "-20" } }],
            servicos: [{ id_cliente: 2, cliente: "(1002) CLIENTE 2 - (INATIVO)", cpf_cnpj: "98765432100", servico: "(2) PLANO 2", status: "servico_habilitado", id_cliente_servico: 502, login: "login2" },
                       { id_cliente: 9, cliente: "(1009) OUTRO", cpf_cnpj: "11222333000181", servico: "(0) PLANO 9", status: "suspenso_debito", id_cliente_servico: 509, login: "login9" }] },
          { id_cpe: 72, phy_addr: "FHTT0002B", data_ultima_atualizacao: "2026-11-19 08:00:00", historico_parametros: [], servicos: [] },
        ]
      : pagina <= ultima ? [{ id_cpe: 100 + pagina, phy_addr: `ALCL${pagina}`, data_ultima_atualizacao: null, historico_parametros: [], servicos: [] }] : [];
    return send({ status: "success", paginacao: { primeira_pagina: 0, ultima_pagina: ultima, pagina_atual: pagina, total_registros: 2 + ultima }, cpes });
  }
  if (p === `${API}/rede/equipamento`) {
    return send({ status: "success", equipamentos: [
      { id_equipamento: 73, nome: "OLT-TESTE", ipv4: "192.0.2.186", tipo: "OLT", modelo: "AN6001-G16", fabricante: "FIBERHOME", autentica_radius: false, senha_telnet: "x",
        interfaces: [
          { id_interface_conexao: 521, nome: "GPON - 1/1/1", tipo: "gpon",
            interface_conexao_roteamento: { id_interface_conexao: 288, nome: "CLIENTES-TESTE", tipo: "vlan", equipamento_conexao: { id_equipamento: 59, nome: "BRAS-TESTE", ipv4: "198.51.100.73" } },
            interface_gpon: { chassi: "1", slot: "1", pon: "1", max_clientes: 64, vlan: 1203 } },
          { id_interface_conexao: 530, nome: "GPON - 1/1/10", tipo: "gpon", interface_conexao_roteamento: null, interface_gpon: { chassi: "1", slot: "1", pon: "10", max_clientes: 64, vlan: null } },
        ] },
      { id_equipamento: 128, nome: "BNG-TESTE", ipv4: "198.51.100.70", tipo: "ROTEADOR", modelo: "NE8000", fabricante: "HUAWEI", autentica_radius: true,
        interfaces: [{ id_interface_conexao: 1056, nome: "1924-QinQ", tipo: "vlan", interface_conexao_roteamento: { nome: "1924-QinQ", equipamento_conexao: { nome: "BNG-TESTE", ipv4: "198.51.100.70" } }, interface_vlan: { tag: 1924 } }] },
      { id_equipamento: 5, nome: "SEM-INTERFACE", ipv4: "1.1.1.1", tipo: "ROTEADOR", modelo: "CCR", fabricante: "MIKROTIK", autentica_radius: true, interfaces: [] },
    ] });
  }
  if (p === `${API}/rede/pop`) {
    return send({ status: "success", pops: [
      { id_pop: 13, nome: "POP SEDE", cidade: "Fortaleza", endereco: "Rua das Flores", cep: "60000-000", telefone: "8532221111",
        equipamentos: [{ id_equipamento: 73, nome: "OLT-TESTE" }, { id_equipamento: 128, nome: "BNG-TESTE" }] },
      { id_pop: 55, nome: "POP VAZIO", equipamentos: [] },
    ] });
  }
  send({ status: "error", msg: "rota inexistente " + p }, 404);
}); }).listen(0);
await new Promise(r => srv.listening ? r() : srv.once("listening", r));
const url = `http://127.0.0.1:${srv.address().port}`;

const dir = mkdtempSync(join(tmpdir(), "hs-export-"));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUBSOFT_")));
const credenciais = (pfx) => ({ [`${pfx}URL`]: url, [`${pfx}CLIENT_ID`]: "1", [`${pfx}CLIENT_SECRET`]: "s", [`${pfx}USERNAME`]: "u", [`${pfx}PASSWORD`]: "p" });
async function conectar(extra = {}, umaBase = false) {
  const t = new StdioClientTransport({ command: "node", args: ["server/hubsoft-mcp.mjs"], stderr: "pipe", env: { ...baseEnv,
    HUBSOFT_TOKENS: "off", HUBSOFT_2FA_DIALOGO: "off", HUBSOFT_EXPORT_DIR: dir, HUBSOFT_EXPORT_ESPERA_MS: "20",
    HUBSOFT_NOME: "base_pf", ...credenciais("HUBSOFT_"),
    ...(umaBase ? {} : { HUBSOFT_2_NOME: "base_pj", ...credenciais("HUBSOFT_2_") }), ...extra } });
  const c = new Client({ name: "export", version: "0" }); await c.connect(t); return c;
}
const call = async (c, name, args = {}, opts) => {
  const r = await c.callTool({ name, arguments: args }, CallToolResultSchema, opts);
  const text = r.content[0].text;
  return { err: r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const lerCsv = (arquivo) => {
  const bruto = readFileSync(arquivo, "utf8");
  assert.ok(bruto.startsWith("﻿"), "CSV com BOM");
  assert.ok(bruto.includes("\r\n"), "CSV com CRLF");
  return bruto;
};
const linhasCsv = (bruto) => bruto.slice(1).trimEnd().split("\r\n").map(l => l.split(";"));
const semPessoais = (texto, onde) => { for (const x of PESSOAIS) assert.ok(!texto.includes(x), `${onde} não pode conter "${x}"`); };
const RESUMO = ["arquivo", "linhas", "paginas_lidas", "tempo_s", "erros", "completo"];

let c = await conectar();
const tools = (await c.listTools()).tools;
for (const n of ["hubsoft_exportar_servicos", "hubsoft_exportar_cpes", "hubsoft_exportar_equipamentos"]) {
  const t = tools.find(x => x.name === n);
  assert.ok(t, `${n} registrada`);
  assert.deepEqual(t.inputSchema.required, ["servidor"], `${n}: servidor obrigatório`);
  assert.equal(t.annotations.destructiveHint, false);
}

// ---- recusa de "todos", listas, vazio e base inexistente
for (const servidor of [undefined, "todos", "all", "*", "base_pf,base_pj", "pessoa física", "base_xyz"]) {
  const r = await call(c, "hubsoft_exportar_servicos", servidor === undefined ? {} : { servidor });
  assert.equal(r.err, true, `servidor=${servidor} deve ser recusado`);
  assert.match(r.text, /servidor|UMA base|não encontrado/);
}
assert.equal(pedidos.length, 0, "nada é pedido ao Hubsoft quando a base é recusada");
assert.equal(readdirSync(dir).length, 0, "nenhum arquivo criado");

// ---- serviços: 3 páginas, 429 na página 1, dois 500 na página 2 (retomada na própria página)
const progresso = [];
let r = await call(c, "hubsoft_exportar_servicos", { servidor: "base_pf" }, { onprogress: (p) => progresso.push(p), timeout: 30_000 });
assert.ok(!r.err, r.text);
assert.equal(r.json.servidor, "base_pf");
assert.deepEqual(Object.keys(r.json).filter(k => RESUMO.includes(k)).sort(), [...RESUMO].sort());
assert.equal(r.json.completo, true);
assert.equal(r.json.paginas_lidas, 3);
assert.equal(r.json.linhas, 5, "cliente 5 não tem serviço");
assert.deepEqual(r.json.erros, []);
assert.equal(r.json.esperas_429, 1);
assert.equal(r.json.novas_tentativas, 2);
assert.match(r.json.arquivo, /servicos_base_pf_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
assert.ok(progresso.length >= 1 && progresso.at(-1).progress === 3, "notificações de progresso");
const pg1 = pedidos.filter(x => x.pagina === "1").map(x => x.t);
assert.ok(pg1.length === 2 && pg1[1] - pg1[0] >= 950, "esperou retry_after (1 s) após o 429");
assert.equal(pedidos.filter(x => x.pagina === "2").length, 3, "página 2: 2 falhas + 1 sucesso, sem reler as outras");
assert.equal(pedidos.filter(x => x.pagina === "0").length, 1);
// resultado não traz linhas nem dados
for (const x of ["CLIENTE 2", "login1", "FHTT0001", "OLT-CENTRO"]) assert.ok(!r.text.includes(x), `resultado sem dados (${x})`);
semPessoais(r.text, "resultado");

let bruto = lerCsv(r.json.arquivo);
semPessoais(bruto, "CSV de serviços");
let linhas = linhasCsv(bruto);
assert.deepEqual(linhas[0], ["base", "id_cliente", "codigo_cliente", "nome_razaosocial", "tipo_pessoa", "id_cliente_servico", "numero_plano", "plano", "tecnologia", "status", "status_prefixo", "login", "mac_addr", "phy_addr", "interface_nome", "interface_tipo", "equipamento_conexao_nome", "equipamento_conexao_ip", "interface_roteamento_nome", "equipamento_roteamento_nome", "equipamento_roteamento_ip", "cpes_ids", "cpes_phy_addr", "qtd_cpes"]);
assert.equal(linhas.length, 6);
assert.ok(bruto.includes('"EMPRESA ""X""; LTDA"'), "célula com ; e aspas escapada");
const l2 = bruto.split("\r\n").find(l => l.includes(";502;"));
assert.ok(l2.startsWith("base_pf;2;1002;CLIENTE 2;pf;502;2;PLANO 2;FTTH;Serviço Habilitado;servico_habilitado;login2;"), l2);
assert.ok(l2.endsWith(";OLT-CENTRO;10.0.0.1;VLAN-100;BNG-01;10.0.0.254;71|72;FHTT0002|FHTT0002B;2"), l2);

// nunca sobrescreve: duas exportações no mesmo segundo geram arquivos diferentes
reset();
const a = await call(c, "hubsoft_exportar_equipamentos", { servidor: "base_pj" });
const b = await call(c, "hubsoft_exportar_equipamentos", { servidor: "base_pj" });
assert.ok(!a.err && !b.err, a.text + b.text);
assert.notEqual(a.json.arquivos.equipamentos.arquivo, b.json.arquivos.equipamentos.arquivo);
assert.notEqual(a.json.arquivos.pops.arquivo, b.json.arquivos.pops.arquivo);

// ---- equipamentos e POPs
assert.equal(a.json.servidor, "base_pj");
assert.equal(a.json.paginas_lidas, 2);
assert.equal(a.json.completo, true);
assert.equal(a.json.arquivos.equipamentos.linhas, 4, "2 PONs + 1 VLAN + 1 equipamento sem interface");
assert.equal(a.json.arquivos.pops.linhas, 2);
assert.match(a.json.arquivos.equipamentos.arquivo, /equipamentos_base_pj_/);
assert.ok(!a.text.includes("OLT-TESTE") && !a.text.includes("POP SEDE"), "resultado sem dados");
bruto = lerCsv(a.json.arquivos.equipamentos.arquivo);
semPessoais(bruto, "CSV de equipamentos");
assert.ok(!bruto.includes("senha_telnet"));
linhas = linhasCsv(bruto);
assert.deepEqual(linhas[0], ["id_equipamento", "nome", "ipv4", "tipo", "modelo", "fabricante", "autentica_radius", "id_interface_conexao", "interface_nome", "interface_tipo", "chassi", "slot", "pon", "vlan", "max_clientes", "roteamento_interface_nome", "roteamento_equipamento_nome", "roteamento_equipamento_ip"]);
assert.deepEqual(linhas[1], ["73", "OLT-TESTE", "192.0.2.186", "OLT", "AN6001-G16", "FIBERHOME", "false", "521", "GPON - 1/1/1", "gpon", "1", "1", "1", "1203", "64", "CLIENTES-TESTE", "BRAS-TESTE", "198.51.100.73"]);
assert.equal(linhas[3][13], "1924", "VLAN vem de interface_vlan.tag");
assert.deepEqual(linhas[4], ["5", "SEM-INTERFACE", "1.1.1.1", "ROTEADOR", "CCR", "MIKROTIK", "true", "", "", "", "", "", "", "", "", "", "", ""]);
bruto = lerCsv(a.json.arquivos.pops.arquivo);
semPessoais(bruto, "CSV de POPs");
linhas = linhasCsv(bruto);
assert.deepEqual(linhas[0], ["id_pop", "nome", "cidade", "qtd_equipamentos", "equipamentos_ids", "equipamentos_nomes"]);
assert.deepEqual(linhas[1], ["13", "POP SEDE", "Fortaleza", "2", "73|128", "OLT-TESTE|BNG-TESTE"]);
assert.deepEqual(linhas[2], ["55", "POP VAZIO", "", "0", "", ""]);

// ---- CPEs: página 1 quebrada → arquivo parcial e retomar_de_pagina; depois retoma dela
reset(); flags.cpePaginaQuebrada = true; flags.cpeTotalPaginas = 3;
r = await call(c, "hubsoft_exportar_cpes", { servidor: "base_pf" });
assert.ok(!r.err, r.text);
assert.equal(r.json.completo, false);
assert.equal(r.json.retomar_de_pagina, 1);
assert.equal(r.json.paginas_lidas, 1);
assert.equal(r.json.linhas, 3, "CPE 71 × 2 serviços + CPE 72 sem serviço");
assert.equal(r.json.erros.length, 1); assert.match(r.json.erros[0], /página 1: HTTP 502.*3 tentativas/);
assert.match(r.json.arquivo, /cpes_base_pf_.*_parcial(_\d+)?\.csv$/);
assert.equal(pedidos.filter(x => x.pagina === "1").length, 3, "3 tentativas na página que falhou");
bruto = lerCsv(r.json.arquivo);
semPessoais(bruto, "CSV de CPEs");
linhas = linhasCsv(bruto);
assert.deepEqual(linhas[0], ["id_cpe", "phy_addr", "data_ultima_atualizacao", "id_cliente_servico", "login", "status_servico", "cliente"]);
assert.deepEqual(linhas[1], ["71", "FHTT0002", "2026-11-20 08:00:00", "502", "login2", "servico_habilitado", "(1002) CLIENTE 2 - (INATIVO)"]);
assert.deepEqual(linhas[2], ["71", "FHTT0002", "2026-11-20 08:00:00", "509", "login9", "suspenso_debito", "(1009) OUTRO"]);
assert.deepEqual(linhas[3], ["72", "FHTT0002B", "2026-11-19 08:00:00", "", "", "", ""]);

flags.cpePaginaQuebrada = false; pedidos = [];
r = await call(c, "hubsoft_exportar_cpes", { servidor: "base_pf", pagina_inicial: 1 });
assert.equal(r.json.completo, true);
assert.equal(r.json.paginas_lidas, 2);
assert.equal(r.json.linhas, 2);
assert.ok(!pedidos.some(x => x.pagina === "0"), "retomada não relê páginas anteriores");
assert.ok(!/_parcial/.test(r.json.arquivo));
await c.close();

// ---- limite de requisições por segundo (aqui 10 req/s, 4 em paralelo, 30 páginas)
reset(); flags.cpeTotalPaginas = 30;
c = await conectar({ HUBSOFT_EXPORT_REQ_S: "10", HUBSOFT_EXPORT_PARALELO: "4" });
r = await call(c, "hubsoft_exportar_cpes", { servidor: "base_pj" }, { timeout: 30_000 });
assert.equal(r.json.completo, true); assert.equal(r.json.paginas_lidas, 30);
const ts = pedidos.map(x => x.t).sort((x, y) => x - y);
let pico = 0;
for (let i = 0; i < ts.length; i++) pico = Math.max(pico, ts.filter(t => t >= ts[i] && t < ts[i] + 1000).length);
assert.ok(pico <= 10, `no máximo 10 req em qualquer janela de 1 s (pico ${pico})`);
await c.close();

// ---- com uma base só, servidor continua obrigatório
c = await conectar({}, true);
r = await call(c, "hubsoft_exportar_equipamentos", {});
assert.equal(r.err, true); assert.match(r.text, /servidor/);
r = await call(c, "hubsoft_exportar_equipamentos", { servidor: "todos" });
assert.equal(r.err, true);
r = await call(c, "hubsoft_exportar_equipamentos", { servidor: "base_pf" });
assert.equal(r.json.servidor, "base_pf"); assert.equal(r.json.completo, true);
await c.close();

srv.close();
console.log("exportar: ok");
