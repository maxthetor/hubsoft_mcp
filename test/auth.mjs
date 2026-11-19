// Testes do login com 2FA (one_time_password) e da persistência de tokens contra um Hubsoft simulado.
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { totp, normalizarSemente } from "../dist/tokens.js";

// 1) TOTP: vetor da RFC 6238 (semente ASCII "12345678901234567890", t=59 s)
const RFC = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
assert.equal(totp(RFC, 59_000, 8), "94287082");
assert.equal(totp(RFC, 1_111_111_109_000, 8), "07081804");
assert.equal(totp(RFC, 59_000), "287082");
assert.equal(normalizarSemente("otpauth://totp/Hubsoft:marcelo?secret=gezd gnbv-gy3t&issuer=Hubsoft"), "GEZDGNBVGY3T");
assert.throws(() => normalizarSemente("senha!"), /inválida/);

// Hubsoft simulado: usuário com 2FA, refresh_token de uso único
const SEMENTE = "JBSWY3DPEHPK3PXP";
let n = 0, grants = [], validos = new Set(), refreshs = new Set();
const srv = http.createServer((q, r) => { let b = ""; q.on("data", d => b += d); q.on("end", () => {
  const send = (o, s = 200) => { r.writeHead(s, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
  if (q.url === "/oauth/token") {
    const f = b.trim().startsWith("{") ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b));
    const negar = () => send({ status: "error", msg: "Os dados de autenticação enviados não são válidos" }, 401);
    const emitir = () => { n++; validos.add("A" + n); refreshs.add("R" + n); send({ token_type: "Bearer", access_token: "A" + n, refresh_token: "R" + n, expires_in: 2592000 }); };
    grants.push(f.grant_type + (f.one_time_password ? "+otp" : ""));
    if (f.client_secret !== "s") return negar();
    if (f.grant_type === "refresh_token") {
      if (!refreshs.delete(f.refresh_token)) return send({ error: "invalid_grant", message: "The refresh token is invalid." }, 401);
      return emitir();
    }
    if (f.username !== "marcelo" || f.password !== "p") return negar();
    const agora = Date.now();
    const aceitos = [agora - 30000, agora, agora + 30000].map(t => totp(SEMENTE, t));
    if (!f.one_time_password || !aceitos.includes(f.one_time_password)) return negar();
    return emitir();
  }
  const tok = (q.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!validos.has(tok)) return send({ message: "Unauthenticated." }, 401);
  send({ status: "success", servico_status: [{ prefixo: "servico_habilitado" }] });
}); }).listen(0);
await new Promise(r => srv.once("listening", r));
const URL_ = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(join(tmpdir(), "hs-auth-"));
const TOK = join(dir, "tokens.json");
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUBSOFT_")));
const cred = { HUBSOFT_NOME: "base_pf", HUBSOFT_URL: URL_, HUBSOFT_CLIENT_ID: "145", HUBSOFT_CLIENT_SECRET: "s", HUBSOFT_USERNAME: "marcelo", HUBSOFT_PASSWORD: "p" };

async function conectar(env) {
  const t = new StdioClientTransport({ command: "node", args: ["server/hubsoft-mcp.mjs"], stderr: "pipe", env: { ...baseEnv, HUBSOFT_TOKENS: TOK, ...cred, ...env } });
  const c = new Client({ name: "auth", version: "0" }); await c.connect(t); return c;
}
const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content[0].text; let json = null; try { json = JSON.parse(text); } catch {}
  return { err: !!r.isError, text, json };
};
const consulta = (c) => call(c, "hubsoft_consulta", { rota: "configuracao/servico_status" });

// 2) Usuário com 2FA, sem semente: falha com a dica de usar hubsoft_conectar
let c = await conectar({});
let r = await consulta(c);
assert.equal(r.err, true); assert.match(r.text, /hubsoft_conectar/); assert.match(r.text, /HTTP 401/);
r = await call(c, "hubsoft_servidores", {});
assert.equal(r.json[0].autenticacao.token_valido, false);
assert.equal(r.json[0].autenticacao.codigo_2fa_automatico, false);

// 3) hubsoft_conectar: exige uma base; código errado recusado; código certo salva token e refresh
r = await call(c, "hubsoft_conectar", { servidor: "todos", codigo_2fa: "123456" });
assert.equal(r.err, true); assert.match(r.text, /UMA base/);
r = await call(c, "hubsoft_conectar", { servidor: "base_pf", codigo_2fa: "12ab" });
assert.equal(r.err, true);
r = await call(c, "hubsoft_conectar", { servidor: "base_pf", codigo_2fa: totp(SEMENTE, Date.now() + 300000) });
assert.equal(r.err, true); assert.match(r.text, /2FA recusado/);
r = await call(c, "hubsoft_conectar", { servidor: "base_pf", codigo_2fa: totp(SEMENTE) });
assert.equal(r.err, false, r.text);
assert.equal(r.json.ok, true); assert.equal(r.json.refresh_token_salvo, true); assert.equal(r.json.token_valido, true);
assert.ok(!/A\d|R\d/.test(JSON.stringify(r.json).replace(/arquivo_tokens.*?,/, "")), "não expõe tokens");
r = await consulta(c);
assert.equal(r.err, false, r.text);
await c.close();

const salvo = JSON.parse(readFileSync(TOK, "utf8"));
const chave = Object.keys(salvo)[0];
assert.match(chave, /\|145\|marcelo$/);
assert.ok(salvo[chave].refresh_token && salvo[chave].access_token);
if (process.platform !== "win32") assert.equal(statSync(TOK).mode & 0o777, 0o600);

// 4) Novo processo: reaproveita o token salvo, sem pedir código e sem chamar /oauth/token
let antes = grants.length;
c = await conectar({});
r = await consulta(c);
assert.equal(r.err, false, r.text);
assert.equal(grants.length, antes, "token salvo reaproveitado");

// 5) Token revogado no servidor: usa o refresh (uma vez), grava o novo; o refresh antigo não vale mais
const refreshAntigo = salvo[chave].refresh_token;
validos.clear();
r = await consulta(c);
assert.equal(r.err, false, r.text);
assert.deepEqual(grants.slice(antes), ["refresh_token"]);
const salvo2 = JSON.parse(readFileSync(TOK, "utf8"))[chave];
assert.notEqual(salvo2.refresh_token, refreshAntigo);
assert.ok(!refreshs.has(refreshAntigo));
r = await call(c, "hubsoft_servidores", { testar: true });
assert.equal(r.json[0].login, "ok"); assert.equal(r.json[0].autenticacao.refresh_token_salvo, true);
assert.ok(!r.text.includes(salvo2.access_token) && !r.text.includes(salvo2.refresh_token));

// 6) Refresh inválido + token revogado: tenta a senha, falha com a dica de 2FA e descarta o refresh
validos.clear(); refreshs.clear(); antes = grants.length;
r = await consulta(c);
assert.equal(r.err, true); assert.match(r.text, /hubsoft_conectar/);
assert.deepEqual(grants.slice(antes), ["refresh_token", "password"]);
assert.equal(JSON.parse(readFileSync(TOK, "utf8"))[chave], undefined);
await c.close();

// 7) Com a semente: código gerado sozinho, sem interação
antes = grants.length;
c = await conectar({ HUBSOFT_OTP_SECRET: `otpauth://totp/Hubsoft:marcelo?secret=${SEMENTE}&issuer=Hubsoft` });
r = await consulta(c);
assert.equal(r.err, false, r.text);
assert.deepEqual(grants.slice(antes), ["password+otp"]);
r = await call(c, "hubsoft_servidores", {});
assert.equal(r.json[0].autenticacao.codigo_2fa_automatico, true);
await c.close();

// 8) Semente errada: mensagem aponta HUBSOFT_OTP_SECRET
c = await conectar({ HUBSOFT_OTP_SECRET: "GEZDGNBVGY3TQOJQ", HUBSOFT_TOKENS: "off" });
r = await consulta(c);
assert.equal(r.err, true); assert.match(r.text, /HUBSOFT_OTP_SECRET/);
await c.close();

// 9) HUBSOFT_TOKENS=off: nada gravado em disco, mas conectar funciona no processo
const TOK2 = join(dir, "nao-criar.json");
c = await conectar({ HUBSOFT_TOKENS: "off" });
r = await call(c, "hubsoft_conectar", { servidor: "base_pf", codigo_2fa: totp(SEMENTE) });
assert.equal(r.json.arquivo_tokens, "desativado (só memória)");
r = await consulta(c);
assert.equal(r.err, false, r.text);
assert.ok(!existsSync(TOK2));
await c.close();

srv.close();
console.log(`✅ auth ok — ${grants.length} chamadas a /oauth/token`);
