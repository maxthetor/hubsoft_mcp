import { spawn, spawnSync } from "node:child_process";

/**
 * Pede o código 2FA ao usuário quando o login do Hubsoft devolve 401.
 *
 * Ordem (HUBSOFT_2FA_DIALOGO=auto, padrão):
 *  1. HUBSOFT_2FA_COMANDO, se definido (ex.: `op item get "Hubsoft" --otp`);
 *  2. prompt no terminal (só na CLI, com TTY);
 *  3. página local no navegador (desktop) — não bloqueia: o login termina quando o código chega;
 *  4. MCP elicitation, se o cliente declarar suporte (Claude Code CLI, VS Code…).
 * O Claude Desktop/Cowork ainda não mostra elicitation, por isso o navegador vem antes.
 *
 * Modos: auto | navegador | janela | elicitation | off. "janela" (diálogo nativo) bloqueia a
 * ferramenta até a resposta, então só é usada se pedida. Se o usuário cancelar, a base não
 * volta a perguntar por 10 minutos.
 */

export interface PedidoInfo {
  base: string;
  host: string;
  usuario: string;
  tentativa: number;
  /** Mensagem da tentativa anterior (código recusado). */
  erro?: string;
}

/** Resposta de quem perguntou: o usuário cancelou. */
export const CANCELAR = "\u0000cancelou";

/** Devolve o código digitado, CANCELAR, ou undefined se este meio não pôde perguntar. */
export type Perguntador = (info: PedidoInfo) => Promise<string | undefined>;

/** Um meio de pedir o código: perguntador direto ou a página do navegador. */
export type Meio = { nome: string; pagina: true } | { nome: string; pagina?: false; perguntar: Perguntador };

const TEMPO_LIMITE_MS = 120_000;
const ESPERA_CANCELADO_MS = 10 * 60_000;

let interativo: { fn: Perguntador; antesDaJanela: boolean; nome: string } | undefined;

/** Registra o meio interativo do processo: elicitation (servidor MCP) ou terminal (CLI). */
export function configurarPerguntador(fn: Perguntador, opts: { antesDaJanela: boolean; nome: string }) {
  interativo = { fn, ...opts };
}

function modo(): string {
  const v = (process.env.HUBSOFT_2FA_DIALOGO ?? "").trim().toLowerCase();
  return ["auto", "navegador", "janela", "elicitation", "off"].includes(v) ? v : "auto";
}

export function extrairCodigo(s: string | undefined): string | undefined {
  return s?.match(/\b\d{6,8}\b/)?.[0];
}

function textos(i: PedidoInfo) {
  const titulo = `Hubsoft – código 2FA (${i.base})`;
  const msg =
    (i.erro ? `${i.erro}\n\n` : "") +
    `Digite o código do app autenticador para ${i.usuario} em ${i.host}.\n` +
    "O token fica salvo; este código não será pedido de novo.";
  return { titulo, msg };
}

function executar(cmd: string, args: string[], env: Record<string, string>, shell = false, ocultar = true): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try {
      p = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: ocultar, shell, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve({ code: -1, out: "" });
    }
    const t = setTimeout(() => p.kill(), TEMPO_LIMITE_MS);
    p.stdout!.on("data", (d) => (out += d));
    p.on("error", () => {
      clearTimeout(t);
      resolve({ code: -1, out: "" });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

const PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = $env:HS2FA_TITULO
$f.ClientSize = New-Object System.Drawing.Size(420, 170)
$f.StartPosition = 'CenterScreen'; $f.TopMost = $true
$f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
$l = New-Object System.Windows.Forms.Label; $l.Text = $env:HS2FA_MSG; $l.SetBounds(12, 10, 396, 72)
$t = New-Object System.Windows.Forms.TextBox; $t.SetBounds(12, 86, 396, 30); $t.MaxLength = 8
$t.Font = New-Object System.Drawing.Font('Consolas', 16)
$ok = New-Object System.Windows.Forms.Button; $ok.Text = 'Conectar'; $ok.SetBounds(232, 130, 85, 28); $ok.DialogResult = 'OK'
$c = New-Object System.Windows.Forms.Button; $c.Text = 'Cancelar'; $c.SetBounds(323, 130, 85, 28); $c.DialogResult = 'Cancel'
$f.AcceptButton = $ok; $f.CancelButton = $c
$f.Controls.AddRange(@($l, $t, $ok, $c))
$f.Add_Shown({ $f.Activate(); $t.Focus() })
if ($f.ShowDialog() -eq 'OK') { [Console]::Out.Write($t.Text) }
`;

const OSA = [
  'set r to display dialog (system attribute "HS2FA_MSG") default answer "" with title (system attribute "HS2FA_TITULO") ' +
    'buttons {"Cancelar", "Conectar"} default button "Conectar" cancel button "Cancelar" with icon note giving up after 120',
  "text returned of r",
];

function temComando(c: string) {
  return spawnSync("sh", ["-c", `command -v ${c}`], { stdio: "ignore" }).status === 0;
}

/** Qual janela nativa dá para abrir neste sistema (ou undefined). */
export function janelaDisponivel(): "windows" | "macos" | "zenity" | "kdialog" | undefined {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    if (temComando("zenity")) return "zenity";
    if (temComando("kdialog")) return "kdialog";
  }
  return undefined;
}

async function janela(i: PedidoInfo): Promise<string | undefined> {
  const tipo = janelaDisponivel();
  const { titulo, msg } = textos(i);
  const env = { HS2FA_TITULO: titulo, HS2FA_MSG: msg };
  let r;
  if (tipo === "windows") {
    const enc = Buffer.from(PS, "utf16le").toString("base64");
    // windowsHide=false: com SW_HIDE no STARTUPINFO o Windows esconde também a primeira janela do processo
    // (o próprio formulário). O console do PowerShell fica oculto por -WindowStyle Hidden.
    r = await executar("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], env, false, false);
  } else if (tipo === "macos") {
    r = await executar("osascript", OSA.flatMap((l) => ["-e", l]), env);
  } else if (tipo === "zenity") {
    r = await executar("zenity", ["--entry", `--title=${titulo}`, `--text=${msg}`, "--timeout=120"], env);
  } else if (tipo === "kdialog") {
    r = await executar("kdialog", ["--title", titulo, "--inputbox", msg], env);
  } else return undefined;
  return r.code === 0 ? extrairCodigo(r.out) ?? CANCELAR : CANCELAR;
}

async function comandoExterno(i: PedidoInfo): Promise<string | undefined> {
  const cmd = process.env.HUBSOFT_2FA_COMANDO?.trim();
  if (!cmd || /^\$\{[^}]+\}$/.test(cmd)) return undefined;
  const r = await executar(cmd, [], { HUBSOFT_2FA_BASE: i.base, HUBSOFT_2FA_HOST: i.host, HUBSOFT_2FA_USUARIO: i.usuario }, true);
  return r.code === 0 ? extrairCodigo(r.out) : undefined;
}

/** Há área de trabalho para abrir o navegador? */
export function temDesktop(): boolean {
  if (process.platform === "win32" || process.platform === "darwin") return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function comandoDefinido() {
  const cmd = process.env.HUBSOFT_2FA_COMANDO?.trim();
  return !!cmd && !/^\$\{[^}]+\}$/.test(cmd);
}

/** Meios de pedir o código, na ordem em que serão tentados. */
export function meios(): Meio[] {
  const m = modo();
  const lista: Meio[] = [];
  if (m === "off") return lista;
  if (m === "auto" && comandoDefinido()) lista.push({ nome: "comando", perguntar: comandoExterno });
  if (m === "auto" && interativo?.antesDaJanela) lista.push({ nome: interativo.nome, perguntar: interativo.fn });
  if (m === "janela" && janelaDisponivel()) lista.push({ nome: `janela (${janelaDisponivel()})`, perguntar: janela });
  if ((m === "auto" && temDesktop()) || m === "navegador") lista.push({ nome: "navegador", pagina: true });
  if (interativo && !interativo.antesDaJanela && (m === "auto" || m === "elicitation")) {
    lista.push({ nome: interativo.nome, perguntar: interativo.fn });
  }
  return lista;
}

/** Nomes dos meios disponíveis (diagnóstico). */
export function meiosDisponiveis(): string[] {
  return meios().map((x) => x.nome);
}

// ---- serialização e espera após cancelamento ----
let fila: Promise<unknown> = Promise.resolve();
const canceladoAte = new Map<string, number>();

/** Executa fn com exclusividade: uma janela de 2FA por vez no processo. */
export function comTrava<T>(fn: () => Promise<T>): Promise<T> {
  const r = fila.then(fn, fn);
  fila = r.catch(() => undefined);
  return r;
}

export function emEspera(chave: string) {
  const ate = canceladoAte.get(chave);
  return !!ate && Date.now() < ate;
}

export function marcarCancelado(chave: string) {
  canceladoAte.set(chave, Date.now() + ESPERA_CANCELADO_MS);
}

export function limparCancelado(chave: string) {
  canceladoAte.delete(chave);
}
