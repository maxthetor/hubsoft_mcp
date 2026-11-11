import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { run } from "../util.js";
import { hojeBR, isoDate } from "../faturas.js";

/** Máximo aceito pelo Hubsoft em `first` (acima disso: "Maximum number of 1000 requested items exceeded"). */
const POR_PAGINA = 1000;
/** Limite de segurança: 200 mil faturas por consulta. */
const MAX_PAGINAS = 200;
/** Páginas buscadas em paralelo (a API aceita 20 req/s por IP). */
const PARALELO = 4;

const consulta = (campo: "data_pagamento" | "data_vencimento") => {
  const nome = campo === "data_pagamento" ? "faturasByDataPagamento" : "faturasByDataVencimento";
  return `query ($de: Date!, $ate: Date!, $page: Int) {
  r: ${nome}(${campo}: { de: $de, ate: $ate }, first: ${POR_PAGINA}, page: $page) {
    paginatorInfo { lastPage total }
    data { valor valor_pago data_vencimento data_pagamento ativo }
  }
}`;
};

type Agrupamento = "dia" | "mes" | "ano" | "total";

function chave(data: string, por: Agrupamento) {
  if (por === "dia") return data;
  if (por === "mes") return data.slice(0, 7);
  if (por === "ano") return data.slice(0, 4);
  return "total";
}

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Acumulado {
  faturas: number;
  total_faturado: number;
  pagas: number;
  total_pago: number;
  em_aberto: number;
  valor_em_aberto: number;
  vencidas_em_aberto: number;
  valor_vencido: number;
}

function novo(): Acumulado {
  return { faturas: 0, total_faturado: 0, pagas: 0, total_pago: 0, em_aberto: 0, valor_em_aberto: 0, vencidas_em_aberto: 0, valor_vencido: 0 };
}

function somar(a: Acumulado, f: any, hoje: string) {
  const valor = Number(f.valor ?? 0);
  a.faturas++;
  a.total_faturado += valor;
  if (f.data_pagamento) {
    a.pagas++;
    a.total_pago += Number(f.valor_pago ?? valor);
  } else {
    a.em_aberto++;
    a.valor_em_aberto += valor;
    const venc = isoDate(f.data_vencimento);
    if (venc && venc < hoje) {
      a.vencidas_em_aberto++;
      a.valor_vencido += valor;
    }
  }
}

/** Remove os campos que não fazem sentido para o tipo de data e arredonda valores. */
function formatar(a: Acumulado, data: "pagamento" | "vencimento") {
  if (data === "pagamento") {
    return { faturas: a.faturas, total_pago: r2(a.total_pago), total_faturado: r2(a.total_faturado) };
  }
  return {
    faturas: a.faturas,
    total_faturado: r2(a.total_faturado),
    pagas: a.pagas,
    total_pago: r2(a.total_pago),
    em_aberto: a.em_aberto,
    valor_em_aberto: r2(a.valor_em_aberto),
    vencidas_em_aberto: a.vencidas_em_aberto,
    valor_vencido: r2(a.valor_vencido),
  };
}

export function registerResumo(server: McpServer, hs: HubsoftClient) {
  const { graphqlPath, maxResponseChars: max } = hs.config;
  if (!graphqlPath) return;

  server.registerTool(
    "hubsoft_resumo_financeiro",
    {
      title: "Resumo financeiro por período (totais)",
      description:
        "Totais de faturas num período, somados no próprio servidor: percorre todas as páginas " +
        "e devolve só os números por dia, mês ou ano. Use para faturamento, recebimentos e " +
        "inadimplência de um período — nunca pagine faturas manualmente para somar. " +
        "data='pagamento' (padrão): faturas pagas no período (quantidade, total pago, total faturado). " +
        "data='vencimento': faturas que vencem no período (faturado, pago, em aberto e vencido em aberto). " +
        "Faturas inativas (canceladas) são ignoradas e contadas à parte.",
      inputSchema: {
        de: z.string().describe("Data inicial, aaaa-mm-dd (ou dd/mm/aaaa)."),
        ate: z.string().describe("Data final, inclusive, aaaa-mm-dd (ou dd/mm/aaaa)."),
        data: z
          .enum(["pagamento", "vencimento"])
          .optional()
          .describe("Qual data filtra e agrupa as faturas. Padrão: pagamento."),
        agrupar_por: z
          .enum(["dia", "mes", "ano", "total"])
          .optional()
          .describe("Agrupamento. Padrão: mes."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ de, ate, data, agrupar_por }) =>
      run(max, async () => {
        const ini = isoDate(de);
        const fim = isoDate(ate);
        if (!ini || !fim) throw new Error("Use datas no formato aaaa-mm-dd (ou dd/mm/aaaa).");
        if (fim < ini) throw new Error("A data final é anterior à inicial.");
        const tipo = data ?? "pagamento";
        const por: Agrupamento = agrupar_por ?? "mes";
        const campo = tipo === "pagamento" ? "data_pagamento" : "data_vencimento";
        const query = consulta(campo);
        const hoje = hojeBR();

        const pagina = async (page: number) => {
          const r = await hs.post(graphqlPath, { query, variables: { de: ini, ate: fim, page } });
          if (r?.errors?.length) throw new Error(`GraphQL: ${r.errors.map((e: any) => e.message).join("; ")}`);
          return r?.data?.r ?? { paginatorInfo: { lastPage: 0, total: 0 }, data: [] };
        };

        const primeira = await pagina(1);
        const ultima = Number(primeira.paginatorInfo?.lastPage ?? 1);
        const total = Number(primeira.paginatorInfo?.total ?? 0);
        const alvo = Math.min(ultima, MAX_PAGINAS);
        const lotes: any[][] = [primeira.data ?? []];
        for (let p = 2; p <= alvo; p += PARALELO) {
          const nums = Array.from({ length: Math.min(PARALELO, alvo - p + 1) }, (_, i) => p + i);
          const res = await Promise.all(nums.map(pagina));
          for (const r of res) lotes.push(r.data ?? []);
        }

        const grupos = new Map<string, Acumulado>();
        const geral = novo();
        let lidas = 0;
        let canceladas = 0;
        for (const lote of lotes) {
          for (const f of lote) {
            lidas++;
            if (f.ativo === false) {
              canceladas++;
              continue;
            }
            const d = isoDate(f[campo]);
            if (!d) continue;
            const k = chave(d, por);
            if (!grupos.has(k)) grupos.set(k, novo());
            somar(grupos.get(k)!, f, hoje);
            somar(geral, f, hoje);
          }
        }

        return {
          periodo: { de: ini, ate: fim },
          data: tipo,
          agrupar_por: por,
          faturas_lidas: lidas,
          canceladas_ignoradas: canceladas,
          completo: alvo === ultima && lidas >= total,
          ...(alvo < ultima ? { aviso: `Limite de ${MAX_PAGINAS * POR_PAGINA} faturas atingido; reduza o período.` } : {}),
          grupos: [...grupos.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([periodo, a]) => ({ periodo, ...formatar(a, tipo) })),
          totais: formatar(geral, tipo),
        };
      }),
  );
}
