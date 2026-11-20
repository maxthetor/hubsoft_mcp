import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HubsoftError, type HubsoftClient } from "../client.js";
import { API, fail, mascararTexto } from "../util.js";
import { carimbo, gravarCsvNome, lerCsv, obter, pausar, segundos, vez, type Contadores } from "../exportar.js";
import { auditar, diff, normPhy, primeiraLista, RELACOES, responder, resumoCpe, snapshotServico } from "./cpe.js";

/**
 * hubsoft_vincular_lote: vincula em lote ONUs já autorizadas na OLT aos serviços do Hubsoft, a partir
 * de um CSV na pasta das exportações (HUBSOFT_EXPORT_DIR). Linha a linha, em sequência (nunca em paralelo):
 *   leitura prévia → [desvincular_cpe da CPE antiga] → configurar_autenticacao → vincular_cpe → releitura.
 * confirmar=false (padrão) só classifica. POST nunca é repetido (no 429, a linha vira ERRO e o lote
 * espera retry_after antes da próxima). Para após 5 erros seguidos e, para não estourar o limite de
 * ~80 s da ponte do Claude Desktop/Cowork, para entre linhas quando o tempo acaba (HUBSOFT_LOTE_TEMPO_MAX_S)
 * e informa de qual linha retomar.
 */

export const MAX_ERROS_SEGUIDOS = 5;
const OBRIGATORIAS = ["base", "id_cliente_servico", "sn"];
const SIM = /^(s|sim|y|yes|true|1|x)$/i;

/** Motivos que não são falha de verdade: ficam fora de primeiras_falhas. */
const ADMINISTRATIVOS = new Set(["OUTRA_BASE", "NAO_APROVADA", "ACIMA_DO_LIMITE", "TEMPO_ESGOTADO", "LOTE_INTERROMPIDO", "JA_VINCULADO"]);

export const COLUNAS_RESULTADO = [
  "linha", "base", "id_cliente_servico", "sn", "aprovar", "desvincular_antes",
  "resultado", "motivo", "mensagem_api", "cpe_desvinculada", "olt_antes", "interface_antes", "cpes_antes",
  "olt_depois", "interface_depois", "cpes_depois",
];

type Resultado = "OK" | "PULADO" | "ERRO" | "EXECUTARIA";

interface Linha {
  linha: number;
  base: string;
  id_cliente_servico: string;
  sn: string;
  aprovar: string;
  desvincular_antes: string;
  resultado?: Resultado;
  motivo?: string;
  mensagem_api?: string;
  cpe_desvinculada?: string;
  olt_antes?: string;
  interface_antes?: string;
  cpes_antes?: string;
  olt_depois?: string;
  interface_depois?: string;
  cpes_depois?: string;
}

const num = (nome: string, padrao: number) => {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v > 0 ? v : padrao;
};

/** Caminho real do arquivo, garantindo que fica dentro de HUBSOFT_EXPORT_DIR (sem ../, links ou absolutos de fora). */
export function resolverArquivoLote(dir: string, arquivo: string): string {
  if (!/\.csv$/i.test(arquivo)) throw new Error("O arquivo do lote precisa ser .csv.");
  let raiz: string;
  try {
    raiz = realpathSync.native(dir);
  } catch {
    throw new Error(`A pasta das exportações CSV (HUBSOFT_EXPORT_DIR) não existe: ${dir}. Crie a pasta e coloque o CSV nela.`);
  }
  let real: string;
  try {
    real = realpathSync.native(resolve(raiz, arquivo));
  } catch {
    throw new Error(`Arquivo não encontrado na pasta das exportações CSV (HUBSOFT_EXPORT_DIR = ${raiz}): ${arquivo}`);
  }
  const rel = relative(raiz, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Recusado: o arquivo precisa estar dentro da pasta das exportações CSV (HUBSOFT_EXPORT_DIR = ${raiz}).`);
  }
  if (!statSync(real).isFile()) throw new Error(`Não é um arquivo: ${arquivo}`);
  return real;
}

/** CPE identificada por MAC (roteador do cliente), que não bloqueia nem é desvinculada. */
function ehMac(phy: unknown, macServico: string) {
  const bruto = String(phy ?? "").trim();
  if (/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(bruto)) return true;
  return Boolean(macServico) && normPhy(bruto) === macServico;
}

function msgApi(body: any): string {
  if (!body) return "";
  const partes = [body.msg ?? body.message ?? body.error ?? body.raw ?? ""];
  if (Array.isArray(body.errors)) partes.push(body.errors.join(" "));
  else if (body.errors && typeof body.errors === "object") partes.push(Object.values(body.errors).flat().join(" "));
  return mascararTexto(partes.filter(Boolean).join(" ").replace(/\s+/g, " ").trim()).slice(0, 300);
}

const juntarPhy = (cpes: any[] | undefined) => (cpes ?? []).map((c) => c?.phy_addr).filter(Boolean).join("|");

async function lerServico(hs: HubsoftClient, id: number, cont: Contadores) {
  const r = await obter(hs, `${API}/cliente`, { busca: "id_cliente_servico", termo_busca: id, relacoes: RELACOES }, cont);
  if (!r.ok) return { erro: r.erro };
  for (const c of r.body?.clientes ?? []) {
    const sv = (c?.servicos ?? []).find((s: any) => Number(s?.id_cliente_servico) === id);
    if (sv) return { servico: snapshotServico(sv) as any };
  }
  return { naoEncontrado: true as const };
}

async function lerCpe(hs: HubsoftClient, sn: string, cont: Contadores) {
  const r = await obter(
    hs,
    `${API}/rede/cpe/todos`,
    { pagina: 0, itens_por_pagina: 20, busca: "phy_addr", termo_busca: sn, somente_assinante_associado: "nao" },
    cont,
  );
  if (!r.ok) return { erro: r.erro };
  const alvo = normPhy(sn);
  return { encontradas: primeiraLista(r.body).filter((c) => normPhy(c?.phy_addr) === alvo).map(resumoCpe) };
}

interface Passo {
  metodo: string;
  url: string;
  corpo: unknown;
  http_status: number;
  resposta: unknown;
}

async function postar(hs: HubsoftClient, path: string, corpo: Record<string, unknown>, passos: Passo[], cont: Contadores) {
  await vez(hs.config.baseUrl);
  cont.requisicoes++;
  const r = await hs.raw("POST", path, { body: corpo });
  if (r.status === 429) {
    cont.esperas_429++;
    pausar(hs.config.baseUrl, r.retryAfter ?? 1); // a próxima linha espera; este POST não é repetido
  }
  passos.push({ metodo: "POST", url: hs.config.baseUrl + path, corpo, http_status: r.status, resposta: r.body });
  const msg = msgApi(r.body);
  return {
    ok: r.ok && r.body?.status !== "error",
    status: r.status,
    msg: r.status === 429 ? `HTTP 429 (limite de requisições; não repetido). ${msg}`.trim() : msg ? `HTTP ${r.status}: ${msg}` : `HTTP ${r.status}`,
    bruto: msg,
  };
}

/** Processa UMA linha já elegível. Preenche resultado/motivo/mensagem e os campos de estado. */
async function processarLinha(hs: HubsoftClient, l: Linha, confirmar: boolean, arquivo: string, cont: Contadores) {
  const id = Number(l.id_cliente_servico);
  const desvincular = SIM.test(l.desvincular_antes);
  const definir = (resultado: Resultado, motivo: string, mensagem = "") => {
    l.resultado = resultado;
    l.motivo = motivo;
    if (mensagem) l.mensagem_api = mensagem;
  };

  const lido = await lerServico(hs, id, cont);
  if ("erro" in lido) return definir("ERRO", "FALHA_LEITURA_SERVICO", lido.erro);
  if ("naoEncontrado" in lido) return definir("PULADO", "SERVICO_NAO_ENCONTRADO");
  const sv = lido.servico;
  const cpesSv: any[] = Array.isArray(sv.cpes) ? sv.cpes : [];
  l.olt_antes = sv.equipamento_conexao?.nome ?? "";
  l.interface_antes = sv.interface?.nome ?? "";
  l.cpes_antes = juntarPhy(cpesSv);

  if (sv.status_prefixo === "cancelado") return definir("PULADO", "SERVICO_CANCELADO");
  const alvo = normPhy(l.sn);
  if (cpesSv.some((c) => normPhy(c?.phy_addr) === alvo)) {
    l.olt_depois = l.olt_antes;
    l.interface_depois = l.interface_antes;
    l.cpes_depois = l.cpes_antes;
    return definir("PULADO", "JA_VINCULADO");
  }

  const cpe = await lerCpe(hs, l.sn, cont);
  if ("erro" in cpe) return definir("ERRO", "FALHA_LEITURA_CPE", cpe.erro);
  if (!cpe.encontradas.length) return definir("PULADO", "SN_FORA_DO_INVENTARIO");
  const outros = [...new Set(cpe.encontradas.flatMap((c: any) => c.servicos_vinculados).filter((x: number) => x !== id))];
  if (outros.length) return definir("PULADO", "SN_EM_OUTRO_SERVICO", `SN vinculado ao(s) serviço(s) ${outros.join(", ")}`);

  const antigas = cpesSv.filter((c) => !ehMac(c?.phy_addr, normPhy(sv.mac_addr)));
  if (antigas.length > 1) {
    return definir("PULADO", "VARIAS_CPES_VINCULADAS", `O serviço tem ${antigas.length} CPEs não-MAC (${juntarPhy(antigas)}); trate manualmente.`);
  }
  const antiga = antigas[0]?.phy_addr as string | undefined;
  if (antiga && !desvincular) {
    return definir("PULADO", "OUTRA_CPE_VINCULADA", `O serviço já tem a CPE ${antiga}; use desvincular_antes=S para trocá-la.`);
  }

  if (!confirmar) {
    return definir(
      "EXECUTARIA",
      antiga ? "DESVINCULARIA_E_VINCULARIA" : "VINCULARIA",
      antiga ? `desvincular ${antiga} → configurar_autenticacao(phy_addr=${l.sn}) → vincular_cpe` : `configurar_autenticacao(phy_addr=${l.sn}) → vincular_cpe`,
    );
  }

  // ── Execução: POSTs em sequência, sem nova tentativa
  const passos: Passo[] = [];
  try {
    if (antiga) {
      const d = await postar(hs, `${API}/cliente/desvincular_cpe`, { id_cliente_servico: id, phy_addr: antiga }, passos, cont);
      if (!d.ok) return definir("ERRO", "FALHA_DESVINCULAR", d.msg);
      l.cpe_desvinculada = antiga;
    }
    const desfeita = antiga ? ` A CPE antiga ${antiga} JÁ FOI desvinculada.` : "";
    const a = await postar(hs, `${API}/cliente/configurar_autenticacao`, { id_cliente_servico: id, phy_addr: l.sn }, passos, cont);
    const semAlteracao = a.status === 422 && /n[ãa]o (é|e) necess[áa]ri/i.test(a.bruto);
    if (!a.ok && !semAlteracao) return definir("ERRO", "FALHA_CONFIGURAR_AUTENTICACAO", a.msg + desfeita);
    const v = await postar(hs, `${API}/cliente/vincular_cpe`, { id_cliente_servico: id }, passos, cont);
    if (!v.ok) return definir("ERRO", "FALHA_VINCULAR", v.msg + desfeita);

    const depois = await lerServico(hs, id, cont);
    if (!("servico" in depois)) return definir("ERRO", "FALHA_RELEITURA", "erro" in depois ? depois.erro : "serviço não encontrado na releitura");
    const sd = depois.servico;
    l.olt_depois = sd.equipamento_conexao?.nome ?? "";
    l.interface_depois = sd.interface?.nome ?? "";
    l.cpes_depois = juntarPhy(sd.cpes);
    const confirmado = (sd.cpes ?? []).some((c: any) => normPhy(c?.phy_addr) === alvo);
    if (!confirmado) return definir("ERRO", "NAO_CONFIRMADO_NA_RELEITURA", `A releitura não mostra o SN ${l.sn} entre as CPEs do serviço.`);
    definir("OK", antiga ? "TROCADO" : "VINCULADO", v.bruto);
    (l as any)._diff = diff(sv, sd);
  } finally {
    if (passos.length) {
      auditar(hs, {
        ferramenta: "hubsoft_vincular_lote",
        lote: basename(arquivo),
        linha: l.linha,
        id_cliente_servico: id,
        sn: l.sn,
        resultado: l.resultado,
        motivo: l.motivo,
        passos,
        estado_antes: sv,
        ...((l as any)._diff ? { diff: (l as any)._diff } : {}),
      });
    }
  }
}

export function registerLote(server: McpServer, hs: HubsoftClient) {
  if (hs.config.readOnly) return;

  server.registerTool(
    "hubsoft_vincular_lote",
    {
      title: "Vincular CPEs em lote (CSV)",
      description:
        "ESCRITA. Vincula em lote ONUs já autorizadas na OLT aos serviços, lendo um CSV (';', UTF-8) da pasta " +
        "das exportações CSV, HUBSOFT_EXPORT_DIR (caminhos fora dela são recusados). Colunas: base, id_cliente_servico, sn; opcionais " +
        "aprovar e desvincular_antes (S/N). Processa só as linhas da base em `servidor`, uma por vez: leitura prévia, " +
        "[desvincular a CPE antiga], configurar_autenticacao(phy_addr=sn), vincular_cpe e releitura. Pula serviço " +
        "cancelado, SN fora do inventário, SN em outro serviço, serviço já com este SN (JA_VINCULADO) e serviço com " +
        "outra CPE não-MAC sem desvincular_antes=S. confirmar=false (padrão) só classifica, sem enviar nada. Para " +
        "após 5 erros seguidos; se o tempo acabar, para entre linhas e informa retomar_a_partir_da_linha. Grava " +
        "<arquivo>_resultado_<data>.csv (ou _simulacao_) ao lado do arquivo e devolve só o resumo.",
      inputSchema: {
        arquivo: z.string().min(1).describe("Nome do CSV dentro da pasta das exportações CSV (HUBSOFT_EXPORT_DIR; pode ter subpasta)."),
        confirmar: z.boolean().optional().describe("false (padrão) = só classifica as linhas. true = executa."),
        limite: z.number().int().min(1).max(300).optional().describe("Máximo de linhas processadas nesta chamada (padrão 50, máx. 300)."),
        so_aprovadas: z.boolean().optional().describe("true (padrão) = só linhas com aprovar=S."),
        a_partir_da_linha: z.number().int().min(2).optional().describe("Retomar a partir desta linha do arquivo (2 = primeira linha de dados)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args: { arquivo: string; confirmar?: boolean; limite?: number; so_aprovadas?: boolean; a_partir_da_linha?: number }) => {
      try {
        const inicio = Date.now();
        const prazo = inicio + num("HUBSOFT_LOTE_TEMPO_MAX_S", 55) * 1000;
        const confirmar = args.confirmar === true;
        const limite = args.limite ?? 50;
        const soAprovadas = args.so_aprovadas !== false;
        const aPartir = args.a_partir_da_linha ?? 2;
        const base = hs.config.nome;

        const caminho = resolverArquivoLote(hs.config.exportDir, args.arquivo);
        const { cabecalho, linhas: brutas } = lerCsv(readFileSync(caminho, "utf8"));
        const faltam = OBRIGATORIAS.filter((c) => !cabecalho.includes(c));
        if (faltam.length) throw new Error(`Colunas obrigatórias ausentes no CSV: ${faltam.join(", ")} (separador ';').`);
        const col = (cells: string[], nome: string) => {
          const i = cabecalho.indexOf(nome);
          return i < 0 ? "" : String(cells[i] ?? "").trim();
        };
        const linhas: Linha[] = brutas
          .map((cells, i) => ({
            linha: i + 2,
            base: col(cells, "base"),
            id_cliente_servico: col(cells, "id_cliente_servico"),
            sn: col(cells, "sn"),
            aprovar: col(cells, "aprovar"),
            desvincular_antes: col(cells, "desvincular_antes"),
          }))
          .filter((l) => l.linha >= aPartir);

        const cont: Contadores = { requisicoes: 0, esperas_429: 0, novas_tentativas: 0 };
        const vistosId = new Set<string>();
        const vistosSn = new Set<string>();
        let processadas = 0;
        let seguidos = 0;
        let interrompido: string | undefined;
        let retomar: number | undefined;

        for (const l of linhas) {
          const pular = (motivo: string, mensagem = "") => {
            l.resultado = "PULADO";
            l.motivo = motivo;
            if (mensagem) l.mensagem_api = mensagem;
          };
          if (l.base.toLowerCase() !== base.toLowerCase()) { pular("OUTRA_BASE"); continue; }
          if (soAprovadas && !SIM.test(l.aprovar)) { pular("NAO_APROVADA"); continue; }
          if (!/^\d+$/.test(l.id_cliente_servico) || Number(l.id_cliente_servico) <= 0 || !/^\S{5,}$/.test(l.sn)) {
            pular("DADOS_INVALIDOS", "id_cliente_servico precisa ser inteiro positivo e sn ter 5+ caracteres sem espaços");
            continue;
          }
          const chaveSn = normPhy(l.sn);
          if (vistosId.has(l.id_cliente_servico) || vistosSn.has(chaveSn)) { pular("DUPLICADO_NO_ARQUIVO"); continue; }
          vistosId.add(l.id_cliente_servico);
          vistosSn.add(chaveSn);
          if (interrompido) { pular("LOTE_INTERROMPIDO"); retomar ??= l.linha; continue; }
          if (processadas >= limite) { pular("ACIMA_DO_LIMITE"); retomar ??= l.linha; continue; }
          if (Date.now() > prazo) { pular("TEMPO_ESGOTADO"); retomar ??= l.linha; continue; }

          processadas++;
          try {
            await processarLinha(hs, l, confirmar, caminho, cont);
          } catch (e) {
            l.resultado = "ERRO";
            if (e instanceof HubsoftError) {
              l.motivo = "AUTENTICACAO";
              interrompido = `falha de autenticação: ${mascararTexto(e.message).slice(0, 200)}`;
            } else l.motivo = "EXCECAO";
            l.mensagem_api = mascararTexto((e as Error).message ?? String(e)).slice(0, 300);
          }
          seguidos = l.resultado === "ERRO" ? seguidos + 1 : 0;
          if (seguidos >= MAX_ERROS_SEGUIDOS && !interrompido) interrompido = `${MAX_ERROS_SEGUIDOS} erros seguidos`;
        }

        const nomeEntrada = basename(caminho).replace(/\.csv$/i, "");
        const arquivoResultado = gravarCsvNome(
          dirname(caminho),
          `${nomeEntrada}_${confirmar ? "resultado" : "simulacao"}_${carimbo()}`,
          COLUNAS_RESULTADO,
          linhas as unknown as Record<string, unknown>[],
        );

        const contagem: Record<string, number> = {};
        const porMotivo: Record<string, number> = {};
        for (const l of linhas) {
          contagem[l.resultado!] = (contagem[l.resultado!] ?? 0) + 1;
          porMotivo[l.motivo!] = (porMotivo[l.motivo!] ?? 0) + 1;
        }
        const falhas = linhas
          .filter((l) => (l.resultado === "ERRO" || l.resultado === "PULADO") && !ADMINISTRATIVOS.has(l.motivo!))
          .sort((a, b) => Number(b.resultado === "ERRO") - Number(a.resultado === "ERRO") || a.linha - b.linha)
          .slice(0, 10)
          .map((l) => ({
            linha: l.linha,
            id_cliente_servico: Number(l.id_cliente_servico) || l.id_cliente_servico,
            sn: l.sn,
            resultado: l.resultado,
            motivo: l.motivo,
            ...(l.mensagem_api ? { mensagem: l.mensagem_api.slice(0, 200) } : {}),
          }));

        return responder(hs, {
          modo: confirmar ? "execucao" : "simulacao",
          ...(confirmar ? {} : { nada_foi_enviado: true }),
          arquivo_entrada: caminho,
          arquivo_resultado: arquivoResultado,
          linhas_lidas: linhas.length,
          processadas,
          contagem,
          por_motivo: porMotivo,
          ...(interrompido ? { interrompido } : {}),
          ...(retomar !== undefined ? { retomar_a_partir_da_linha: retomar } : {}),
          tempo_s: segundos(inicio),
          ...(cont.esperas_429 ? { esperas_429: cont.esperas_429 } : {}),
          primeiras_falhas: falhas,
          ...(confirmar ? {} : { para_executar: "Revise o CSV de simulação e repita com confirmar=true." }),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
