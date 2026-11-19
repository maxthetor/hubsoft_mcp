import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { run } from "../util.js";

/**
 * Login com 2FA: o código do app autenticador só é pedido no primeiro acesso.
 * Depois o token (30 dias) e o refresh_token ficam salvos e são renovados sozinhos.
 */
export function registerConexao(server: McpServer, hs: HubsoftClient) {
  const max = hs.config.maxResponseChars;
  server.registerTool(
    "hubsoft_conectar",
    {
      title: "Conectar ao Hubsoft (login com 2FA)",
      description:
        "Faz o login na base com usuário, senha e, se o usuário tiver autenticação em dois fatores, " +
        "o código de 6 dígitos do app autenticador (codigo_2fa). O token fica salvo e é renovado " +
        "sozinho, então o código só é necessário no primeiro acesso ou se o refresh expirar. " +
        "Use quando outra ferramenta falhar na autenticação, PEDINDO o código ao usuário — nunca invente um. " +
        "Sem codigo_2fa, só verifica/renova o acesso atual.",
      inputSchema: {
        codigo_2fa: z
          .string()
          .trim()
          .regex(/^\d{6,8}$/, "o código 2FA tem 6 a 8 dígitos")
          .optional()
          .describe("Código atual do app autenticador (Google Authenticator, Authy…). Muda a cada 30 s."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ codigo_2fa }: { codigo_2fa?: string }) => run(max, () => hs.conectar(codigo_2fa)),
  );
}
