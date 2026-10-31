import { readFileSync } from "node:fs";

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

/** Lê uma variável; ignora placeholders não substituídos como "${user_config.x}". */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  if (!v || /^\$\{[^}]+\}$/.test(v)) return undefined;
  return v;
}

function required(name: string): string {
  const v = env(name);
  if (!v) {
    throw new Error(
      `Variável de ambiente obrigatória ausente: ${name}. ` +
        `Veja o README para configurar o hubsoft-mcp.`,
    );
  }
  return v;
}

function bool(name: string, def: boolean): boolean {
  const v = env(name)?.toLowerCase();
  if (v === undefined) return def;
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
      const v = env("HUBSOFT_GRAPHQL_PATH") ?? "";
      if (v.toLowerCase() === "off") return "";
      return v || "/graphql/v1";
    })(),
    maxResponseChars: Number(env("HUBSOFT_MAX_RESPONSE_CHARS") ?? 60000),
    exposeSecrets: bool("HUBSOFT_EXPOR_SENHAS", false),
  };
}

/**
 * Carrega variáveis HUBSOFT_* de arquivos .env (sem sobrescrever o ambiente).
 * Ordem: ./.env, depois ~/.config/hubsoft/.env. Usado pela CLI.
 */
export function loadEnvFiles(files: string[]): string[] {
  const loaded: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    loaded.push(f);
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?(HUBSOFT_[A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
  return loaded;
}
