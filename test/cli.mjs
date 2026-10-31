// Teste da CLI (bundle da skill) contra um Hubsoft simulado: node test/cli.mjs
import http from "node:http";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const srv = http.createServer((q, r) => { let b = ""; q.on("data", d => b += d); q.on("end", () => {
  const send = (o, s = 200) => { r.writeHead(s, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
  if (q.url === "/oauth/token") return send({ token_type: "Bearer", access_token: "t", expires_in: 2592000 });
  if (q.url.startsWith("/api/v1/integracao/configuracao/servico_status")) return send({ status: "success", servico_status: [{ prefixo: "suspenso_debito" }] });
  if (q.url === "/graphql/v1") return send({ data: { echo: JSON.parse(b).query } });
  send({ status: "error", msg: "rota não existe" }, 404);
}); }).listen(0);
await new Promise(r => srv.once("listening", r));

const dir = mkdtempSync(join(tmpdir(), "hs-"));
const envFile = join(dir, "hubsoft.env");
writeFileSync(envFile, `HUBSOFT_URL=http://127.0.0.1:${srv.address().port}\nHUBSOFT_CLIENT_ID=1\nHUBSOFT_CLIENT_SECRET="s"\nHUBSOFT_USERNAME=u\nHUBSOFT_PASSWORD='p'\n`);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUBSOFT_")));
const cli = (...a) => new Promise(res => execFile("node", ["skills/hubsoft/scripts/hubsoft.mjs", ...a], { env, cwd: dir.startsWith("/") ? process.cwd() : undefined }, (e, out, err) => res({ code: e?.code ?? 0, out, err })));

let r = await cli("ferramentas");
assert.equal(r.code, 0); assert.match(r.out, /servicos_por_status/); assert.doesNotMatch(r.out, /desbloqueio/);

r = await cli("situacao_cliente", "--help");
assert.match(r.out, /--cpf_cnpj <string>/);

r = await cli("consulta", "--rota", "configuracao/servico_status", "--env-file", envFile);
assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).servico_status[0].prefixo, "suspenso_debito");

r = await cli("graphql", "--env-file", envFile, "--query", "{ pops(first: 1) { data { id_pop } } }");
assert.equal(JSON.parse(r.out).data.echo, "{ pops(first: 1) { data { id_pop } } }");

r = await cli("graphql", "--env-file", envFile, "--query=mutation { x }");
assert.equal(r.code, 1); assert.match(r.err, /bloqueadas/);

r = await cli("consulta", "--env-file", envFile, "--rota", "nao/existe");
assert.equal(r.code, 1); assert.match(r.err, /HTTP 404/);

r = await cli("situacao_cliente", "--env-file", envFile, "--codigo_cliente", "abc");
assert.equal(r.code, 1); assert.match(r.err, /número/);

r = await cli("consulta");
assert.equal(r.code, 1); assert.match(r.err, /HUBSOFT_URL/);

srv.close();
console.log("✅ cli ok");
