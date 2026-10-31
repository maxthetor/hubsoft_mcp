/**
 * Configuração lida das variáveis de ambiente.
 *
 * Cada usuário configura o MCP com o PRÓPRIO login do Hubsoft
 * (HUBSOFT_USERNAME / HUBSOFT_PASSWORD). URL, client_id e client_secret
 * são do provedor e podem ser compartilhados internamente.
 */
export interface HubsoftConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  /** Quando true (padrão), ferramentas de escrita não são registradas. */
  readOnly: boolean;
  /** Caminho do endpoint GraphQL (ex.: /graphql). Vazio = desativado. */
  graphqlPath: string;
  /** Tamanho máximo (caracteres) da resposta devolvida ao modelo. */
  maxResponseChars: number;
  /** Mostrar senhas (PPPoE etc.) nas respostas. Padrão: false. */
  exposeSecrets: boolean;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `Variável de ambiente obrigatória ausente: ${name}. ` +
        `Veja o README para configurar o hubsoft-mcp.`,
    );
  }
  return v;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return def;
  return ["1", "true", "sim", "yes", "on"].includes(v);
}

export function loadConfig(): HubsoftConfig {
  return {
    baseUrl: required("HUBSOFT_URL").replace(/\/+$/, ""),
    clientId: required("HUBSOFT_CLIENT_ID"),
    clientSecret: required("HUBSOFT_CLIENT_SECRET"),
    username: required("HUBSOFT_USERNAME"),
    password: required("HUBSOFT_PASSWORD"),
    readOnly: bool("HUBSOFT_READ_ONLY", true),
    // Padrão do Hubsoft: /graphql/v1. Use "off" para desativar.
    graphqlPath: (() => {
      const v = (process.env.HUBSOFT_GRAPHQL_PATH ?? "").trim();
      if (v.toLowerCase() === "off") return "";
      return v || "/graphql/v1";
    })(),
    maxResponseChars: Number(process.env.HUBSOFT_MAX_RESPONSE_CHARS ?? 60000),
    exposeSecrets: bool("HUBSOFT_EXPOR_SENHAS", false),
  };
}
