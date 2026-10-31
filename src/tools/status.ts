import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { API, run } from "../util.js";
import { hojeBR, isoDate, resumoFinanceiro } from "../faturas.js";

/** Status de serviço que indicam bloqueio/suspensão. */
export const STATUS_BLOQUEIO = [
  "suspenso_debito",
  "suspenso_parcialmente",
  "suspenso_pedido_cliente",
  "franquia_excedida",
];

const PAGE = 100;
const MAX_PAGES = 50; // limite de segurança: 5.000 registros por status

function dias(desde: string | null, hoje: string) {
  if (!desde) return undefined;
  return Math.round((Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 864e5);
}

export function registerStatus(server: McpServer, hs: HubsoftClient) {
  const max = hs.config.maxResponseChars;

  server.registerTool(
    "hubsoft_servicos_por_status",
    {
      title: "Serviços por status (bloqueados, suspensos…)",
      description:
        "Lista serviços de clientes filtrando por status no próprio Hubsoft, sem varrer a " +
        "base inteira. Padrão: todos os bloqueados/suspensos (suspenso_debito, " +
        "suspenso_parcialmente, suspenso_pedido_cliente, franquia_excedida). " +
        "Outros status: servico_habilitado, aguardando_instalacao, agendado_para_instalacao, " +
        "aguardando_configuracao, aguardando_assinatura_contrato, aguardando_migracao, " +
        "aguardando_liberacao_ti, inativo, cancelado (lista do provedor em " +
        "hubsoft_consulta rota 'configuracao/servico_status'). " +
        "Com incluir_faturas_vencidas=true, traz também o débito vencido de cada cliente.",
      inputSchema: {
        status: z
          .array(z.string())
          .optional()
          .describe("Prefixos de status. Padrão: os de bloqueio/suspensão."),
        incluir_faturas_vencidas: z
          .boolean()
          .optional()
          .describe("Consulta as faturas vencidas de cada cliente (1 chamada por cliente; máx. 100)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ status, incluir_faturas_vencidas }) =>
      run(max, async () => {
        const alvos = status?.length ? status : STATUS_BLOQUEIO;
        const hoje = hojeBR();
        const itens: any[] = [];
        const vistos = new Set<unknown>();

        for (const st of alvos) {
          for (let pagina = 0; pagina < MAX_PAGES; pagina++) {
            const r = await hs.get(`${API}/cliente/todos`, {
              servico_status: st,
              itens_por_pagina: PAGE,
              pagina,
            });
            for (const c of r?.clientes ?? []) {
              for (const s of c?.servicos ?? []) {
                if (s?.status_prefixo !== st || vistos.has(s.id_cliente_servico)) continue;
                vistos.add(s.id_cliente_servico);
                const suspenso = isoDate(s.data_ultima_suspensao);
                itens.push({
                  codigo_cliente: c.codigo_cliente,
                  nome: c.nome_razaosocial,
                  telefone: c.telefone_primario ?? undefined,
                  id_cliente_servico: s.id_cliente_servico,
                  plano: s.nome,
                  valor: s.valor,
                  status: s.status,
                  status_prefixo: s.status_prefixo,
                  login: s.login,
                  onu: s.phy_addr ?? undefined,
                  tecnologia: s.tecnologia ?? undefined,
                  data_ultima_suspensao: suspenso ?? undefined,
                  dias_suspenso: dias(suspenso, hoje),
                });
              }
            }
            const pg = r?.paginacao;
            if (!pg || pagina >= Number(pg.ultima_pagina ?? 0)) break;
          }
        }

        if (incluir_faturas_vencidas) {
          for (const it of itens.slice(0, 100)) {
            try {
              const f = await hs.get(`${API}/cliente/financeiro`, {
                busca: "codigo_cliente",
                termo_busca: String(it.codigo_cliente),
                apenas_pendente: "sim",
                limit: 60,
              });
              const fin = resumoFinanceiro(f?.faturas ?? [], hoje);
              it.debito_vencido = {
                faturas: fin.vencidas.quantidade,
                valor: fin.vencidas.valor_total,
                maior_atraso_dias: Math.max(0, ...fin.vencidas.faturas.map((x) => x.dias_atraso ?? 0)),
              };
            } catch (e) {
              it.debito_vencido = { erro: (e as Error).message };
            }
          }
        }

        const porStatus: Record<string, number> = {};
        for (const it of itens) porStatus[it.status_prefixo] = (porStatus[it.status_prefixo] ?? 0) + 1;
        itens.sort((a, b) => (b.dias_suspenso ?? -1) - (a.dias_suspenso ?? -1));

        return {
          hoje,
          total: itens.length,
          por_status: porStatus,
          ...(incluir_faturas_vencidas
            ? {
                debito_vencido_total: Number(
                  itens.reduce((s, x) => s + (x.debito_vencido?.valor ?? 0), 0).toFixed(2),
                ),
              }
            : {}),
          servicos: itens,
        };
      }),
  );
}
