import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { API, fail, ok } from "../util.js";

/**
 * Ferramentas de escrita/controle de CPE (vínculo de ONT/ONU já autorizada na OLT ao
 * serviço do Hubsoft, sem desprovisionar, e controle da CPE pelo Hubsoft).
 *
 * Regras comuns (ver README):
 *  - escrita só existe com HUBSOFT_PERMITIR_ESCRITA=true (global ou por base);
 *  - `servidor` obrigatório e com UMA base (garantido em multi.ts);
 *  - `confirmar=false` (padrão) é simulação: nada é enviado;
 *  - leitura do estado antes e depois, com diff;
 *  - resposta do Hubsoft sempre na íntegra; sem nova tentativa em POST (exceto 401, uma vez);
 *  - auditoria JSONL sem segredos.
 */

const RELACOES = "interface,equipamento_conexao,interface_roteamento,equipamento_roteamento,cpes";
const SEGREDO = /password|senha|secret|token/i;

/** Normaliza phy_addr/MAC para comparação: sem separadores, maiúsculas. */
export const normPhy = (s: unknown) => String(s ?? "").replace(/[^0-9a-z]/gi, "").toUpperCase();

const mascara = (v: unknown) => (v === null || v === undefined || v === "" ? v : "***");

/** Mantém só campos escalares (ids, nomes, phy, vlan…), mascarando segredos. */
function compacto(o: any): any {
  if (o === null || o === undefined) return o ?? null;
  if (Array.isArray(o)) return o.map(compacto);
  if (typeof o !== "object") return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && typeof v === "object") continue;
    out[k] = SEGREDO.test(k) ? mascara(v) : v;
  }
  return out;
}

/** Todos os id_cliente_servico citados dentro de um objeto (vínculos de uma CPE). */
function idsServico(o: any, acc = new Set<number>()): Set<number> {
  if (Array.isArray(o)) o.forEach((x) => idsServico(x, acc));
  else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      if (k === "id_cliente_servico" && v !== null && v !== "") acc.add(Number(v));
      else if (v && typeof v === "object") idsServico(v, acc);
    }
  }
  return acc;
}

function snapshotServico(sv: any) {
  const out: Record<string, unknown> = {
    id_cliente_servico: sv.id_cliente_servico,
    status: sv.status ?? sv.servico_status?.descricao,
    status_prefixo: sv.status_prefixo ?? sv.servico_status?.prefixo,
    login: sv.login,
    mac_addr: sv.mac_addr,
    phy_addr: sv.phy_addr,
    id_interface_conexao:
      sv.id_interface_conexao ?? sv.interface?.id_interface_conexao ?? sv.interface_conexao?.id_interface_conexao ?? null,
  };
  for (const rel of ["interface", "interface_conexao", "equipamento_conexao", "interface_roteamento", "equipamento_roteamento", "cpes"]) {
    if (rel in sv) out[rel] = compacto(sv[rel]);
  }
  return out;
}

function resumoCpe(c: any) {
  return {
    id_cpe: c.id_cpe,
    phy_addr: c.phy_addr,
    data_ultima_atualizacao: c.data_ultima_atualizacao ?? null,
    servicos_vinculados: [...idsServico(c)],
    ...Object.fromEntries(
      Object.entries(c)
        .filter(([k, v]) => /servic|cliente|assinante/i.test(k) && v && typeof v === "object")
        .map(([k, v]) => [k, compacto(v)]),
    ),
  };
}

function primeiraLista(body: any): any[] {
  if (Array.isArray(body)) return body;
  for (const k of ["cpes", "dados", "data", "registros"]) if (Array.isArray(body?.[k])) return body[k];
  for (const v of Object.values(body ?? {})) if (Array.isArray(v)) return v as any[];
  return [];
}

async function lerServico(hs: HubsoftClient, id: number) {
  const r = await hs.raw("GET", `${API}/cliente`, {
    query: { busca: "id_cliente_servico", termo_busca: id, relacoes: RELACOES },
  });
  if (!r.ok) return { erro: { http_status: r.status, resposta: r.body } };
  for (const c of r.body?.clientes ?? []) {
    const sv = (c.servicos ?? []).find((s: any) => Number(s.id_cliente_servico) === Number(id));
    if (sv) return { cliente: { codigo_cliente: c.codigo_cliente, nome: c.nome_razaosocial }, servico: snapshotServico(sv) };
  }
  return { erro: { msg: `Serviço ${id} não encontrado nesta base.` } };
}

async function lerCpe(hs: HubsoftClient, phy: string) {
  const r = await hs.raw("GET", `${API}/rede/cpe/todos`, {
    query: { pagina: 0, itens_por_pagina: 20, busca: "phy_addr", termo_busca: phy, somente_assinante_associado: "nao" },
  });
  if (!r.ok) return { erro: { http_status: r.status, resposta: r.body } };
  const alvo = normPhy(phy);
  return { encontradas: primeiraLista(r.body).filter((c) => normPhy(c?.phy_addr) === alvo).map(resumoCpe) };
}

function achatar(o: any, prefixo = "", out: Record<string, string> = {}) {
  if (o && typeof o === "object") {
    const entradas = Array.isArray(o) ? o.map((v, i) => [String(i), v] as const) : Object.entries(o);
    if (!entradas.length) out[prefixo] = JSON.stringify(o);
    for (const [k, v] of entradas) achatar(v, prefixo ? `${prefixo}.${k}` : k, out);
  } else out[prefixo] = JSON.stringify(o ?? null);
  return out;
}

/** Diferenças campo a campo entre dois estados. */
export function diff(antes: unknown, depois: unknown) {
  const a = achatar(antes);
  const b = achatar(depois);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => a[k] !== b[k])
    .sort()
    .map((campo) => ({
      campo,
      antes: a[campo] === undefined ? undefined : JSON.parse(a[campo]),
      depois: b[campo] === undefined ? undefined : JSON.parse(b[campo]),
    }));
}

/** Copia profunda com segredos e senhas Wi-Fi trocados por "***" (para auditoria e exibição). */
export function semSegredos(o: any): any {
  if (Array.isArray(o)) return o.map(semSegredos);
  if (!o || typeof o !== "object") return o;
  const senhaWifi = typeof o.prefixo === "string" && /password/i.test(o.prefixo);
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => {
      if (SEGREDO.test(k) && (v === null || typeof v !== "object")) return [k, mascara(v)];
      if (senhaWifi && ["valor", "atual", "novo"].includes(k)) return [k, mascara(v)];
      return [k, semSegredos(v)];
    }),
  );
}

function auditar(hs: HubsoftClient, registro: Record<string, unknown>) {
  const arq = hs.config.auditoria;
  if (!arq) return;
  try {
    mkdirSync(dirname(arq), { recursive: true });
    appendFileSync(arq, JSON.stringify(semSegredos({ data_hora: new Date().toISOString(), base: hs.config.nome, ...registro })) + "\n", { mode: 0o600 });
  } catch (e) {
    registro.aviso_auditoria = `Falha ao gravar auditoria em ${arq}: ${(e as Error).message}`;
  }
}

function responder(hs: HubsoftClient, data: unknown, erro = false) {
  const r = ok(data, hs.config.maxResponseChars);
  return erro ? { ...r, isError: true } : r;
}

interface Alvo {
  servico?: number;
  phy?: string;
}

async function lerEstado(hs: HubsoftClient, alvo: Alvo) {
  const estado: Record<string, unknown> = {};
  if (alvo.servico) estado.servico = await lerServico(hs, alvo.servico);
  if (alvo.phy) estado.cpe = await lerCpe(hs, alvo.phy);
  return estado;
}

/** Fluxo comum das escritas: simulação (sem envio) ou execução com leitura antes/depois e auditoria. */
async function escrever(
  hs: HubsoftClient,
  p: {
    ferramenta: string;
    path: string;
    corpo: unknown;
    corpoExibicao?: unknown;
    confirmar?: boolean;
    alvo: Alvo;
    estadoAntes?: Record<string, unknown>;
    efeito: string | string[];
    avisos: string[];
    bloqueio?: string;
    extra?: Record<string, unknown>;
    alvoDepois?: (antes: Record<string, unknown>) => Alvo;
  },
) {
  const antes = p.estadoAntes ?? (await lerEstado(hs, p.alvo));
  const requisicao = { metodo: "POST", url: hs.config.baseUrl + p.path, corpo: p.corpoExibicao ?? p.corpo };

  if (!p.confirmar || p.bloqueio) {
    return responder(
      hs,
      {
        modo: "simulacao",
        nada_foi_enviado: true,
        ...(p.bloqueio ? { bloqueado: p.bloqueio } : {}),
        requisicao_que_seria_enviada: requisicao,
        estado_atual: antes,
        efeito_esperado: p.efeito,
        avisos: p.avisos,
        ...p.extra,
        ...(p.bloqueio ? {} : { para_executar: "Confirme com o usuário e repita a chamada com confirmar=true." }),
      },
      Boolean(p.bloqueio && p.confirmar),
    );
  }

  const r = await hs.raw("POST", p.path, { body: p.corpo });
  const sucesso = r.ok && r.body?.status !== "error";
  const depois = await lerEstado(hs, p.alvoDepois ? p.alvoDepois(antes) : p.alvo);
  const mudancas = diff(antes, depois);
  const resultado = {
    http_status: r.status,
    sucesso,
    resposta: r.body,
    ...(r.status === 429 ? { retry_after: r.retryAfter, observacao: "Limite de requisições: não foi repetido. Aguarde retry_after segundos." } : {}),
    ...(r.tokenRenovado ? { token_renovado: true } : {}),
  };
  const registro: Record<string, unknown> = {
    ferramenta: p.ferramenta,
    metodo: "POST",
    url: requisicao.url,
    corpo: p.corpoExibicao ?? p.corpo,
    http_status: r.status,
    resposta: r.body,
    diff: mudancas,
  };
  auditar(hs, registro);
  return responder(
    hs,
    {
      modo: "execucao",
      requisicao_enviada: requisicao,
      resultado,
      estado_antes: antes,
      estado_depois: depois,
      diff: mudancas,
      ...(registro.aviso_auditoria ? { aviso_auditoria: registro.aviso_auditoria } : {}),
    },
    !sucesso,
  );
}

const confirmar = z.boolean().optional().describe("false (padrão) = só simula, nada é enviado. true = executa.");
const mostrarSenhas = z.boolean().optional().describe("Mostra senhas de Wi-Fi (padrão: mascaradas).");
const phySchema = z.string().trim().min(5, "phy_addr: mínimo 5 caracteres").regex(/^\S+$/, "phy_addr: sem espaços");
const ESCRITA = { readOnlyHint: false, openWorldHint: true } as const;

/** Parâmetros ACS com senhas mascaradas (salvo mostrar_senhas). */
function parametrosVisiveis(params: any[], mostrar?: boolean) {
  return (params ?? []).map((x) => ({
    descricao: x.descricao,
    prefixo: x.prefixo,
    parametro: x.parametro,
    valor: !mostrar && /password/i.test(String(x.prefixo ?? "")) ? mascara(x.valor) : x.valor,
  }));
}

async function iniciarGerenciamento(hs: HubsoftClient, q: { phy_addr?: string; id_cpe?: number }) {
  return hs.raw("GET", `${API}/rede/cpe/iniciar_gerenciamento`, { query: q });
}

/** Confere se o novo valor tem formato compatível com o atual (a API rejeita divergências). */
function validarValor(prefixo: string, atual: unknown, novo: string): string | undefined {
  const a = String(atual ?? "");
  if (/password/i.test(prefixo) && (novo.length < 8 || novo.length > 63)) return `${prefixo}: senha Wi-Fi precisa ter de 8 a 63 caracteres`;
  if (/ssid/i.test(prefixo) && !/password/i.test(prefixo) && (novo.length < 1 || novo.length > 32)) return `${prefixo}: SSID precisa ter de 1 a 32 caracteres`;
  if (/^(true|false)$/i.test(a) && !/^(true|false)$/i.test(novo)) return `${prefixo}: valor atual é booleano (${a}); use true ou false`;
  if (/^-?\d+$/.test(a) && !/^-?\d+$/.test(novo)) return `${prefixo}: valor atual é numérico (${a}); envie um número`;
  return undefined;
}

export function registerCpe(server: McpServer, hs: HubsoftClient) {
  // ── Leitura ACS: sempre disponível (servidor obrigatório e único, ver multi.ts)
  server.registerTool(
    "hubsoft_cpe_iniciar_gerenciamento",
    {
      title: "CPE: ler parâmetros gerenciáveis (ACS)",
      description:
        "Abre o gerenciamento da CPE pelo gerenciador do Hubsoft (ACS) e lista os parâmetros " +
        "editáveis (descricao, prefixo, parametro, valor), ex.: wifi_ssid, wifi_password, wifi_ssid_5ghz, " +
        "wifi_password_5ghz. Informe EXATAMENTE um entre phy_addr e id_cpe. Senhas de Wi-Fi vêm " +
        "mascaradas, salvo mostrar_senhas=true. Exige uma única base em `servidor`.",
      inputSchema: {
        phy_addr: phySchema.optional(),
        id_cpe: z.number().int().positive().optional(),
        mostrar_senhas: mostrarSenhas,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ phy_addr, id_cpe, mostrar_senhas }) => {
      try {
        if (Boolean(phy_addr) === Boolean(id_cpe)) throw new Error("Informe exatamente um entre phy_addr e id_cpe.");
        const r = await iniciarGerenciamento(hs, phy_addr ? { phy_addr } : { id_cpe });
        if (!r.ok || r.body?.status === "error") {
          return responder(hs, { http_status: r.status, resposta: r.body, ...(r.retryAfter ? { retry_after: r.retryAfter } : {}) }, true);
        }
        const cpe = r.body?.cpe ?? {};
        return responder(hs, {
          http_status: r.status,
          cpe: { id_cpe: cpe.id_cpe, phy_addr: cpe.phy_addr, parametros: parametrosVisiveis(cpe.parametros, mostrar_senhas) },
          ...(mostrar_senhas ? {} : { observacao: "Senhas de Wi-Fi mascaradas; use mostrar_senhas=true para vê-las." }),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  if (hs.config.readOnly) return;

  // ── 1. Configurar autenticação
  server.registerTool(
    "hubsoft_configurar_autenticacao",
    {
      title: "Configurar autenticação do serviço (phy_addr, interface, login)",
      description:
        "ESCRITA. Altera a autenticação de um serviço: id_interface_conexao (PON), phy_addr (serial/MAC da ONU), " +
        "login, password e observações — útil para vincular uma ONU já autorizada na OLT sem desprovisionar. " +
        "Regras da API: não altera serviço cancelado; o phy_addr não pode estar em uso por outro assinante " +
        "em outra interface; o login não pode estar em uso. O Hubsoft grava o phy_addr em maiúsculas. " +
        "confirmar=false (padrão) só simula e mostra estado atual, requisição e efeito; confirmar=true " +
        "executa e devolve o diff antes/depois. Exige uma única base em `servidor`.",
      inputSchema: {
        id_cliente_servico: z.number().int().positive(),
        id_interface_conexao: z.number().int().positive().optional(),
        phy_addr: phySchema.optional(),
        login: z.string().min(3, "login: mínimo 3 caracteres").max(255, "login: máximo 255 caracteres").optional(),
        password: z.string().min(3, "password: mínimo 3 caracteres").optional(),
        observacoes: z.string().nullable().optional().describe("Texto livre; vazio ou null limpa."),
        confirmar,
      },
      annotations: { ...ESCRITA, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const { id_cliente_servico, id_interface_conexao, phy_addr, login, password, confirmar: conf } = args;
        const temObs = Object.prototype.hasOwnProperty.call(args, "observacoes");
        if ([id_interface_conexao, phy_addr, login, password].every((v) => v === undefined) && !temObs) {
          throw new Error("Informe pelo menos um entre id_interface_conexao, phy_addr, login, password e observacoes.");
        }
        const corpo: Record<string, unknown> = { id_cliente_servico };
        if (id_interface_conexao !== undefined) corpo.id_interface_conexao = id_interface_conexao;
        if (phy_addr !== undefined) corpo.phy_addr = phy_addr;
        if (login !== undefined) corpo.login = login;
        if (password !== undefined) corpo.password = password;
        if (temObs) corpo.observacoes = args.observacoes ?? null;

        const antes = await lerEstado(hs, { servico: id_cliente_servico, phy: phy_addr });
        const sv: any = (antes.servico as any)?.servico;
        const avisos: string[] = [];
        if ((antes.servico as any)?.erro) avisos.push(`Leitura prévia do serviço falhou: ${JSON.stringify((antes.servico as any).erro)}`);
        if (sv?.status_prefixo === "cancelado") avisos.push("Serviço CANCELADO: a API recusa a alteração.");
        if (phy_addr) {
          const cpes = (antes.cpe as any)?.encontradas ?? [];
          const outros = cpes.flatMap((c: any) => c.servicos_vinculados).filter((id: number) => id !== id_cliente_servico);
          if (outros.length) avisos.push(`A CPE ${phy_addr} já está vinculada a outro(s) serviço(s): ${[...new Set(outros)].join(", ")}. A API recusa phy_addr em uso por outro assinante em outra interface.`);
          if (!cpes.length && !(antes.cpe as any)?.erro) avisos.push(`phy_addr ${phy_addr} não está no inventário de CPEs do Hubsoft (vincular_cpe falharia até a CPE ser encontrada pela varredura).`);
        }
        const efeito: string[] = [];
        if (phy_addr !== undefined) efeito.push(`phy_addr: ${JSON.stringify(sv?.phy_addr ?? null)} → "${phy_addr.toUpperCase()}"`);
        if (id_interface_conexao !== undefined) efeito.push(`id_interface_conexao: ${JSON.stringify(sv?.id_interface_conexao ?? null)} → ${id_interface_conexao}`);
        if (login !== undefined) efeito.push(`login: ${JSON.stringify(sv?.login ?? null)} → "${login}" (recusado se o login já estiver em uso)`);
        if (password !== undefined) efeito.push("password de autenticação: será alterada (não exibida)");
        if (temObs) efeito.push(`observações: ${args.observacoes ? "atualizadas" : "limpas"}`);

        return await escrever(hs, {
          ferramenta: "hubsoft_configurar_autenticacao",
          path: `${API}/cliente/configurar_autenticacao`,
          corpo,
          corpoExibicao: password !== undefined ? { ...corpo, password: "***" } : corpo,
          confirmar: conf,
          alvo: { servico: id_cliente_servico, phy: phy_addr },
          estadoAntes: antes,
          efeito,
          avisos,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── 2. Vincular CPE
  server.registerTool(
    "hubsoft_vincular_cpe",
    {
      title: "Vincular CPE ao serviço",
      description:
        "ESCRITA. Vincula a CPE (ONU) à autenticação do serviço. Informe EXATAMENTE um: id_cliente_servico " +
        "(usa o phy_addr gravado na autenticação) ou phy_addr (procura a autenticação com esse phy_addr). " +
        "Comportamento observado em produção: ao vincular, o Hubsoft preenche SOZINHO o equipamento de " +
        "conexão (OLT), a interface (PON) e o roteamento (BNG/VLAN) a partir da varredura da CPE — por isso " +
        "o resultado traz o diff antes/depois. Erro conhecido: \"CPE não encontrada para o MAC informado\" " +
        "(phy_addr fora do inventário). confirmar=false (padrão) só simula. Exige uma única base em `servidor`.",
      inputSchema: {
        id_cliente_servico: z.number().int().positive().optional(),
        phy_addr: phySchema.optional(),
        confirmar,
      },
      annotations: { ...ESCRITA, destructiveHint: false },
    },
    async ({ id_cliente_servico, phy_addr, confirmar: conf }) => {
      try {
        if (Boolean(id_cliente_servico) === Boolean(phy_addr)) {
          throw new Error("Informe exatamente um entre id_cliente_servico e phy_addr (os dois juntos não são aceitos).");
        }
        const avisos: string[] = [];
        let phy = phy_addr;
        const antes: Record<string, unknown> = {};
        if (id_cliente_servico) {
          antes.servico = await lerServico(hs, id_cliente_servico);
          phy = ((antes.servico as any)?.servico?.phy_addr as string) || undefined;
          if (!phy) avisos.push("O serviço não tem phy_addr na autenticação: configure-o antes com hubsoft_configurar_autenticacao.");
        }
        if (phy) {
          antes.cpe = await lerCpe(hs, phy);
          if (!((antes.cpe as any)?.encontradas ?? []).length) {
            avisos.push(`O phy_addr ${phy} não existe no inventário de CPEs: a API deve responder "CPE não encontrada para o MAC informado".`);
          }
        }
        return await escrever(hs, {
          ferramenta: "hubsoft_vincular_cpe",
          path: `${API}/cliente/vincular_cpe`,
          corpo: id_cliente_servico ? { id_cliente_servico } : { phy_addr },
          confirmar: conf,
          alvo: { servico: id_cliente_servico, phy },
          estadoAntes: antes,
          efeito: [
            `Vincular a CPE ${phy ?? "(phy_addr do serviço)"} à autenticação do serviço.`,
            "O Hubsoft deve preencher automaticamente OLT, PON e roteamento (BNG/VLAN) pela varredura da CPE — confira no diff.",
          ],
          avisos,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── 3. Desvincular CPE
  server.registerTool(
    "hubsoft_desvincular_cpe",
    {
      title: "Desvincular CPE do serviço",
      description:
        "ESCRITA, DESTRUTIVA. Desvincula CPE(s) do serviço. Só com id_cliente_servico, desvincula TODAS as CPEs " +
        "do serviço; com phy_addr (com ou sem separadores, qualquer caixa), só aquela. Se a CPE desvinculada " +
        "for a da autenticação, o phy_addr do serviço é ZERADO. Efeito imediato e registrado no histórico do " +
        "cliente. A simulação (confirmar=false, padrão) mostra o efeito e o comando de rollback. " +
        "Exige uma única base em `servidor`.",
      inputSchema: {
        id_cliente_servico: z.number().int().positive(),
        phy_addr: z.string().trim().min(1).optional().describe("Limita a um equipamento."),
        confirmar,
      },
      annotations: { ...ESCRITA, destructiveHint: true },
    },
    async ({ id_cliente_servico, phy_addr, confirmar: conf }) => {
      try {
        const antes = await lerEstado(hs, { servico: id_cliente_servico });
        const sv: any = (antes.servico as any)?.servico;
        const avisos: string[] = [];
        if ((antes.servico as any)?.erro) avisos.push(`Leitura prévia do serviço falhou: ${JSON.stringify((antes.servico as any).erro)}`);
        const cpes: any[] = Array.isArray(sv?.cpes) ? sv.cpes : [];
        const alvos = phy_addr ? cpes.filter((c) => normPhy(c.phy_addr) === normPhy(phy_addr)) : cpes;
        if (phy_addr && !alvos.length) avisos.push(`Nenhuma CPE com phy_addr ${phy_addr} vinculada a este serviço segundo a leitura prévia.`);
        const zeraAuth = sv?.phy_addr && (phy_addr ? normPhy(phy_addr) === normPhy(sv.phy_addr) : true);
        const efeito = [
          phy_addr ? `Desvincular a CPE ${phy_addr} do serviço ${id_cliente_servico}.` : `Desvincular TODAS as CPEs do serviço ${id_cliente_servico} (${cpes.length} na leitura prévia).`,
          zeraAuth ? `O phy_addr da autenticação (${sv.phy_addr}) será ZERADO.` : "O phy_addr da autenticação não deve mudar.",
          "Efeito imediato, registrado no histórico do cliente.",
        ];
        const rollback = sv?.phy_addr
          ? [
              {
                ferramenta: "hubsoft_configurar_autenticacao",
                argumentos: {
                  servidor: hs.config.nome,
                  id_cliente_servico,
                  phy_addr: sv.phy_addr,
                  ...(sv.id_interface_conexao ? { id_interface_conexao: Number(sv.id_interface_conexao) } : {}),
                  confirmar: true,
                },
              },
              { ferramenta: "hubsoft_vincular_cpe", argumentos: { servidor: hs.config.nome, id_cliente_servico, confirmar: true } },
            ]
          : "Sem phy_addr atual na autenticação: não há rollback automático a sugerir.";
        return await escrever(hs, {
          ferramenta: "hubsoft_desvincular_cpe",
          path: `${API}/cliente/desvincular_cpe`,
          corpo: phy_addr ? { id_cliente_servico, phy_addr } : { id_cliente_servico },
          confirmar: conf,
          alvo: { servico: id_cliente_servico },
          estadoAntes: antes,
          efeito,
          avisos,
          extra: { cpes_afetadas: alvos, rollback },
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── 4/5. Reiniciar e restaurar CPE
  const controle = (acao: "reiniciar" | "restaurar") => async (args: { phy_addr: string; confirmar?: boolean; confirmar_phy_addr?: string }) => {
    try {
      const { phy_addr, confirmar: conf } = args;
      const antes = await lerEstado(hs, { phy: phy_addr });
      const cpes = (antes.cpe as any)?.encontradas ?? [];
      const avisos: string[] = [];
      let bloqueio: string | undefined;
      if ((antes.cpe as any)?.erro) bloqueio = `Consulta da CPE falhou: ${JSON.stringify((antes.cpe as any).erro)}`;
      else if (!cpes.length) bloqueio = `CPE ${phy_addr} não encontrada pelo sistema (rede/cpe/todos). A ação só funciona com CPEs já encontradas.`;
      if (acao === "reiniciar") avisos.push("O cliente fica SEM CONEXÃO durante o reboot da CPE.");
      else {
        avisos.push("RESTAURAÇÃO DE FÁBRICA: a CPE perde PPPoE, Wi-Fi e qualquer outra configuração; o cliente fica sem serviço até reconfigurar.");
        if (conf && normPhy(args.confirmar_phy_addr) !== normPhy(phy_addr)) {
          bloqueio = "Para restaurar, informe confirmar_phy_addr com o MESMO valor de phy_addr.";
        }
      }
      return await escrever(hs, {
        ferramenta: `hubsoft_${acao}_cpe`,
        path: `${API}/rede/${acao}_cpe/${encodeURIComponent(phy_addr)}`,
        corpo: [],
        confirmar: conf,
        alvo: { phy: phy_addr },
        estadoAntes: antes,
        efeito: acao === "reiniciar" ? `Reiniciar a CPE ${phy_addr}.` : `Restaurar a CPE ${phy_addr} para a configuração de fábrica.`,
        avisos,
        bloqueio,
        extra: { cpe: cpes[0] ?? null },
      });
    } catch (e) {
      return fail(e);
    }
  };

  server.registerTool(
    "hubsoft_reiniciar_cpe",
    {
      title: "Reiniciar CPE",
      description:
        "CONTROLE. Reinicia a CPE pelo Hubsoft. Só funciona com CPEs já encontradas pelo sistema (a ferramenta " +
        "consulta antes e mostra a CPE e o serviço vinculado). O cliente fica sem conexão durante o reboot. " +
        "confirmar=false (padrão) só simula. Exige uma única base em `servidor`.",
      inputSchema: { phy_addr: phySchema, confirmar },
      annotations: { ...ESCRITA, destructiveHint: true, idempotentHint: false },
    },
    controle("reiniciar"),
  );

  server.registerTool(
    "hubsoft_restaurar_cpe",
    {
      title: "Restaurar CPE para configuração de fábrica",
      description:
        "CONTROLE DESTRUTIVO. Restaura a CPE para a configuração de FÁBRICA: perde PPPoE, Wi-Fi e qualquer " +
        "outra configuração. Além de confirmar=true, exige confirmar_phy_addr igual ao phy_addr. " +
        "confirmar=false (padrão) só simula. Exige uma única base em `servidor`.",
      inputSchema: {
        phy_addr: phySchema,
        confirmar,
        confirmar_phy_addr: z.string().optional().describe("Repita o phy_addr para confirmar a restauração."),
      },
      annotations: { ...ESCRITA, destructiveHint: true, idempotentHint: false },
    },
    controle("restaurar"),
  );

  // ── 7. Gerenciar parâmetros (ACS)
  server.registerTool(
    "hubsoft_cpe_gerenciar",
    {
      title: "CPE: alterar parâmetros (Wi-Fi etc.) via ACS",
      description:
        "ESCRITA. Altera parâmetros da CPE pelo gerenciador do Hubsoft (ex.: wifi_ssid, wifi_password, " +
        "wifi_ssid_5ghz, wifi_password_5ghz). Antes, lê os parâmetros atuais e valida que cada prefixo existe " +
        "e que o formato do valor é compatível. A simulação (confirmar=false, padrão) mostra valor atual → " +
        "novo, com senhas mascaradas (mostrar_senhas=true para ver). A alteração é aplicada de fato na CPE. " +
        "Exige uma única base em `servidor`.",
      inputSchema: {
        id_cpe: z.number().int().positive(),
        parametros: z
          .array(z.object({ prefixo: z.string().min(1), valor: z.string() }))
          .min(1)
          .describe('Ex.: [{"prefixo":"wifi_ssid","valor":"MinhaRede"}]'),
        confirmar,
        mostrar_senhas: mostrarSenhas,
      },
      annotations: { ...ESCRITA, destructiveHint: false },
    },
    async ({ id_cpe, parametros, confirmar: conf, mostrar_senhas }) => {
      try {
        const ini = await iniciarGerenciamento(hs, { id_cpe });
        if (!ini.ok || ini.body?.status === "error") {
          return responder(hs, { etapa: "iniciar_gerenciamento", http_status: ini.status, resposta: ini.body }, true);
        }
        const atuais: any[] = ini.body?.cpe?.parametros ?? [];
        const porPrefixo = new Map(atuais.map((x) => [String(x.prefixo), x]));
        const erros: string[] = [];
        const vistos = new Set<string>();
        for (const p of parametros) {
          if (vistos.has(p.prefixo)) erros.push(`${p.prefixo}: repetido`);
          vistos.add(p.prefixo);
          const at = porPrefixo.get(p.prefixo);
          if (!at) erros.push(`${p.prefixo}: prefixo inexistente nesta CPE (disponíveis: ${[...porPrefixo.keys()].join(", ")})`);
          else {
            const e = validarValor(p.prefixo, at.valor, p.valor);
            if (e) erros.push(e);
          }
        }
        const ver = (prefixo: string, v: unknown) => (!mostrar_senhas && /password/i.test(prefixo) ? mascara(v) : v);
        const alteracoes = parametros.map((p) => ({
          prefixo: p.prefixo,
          descricao: porPrefixo.get(p.prefixo)?.descricao,
          atual: ver(p.prefixo, porPrefixo.get(p.prefixo)?.valor),
          novo: ver(p.prefixo, p.valor),
        }));
        if (erros.length) {
          return responder(hs, { modo: "simulacao", nada_foi_enviado: true, erros_de_validacao: erros, alteracoes }, true);
        }
        const corpo = { id_cpe, parametros };
        const corpoExibicao = { id_cpe, parametros: parametros.map((p) => ({ prefixo: p.prefixo, valor: ver(p.prefixo, p.valor) })) };
        const requisicao = { metodo: "POST", url: `${hs.config.baseUrl}${API}/rede/cpe/gerenciar`, corpo: corpoExibicao };
        if (!conf) {
          return responder(hs, {
            modo: "simulacao",
            nada_foi_enviado: true,
            requisicao_que_seria_enviada: requisicao,
            cpe: { id_cpe, phy_addr: ini.body?.cpe?.phy_addr },
            alteracoes,
            efeito_esperado: "Os parâmetros serão aplicados na CPE pelo gerenciador (ACS). Alterar Wi-Fi desconecta os dispositivos do cliente.",
            para_executar: "Confirme com o usuário e repita a chamada com confirmar=true.",
          });
        }
        const r = await hs.raw("POST", `${API}/rede/cpe/gerenciar`, { body: corpo });
        const sucesso = r.ok && r.body?.status !== "error";
        const releitura = await iniciarGerenciamento(hs, { id_cpe });
        const depoisPorPrefixo = new Map(((releitura.body?.cpe?.parametros ?? []) as any[]).map((x) => [String(x.prefixo), x]));
        const antesSel = Object.fromEntries(parametros.map((p) => [p.prefixo, ver(p.prefixo, porPrefixo.get(p.prefixo)?.valor)]));
        const depoisSel = Object.fromEntries(parametros.map((p) => [p.prefixo, ver(p.prefixo, depoisPorPrefixo.get(p.prefixo)?.valor)]));
        const mudancas = diff(antesSel, depoisSel);
        const registro: Record<string, unknown> = {
          ferramenta: "hubsoft_cpe_gerenciar",
          metodo: "POST",
          url: requisicao.url,
          corpo: semSegredos({ id_cpe, parametros }),
          http_status: r.status,
          resposta: r.body,
          diff: semSegredos(diff(
            Object.fromEntries(parametros.map((p) => [p.prefixo, /password/i.test(p.prefixo) ? "***" : porPrefixo.get(p.prefixo)?.valor])),
            Object.fromEntries(parametros.map((p) => [p.prefixo, /password/i.test(p.prefixo) ? "***" : depoisPorPrefixo.get(p.prefixo)?.valor])),
          )),
        };
        auditar(hs, registro);
        return responder(
          hs,
          {
            modo: "execucao",
            requisicao_enviada: requisicao,
            resultado: {
              http_status: r.status,
              sucesso,
              resposta: r.body,
              ...(r.status === 429 ? { retry_after: r.retryAfter, observacao: "Limite de requisições: não foi repetido." } : {}),
              ...(r.tokenRenovado ? { token_renovado: true } : {}),
            },
            antes: antesSel,
            depois: depoisSel,
            diff: mudancas,
            ...(releitura.ok ? {} : { aviso: `Releitura falhou (HTTP ${releitura.status}); o diff pode estar incompleto.` }),
          },
          !sucesso,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
