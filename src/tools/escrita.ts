import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { API, run } from "../util.js";

/**
 * Ferramentas que ALTERAM dados no Hubsoft.
 * Só são registradas quando HUBSOFT_READ_ONLY=false.
 * Marcadas como destrutivas para que o cliente MCP peça confirmação ao usuário.
 */
export function registerEscrita(server: McpServer, hs: HubsoftClient) {
  const max = hs.config.maxResponseChars;

  server.registerTool(
    "hubsoft_desbloqueio_confianca",
    {
      title: "Desbloqueio em confiança",
      description:
        "Libera em confiança um serviço bloqueado por inadimplência, pelo número de dias " +
        "informado. O Hubsoft recusa se exceder o máximo configurado no painel. " +
        "Confirme o cliente e o serviço com o usuário antes de executar.",
      inputSchema: {
        id_cliente_servico: z.number().int().positive().describe("ID do serviço do cliente."),
        dias_desbloqueio: z.number().int().min(1).max(30).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ id_cliente_servico, dias_desbloqueio }) =>
      run(max, () =>
        hs.post(`${API}/cliente/desbloqueio_confianca`, {
          id_cliente_servico: String(id_cliente_servico),
          ...(dias_desbloqueio ? { dias_desbloqueio: String(dias_desbloqueio) } : {}),
        }),
      ),
  );

  server.registerTool(
    "hubsoft_enviar_fatura_email",
    {
      title: "Enviar fatura por e-mail",
      description:
        "Pede ao Hubsoft para enviar a fatura por e-mail ao cliente (e a e-mails adicionais).",
      inputSchema: {
        id_fatura: z.number().int().positive(),
        email_adicional: z.array(z.string().email()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ id_fatura, email_adicional }) =>
      run(max, () =>
        hs.post(`${API}/cliente/financeiro/enviar_email`, {
          id_fatura,
          ...(email_adicional?.length ? { email_adicional } : {}),
        }),
      ),
  );
}
