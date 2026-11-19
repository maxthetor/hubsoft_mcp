import type { HubsoftConfig } from "./config.js";
import { TokenStore, chaveToken, totp, type TokenSalvo } from "./tokens.js";
import { CANCELAR, comTrava, emEspera, extrairCodigo, limparCancelado, marcarCancelado, meios, meiosDisponiveis, type Perguntador } from "./dialogo2fa.js";
import { solicitarNaPagina, urlPagina } from "./pagina2fa.js";

export class HubsoftError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "HubsoftError";
  }
}

interface TokenState {
  header: string; // "Bearer xxx"
  expiresAt: number; // epoch ms
  access: string;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** Margem antes do vencimento em que o token já é considerado expirado. */
const MARGEM_MS = 5 * 60_000;

export const DICA_2FA =
  "Se este usuário usa 2FA e o pedido do código foi cancelado ou não apareceu, faça o primeiro login com a ferramenta hubsoft_conectar " +
  "(servidor + codigo_2fa do app autenticador) ou configure a semente em HUBSOFT_OTP_SECRET. " +
  "Depois disso o token fica salvo e é renovado sozinho.";

/**
 * Cliente mínimo da API do Hubsoft.
 *
 * Autenticação (OAuth2), na ordem:
 *  1. token em memória ou salvo no arquivo de tokens, se ainda válido;
 *  2. grant_type=refresh_token com o refresh salvo (uso único: o novo é gravado na hora);
 *  3. grant_type=password, com `one_time_password` quando houver semente TOTP configurada.
 * Usuário com 2FA sem semente: o primeiro login é feito por `conectar(codigo)`.
 * A rota de auth aceita só 30 req/min por IP, por isso o token é reaproveitado ao máximo.
 */
export class HubsoftClient {
  private token?: TokenState;
  private pendingAuth?: Promise<TokenState>;
  private store: TokenStore;
  private chave: string;

  constructor(private cfg: HubsoftConfig) {
    this.store = new TokenStore(cfg.tokens ?? "");
    this.chave = chaveToken(cfg.baseUrl, cfg.clientId, cfg.username);
  }

  get config(): HubsoftConfig {
    return this.cfg;
  }

  /** POST /oauth/token em JSON ou form-urlencoded (o Hubsoft aceita ambos em versões diferentes). */
  async requestToken(format: "json" | "form", extra: Record<string, string> = {}) {
    const fields: Record<string, string> = {
      grant_type: "password",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      username: this.cfg.username,
      password: this.cfg.password,
      ...extra,
    };
    if (fields.grant_type === "refresh_token") {
      delete fields.username;
      delete fields.password;
    }
    const res = await fetch(`${this.cfg.baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type":
          format === "json" ? "application/json" : "application/x-www-form-urlencoded",
      },
      body:
        format === "json" ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
    });
    return { res, body: await safeJson(res) };
  }

  private async pedirToken(extra: Record<string, string>) {
    let r = await this.requestToken("json", extra);
    // tenta form-urlencoded só se o JSON não foi entendido; 401/429 não mudam com o formato
    if (!r.body?.access_token && ![401, 429].includes(r.res.status)) {
      const alt = await this.requestToken("form", extra);
      if (alt.body?.access_token) r = alt;
    }
    return r;
  }

  /** Grava o token recebido (memória + arquivo) e devolve o estado. */
  private guardar(body: any): TokenState {
    const ttlSec = Number(body.expires_in ?? 3600);
    const tipo = body.token_type ?? "Bearer";
    const anterior = this.store.get(this.chave);
    const salvo: TokenSalvo = {
      token_type: tipo,
      access_token: body.access_token,
      expires_at: Date.now() + ttlSec * 1000,
      refresh_token: body.refresh_token ?? anterior?.refresh_token,
      refresh_emitido_em: body.refresh_token ? new Date().toISOString() : anterior?.refresh_emitido_em,
      atualizado_em: new Date().toISOString(),
    };
    try {
      this.store.set(this.chave, salvo);
    } catch {
      /* sem permissão de escrita: segue só em memória */
    }
    return this.estado(salvo);
  }

  private estado(t: TokenSalvo): TokenState {
    return { header: `${t.token_type} ${t.access_token}`, expiresAt: t.expires_at - MARGEM_MS, access: t.access_token };
  }

  private falha(res: Response, body: any, comOtp: boolean): HubsoftError {
    const msg = body?.msg || body?.message || body?.error_description || body?.error || "";
    const dica = res.status === 429 ? " Limite de autenticação atingido (30/min); aguarde." : comOtp ? " O código 2FA gerado pela semente foi recusado: confira HUBSOFT_OTP_SECRET e o relógio do computador." : ` ${DICA_2FA}`;
    return new HubsoftError(
      `Falha na autenticação no Hubsoft (HTTP ${res.status}${msg ? `: ${msg}` : ""}). ` +
        `Confira URL, client_id, client_secret, usuário e senha.` + dica,
      res.status,
      body,
    );
  }

  private async authenticate(force: boolean): Promise<TokenState> {
    const salvo = this.store.get(this.chave);
    // 1) token salvo válido — inclusive se outro processo (CLI, outra janela) já renovou
    if (salvo?.access_token && Date.now() < salvo.expires_at - MARGEM_MS) {
      if (!force || salvo.access_token !== this.token?.access) return this.estado(salvo);
    }
    // 2) refresh_token (uso único)
    if (salvo?.refresh_token) {
      const r = await this.pedirToken({ grant_type: "refresh_token", refresh_token: salvo.refresh_token });
      if (r.body?.access_token) return this.guardar(r.body);
      if (r.res.status === 429) throw this.falha(r.res, r.body, false);
      // refresh inválido/expirado: descarta e cai para o login com senha
      try {
        this.store.set(this.chave, undefined);
      } catch {
        /* ignore */
      }
    }
    // 3) senha (+ TOTP automático, se houver semente)
    const extra: Record<string, string> = {};
    if (this.cfg.otpSecret) extra.one_time_password = totp(this.cfg.otpSecret);
    const r = await this.pedirToken(extra);
    if (r.body?.access_token) return this.guardar(r.body);
    // 4) 401 sem semente: pede o código ao usuário (janela, elicitation ou comando)
    if (r.res.status === 401 && !this.cfg.otpSecret) {
      const t = await this.loginInterativo();
      if (t) return t;
    }
    throw this.falha(r.res, r.body, !!this.cfg.otpSecret);
  }

  /** Token salvo ainda válido (outro cliente do processo ou outra janela pode ter conectado). */
  private salvoValido(): TokenState | undefined {
    const salvo = this.store.get(this.chave);
    return salvo?.access_token && Date.now() < salvo.expires_at - MARGEM_MS ? this.estado(salvo) : undefined;
  }

  private info(tentativa: number, erro?: string) {
    return { base: this.cfg.nome, host: new URL(this.cfg.baseUrl).host, usuario: this.cfg.username, tentativa, erro };
  }

  /** Login com o código; devolve o token ou a mensagem de erro. */
  private async tentarCodigo(codigo: string): Promise<TokenState | string> {
    const r = await this.pedirToken({ one_time_password: codigo });
    if (r.body?.access_token) {
      limparCancelado(this.chave);
      this.token = this.guardar(r.body);
      return this.token;
    }
    if (r.res.status === 429) return "Limite de autenticação do Hubsoft atingido (30/min). Aguarde um minuto e tente de novo.";
    const msg = r.body?.msg || r.body?.message || r.body?.error || "";
    return `Código recusado pelo Hubsoft (HTTP ${r.res.status}${msg ? `: ${msg}` : ""}). Use o código atual do app; se continuar, confira a senha e o client.`;
  }

  /**
   * Pede o código 2FA ao usuário pelos meios disponíveis (comando, terminal, navegador,
   * elicitation). undefined = cancelado ou sem meio interativo.
   */
  private async loginInterativo(): Promise<TokenState | undefined> {
    if (emEspera(this.chave)) return undefined;
    for (const m of meios()) {
      if (m.pagina) return this.loginNavegador();
      const r = await comTrava(() => this.loginComPerguntador(m.perguntar));
      if (r === "sem") continue;
      if (r === "cancelou") {
        marcarCancelado(this.chave);
        return undefined;
      }
      return r;
    }
    return undefined;
  }

  /** Até 3 tentativas com um perguntador; "sem" = este meio não conseguiu perguntar. */
  private async loginComPerguntador(perguntar: Perguntador): Promise<TokenState | "sem" | "cancelou"> {
    const ja = this.salvoValido();
    if (ja) return ja;
    let erro: string | undefined;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      const resp = await perguntar(this.info(tentativa, erro)).catch(() => undefined);
      if (resp === undefined) return tentativa === 1 ? "sem" : "cancelou";
      const codigo = resp === CANCELAR ? undefined : extrairCodigo(resp);
      if (!codigo) return "cancelou";
      const r = await this.tentarCodigo(codigo);
      if (typeof r !== "string") return r;
      erro = r;
    }
    throw new HubsoftError(
      "Login recusado mesmo com o código 2FA (3 tentativas). Confira a senha, o client_id/client_secret " +
        "e se o client está liberado para este usuário no Hubsoft.",
      401,
    );
  }

  /**
   * Página no navegador: espera um pouco pelo código (a consulta segue sozinha se ele chegar);
   * senão responde com o link e o login termina quando o usuário enviar o código.
   */
  private async loginNavegador(): Promise<TokenState | undefined> {
    const ja = this.salvoValido();
    if (ja) return ja;
    const { url, concluido } = await solicitarNaPagina({
      chave: this.chave,
      base: this.cfg.nome,
      host: new URL(this.cfg.baseUrl).host,
      usuario: this.cfg.username,
      tentar: async (codigo) => {
        const r = await this.tentarCodigo(codigo);
        return typeof r === "string" ? r : undefined;
      },
      cancelar: () => marcarCancelado(this.chave),
    });
    const espera = Math.max(0, Number(process.env.HUBSOFT_2FA_ESPERA_S ?? 45)) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const ok = await Promise.race([
      concluido,
      new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), espera))),
    ]);
    clearTimeout(timer);
    if (ok === true) return this.salvoValido() ?? this.token;
    if (ok === false) return undefined;
    throw new HubsoftError(
      `Login 2FA pendente na base ${this.cfg.nome}: abri uma página no navegador para o usuário digitar o ` +
        `código do app autenticador. Se ela não abriu, o link é ${url} . Mostre o link ao usuário; depois que ` +
        "ele conectar, repita a consulta (o acesso fica salvo e o código não é pedido de novo).",
      401,
    );
  }

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) {
      return this.token.header;
    }
    // evita autenticações paralelas
    this.pendingAuth ??= this.authenticate(force).finally(() => {
      this.pendingAuth = undefined;
    });
    this.token = await this.pendingAuth;
    return this.token.header;
  }

  /**
   * Primeiro login de um usuário com 2FA: senha + código do app autenticador.
   * O token e o refresh_token ficam salvos; os próximos logins não pedem código.
   */
  async conectar(codigo?: string): Promise<{ ok: true; metodo: string } & ReturnType<HubsoftClient["situacaoToken"]>> {
    let metodo: string;
    if (codigo) {
      const r = await this.pedirToken({ one_time_password: codigo });
      if (!r.body?.access_token) {
        const msg = r.body?.msg || r.body?.message || r.body?.error_description || r.body?.error || "";
        throw new HubsoftError(
          `Login com 2FA recusado (HTTP ${r.res.status}${msg ? `: ${msg}` : ""}). ` +
            "Confira usuário, senha e o código (ele muda a cada 30 s; use um código novo).",
          r.res.status,
          r.body,
        );
      }
      this.token = this.guardar(r.body);
      metodo = "senha + código 2FA";
    } else {
      this.token = undefined;
      await this.getToken(false);
      metodo = this.cfg.otpSecret ? "token salvo, refresh ou semente 2FA" : "token salvo, refresh ou senha";
    }
    return { ok: true, metodo, ...this.situacaoToken() };
  }

  /** Estado da autenticação, sem expor tokens. */
  situacaoToken() {
    const t = this.store.get(this.chave);
    const exp = t?.expires_at ?? (this.token ? this.token.expiresAt + MARGEM_MS : undefined);
    return {
      token_valido_ate: exp ? new Date(exp).toISOString() : null,
      token_valido: !!exp && Date.now() < exp - MARGEM_MS,
      refresh_token_salvo: !!t?.refresh_token,
      refresh_emitido_em: t?.refresh_emitido_em ?? null,
      codigo_2fa_automatico: !!this.cfg.otpSecret,
      pedido_2fa: this.cfg.otpSecret ? "semente" : meiosDisponiveis().join(" → ") || "nenhum (use hubsoft_conectar)",
      ...(urlPagina() ? { pagina_2fa: urlPagina() } : {}),
      arquivo_tokens: this.cfg.tokens || "desativado (só memória)",
    };
  }

  /** Testa o acesso pelo fluxo normal (reaproveita o token; não gasta o refresh à toa). */
  async testarLogin() {
    await this.getToken(false);
    return this.situacaoToken();
  }

  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<any> {
    const url = new URL(this.cfg.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const doFetch = async (force: boolean) =>
      fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: await this.getToken(force),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });

    let res = await doFetch(false);
    if (res.status === 401) res = await doFetch(true);

    const body = await safeJson(res);
    if (!res.ok) {
      const msg =
        (body && (body.msg || body.message || body.error_description || body.error)) ||
        res.statusText;
      throw new HubsoftError(`Hubsoft respondeu HTTP ${res.status}: ${msg}`, res.status, body);
    }
    return body;
  }

  /**
   * Requisição que NUNCA lança erro por status HTTP: devolve status e corpo na íntegra.
   * Usada pelas ferramentas de escrita, que precisam mostrar a resposta do Hubsoft sem filtro.
   * - 401: renova o token UMA vez e reenvia (único reenvio permitido, inclusive em POST);
   * - 429: não repete; devolve o erro com retry_after;
   * - demais códigos: sem nova tentativa.
   */
  async raw(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ status: number; ok: boolean; url: string; body: any; retryAfter?: number; tokenRenovado?: boolean }> {
    const url = new URL(this.cfg.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const enviar = async (force: boolean) =>
      fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: await this.getToken(force),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    let res = await enviar(false);
    let tokenRenovado = false;
    if (res.status === 401) {
      tokenRenovado = true;
      res = await enviar(true);
    }
    const body = await safeJson(res);
    let retryAfter: number | undefined;
    if (res.status === 429) {
      const h = Number(res.headers.get("retry-after"));
      retryAfter = Number(body?.retry_after ?? (Number.isFinite(h) ? h : undefined)) || undefined;
    }
    return { status: res.status, ok: res.ok, url: url.toString(), body, retryAfter, ...(tokenRenovado ? { tokenRenovado } : {}) };
  }

  get(path: string, query?: Query) {
    return this.request("GET", path, { query });
  }

  post(path: string, body?: unknown) {
    return this.request("POST", path, { body });
  }
}

async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}
