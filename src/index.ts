#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { HubsoftClient } from "./client.js";
import { registerLeitura } from "./tools/leitura.js";
import { registerEscrita } from "./tools/escrita.js";
import { registerGraphql } from "./tools/graphql.js";
import { registerSituacao } from "./tools/situacao.js";
import { setExposeSecrets } from "./util.js";

const VERSION = "0.2.0";

async function main() {
  const cfg = loadConfig();
  const hs = new HubsoftClient(cfg);

  const server = new McpServer(
    { name: "hubsoft-mcp", version: VERSION },
    {
      instructions:
        "Ferramentas para o ERP Hubsoft (provedores de internet). As chamadas usam o login " +
        "do próprio usuário, então o acesso segue as permissões dele no Hubsoft. " +
        "Para perguntas sobre um cliente, comece por hubsoft_situacao_cliente (CPF/CNPJ ou código). " +
        "Para buscas por nome, login ou outros campos use hubsoft_buscar_cliente. " +
        "Para relatórios por período, POPs, CPEs/ONUs, notas fiscais e sessões RADIUS, use as " +
        "ferramentas GraphQL (hubsoft_graphql_consultas → hubsoft_graphql_tipo → hubsoft_graphql). " +
        "Senhas (ex.: PPPoE) são mascaradas por padrão. " +
        "Dados de clientes são pessoais (LGPD): mostre apenas o necessário. " +
        "Antes de qualquer ação que altere dados, confirme cliente e serviço com o usuário.",
    },
  );

  setExposeSecrets(cfg.exposeSecrets);
  registerSituacao(server, hs);
  registerLeitura(server, hs);
  if (!cfg.readOnly) registerEscrita(server, hs);
  registerGraphql(server, hs);

  await server.connect(new StdioServerTransport());
  // stdout é do protocolo MCP; logs vão para stderr
  console.error(
    `hubsoft-mcp ${VERSION} conectado a ${cfg.baseUrl} ` +
      `(usuário ${cfg.username}, ${cfg.readOnly ? "somente leitura" : "leitura e escrita"}` +
      `${cfg.graphqlPath ? `, GraphQL em ${cfg.graphqlPath}` : ""})`,
  );
}

main().catch((err) => {
  console.error(`hubsoft-mcp: ${err?.message ?? err}`);
  process.exit(1);
});
