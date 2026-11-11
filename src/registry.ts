import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "./client.js";
import { registerSituacao } from "./tools/situacao.js";
import { registerStatus } from "./tools/status.js";
import { registerResumo } from "./tools/resumo.js";
import { registerLeitura } from "./tools/leitura.js";
import { registerEscrita } from "./tools/escrita.js";
import { registerGraphql } from "./tools/graphql.js";

/** Definição de uma ferramenta, compartilhada entre o servidor MCP e a CLI. */
export interface ToolDef {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, any>;
    annotations?: Record<string, unknown>;
  };
  cb: (args: any, extra?: any) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}

/**
 * Coleta todas as ferramentas habilitadas pela configuração.
 * Os módulos de ferramentas chamam `registerTool`; aqui capturamos as chamadas
 * para que MCP e CLI usem exatamente as mesmas definições.
 */
export function collectTools(hs: HubsoftClient): ToolDef[] {
  const defs: ToolDef[] = [];
  const collector = {
    registerTool: (name: string, config: ToolDef["config"], cb: ToolDef["cb"]) => {
      defs.push({ name, config, cb });
    },
  } as unknown as McpServer;

  registerSituacao(collector, hs);
  registerStatus(collector, hs);
  registerResumo(collector, hs);
  registerLeitura(collector, hs);
  if (!hs.config.readOnly) registerEscrita(collector, hs);
  registerGraphql(collector, hs);
  return defs;
}
