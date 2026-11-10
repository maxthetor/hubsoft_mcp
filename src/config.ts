import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Configuração de UM servidor Hubsoft.
 *
 * Cada usuário configura o MCP com o PRÓPRIO login do Hubsoft. URL, client_id e
 * client_secret são do provedor. Um provedor pode ter várias bases (servidores),
 * cada uma com nome e descrição; a descrição ajuda o agente a escolher a base
 * certa ("pessoa física" → base_pf).
 */
export interface HubsoftConfig {
  /** Apelido do servidor (ex.: base_pf). Usado no parâmetro `servidor`. */
  nome: string;
  /** Descrição livre (ex.: "Clientes pessoa física"). */
  descricao?: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  /** Quando true (padrão), ferramentas de escrita não são registradas. */
  readOnly: boolean;
  /** Caminho do endpoint GraphQL (ex.: /graphql/v1). Vazio = desativado. */
  graphqlPath: string;
  /** Tamanho máximo (caracteres) da resposta devolvida ao modelo. */
  maxResponseChars: number;
  /** Mostrar senhas (PPPoE etc.) nas respostas. Padrão: false. */
  exposeSecrets: boolean;
}

/** Quantidade de servidores configuráveis por variáveis numeradas (HUBSOFT_2_*, …). */
export const MAX_SLOTS = 9;

/** Arquivo padrão com a lista de servidores (opcional). */
export const ARQUIVO_PADRAO = join(homedir(), ".config", "hubsoft", "servidores.json");

/** Lê uma variável; ignora placeholders não substituídos como "${user_config.x}". */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  if (!v || /^\$\{[^}]+\}$/.test(v)) return undefined;
  return v;
}

function bool(name: string, def: boolean): boolean {
  const v = env(name)?.toLowerCase();
  if (v === undefined) return def;
  return ["1", "true", "sim", "yes", "on"].includes(v);
}

function graphqlPath(v: string | undefined): string {
  const s = (v ?? "").trim();
  if (s.toLowerCase() === "off") return "";
  return s || "/graphql/v1";
}

/** Normaliza o apelido: minúsculas, sem acentos, só [a-z0-9_-]. */
export function normalizarNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Substitui "{env:VAR}" pelo valor da variável de ambiente (para não gravar segredos no JSON). */
function expandEnv(v: unknown): string | undefined {
  if (typeof v !== "string") return v === undefined || v === null ? undefined : String(v);
  return v.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? "").trim() || undefined;
}

interface Bruto {
  origem: string;
  nome?: string;
  descricao?: string;
  url?: string;
  client_id?: string;
  client_secret?: string;
  usuario?: string;
  senha?: string;
  graphql_path?: string;
}

function globais() {
  return {
    readOnly: bool("HUBSOFT_READ_ONLY", true),
    maxResponseChars: Number(env("HUBSOFT_MAX_RESPONSE_CHARS") ?? 60000),
    exposeSecrets: bool("HUBSOFT_EXPOR_SENHAS", false),
  };
}

function lerArquivo(caminho: string): Bruto[] {
  let json: any;
  try {
    json = JSON.parse(readFileSync(caminho, "utf8"));
  } catch (e) {
    throw new Error(`Não foi possível ler ${caminho}: ${(e as Error).message}`);
  }
  const lista = Array.isArray(json) ? json : json?.servidores;
  if (!Array.isArray(lista)) {
    throw new Error(`${caminho}: esperado {"servidores": [ ... ]}`);
  }
  return lista.map((s: any, i: number) => ({
    origem: `${caminho} (item ${i + 1})`,
    nome: expandEnv(s.nome),
    descricao: expandEnv(s.descricao),
    url: expandEnv(s.url),
    client_id: expandEnv(s.client_id),
    client_secret: expandEnv(s.client_secret),
    usuario: expandEnv(s.usuario ?? s.username),
    senha: expandEnv(s.senha ?? s.password),
    graphql_path: expandEnv(s.graphql_path),
  }));
}

function lerSlot(prefixo: string, origem: string): Bruto | undefined {
  const url = env(`${prefixo}URL`);
  if (!url) return undefined;
  return {
    origem,
    nome: env(`${prefixo}NOME`),
    descricao: env(`${prefixo}DESCRICAO`),
    url,
    client_id: env(`${prefixo}CLIENT_ID`),
    client_secret: env(`${prefixo}CLIENT_SECRET`),
    usuario: env(`${prefixo}USERNAME`),
    senha: env(`${prefixo}PASSWORD`),
    graphql_path: env(`${prefixo}GRAPHQL_PATH`),
  };
}

/**
 * Carrega todos os servidores configurados, nesta ordem:
 *  1. variáveis sem número (HUBSOFT_URL, HUBSOFT_NOME…) — servidor 1, compatível com a v0.3;
 *  2. variáveis numeradas HUBSOFT_2_URL … HUBSOFT_9_URL (e HUBSOFT_1_* como alternativa ao 1);
 *  3. arquivo JSON em HUBSOFT_CONFIG ou ~/.config/hubsoft/servidores.json.
 */
export function loadServers(): HubsoftConfig[] {
  const brutos: Bruto[] = [];
  const s0 = lerSlot("HUBSOFT_", "variáveis HUBSOFT_*");
  if (s0) brutos.push(s0);
  for (let i = 1; i <= MAX_SLOTS; i++) {
    const s = lerSlot(`HUBSOFT_${i}_`, `variáveis HUBSOFT_${i}_*`);
    if (s) brutos.push(s);
  }
  const arquivo = env("HUBSOFT_CONFIG") ?? (existsSync(ARQUIVO_PADRAO) ? ARQUIVO_PADRAO : undefined);
  if (arquivo) brutos.push(...lerArquivo(arquivo));

  if (!brutos.length) {
    throw new Error(
      "Nenhum servidor Hubsoft configurado. Defina HUBSOFT_URL, HUBSOFT_CLIENT_ID, " +
        "HUBSOFT_CLIENT_SECRET, HUBSOFT_USERNAME e HUBSOFT_PASSWORD, ou crie " +
        `${ARQUIVO_PADRAO}. Veja o README.`,
    );
  }

  const g = globais();
  const vistos = new Set<string>();
  return brutos.map((b, i) => {
    const faltando = (
      [
        ["url", b.url],
        ["client_id", b.client_id],
        ["client_secret", b.client_secret],
        ["usuário", b.usuario],
        ["senha", b.senha],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (faltando.length) {
      throw new Error(`Servidor em ${b.origem}: faltando ${faltando.join(", ")}.`);
    }
    let nome = normalizarNome(b.nome ?? "") || (i === 0 ? "principal" : `servidor_${i + 1}`);
    if (["todos", "all"].includes(nome)) throw new Error(`Nome de servidor reservado: "${nome}".`);
    if (vistos.has(nome)) throw new Error(`Nome de servidor repetido: "${nome}" (${b.origem}).`);
    vistos.add(nome);
    return {
      nome,
      descricao: b.descricao,
      baseUrl: b.url!.replace(/\/+$/, ""),
      clientId: b.client_id!,
      clientSecret: b.client_secret!,
      username: b.usuario!,
      password: b.senha!,
      graphqlPath: graphqlPath(b.graphql_path ?? env("HUBSOFT_GRAPHQL_PATH")),
      ...g,
    };
  });
}

/**
 * Configuração de um único servidor (diagnóstico, export de esquema).
 * Usa HUBSOFT_SERVIDOR para escolher; senão, o primeiro.
 */
export function loadConfig(): HubsoftConfig {
  const lista = loadServers();
  const alvo = env("HUBSOFT_SERVIDOR");
  if (!alvo) return lista[0];
  const s = lista.find((x) => x.nome === normalizarNome(alvo));
  if (!s) throw new Error(`Servidor "${alvo}" não encontrado. Disponíveis: ${lista.map((x) => x.nome).join(", ")}`);
  return s;
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
