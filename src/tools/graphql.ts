import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { run } from "../util.js";

const TYPE_REF = `name kind ofType { name kind ofType { name kind ofType { name kind } } }`;

const ROOT_FIELDS = `query {
  __schema {
    queryType { fields { name description args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } } }
    mutationType { fields { name description } }
  }
}`;

const TYPE_FIELDS = `query ($nome: String!) {
  __type(name: $nome) {
    name kind description
    fields { name description type { ${TYPE_REF} } }
    inputFields { name type { ${TYPE_REF} } }
    enumValues { name }
  }
}`;

/** Converte a árvore de tipos da introspecção em notação GraphQL (ex.: [Cliente!]!). */
function typeStr(t: any): string {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return `${typeStr(t.ofType)}!`;
  if (t.kind === "LIST") return `[${typeStr(t.ofType)}]`;
  return t.name ?? "?";
}

/** Detecta "mutation"/"subscription" fora de comentários e strings. */
function isMutation(query: string): boolean {
  const clean = query.replace(/#[^\n]*/g, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return /\bmutation\b/i.test(clean) || /\bsubscription\b/i.test(clean);
}

/**
 * Ferramentas GraphQL (endpoint padrão do Hubsoft: /graphql/v1).
 * Requer a opção "Permite acesso à API GraphQL" no cliente da API.
 */
export function registerGraphql(server: McpServer, hs: HubsoftClient) {
  const { graphqlPath, readOnly, maxResponseChars: max } = hs.config;
  if (!graphqlPath) return;

  server.registerTool(
    "hubsoft_graphql_consultas",
    {
      title: "Consultas GraphQL disponíveis",
      description:
        "Lista as consultas da API GraphQL do Hubsoft (ex.: clienteByCpfCnpj, faturas, " +
        "statusConexaoRadius, cpeById), com argumentos e tipo de retorno. " +
        "Chame primeiro; depois use hubsoft_graphql_tipo para ver os campos do tipo de retorno.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(max, async () => {
        const r = await hs.post(graphqlPath, { query: ROOT_FIELDS });
        const s = r?.data?.__schema;
        if (!s) return r;
        return {
          consultas: s.queryType.fields.map(
            (f: any) =>
              `${f.name}(${f.args.map((a: any) => `${a.name}: ${typeStr(a.type)}`).join(", ")}): ` +
              `${typeStr(f.type)}${f.description ? `  # ${f.description}` : ""}`,
          ),
          mutations: (s.mutationType?.fields ?? []).map((f: any) => f.name),
        };
      }),
  );

  server.registerTool(
    "hubsoft_graphql_tipo",
    {
      title: "Campos de um tipo GraphQL",
      description:
        "Mostra os campos de um tipo do esquema GraphQL do Hubsoft (ex.: Cliente, Fatura, " +
        "ClienteServico), para montar a consulta pedindo só o necessário.",
      inputSchema: { nome: z.string().describe("Nome do tipo, ex.: Cliente") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ nome }) =>
      run(max, async () => {
        const r = await hs.post(graphqlPath, { query: TYPE_FIELDS, variables: { nome } });
        const t = r?.data?.__type;
        if (!t) return r?.errors ? r : { erro: `Tipo "${nome}" não encontrado.` };
        return {
          tipo: t.name,
          kind: t.kind,
          descricao: t.description ?? undefined,
          campos: t.fields?.map((f: any) => `${f.name}: ${typeStr(f.type)}`),
          campos_entrada: t.inputFields?.map((f: any) => `${f.name}: ${typeStr(f.type)}`),
          valores: t.enumValues?.map((e: any) => e.name),
        };
      }),
  );

  server.registerTool(
    "hubsoft_graphql",
    {
      title: "Consulta GraphQL",
      description:
        "Executa uma consulta GraphQL no Hubsoft. Peça só os campos necessários e use " +
        "argumentos de paginação/limite quando houver. " +
        (readOnly
          ? "Modo somente leitura: mutations são bloqueadas."
          : "Mutations alteram dados: confirme com o usuário antes."),
      inputSchema: {
        query: z.string().describe("Documento GraphQL."),
        variables: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
    },
    async ({ query, variables }) =>
      run(max, () => {
        if (readOnly && isMutation(query)) {
          throw new Error(
            "Mutations estão bloqueadas (HUBSOFT_READ_ONLY=true). Só consultas são permitidas.",
          );
        }
        return hs.post(graphqlPath, { query, variables });
      }),
  );
}
