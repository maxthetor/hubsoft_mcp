import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { API, run } from "../util.js";

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// Parâmetros comuns às rotas de cliente do Hubsoft
const busca = z
  .string()
  .describe(
    "Campo usado na busca. Valores usuais: cpf_cnpj, codigo_cliente, " +
      "nome_razaosocial, id_cliente_servico, login_radius, telefone.",
  );
const termo = z.string().describe("Valor buscado (ex.: o CPF/CNPJ só com números).");
const limit = z.number().int().min(1).max(200).optional().describe("Limite de resultados.");

export function registerLeitura(server: McpServer, hs: HubsoftClient) {
  const max = hs.config.maxResponseChars;

  server.registerTool(
    "hubsoft_buscar_cliente",
    {
      title: "Buscar cliente",
      description:
        "Busca clientes no Hubsoft e retorna cadastro e serviços (plano, situação, " +
        "login PPPoE, endereço). Use para identificar o cliente antes de outras consultas; " +
        "o id_cliente_servico retornado é usado em várias outras ferramentas.",
      inputSchema: {
        busca,
        termo_busca: termo,
        limit,
        apenas_servicos_ativos: z
          .boolean()
          .optional()
          .describe("Se true, retorna apenas serviços ativos."),
      },
      annotations: READ,
    },
    async ({ busca, termo_busca, limit, apenas_servicos_ativos }) =>
      run(max, () =>
        hs.get(`${API}/cliente`, {
          busca,
          termo_busca,
          limit,
          apenas_servicos_ativos:
            apenas_servicos_ativos === undefined ? undefined : apenas_servicos_ativos ? "sim" : "nao",
        }),
      ),
  );

  server.registerTool(
    "hubsoft_faturas_cliente",
    {
      title: "Faturas do cliente",
      description:
        "Lista faturas do cliente (em aberto e/ou histórico), com vencimento, valor, " +
        "situação, linha digitável e link/PIX quando disponíveis.",
      inputSchema: {
        busca,
        termo_busca: termo,
        limit,
        apenas_pendente: z
          .boolean()
          .optional()
          .describe("Se true, retorna apenas faturas em aberto."),
      },
      annotations: READ,
    },
    async ({ busca, termo_busca, limit, apenas_pendente }) =>
      run(max, () =>
        hs.get(`${API}/cliente/financeiro`, {
          busca,
          termo_busca,
          limit,
          apenas_pendente:
            apenas_pendente === undefined ? undefined : apenas_pendente ? "sim" : "nao",
        }),
      ),
  );

  server.registerTool(
    "hubsoft_atendimentos_cliente",
    {
      title: "Atendimentos do cliente",
      description: "Lista atendimentos (chamados) abertos e/ou fechados do cliente.",
      inputSchema: {
        busca,
        termo_busca: termo,
        limit,
        apenas_pendente: z.boolean().optional().describe("Se true, só atendimentos em aberto."),
        order_by: z.string().optional().describe("Campo de ordenação (ex.: data_cadastro)."),
        order_type: z.enum(["asc", "desc"]).optional(),
      },
      annotations: READ,
    },
    async ({ busca, termo_busca, limit, apenas_pendente, order_by, order_type }) =>
      run(max, () =>
        hs.get(`${API}/cliente/atendimento`, {
          busca,
          termo_busca,
          limit,
          apenas_pendente:
            apenas_pendente === undefined ? undefined : apenas_pendente ? "sim" : "nao",
          order_by,
          order_type,
        }),
      ),
  );

  server.registerTool(
    "hubsoft_ordens_servico_cliente",
    {
      title: "Ordens de serviço do cliente",
      description: "Lista ordens de serviço (OS) do cliente, com tipo, status e técnico.",
      inputSchema: {
        busca,
        termo_busca: termo,
        limit,
        apenas_pendente: z.boolean().optional().describe("Se true, só OS em aberto."),
      },
      annotations: READ,
    },
    async ({ busca, termo_busca, limit, apenas_pendente }) =>
      run(max, () =>
        hs.get(`${API}/cliente/ordem_servico`, {
          busca,
          termo_busca,
          limit,
          apenas_pendente:
            apenas_pendente === undefined ? undefined : apenas_pendente ? "sim" : "nao",
        }),
      ),
  );

  server.registerTool(
    "hubsoft_consulta",
    {
      title: "Consulta genérica (GET)",
      description:
        "Faz um GET em qualquer rota da API de integração do Hubsoft " +
        `(prefixo ${API}). Use quando nenhuma ferramenta específica atender, ` +
        "por exemplo: 'configuracao/servico' (planos), 'configuracao/tipo_atendimento', " +
        "'cliente/contrato'. Somente leitura. Resultados paginados aceitam 'pagina'.",
      inputSchema: {
        rota: z
          .string()
          .regex(/^[a-z0-9_\/-]+$/i, "Use apenas letras, números, _ - e /")
          .describe(`Rota relativa a ${API}, ex.: "configuracao/servico".`),
        parametros: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Parâmetros de query string."),
      },
      annotations: READ,
    },
    async ({ rota, parametros }) =>
      run(max, () => {
        if (rota.includes("..")) throw new Error("Rota inválida.");
        return hs.get(`${API}/${rota.replace(/^\/+/, "")}`, parametros);
      }),
  );
}
