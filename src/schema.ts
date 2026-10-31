#!/usr/bin/env node
/**
 * Exporta o esquema GraphQL do Hubsoft (só estrutura, sem dados de clientes)
 * para hubsoft-schema.json no diretório atual.
 *
 * Uso: npm run schema   (com as variáveis HUBSOFT_* definidas)
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { HubsoftClient } from "./client.js";

const TYPE_REF = `kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }`;
const INTROSPECTION = `query {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: true) {
        name description isDeprecated
        args { name description defaultValue type { ${TYPE_REF} } }
        type { ${TYPE_REF} }
      }
      inputFields { name description defaultValue type { ${TYPE_REF} } }
      enumValues(includeDeprecated: true) { name description }
      interfaces { kind name }
      possibleTypes { kind name }
    }
    directives { name locations args { name type { ${TYPE_REF} } } }
  }
}`;

const cfg = loadConfig();
if (!cfg.graphqlPath) {
  console.error("GraphQL desativado (HUBSOFT_GRAPHQL_PATH=off).");
  process.exit(1);
}
const hs = new HubsoftClient(cfg);

hs.post(cfg.graphqlPath, { query: INTROSPECTION })
  .then((r) => {
    const types = r?.data?.__schema?.types;
    if (!types) throw new Error(`Resposta inesperada: ${JSON.stringify(r).slice(0, 500)}`);
    const own = types.filter((t: any) => !t.name.startsWith("__"));
    writeFileSync("hubsoft-schema.json", JSON.stringify(r.data, null, 2));
    console.log(
      `✅ hubsoft-schema.json gerado: ${own.length} tipos, mutations: ` +
        `${r.data.__schema.mutationType ? "sim" : "não"}`,
    );
  })
  .catch((e) => {
    console.error(`❌ ${e?.message ?? e}`);
    process.exit(1);
  });
