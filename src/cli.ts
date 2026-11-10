/**
 * CLI do hubsoft-mcp: as mesmas ferramentas do servidor MCP, pela linha de comando.
 * Pensada para agentes que usam a skill sem suporte a MCP, e para scripts.
 *
 *   hubsoft ferramentas
 *   hubsoft situacao_cliente --cpf_cnpj 12345678900
 *   hubsoft servicos_por_status --status suspenso_debito --incluir_faturas_vencidas
 *   hubsoft graphql --query '{ pops(first: 5) { data { id_pop } } }'
 *   hubsoft faturas_cliente --json '{"busca":"codigo_cliente","termo_busca":"624"}'
 *
 * Credenciais: variáveis HUBSOFT_* no ambiente, num .env da pasta atual,
 * em ~/.config/hubsoft/.env ou no arquivo indicado por --env-file.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadServers, loadEnvFiles } from "./config.js";
import { HubsoftClient } from "./client.js";
import { collectTools, type ToolDef } from "./registry.js";
import { collectMultiTools } from "./multi.js";
import { setExposeSecrets } from "./util.js";
import { VERSION } from "./version.js";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

/** Tipo base de um campo zod (desembrulha optional/default/nullable). */
function baseType(s: any): string {
  let t = s;
  for (let i = 0; i < 5 && t?._zod?.def; i++) {
    const k = t._zod.def.type;
    if (k === "optional" || k === "default" || k === "nullable") t = t._zod.def.innerType;
    else return k;
  }
  return "string";
}

function isOptional(s: any): boolean {
  return s?._zod?.def?.type === "optional" || s?._zod?.def?.type === "default";
}

function coerce(raw: string | true, type: string, flag: string): unknown {
  if (type === "boolean") {
    if (raw === true) return true;
    if (/^(true|sim|1|yes)$/i.test(raw)) return true;
    if (/^(false|nao|não|0|no)$/i.test(raw)) return false;
    throw new Error(`--${flag} espera true/false`);
  }
  if (raw === true) throw new Error(`--${flag} precisa de um valor`);
  if (type === "number") {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`--${flag} espera um número`);
    return n;
  }
  if (type === "array") {
    if (raw.trim().startsWith("[")) return JSON.parse(raw);
    return raw.split(",").map((x) => x.trim()).filter(Boolean);
  }
  if (type === "record" || type === "object") return JSON.parse(raw);
  return raw;
}

function parseArgs(argv: string[], shape: Record<string, any>) {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Argumento inesperado: ${a}`);
    let [flag, val] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    flag = flag.replace(/-/g, "_");
    if (flag === "json") {
      Object.assign(args, JSON.parse(val ?? argv[++i]));
      continue;
    }
    const field = shape[flag];
    if (!field) throw new Error(`Parâmetro desconhecido: --${flag}`);
    const type = baseType(field);
    let raw: string | true;
    if (val !== undefined) raw = val;
    else if (type === "boolean" && (i + 1 >= argv.length || argv[i + 1].startsWith("--"))) raw = true;
    else raw = argv[++i] ?? true;
    const v = coerce(raw, type, flag);
    if (type === "array" && Array.isArray(args[flag])) (args[flag] as unknown[]).push(...(v as unknown[]));
    else args[flag] = v;
  }
  return args;
}

function shortName(t: ToolDef) {
  return t.name.replace(/^hubsoft_/, "");
}

function helpGeral(tools: ToolDef[]) {
  out(`hubsoft ${VERSION} — CLI do hubsoft-mcp (ERP Hubsoft)\n`);
  out("Uso: hubsoft <ferramenta> [--parametro valor ...] [--json '{...}']");
  out("     hubsoft <ferramenta> --help\n");
  out("Ferramentas:");
  const w = Math.max(...tools.map((t) => shortName(t).length));
  for (const t of tools) out(`  ${shortName(t).padEnd(w)}  ${t.config.title ?? ""}`);
  out("\nOpções globais: --env-file <arquivo>  --version");
  out("Credenciais: HUBSOFT_URL, HUBSOFT_CLIENT_ID, HUBSOFT_CLIENT_SECRET, HUBSOFT_USERNAME,");
  out("HUBSOFT_PASSWORD (ambiente, ./.env ou ~/.config/hubsoft/.env).");
  out("Várias bases: HUBSOFT_NOME/HUBSOFT_DESCRICAO + HUBSOFT_2_URL, HUBSOFT_2_NOME… ou");
  out("~/.config/hubsoft/servidores.json. Escolha a base com --servidor <nome> (padrão: todas).");
}

function helpFerramenta(t: ToolDef) {
  out(`hubsoft ${shortName(t)} — ${t.config.title ?? ""}\n`);
  out(`${t.config.description ?? ""}\n`);
  const shape = t.config.inputSchema ?? {};
  const keys = Object.keys(shape);
  if (!keys.length) return out("Sem parâmetros.");
  out("Parâmetros:");
  for (const k of keys) {
    const f = shape[k];
    out(
      `  --${k} <${baseType(f)}>${isOptional(f) ? "" : " (obrigatório)"}` +
        `${f?.description ? `\n      ${f.description}` : ""}`,
    );
  }
}

// Lista de ferramentas sem precisar de credenciais válidas (para --help).
function toolsSemCredenciais(): ToolDef[] {
  try {
    return collectMultiTools(loadServers());
  } catch {
    /* sem configuração: mostra as ferramentas de um servidor genérico */
  }
  const fake = new HubsoftClient({
    nome: "principal",
    baseUrl: "http://localhost",
    clientId: "",
    clientSecret: "",
    username: "",
    password: "",
    readOnly: process.env.HUBSOFT_READ_ONLY?.toLowerCase() !== "false",
    graphqlPath: process.env.HUBSOFT_GRAPHQL_PATH === "off" ? "" : "/graphql/v1",
    maxResponseChars: 0,
    exposeSecrets: false,
  });
  return collectTools(fake);
}

async function main() {
  let argv = process.argv.slice(2);

  const envIdx = argv.indexOf("--env-file");
  if (envIdx >= 0) {
    const file = argv[envIdx + 1];
    argv = argv.filter((_, i) => i !== envIdx && i !== envIdx + 1);
    if (!loadEnvFiles([file]).length) throw new Error(`Não foi possível ler ${file}`);
  } else {
    loadEnvFiles([join(process.cwd(), ".env"), join(homedir(), ".config", "hubsoft", ".env")]);
  }

  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v") return out(VERSION);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help" || cmd === "ferramentas") {
    return helpGeral(toolsSemCredenciais());
  }

  const want = cmd.replace(/-/g, "_").replace(/^hubsoft_/, "");
  const find = (list: ToolDef[]) => list.find((t) => shortName(t) === want);

  if (rest.includes("--help") || rest.includes("-h")) {
    const t = find(toolsSemCredenciais());
    if (!t) throw new Error(`Ferramenta desconhecida: ${cmd}. Veja: hubsoft ferramentas`);
    return helpFerramenta(t);
  }

  const servers = loadServers();
  setExposeSecrets(servers[0].exposeSecrets);
  const tools = collectMultiTools(servers);
  const t = find(tools);
  if (!t) {
    const off = find(toolsSemCredenciais()) ? "" : " Veja: hubsoft ferramentas";
    throw new Error(
      `Ferramenta indisponível: ${cmd}.` +
        (off || " (ferramentas de escrita exigem HUBSOFT_READ_ONLY=false)"),
    );
  }

  const shape = t.config.inputSchema ?? {};
  const args = z.object(shape).parse(parseArgs(rest, shape));
  const r = await t.cb(args);
  const text = r.content.map((c) => c.text).join("\n");
  if (r.isError) {
    err(text);
    process.exitCode = 1;
  } else out(text);
}

main().catch((e) => {
  const msg =
    e instanceof z.ZodError
      ? e.issues.map((i) => `--${i.path.join(".")}: ${i.message}`).join("\n")
      : (e?.message ?? String(e));
  err(`hubsoft: ${msg}`);
  process.exitCode = 1;
});
