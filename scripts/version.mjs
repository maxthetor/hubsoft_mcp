// Gera src/version.ts a partir do package.json (executado antes do build).
import { readFileSync, writeFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
writeFileSync(new URL("../src/version.ts", import.meta.url), `// Gerado por scripts/version.mjs — não edite.\nexport const VERSION = "${version}";\n`);
