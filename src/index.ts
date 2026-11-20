import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadServers } from "./config.js";
import { collectMultiTools, diagnosticoVariaveis, instrucoesServidores } from "./multi.js";
import { setExposeSecrets } from "./util.js";
import { VERSION } from "./version.js";
import { CANCELAR, configurarPerguntador } from "./dialogo2fa.js";

export const INSTRUCTIONS =
  "Ferramentas para o ERP Hubsoft (provedores de internet). As chamadas usam o login " +
  "do próprio usuário, então o acesso segue as permissões dele no Hubsoft. " +
  "Para perguntas sobre um cliente, comece por hubsoft_situacao_cliente (CPF/CNPJ ou código). " +
  "Para listas de clientes bloqueados/suspensos ou por qualquer status de serviço, use " +
  "hubsoft_servicos_por_status (filtra no servidor; não varra a base). " +
  "Para totais de um período (faturamento, recebimentos, inadimplência por mês), use " +
  "hubsoft_resumo_financeiro, que pagina e soma no servidor; nunca pagine faturas para somar. " +
  "Para clientes com cadastro ativo e sem serviço ativo, use hubsoft_clientes_ativos_sem_servico_ativo " +
  "(varre a base no servidor); nunca pagine clientes manualmente. " +
  "Para buscas por nome, login ou outros campos use hubsoft_buscar_cliente. " +
  "Para relatórios por período, POPs, CPEs/ONUs, notas fiscais e sessões RADIUS, use as " +
  "ferramentas GraphQL (hubsoft_graphql_consultas → hubsoft_graphql_tipo → hubsoft_graphql). " +
  "Faturas com status 'aguardando' e vencimento futuro (ex.: parcelas de carnê) não estão vencidas. " +
  "Para exportar a base inteira (serviços, CPEs, equipamentos/POPs) para planilha, use hubsoft_exportar_* com " +
  "servidor de UMA base: elas gravam um CSV e devolvem só o resumo; não pagine para montar planilhas. " +
  "Senhas (ex.: PPPoE) são mascaradas por padrão. " +
  "Dados de clientes são pessoais (LGPD): mostre apenas o necessário. " +
  "Quando o login exige 2FA, o próprio MCP abre uma página no navegador para o usuário digitar o código. " +
  "Se a resposta disser 'Login 2FA pendente', mostre o link ao usuário e repita a consulta depois que ele " +
  "conectar. Só se isso não for possível, peça o código e chame hubsoft_conectar; nunca invente um código. " +
  "O token fica salvo, então isso só é preciso no primeiro acesso. " +
  "Antes de qualquer ação que altere dados, confirme cliente e serviço com o usuário. " +
  "Ferramentas de escrita/controle de CPE (configurar_autenticacao, vincular/desvincular_cpe, " +
  "reiniciar/restaurar_cpe, cpe_gerenciar) exigem servidor com UMA base e começam SEMPRE em simulação " +
  "(confirmar=false): mostre ao usuário o estado atual, a requisição e o efeito, e só repita com " +
  "confirmar=true depois de ele aprovar explicitamente. Depois de executar, mostre o diff antes/depois.";

async function main() {
  const servers = loadServers();
  const cfg = servers[0];
  setExposeSecrets(cfg.exposeSecrets);

  const server = new McpServer(
    { name: "hubsoft-mcp", version: VERSION },
    { instructions: INSTRUCTIONS + instrucoesServidores(servers) },
  );
  for (const t of collectMultiTools(servers)) server.registerTool(t.name, t.config as any, t.cb as any);

  await server.connect(new StdioServerTransport());

  // 2FA via MCP elicitation, quando o cliente suporta (a janela nativa é tentada antes).
  configurarPerguntador(
    async (i) => {
      if (!server.server.getClientCapabilities()?.elicitation) return undefined;
      const r = await server.server.elicitInput(
        {
          mode: "form",
          message:
            (i.erro ? `${i.erro} ` : "") +
            `Hubsoft (${i.base} – ${i.host}): digite o código do app autenticador para ${i.usuario}. ` +
            "O token fica salvo; o código não será pedido de novo.",
          requestedSchema: {
            type: "object",
            properties: {
              codigo: { type: "string", title: "Código 2FA", description: "6 dígitos do app autenticador", minLength: 6, maxLength: 8 },
            },
            required: ["codigo"],
          },
        } as any,
        { timeout: 120_000 },
      );
      return r.action === "accept" ? String((r.content as any)?.codigo ?? "") : CANCELAR;
    },
    { antesDaJanela: false, nome: "elicitation" },
  );
  // stdout é do protocolo MCP; logs vão para stderr
  console.error(
    `hubsoft-mcp ${VERSION}: ${servers.length} servidor(es) — ` +
      servers.map((s) => `${s.nome}=${new URL(s.baseUrl).host}`).join(", ") +
      ` (${cfg.readOnly ? "somente leitura" : "leitura e escrita"})`,
  );
  console.error(`hubsoft-mcp: variáveis recebidas ${JSON.stringify(diagnosticoVariaveis())}`);
}

main().catch((err) => {
  console.error(`hubsoft-mcp: ${err?.message ?? err}`);
  process.exit(1);
});
