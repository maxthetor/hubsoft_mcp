// Gera arquivos únicos, sem dependências externas (só precisam de Node.js 18+):
//   server/hubsoft-mcp.mjs          → servidor MCP (plugin do Claude, .mcpb, outros harnesses)
//   skills/hubsoft/scripts/hubsoft.mjs → CLI usada pela skill
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const banner = {
  js:
    `#!/usr/bin/env node\n// hubsoft-mcp ${version} — https://github.com/maxthetor/hubsoft_mcp (MIT)\n` +
    `// Arquivo gerado por scripts/bundle.mjs a partir de src/. Não edite.\n` +
    `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);`,
};
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  banner,
  logLevel: "warning",
};
await build({ ...common, entryPoints: ["src/index.ts"], outfile: "server/hubsoft-mcp.mjs" });
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "skills/hubsoft/scripts/hubsoft.mjs" });
console.log("bundles gerados");
