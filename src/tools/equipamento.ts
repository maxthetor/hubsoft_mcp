import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { API, fail } from "../util.js";
import { lerCsv, paginar, pausar, vez } from "../exportar.js";
import { auditar, diff, responder } from "./cpe.js";

/**
 * Inativar/reativar equipamento de conexão (OLT, BNG…) — ROTAS INTERNAS, NÃO DOCUMENTADAS.
 * Elas ficam fora de /api/v1/integracao (mesmo host e mesmo token Bearer) e podem mudar sem aviso:
 *   leitura:  GET    /api/v1/rede/equipamento_conexao/{id}
 *   inativar: DELETE /api/v1/rede/equipamento_conexao/{id}          (soft delete: preenche deleted_at)
 *   reativar: GET    /api/v1/rede/equipamento_conexao/{id}/restore  (GET que ALTERA: nunca é repetido)
 */
export const ROTA_EQUIPAMENTO = "/api/v1/rede/equipamento_conexao";
const IDADE_MAX_EXPORTACAO_H = 24;

/** Extrai o equipamento de respostas nos formatos {equipamento_conexao: {...}}, {data: {...}} ou o próprio objeto. */
export function extrairEquipamento(body: any): any {
  if (!body || typeof body !== "object") return undefined;
  if ("nome" in body || "ipv4" in body) return body;
  for (const k of ["equipamento_conexao", "equipamento", "data", "dados"]) {
    const v = body[k];
    if (v && typeof v === "object" && !Array.isArray(v)) return extrairEquipamento(v) ?? v;
  }
  return undefined;
}

function resumoEquipamento(e: any) {
  if (!e) return null;
  const ifs = e.interfaces ?? e.interfaces_conexao ?? e.interface_conexao;
  return {
    id_equipamento: e.id_equipamento_conexao ?? e.id_equipamento ?? e.id ?? null,
    nome: e.nome ?? null,
    ipv4: e.ipv4 ?? null,
    tipo: e.tipo ?? e.tipo_equipamento?.descricao ?? null,
    deleted_at: e.deleted_at ?? null,
    ativo: !e.deleted_at,
    qtd_interfaces: Array.isArray(ifs) ? ifs.length : null,
  };
}

async function lerEquipamento(hs: HubsoftClient, id: number) {
  await vez(hs.config.baseUrl);
  const r = await hs.raw("GET", `${ROTA_EQUIPAMENTO}/${id}`);
  if (r.status === 429) pausar(hs.config.baseUrl, r.retryAfter ?? 1);
  const eq = r.ok ? extrairEquipamento(r.body) : undefined;
  return { http_status: r.status, encontrado: Boolean(eq), equipamento: resumoEquipamento(eq), ...(r.ok ? {} : { resposta: r.body }) };
}

const igual = (a: unknown, b: unknown) => String(a ?? "").trim().toUpperCase() === String(b ?? "").trim().toUpperCase();

/** Conta na última exportação COMPLETA de serviços desta base (≤ 24 h), pelo nome + IP do equipamento. */
function contarPelaExportacao(hs: HubsoftClient, nome: string, ipv4: string | null) {
  let arquivos: { arquivo: string; mtime: number }[] = [];
  try {
    const pref = `servicos_${hs.config.nome}_`;
    arquivos = readdirSync(hs.config.exportDir)
      .filter((f) => f.startsWith(pref) && f.endsWith(".csv") && !f.includes("_parcial"))
      .map((f) => ({ arquivo: join(hs.config.exportDir, f), mtime: statSync(join(hs.config.exportDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return undefined;
  }
  const ultimo = arquivos[0];
  if (!ultimo || Date.now() - ultimo.mtime > IDADE_MAX_EXPORTACAO_H * 3600_000) return undefined;
  const { cabecalho, linhas } = lerCsv(readFileSync(ultimo.arquivo, "utf8"));
  const iNome = cabecalho.indexOf("equipamento_conexao_nome");
  const iIp = cabecalho.indexOf("equipamento_conexao_ip");
  if (iNome < 0) return undefined;
  const n = linhas.filter((c) => igual(c[iNome], nome) && (!ipv4 || iIp < 0 || !c[iIp] || igual(c[iIp], ipv4))).length;
  return { servicos_vinculados: n, fonte: "exportacao", arquivo: ultimo.arquivo, data_arquivo: new Date(ultimo.mtime).toISOString() };
}

/** Conta pela API: cliente/todos (não cancelados) com a relação equipamento_conexao, dentro de um prazo. */
async function contarPelaApi(hs: HubsoftClient, nome: string, ipv4: string | null, prazo: number) {
  let n = 0;
  const r = await paginar({
    hs,
    rota: `${API}/cliente/todos`,
    query: { itens_por_pagina: 500, cancelado: "nao", relacoes: "equipamento_conexao" },
    chave: "clientes",
    prazo,
    aoLer: (lote) => {
      for (const c of lote)
        for (const s of c?.servicos ?? []) {
          const e = s?.equipamento_conexao;
          if (s?.status_prefixo === "cancelado" || !e) continue;
          if (igual(e.nome, nome) && (!ipv4 || !e.ipv4 || igual(e.ipv4, ipv4))) n++;
        }
    },
  });
  const completo = r.pagina_falhou === undefined && !r.erros.length;
  return completo
    ? { servicos_vinculados: n, fonte: "api", paginas_lidas: r.paginas_lidas }
    : { servicos_vinculados: null, fonte: "api", paginas_lidas: r.paginas_lidas, incompleta: true, minimo_encontrado: n, erros: r.erros };
}

export function registerEquipamento(server: McpServer, hs: HubsoftClient) {
  if (hs.config.readOnly) return;

  const comum = {
    id_equipamento: z.number().int().positive().describe("id do equipamento de conexão (id_equipamento em rede/equipamento)."),
    confirmar: z.boolean().optional().describe("false (padrão) = só simula. true = executa."),
    confirmar_nome: z.string().optional().describe("Obrigatório para executar: o nome ATUAL do equipamento, exatamente."),
  };
  const aviso = "Rota interna do Hubsoft, não documentada (fora de /api/v1/integracao): pode mudar sem aviso.";

  server.registerTool(
    "hubsoft_equipamento_inativar",
    {
      title: "Inativar equipamento de conexão (rota interna)",
      description:
        "ESCRITA, DESTRUTIVA. Inativa (soft delete: preenche deleted_at) um equipamento de conexão (OLT, BNG…) por " +
        "DELETE /api/v1/rede/equipamento_conexao/{id} — ROTA INTERNA NÃO DOCUMENTADA, pode mudar. Antes lê o " +
        "equipamento (nome, ipv4, deleted_at, nº de interfaces) e conta os serviços não cancelados ligados a ele " +
        "(última exportação de serviços da base com até 24 h, ou varredura de cliente/todos). Recusa se houver " +
        "serviços vinculados ou se a contagem não terminar, salvo forcar=true. Para executar: confirmar=true e " +
        "confirmar_nome igual ao nome atual. Reverte com hubsoft_equipamento_reativar. Exige uma única base em `servidor`.",
      inputSchema: {
        ...comum,
        forcar: z.boolean().optional().describe("Inativa mesmo com serviços vinculados (ou contagem incompleta)."),
        fonte_contagem: z.enum(["auto", "api", "exportacao"]).optional().describe("auto (padrão): exportação recente, senão API."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id_equipamento, confirmar, confirmar_nome, forcar, fonte_contagem }) => {
      try {
        const inicio = Date.now();
        const antes = await lerEquipamento(hs, id_equipamento);
        const eq = antes.equipamento;
        const bloqueios: string[] = [];
        let contagem: any;
        if (!antes.encontrado) bloqueios.push(`Equipamento ${id_equipamento} não encontrado ou inacessível (HTTP ${antes.http_status}).`);
        else if (eq?.deleted_at) bloqueios.push(`O equipamento já está inativo (deleted_at = ${eq.deleted_at}).`);
        else {
          const fonte = fonte_contagem ?? "auto";
          if (fonte !== "api") contagem = contarPelaExportacao(hs, eq!.nome, eq!.ipv4);
          if (!contagem && fonte === "exportacao") {
            contagem = { servicos_vinculados: null, fonte: "exportacao", incompleta: true, erro: `Sem exportação completa de serviços desta base com até ${IDADE_MAX_EXPORTACAO_H} h. Rode hubsoft_exportar_servicos ou use fonte_contagem=api.` };
          }
          if (!contagem) contagem = await contarPelaApi(hs, eq!.nome, eq!.ipv4, inicio + 45_000);
          if (contagem.servicos_vinculados === null && !forcar) {
            bloqueios.push("Não foi possível contar todos os serviços ligados ao equipamento. Rode hubsoft_exportar_servicos e tente de novo, ou use forcar=true.");
          } else if (contagem.servicos_vinculados > 0 && !forcar) {
            bloqueios.push(`Há ${contagem.servicos_vinculados} serviço(s) não cancelado(s) ligados a este equipamento. Migre-os antes ou use forcar=true.`);
          }
        }
        if (confirmar && eq && !bloqueios.length && confirmar_nome?.trim() !== String(eq.nome ?? "").trim()) {
          bloqueios.push(`confirmar_nome precisa ser exatamente o nome atual: "${eq.nome}".`);
        }
        const requisicao = { metodo: "DELETE", url: `${hs.config.baseUrl}${ROTA_EQUIPAMENTO}/${id_equipamento}` };
        if (!confirmar || bloqueios.length) {
          return responder(
            hs,
            {
              modo: "simulacao",
              nada_foi_enviado: true,
              ...(bloqueios.length ? { bloqueado: bloqueios } : {}),
              requisicao_que_seria_enviada: requisicao,
              estado_atual: antes,
              ...(contagem ? { contagem_servicos: contagem } : {}),
              efeito_esperado: "Soft delete: o equipamento some das listas (deleted_at preenchido); reverte com hubsoft_equipamento_reativar.",
              aviso,
              ...(bloqueios.length ? {} : { para_executar: `Confirme com o usuário e repita com confirmar=true e confirmar_nome="${eq?.nome}".` }),
            },
            Boolean(confirmar && bloqueios.length),
          );
        }
        await vez(hs.config.baseUrl);
        const r = await hs.raw("DELETE", `${ROTA_EQUIPAMENTO}/${id_equipamento}`);
        const sucesso = r.ok && r.body?.status !== "error";
        const depois = await lerEquipamento(hs, id_equipamento);
        const mudancas = diff(antes, depois);
        const registro: Record<string, unknown> = {
          ferramenta: "hubsoft_equipamento_inativar",
          metodo: "DELETE",
          url: requisicao.url,
          http_status: r.status,
          resposta: r.body,
          forcar: Boolean(forcar),
          contagem_servicos: contagem,
          diff: mudancas,
        };
        auditar(hs, registro);
        return responder(
          hs,
          {
            modo: "execucao",
            requisicao_enviada: requisicao,
            resultado: { http_status: r.status, sucesso, resposta: r.body, ...(r.status === 429 ? { retry_after: r.retryAfter, observacao: "Não foi repetido." } : {}) },
            estado_antes: antes,
            estado_depois: depois,
            diff: mudancas,
            contagem_servicos: contagem,
            aviso,
            ...(sucesso ? { reverter: { ferramenta: "hubsoft_equipamento_reativar", argumentos: { servidor: hs.config.nome, id_equipamento, confirmar: true, confirmar_nome: eq!.nome } } } : {}),
            ...(registro.aviso_auditoria ? { aviso_auditoria: registro.aviso_auditoria } : {}),
          },
          !sucesso,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "hubsoft_equipamento_reativar",
    {
      title: "Reativar equipamento de conexão (rota interna)",
      description:
        "ESCRITA. Reativa (restore do soft delete) um equipamento de conexão inativado, por " +
        "GET /api/v1/rede/equipamento_conexao/{id}/restore — ROTA INTERNA NÃO DOCUMENTADA, pode mudar; é um GET que " +
        "altera dados, por isso nunca é repetido. Para executar: confirmar=true e confirmar_nome igual ao nome do " +
        "equipamento. Se a leitura prévia não enxergar o equipamento inativo, o nome é conferido na releitura e " +
        "uma divergência é apontada. Exige uma única base em `servidor`.",
      inputSchema: comum,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id_equipamento, confirmar, confirmar_nome }) => {
      try {
        const antes = await lerEquipamento(hs, id_equipamento);
        const eq = antes.equipamento;
        const bloqueios: string[] = [];
        const avisos: string[] = [aviso];
        if (antes.encontrado && eq && !eq.deleted_at) bloqueios.push("O equipamento já está ativo (deleted_at vazio).");
        if (!antes.encontrado) avisos.push(`A leitura prévia não encontrou o equipamento (HTTP ${antes.http_status}); comum quando está inativo. O nome será conferido depois da reativação.`);
        if (confirmar && !confirmar_nome?.trim()) bloqueios.push("Informe confirmar_nome com o nome do equipamento.");
        if (confirmar && eq && antes.encontrado && confirmar_nome?.trim() !== String(eq.nome ?? "").trim()) {
          bloqueios.push(`confirmar_nome precisa ser exatamente o nome atual: "${eq.nome}".`);
        }
        const requisicao = { metodo: "GET", url: `${hs.config.baseUrl}${ROTA_EQUIPAMENTO}/${id_equipamento}/restore` };
        if (!confirmar || bloqueios.length) {
          return responder(
            hs,
            {
              modo: "simulacao",
              nada_foi_enviado: true,
              ...(bloqueios.length ? { bloqueado: bloqueios } : {}),
              requisicao_que_seria_enviada: requisicao,
              estado_atual: antes,
              efeito_esperado: "Limpa deleted_at: o equipamento volta às listas e pode receber serviços.",
              avisos,
              ...(bloqueios.length ? {} : { para_executar: "Confirme com o usuário e repita com confirmar=true e confirmar_nome." }),
            },
            Boolean(confirmar && bloqueios.length),
          );
        }
        await vez(hs.config.baseUrl);
        const r = await hs.raw("GET", `${ROTA_EQUIPAMENTO}/${id_equipamento}/restore`);
        const sucesso = r.ok && r.body?.status !== "error";
        const depois = await lerEquipamento(hs, id_equipamento);
        const mudancas = diff(antes, depois);
        const nomeDepois = depois.equipamento?.nome;
        if (sucesso && nomeDepois && confirmar_nome?.trim() !== String(nomeDepois).trim()) {
          avisos.push(`ATENÇÃO: o equipamento reativado se chama "${nomeDepois}", diferente de confirmar_nome. Se foi engano, inative-o de novo com hubsoft_equipamento_inativar.`);
        }
        const registro: Record<string, unknown> = {
          ferramenta: "hubsoft_equipamento_reativar",
          metodo: "GET",
          url: requisicao.url,
          http_status: r.status,
          resposta: r.body,
          confirmar_nome,
          diff: mudancas,
        };
        auditar(hs, registro);
        return responder(
          hs,
          {
            modo: "execucao",
            requisicao_enviada: requisicao,
            resultado: { http_status: r.status, sucesso, resposta: r.body, ...(r.status === 429 ? { retry_after: r.retryAfter, observacao: "Não foi repetido." } : {}) },
            estado_antes: antes,
            estado_depois: depois,
            diff: mudancas,
            avisos,
            ...(registro.aviso_auditoria ? { aviso_auditoria: registro.aviso_auditoria } : {}),
          },
          !sucesso,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
