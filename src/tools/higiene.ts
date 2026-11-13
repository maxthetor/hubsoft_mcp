import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { API, run } from "../util.js";
import { isoDate } from "../faturas.js";

/** Máximo aceito pela REST cliente/todos ("não deverá conter um valor superior a 500"). */
const POR_PAGINA = 500;
const PARALELO = 4;
const MAX_PAGINAS = 400; // 200 mil clientes

/** Status de serviço encerrados: não contam como serviço em vigor. */
const ENCERRADOS = new Set(["cancelado", "inativo"]);

export function registerHigiene(server: McpServer, hs: HubsoftClient) {
  const max = hs.config.maxResponseChars;

  server.registerTool(
    "hubsoft_clientes_ativos_sem_servico_ativo",
    {
      title: "Clientes ativos sem serviço ativo",
      description:
        "Varre TODOS os clientes da base no próprio servidor (REST cliente/todos, 500 por página) e " +
        "devolve só os clientes com cadastro ATIVO que não têm nenhum serviço ativo — para higiene " +
        "de cadastro (inativar cadastros) ou recuperação de ex-clientes. Nunca pagine clientes " +
        "manualmente para isso. criterio='vigente' (padrão): serviço ativo = qualquer status exceto " +
        "cancelado e inativo (suspensos e instalações pendentes contam como ativos). " +
        "criterio='habilitado': só 'Serviço Habilitado' conta como ativo (inclui suspensos na lista). " +
        "Devolve código, nome, CPF/CNPJ, data de cadastro e o status de cada serviço, além de " +
        "contagens por situação.",
      inputSchema: {
        criterio: z
          .enum(["vigente", "habilitado"])
          .optional()
          .describe("O que conta como serviço ativo. Padrão: vigente."),
        limite: z
          .number()
          .int()
          .min(0)
          .max(20000)
          .optional()
          .describe("Máximo de clientes na lista (as contagens consideram todos). Padrão: 1000; 0 = só contagens."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ criterio, limite }) =>
      run(max, async () => {
        const modo = criterio ?? "vigente";
        const lim = limite ?? 1000;
        const ativo = (st: string) => (modo === "habilitado" ? st === "servico_habilitado" : !ENCERRADOS.has(st));

        const pagina = (n: number) =>
          hs.get(`${API}/cliente/todos`, { itens_por_pagina: POR_PAGINA, pagina: n });

        const clientes = new Map<string, any>();
        let total = 0;
        let paginas = 0;
        let repetidos = 0;

        // Uma varredura completa; devolve quantos clientes novos entraram.
        const varrer = async () => {
          const primeira = await pagina(0);
          paginas++;
          const ultima = Math.min(Number(primeira?.paginacao?.ultima_pagina ?? 0), MAX_PAGINAS - 1);
          total = Number(primeira?.paginacao?.total_registros ?? 0);
          const lotes = [primeira?.clientes ?? []];
          for (let p = 1; p <= ultima; p += PARALELO) {
            const nums = Array.from({ length: Math.min(PARALELO, ultima - p + 1) }, (_, i) => p + i);
            const res = await Promise.all(nums.map(pagina));
            paginas += nums.length;
            for (const r of res) lotes.push(r?.clientes ?? []);
          }
          for (const lote of lotes) {
            for (const c of lote) {
              const id = String(c?.id_cliente ?? c?.codigo_cliente);
              if (clientes.has(id)) repetidos++;
              else clientes.set(id, c);
            }
          }
          return ultima;
        };

        let ultima = await varrer();
        let passadas = 1;
        // Paginação sem ordem estável pode pular clientes: uma segunda passada completa a lista.
        if (clientes.size < total) {
          ultima = await varrer();
          passadas++;
        }
        const truncado = ultima >= MAX_PAGINAS - 1 && total > MAX_PAGINAS * POR_PAGINA;

        const resultado: any[] = [];
        const porSituacao: Record<string, number> = {};
        let ativosCadastro = 0;
        for (const c of clientes.values()) {
          if (c?.ativo === false) continue;
          ativosCadastro++;
          const servicos: any[] = c?.servicos ?? [];
          if (servicos.some((s) => ativo(String(s?.status_prefixo ?? "")))) continue;
          const sts = [...new Set(servicos.map((s) => String(s?.status_prefixo ?? "?")))].sort();
          const situacao = sts.length ? sts.join("+") : "sem_servicos";
          porSituacao[situacao] = (porSituacao[situacao] ?? 0) + 1;
          resultado.push({
            codigo_cliente: c.codigo_cliente,
            nome: c.nome_razaosocial,
            cpf_cnpj: c.cpf_cnpj,
            data_cadastro: isoDate(c.data_cadastro) ?? c.data_cadastro,
            servicos: servicos.map((s) => ({
              id_cliente_servico: s.id_cliente_servico,
              plano: s.nome,
              status: s.status_prefixo,
              ...(s.data_cancelamento ? { cancelado_em: isoDate(s.data_cancelamento) ?? s.data_cancelamento } : {}),
            })),
          });
        }
        resultado.sort((a, b) => Number(a.codigo_cliente) - Number(b.codigo_cliente));

        const completo = clientes.size >= total && !truncado;
        return {
          criterio: modo,
          clientes_na_base: total,
          clientes_lidos: clientes.size,
          clientes_ativos_no_cadastro: ativosCadastro,
          total_sem_servico_ativo: resultado.length,
          por_situacao: porSituacao,
          completo,
          ...(completo
            ? {}
            : { aviso: `Lidos ${clientes.size} de ${total} clientes após ${passadas} passada(s); a lista pode estar incompleta.` }),
          paginas_consultadas: paginas,
          repetidos_descartados: repetidos,
          ...(resultado.length > lim ? { lista_truncada_em: lim } : {}),
          clientes: resultado.slice(0, lim),
        };
      }),
  );
}
