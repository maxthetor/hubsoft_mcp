#!/usr/bin/env node
/**
 * Diagnóstico: valida credenciais, testa as rotas usadas pelo MCP e procura
 * o endpoint GraphQL. Não imprime dados de clientes, só status e estrutura.
 *
 * Uso:  npx hubsoft-mcp-probe            (usa as mesmas variáveis HUBSOFT_*)
 *       PROBE_CPF=12345678900 npx hubsoft-mcp-probe   (testa com um cliente real)
 */
import { loadConfig } from "./config.js";
import { HubsoftClient, HubsoftError } from "./client.js";
import { API } from "./util.js";

const cfg = loadConfig();
const hs = new HubsoftClient(cfg);
const cpf = process.env.PROBE_CPF?.replace(/\D/g, "");
const q = cpf
  ? { busca: "cpf_cnpj", termo_busca: cpf, limit: 1 }
  : { busca: "codigo_cliente", termo_busca: "1", limit: 1 };

function shape(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `(${v.length} itens)`] : [];
  if (v && typeof v === "object") {
    if (depth >= 2) return "{…}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return typeof v;
}

async function check(label: string, fn: () => Promise<any>) {
  try {
    const r = await fn();
    console.log(`✅ ${label}`);
    console.log("   estrutura:", JSON.stringify(shape(r)).slice(0, 600));
    return r;
  } catch (e) {
    const err = e as HubsoftError;
    console.log(`❌ ${label} → ${err.message}`);
    return undefined;
  }
}

async function main() {
  console.log(`Hubsoft: ${cfg.baseUrl} | usuário: ${cfg.username}\n`);

  console.log("== Autenticação ==");
  console.log(
    `   client_id=${cfg.clientId} | client_secret=${cfg.clientSecret.slice(0, 4)}…(${cfg.clientSecret.length} chars)` +
      ` | senha=(${cfg.password.length} chars)`,
  );
  let authOk = false;
  for (const fmt of ["json", "form"] as const) {
    try {
      const { res, body } = await hs.requestToken(fmt);
      const okTok = res.ok && !!body?.access_token;
      authOk ||= okTok;
      const safe = body && typeof body === "object"
        ? Object.fromEntries(
            Object.entries(body).map(([k, v]) =>
              /token/i.test(k) ? [k, "<oculto>"] : [k, v],
            ),
          )
        : body;
      console.log(`${okTok ? "✅" : "❌"} POST /oauth/token (${fmt}) → HTTP ${res.status}`);
      console.log("   resposta:", JSON.stringify(safe).slice(0, 800));
    } catch (e) {
      console.log(`❌ POST /oauth/token (${fmt}) → ${(e as Error).message}`);
    }
  }
  if (!authOk) {
    console.log(
      "\n➡️  Autenticação falhou. Leia o campo de erro acima:\n" +
        "   • invalid_client  → client_id/client_secret errados, ou o secret foi regenerado\n" +
        "   • invalid_grant / invalid_credentials → usuário/senha recusados (inclui usuário com 2FA,\n" +
        "     sem permissão de acesso à API ou não vinculado a este client_id)\n" +
        "   • menção a 2FA/token/código → confirma que o 2FA bloqueia o login pela API\n",
    );
    return;
  }

  console.log("\n== Rotas REST ==");
  await check(`GET ${API}/cliente`, () => hs.get(`${API}/cliente`, q));
  await check(`GET ${API}/cliente/financeiro`, () => hs.get(`${API}/cliente/financeiro`, q));
  await check(`GET ${API}/cliente/atendimento`, () => hs.get(`${API}/cliente/atendimento`, q));
  await check(`GET ${API}/cliente/ordem_servico`, () => hs.get(`${API}/cliente/ordem_servico`, q));
  await check(`GET ${API}/configuracao/tipo_atendimento`, () =>
    hs.get(`${API}/configuracao/tipo_atendimento`),
  );

  console.log("\n== GraphQL ==");
  const candidates = [
    process.env.HUBSOFT_GRAPHQL_PATH,
    "/graphql",
    "/api/graphql",
    "/api/v1/graphql",
    "/api/v1/integracao/graphql",
    "/graphql/v1",
  ].filter((p, i, a): p is string => !!p && a.indexOf(p) === i);

  let found: string | undefined;
  for (const p of candidates) {
    const r = await check(`POST ${p}  { __typename }`, () => hs.post(p, { query: "{ __typename }" }));
    if (r && (r.data || r.errors)) {
      found = p;
      break;
    }
  }
  if (found) {
    console.log(`\n➡️  GraphQL encontrado em ${found}. Configure HUBSOFT_GRAPHQL_PATH=${found}`);
    await check("Introspecção (lista de queries)", async () => {
      const r = await hs.post(found!, { query: "{ __schema { queryType { fields { name } } } }" });
      const names = r?.data?.__schema?.queryType?.fields?.map((f: any) => f.name) ?? [];
      console.log(`   ${names.length} queries: ${names.slice(0, 60).join(", ")}`);
      return { total: names.length };
    });
  } else {
    console.log(
      "\n➡️  Nenhum endpoint GraphQL respondeu. Verifique se a opção " +
        '"Permite acesso à API GraphQL" está ativa para este usuário/cliente da API ' +
        "e pergunte ao suporte do Hubsoft qual é o caminho do endpoint.",
    );
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
