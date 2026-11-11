import { z } from "zod";
import type { HubsoftConfig } from "./config.js";
import { normalizarNome } from "./config.js";
import { HubsoftClient } from "./client.js";
import { collectTools, type ToolDef } from "./registry.js";
import { fail, ok, run } from "./util.js";
import { VERSION } from "./version.js";

/** Estado das variáveis HUBSOFT_* recebidas (só nomes e estado, nunca valores). */
export function diagnosticoVariaveis() {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env).sort()) {
    if (!k.startsWith("HUBSOFT_")) continue;
    const t = (v ?? "").trim();
    out[k] = !t ? "vazia" : /^\$\{[^}]+\}$/.test(t) ? `não substituída (${t})` : "preenchida";
  }
  return out;
}

const TODOS = new Set(["", "todos", "todas", "all", "*"]);

/** Ferramentas que alteram dados: exigem exatamente um servidor (IDs não valem entre bases). */
function exigeUmServidor(t: ToolDef) {
  return t.config.annotations?.readOnlyHint === false && t.name !== "hubsoft_graphql";
}

function rotulo(s: HubsoftConfig) {
  return s.descricao ? `${s.nome} (${s.descricao})` : s.nome;
}

/** Texto que lista os servidores, usado nas descrições e nas instruções do MCP. */
export function descreverServidores(servers: HubsoftConfig[]) {
  return servers.map(rotulo).join("; ");
}

export function instrucoesServidores(servers: HubsoftConfig[]) {
  if (servers.length < 2) return "";
  return (
    ` Há ${servers.length} servidores (bases) Hubsoft configurados: ${descreverServidores(servers)}. ` +
    "Todas as ferramentas aceitam o parâmetro `servidor`. Sem ele (ou com \"todos\"), a consulta " +
    "roda em todas as bases em paralelo e o resultado vem agrupado por base. Quando o usuário citar " +
    "uma base pelo nome ou pela descrição (ex.: \"pessoa física\"), passe só o nome dessa base. " +
    "Ações que alteram dados exigem uma única base: use a base onde o cliente foi encontrado."
  );
}

/** Escolhe os servidores a partir do parâmetro `servidor` (nome, lista "a,b", descrição ou "todos"). */
export function resolverServidores(servers: HubsoftConfig[], pedido?: string): HubsoftConfig[] {
  const termos = (pedido ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!termos.length || termos.some((t) => TODOS.has(t.toLowerCase()))) return servers;
  const out: HubsoftConfig[] = [];
  for (const termo of termos) {
    const n = normalizarNome(termo);
    let achou = servers.filter((s) => s.nome === n);
    if (!achou.length) {
      // tenta pela descrição (ex.: "pessoa fisica" → base_pf)
      achou = servers.filter((s) => s.descricao && normalizarNome(s.descricao).includes(n));
    }
    if (achou.length !== 1) {
      throw new Error(
        `Servidor "${termo}" ${achou.length ? "é ambíguo" : "não encontrado"}. ` +
          `Disponíveis: ${descreverServidores(servers)}.`,
      );
    }
    if (!out.includes(achou[0])) out.push(achou[0]);
  }
  return out;
}

/** Soma campos numéricos de objetos (para consolidar totais de várias bases). */
function somarNumeros(alvo: Record<string, any>, origem: Record<string, any>) {
  for (const [k, v] of Object.entries(origem)) {
    if (typeof v === "number") alvo[k] = Math.round(((alvo[k] ?? 0) + v) * 100) / 100;
  }
  return alvo;
}

/** Resultados com `grupos` (por `periodo`) e `totais` — ex.: hubsoft_resumo_financeiro — ganham um consolidado. */
function consolidar(resultados: Record<string, any>) {
  const lista = Object.values(resultados);
  if (lista.length < 2 || !lista.every((r) => r && Array.isArray(r.grupos) && r.totais)) return undefined;
  const grupos = new Map<string, Record<string, any>>();
  const totais: Record<string, any> = {};
  for (const r of lista) {
    for (const g of r.grupos) {
      const { periodo, ...nums } = g;
      grupos.set(periodo, somarNumeros(grupos.get(periodo) ?? {}, nums));
    }
    somarNumeros(totais, r.totais);
  }
  return {
    grupos: [...grupos.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([periodo, n]) => ({ periodo, ...n })),
    totais,
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Monta as ferramentas para N servidores.
 * Com 1 servidor, as ferramentas são exatamente as da v0.3 (mais hubsoft_servidores).
 * Com 2+, cada ferramenta ganha o parâmetro `servidor` e agrega os resultados por base.
 */
export function collectMultiTools(servers: HubsoftConfig[]): ToolDef[] {
  const max = servers[0].maxResponseChars;
  const clientes = new Map(servers.map((s) => [s.nome, new HubsoftClient(s)]));

  const toolServidores: ToolDef = {
    name: "hubsoft_servidores",
    config: {
      title: "Servidores (bases) Hubsoft configurados",
      description:
        "Lista as bases Hubsoft configuradas (nome, descrição, endereço, GraphQL). " +
        "Com testar=true, verifica o login em cada uma. Use para saber em qual base procurar " +
        "ou para diagnosticar falhas de acesso.",
      inputSchema: {
        testar: z.boolean().optional().describe("Testa a autenticação em cada servidor."),
        diagnostico: z
          .boolean()
          .optional()
          .describe("Mostra a versão e quais variáveis HUBSOFT_* o servidor recebeu (só nomes e estado, sem valores)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    cb: async ({ testar, diagnostico }: { testar?: boolean; diagnostico?: boolean }) =>
      run(max, async () => {
        const lista = await Promise.all(
          servers.map(async (s) => {
            const info: Record<string, unknown> = {
              nome: s.nome,
              descricao: s.descricao,
              endereco: new URL(s.baseUrl).host,
              usuario: s.username,
              graphql: s.graphqlPath || "desativado",
            };
            if (testar) {
              try {
                const { res, body } = await clientes.get(s.nome)!.requestToken("json");
                info.login = res.ok && body?.access_token ? "ok" : `falhou (HTTP ${res.status}: ${body?.msg ?? body?.error ?? ""})`;
              } catch (e) {
                info.login = `falhou (${(e as Error).message})`;
              }
            }
            return info;
          }),
        );
        return diagnostico ? { versao: VERSION, servidores: lista, variaveis: diagnosticoVariaveis() } : lista;
      }),
  };

  if (servers.length === 1) {
    return [toolServidores, ...collectTools(clientes.get(servers[0].nome)!)];
  }

  // Ferramentas de cada servidor, com limite de tamanho só no resultado agregado.
  const porServidor = new Map(
    servers.map((s) => [
      s.nome,
      collectTools(new HubsoftClient({ ...s, maxResponseChars: Number.MAX_SAFE_INTEGER })),
    ]),
  );
  const nomes: string[] = [];
  for (const defs of porServidor.values()) for (const d of defs) if (!nomes.includes(d.name)) nomes.push(d.name);

  const lista = descreverServidores(servers);
  const combinadas = nomes.map((name): ToolDef => {
    const base = [...porServidor.values()].flat().find((d) => d.name === name)!;
    const umSo = exigeUmServidor(base);
    const servidorParam = z
      .string()
      .optional()
      .describe(
        umSo
          ? `Obrigatório: a base onde executar (${lista}).`
          : `Base(s) a consultar: nome, lista separada por vírgula ou "todos" (padrão). Bases: ${lista}.`,
      );
    return {
      name,
      config: {
        ...base.config,
        description:
          `${base.config.description ?? ""} ` +
          (umSo
            ? "Exige o parâmetro servidor (uma única base)."
            : "Sem o parâmetro servidor, consulta todas as bases e agrupa o resultado por base."),
        inputSchema: { servidor: servidorParam, ...(base.config.inputSchema ?? {}) },
      },
      cb: async (args: any) => {
        try {
          const { servidor, ...resto } = args ?? {};
          const alvos = resolverServidores(servers, servidor);
          if (umSo && alvos.length !== 1) {
            throw new Error(`Esta ação altera dados: informe uma única base no parâmetro servidor (${lista}).`);
          }

          const resultados = await Promise.all(
            alvos.map(async (s) => {
              const def = porServidor.get(s.nome)!.find((d) => d.name === name);
              if (!def) return { s, erro: "ferramenta indisponível nesta base (GraphQL desativado?)" };
              const r = await def.cb(resto);
              const text = r.content.map((c) => c.text).join("\n");
              return r.isError ? { s, erro: text } : { s, dado: parse(text) };
            }),
          );

          if (alvos.length === 1) {
            const [r] = resultados;
            if ("erro" in r) throw new Error(`[${r.s.nome}] ${r.erro}`);
            const d = r.dado;
            return ok(d && typeof d === "object" && !Array.isArray(d) ? { servidor: r.s.nome, ...d } : { servidor: r.s.nome, resultado: d }, max);
          }

          const saida: Record<string, any> = {
            servidores_consultados: alvos.map((s) => s.nome),
            resultados: {},
          };
          const naoEncontrado: string[] = [];
          const erros: Record<string, string> = {};
          for (const r of resultados) {
            if ("erro" in r) erros[r.s.nome] = r.erro!;
            else if ((r.dado as any)?.encontrado === false) naoEncontrado.push(r.s.nome);
            else saida.resultados[r.s.nome] = r.dado;
          }
          const consolidado = consolidar(saida.resultados);
          if (consolidado) saida.consolidado_todas_bases = consolidado;
          if (naoEncontrado.length) saida.nao_encontrado_em = naoEncontrado;
          if (Object.keys(erros).length) saida.erros = erros;
          if (!Object.keys(saida.resultados).length && !naoEncontrado.length) {
            throw new Error(`Falhou em todas as bases: ${JSON.stringify(erros)}`);
          }
          return ok(saida, max);
        } catch (e) {
          return fail(e);
        }
      },
    };
  });

  return [toolServidores, ...combinadas];
}
