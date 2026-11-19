import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

/**
 * Página local (127.0.0.1) para digitar o código 2FA no navegador.
 *
 * Não bloqueia: o pedido fica pendente na página e o login é concluído (e salvo) quando o
 * usuário envia o código, mesmo que a ferramenta que disparou já tenha respondido.
 * Segurança: só escuta em 127.0.0.1, exige um token aleatório de 128 bits no caminho e
 * confere o cabeçalho Host (proteção contra DNS rebinding).
 */

export interface Pendente {
  chave: string;
  base: string;
  host: string;
  usuario: string;
  /** Tenta o login com o código; devolve undefined se deu certo, ou a mensagem de erro. */
  tentar: (codigo: string) => Promise<string | undefined>;
  /** Chamado quando o usuário cancela. */
  cancelar: () => void;
}

interface Entrada extends Pendente {
  estado: "pendente" | "conectado" | "cancelado";
  erro?: string;
  concluido: Promise<boolean>;
  resolver: (ok: boolean) => void;
}

const TOKEN = randomBytes(16).toString("hex");
const pendentes = new Map<string, Entrada>();
let servidor: http.Server | undefined;
let porta = 0;
let abertoEm = 0;

function url() {
  return `http://127.0.0.1:${porta}/2fa/${TOKEN}`;
}

export function urlPagina(): string | undefined {
  return servidor && [...pendentes.values()].some((e) => e.estado === "pendente") ? url() : undefined;
}

function abrirNavegador(u: string) {
  const v = (process.env.HUBSOFT_2FA_ABRIR ?? "").trim().toLowerCase();
  if (["off", "false", "nao", "não", "0"].includes(v)) return;
  // não reabre a cada consulta: no máximo uma vez a cada 60 s
  if (Date.now() - abertoEm < 60_000) return;
  abertoEm = Date.now();
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", u]]
      : process.platform === "darwin"
        ? ["open", [u]]
        : ["xdg-open", [u]];
  try {
    const p = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    p.on("error", () => undefined);
    p.unref();
  } catch {
    /* o link também vai na resposta da ferramenta */
  }
}

function estado() {
  return [...pendentes.values()].map((e) => ({
    chave: e.chave,
    base: e.base,
    host: e.host,
    usuario: e.usuario,
    estado: e.estado,
    erro: e.erro,
  }));
}

function ler(req: http.IncomingMessage): Promise<any> {
  return new Promise((res) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
      if (b.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        res(JSON.parse(b));
      } catch {
        res({});
      }
    });
  });
}

async function tratar(req: http.IncomingMessage, res: http.ServerResponse) {
  const json = (o: unknown, s = 200) => {
    res.writeHead(s, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(o));
  };
  if (req.headers.host !== `127.0.0.1:${porta}` && req.headers.host !== `localhost:${porta}`) return json({ erro: "host" }, 403);
  const caminho = (req.url ?? "").split("?")[0];
  const base = `/2fa/${TOKEN}`;
  if (caminho === base && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      "Referrer-Policy": "no-referrer",
    });
    return res.end(HTML);
  }
  if (caminho === `${base}/estado` && req.method === "GET") return json(estado());
  if (caminho === `${base}/enviar` && req.method === "POST") {
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) return json({ erro: "tipo" }, 415);
    const { chave, codigo, cancelar } = await ler(req);
    const e = pendentes.get(String(chave));
    if (!e) return json({ erro: "Pedido não encontrado (já concluído?)" }, 404);
    if (e.estado !== "pendente") return json({ estado: e.estado });
    if (cancelar) {
      e.estado = "cancelado";
      e.cancelar();
      e.resolver(false);
      return json({ estado: e.estado });
    }
    const cod = String(codigo ?? "").replace(/\D/g, "");
    if (!/^\d{6,8}$/.test(cod)) return json({ estado: e.estado, erro: "Digite os 6 dígitos do app autenticador." });
    const erro = await e.tentar(cod);
    if (erro) {
      e.erro = erro;
      return json({ estado: e.estado, erro });
    }
    e.estado = "conectado";
    e.erro = undefined;
    e.resolver(true);
    limparDepois();
    return json({ estado: e.estado });
  }
  json({ erro: "não encontrado" }, 404);
}

let timerLimpeza: NodeJS.Timeout | undefined;
function limparDepois() {
  clearTimeout(timerLimpeza);
  timerLimpeza = setTimeout(() => {
    for (const [k, e] of pendentes) if (e.estado !== "pendente") pendentes.delete(k);
    if (!pendentes.size && servidor) {
      servidor.close();
      servidor = undefined;
    }
  }, 10 * 60_000);
  timerLimpeza.unref();
}

async function garantirServidor() {
  if (servidor) return;
  const s = http.createServer((req, res) => {
    tratar(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((ok, erro) => {
    s.once("error", erro);
    s.listen(0, "127.0.0.1", () => ok());
  });
  s.unref();
  porta = (s.address() as any).port;
  servidor = s;
}

/**
 * Coloca a base na página (ou reaproveita o pedido pendente) e abre o navegador.
 * `concluido` resolve true quando o login com o código der certo, false se cancelado.
 */
export async function solicitarNaPagina(p: Pendente): Promise<{ url: string; concluido: Promise<boolean> }> {
  await garantirServidor();
  let e = pendentes.get(p.chave);
  if (!e || e.estado !== "pendente") {
    let resolver!: (ok: boolean) => void;
    const concluido = new Promise<boolean>((r) => (resolver = r));
    e = { ...p, estado: "pendente", concluido, resolver };
    pendentes.set(p.chave, e);
  }
  limparDepois();
  abrirNavegador(url());
  return { url: url(), concluido: e.concluido };
}

const HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hubsoft – código 2FA</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--mut:#656d76;--bd:#d0d7de;--bg:#fff;--card:#f6f8fa;--ok:#1a7f37;--err:#cf222e;--pri:#0969da}
@media(prefers-color-scheme:dark){:root{--fg:#e6edf3;--mut:#8d96a0;--bd:#30363d;--bg:#0d1117;--card:#161b22;--ok:#3fb950;--err:#f85149;--pri:#4493f8}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);display:flex;justify-content:center;padding:48px 16px}
main{width:100%;max-width:440px}h1{font-size:20px;margin:0 0 4px}p.sub{color:var(--mut);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px;margin-bottom:12px}
.base{font-weight:600}.det{color:var(--mut);font-size:13px;margin-bottom:12px;word-break:break-all}
form{display:flex;gap:8px}input{flex:1;font:600 22px ui-monospace,Consolas,monospace;letter-spacing:6px;text-align:center;padding:8px;border:1px solid var(--bd);border-radius:8px;background:var(--bg);color:var(--fg);min-width:0}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);cursor:pointer}
button.pri{background:var(--pri);border-color:var(--pri);color:#fff}button:disabled{opacity:.6;cursor:default}
.msg{font-size:13px;margin-top:8px}.err{color:var(--err)}.ok{color:var(--ok);font-weight:600}.mut{color:var(--mut)}
</style></head><body><main>
<h1>Hubsoft (não oficial) – código 2FA</h1>
<p class="sub">Digite o código de 6 dígitos do seu app autenticador. O acesso fica salvo; o código não será pedido de novo.</p>
<div id="lista"><p class="mut">Carregando…</p></div>
<p id="fim" class="ok" hidden>Pronto! Pode fechar esta aba e voltar ao Claude.</p>
</main><script>
const base = location.pathname;
const cards = new Map();
function el(t, c, txt){const e=document.createElement(t);if(c)e.className=c;if(txt!==undefined)e.textContent=txt;return e;}
async function enviar(chave, corpo){
  const r = await fetch(base + "/enviar", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({chave, ...corpo})});
  return r.json();
}
function render(lista){
  const box = document.getElementById("lista");
  if (!lista.length) { box.innerHTML = '<p class="mut">Nenhum pedido pendente.</p>'; return; }
  if (box.querySelector("p.mut")) box.textContent = "";
  for (const p of lista) {
    let c = cards.get(p.chave);
    if (!c) {
      c = {root: el("div","card")};
      c.root.append(el("div","base",p.base), el("div","det",p.usuario + " · " + p.host));
      c.form = el("form"); c.inp = el("input"); c.inp.inputMode="numeric"; c.inp.autocomplete="one-time-code"; c.inp.maxLength=8; c.inp.placeholder="000000";
      c.btn = el("button","pri","Conectar"); c.btn.type="submit";
      c.cancel = el("button","","Cancelar"); c.cancel.type="button";
      c.form.append(c.inp, c.btn, c.cancel); c.msg = el("div","msg");
      c.root.append(c.form, c.msg); box.append(c.root); cards.set(p.chave, c);
      c.form.onsubmit = async (ev) => { ev.preventDefault(); c.btn.disabled = true; c.msg.className="msg mut"; c.msg.textContent="Conectando…";
        const r = await enviar(p.chave, {codigo: c.inp.value}).catch(()=>({erro:"Sem resposta do MCP."})); c.btn.disabled=false; aplicar(c, r.estado || "pendente", r.erro); };
      c.cancel.onclick = async () => { const r = await enviar(p.chave, {cancelar:true}).catch(()=>({})); aplicar(c, r.estado || "cancelado"); };
      if (cards.size === 1) c.inp.focus();
    }
    if (p.estado !== "pendente") aplicar(c, p.estado, p.erro);
  }
  document.getElementById("fim").hidden = !lista.length || lista.some(p => p.estado === "pendente");
}
function aplicar(c, estado, erro){
  if (estado === "conectado") { c.form.remove(); c.msg.className="msg ok"; c.msg.textContent="✓ Conectado"; }
  else if (estado === "cancelado") { c.form.remove(); c.msg.className="msg mut"; c.msg.textContent="Cancelado"; }
  else if (erro) { c.msg.className="msg err"; c.msg.textContent=erro; c.inp.select(); }
  const todos=[...cards.values()]; document.getElementById("fim").hidden = todos.some(x => x.form.isConnected);
}
async function atualizar(){ try { render(await (await fetch(base + "/estado")).json()); } catch {} }
atualizar(); setInterval(atualizar, 2000);
</script></body></html>`;
