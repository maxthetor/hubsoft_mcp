import type { HubsoftConfig } from "./config.js";

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
}

type Query = Record<string, string | number | boolean | undefined | null>;

/**
 * Cliente mínimo da API do Hubsoft.
 *
 * - Autenticação OAuth2 "password grant" em POST /oauth/token
 * - Token em cache até expirar (a rota de auth aceita só 30 req/min por IP)
 * - Uma nova tentativa automática em caso de 401 (token revogado/expirado)
 */
export class HubsoftClient {
  private token?: TokenState;
  private pendingAuth?: Promise<TokenState>;

  constructor(private cfg: HubsoftConfig) {}

  get config(): HubsoftConfig {
    return this.cfg;
  }

  /** Faz a chamada de token em JSON ou form-urlencoded (o Hubsoft aceita ambos em versões diferentes). */
  async requestToken(format: "json" | "form") {
    const fields = {
      grant_type: "password",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      username: this.cfg.username,
      password: this.cfg.password,
    };
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

  private async authenticate(): Promise<TokenState> {
    let { res, body } = await this.requestToken("json");
    if (!res.ok || !body?.access_token) {
      const alt = await this.requestToken("form");
      if (alt.res.ok && alt.body?.access_token) ({ res, body } = alt);
    }
    if (!res.ok || !body?.access_token) {
      throw new HubsoftError(
        `Falha na autenticação no Hubsoft (HTTP ${res.status}). ` +
          `Confira URL, client_id, client_secret, usuário e senha.`,
        res.status,
        body,
      );
    }
    const ttlSec = Number(body.expires_in ?? 3600);
    return {
      header: `${body.token_type ?? "Bearer"} ${body.access_token}`,
      // renova 60 s antes de expirar
      expiresAt: Date.now() + Math.max(ttlSec - 60, 30) * 1000,
    };
  }

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) {
      return this.token.header;
    }
    // evita autenticações paralelas
    this.pendingAuth ??= this.authenticate().finally(() => {
      this.pendingAuth = undefined;
    });
    this.token = await this.pendingAuth;
    return this.token.header;
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
