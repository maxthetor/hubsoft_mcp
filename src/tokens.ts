import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persistência de tokens OAuth e geração de códigos TOTP (2FA).
 *
 * Fluxo igual ao do MCP oficial do Hubsoft: o código 2FA (`one_time_password`) só é
 * necessário no primeiro login. Depois o access_token (30 dias) e o refresh_token
 * (uso único, renovado a cada uso) ficam salvos e são reutilizados sem pedir código.
 */

export const TOKENS_PADRAO = join(homedir(), ".config", "hubsoft", "tokens.json");

export interface TokenSalvo {
  token_type: string;
  access_token: string;
  /** epoch ms */
  expires_at: number;
  refresh_token?: string;
  /** ISO, quando o refresh_token foi emitido */
  refresh_emitido_em?: string;
  atualizado_em: string;
}

/** Chave de uma credencial: mesma URL + client + usuário = mesmo token. */
export function chaveToken(baseUrl: string, clientId: string, username: string) {
  return `${baseUrl}|${clientId}|${username.toLowerCase()}`;
}

/** Tokens em memória, compartilhados pelos clientes do mesmo processo quando o arquivo está desativado. */
const memoria: Record<string, TokenSalvo> = {};

/** Arquivo JSON com os tokens. Caminho vazio = só memória (nada é gravado em disco). */
export class TokenStore {
  constructor(public readonly caminho: string) {}

  private ler(): Record<string, TokenSalvo> {
    if (!this.caminho) return memoria;
    if (!existsSync(this.caminho)) return {};
    try {
      const j = JSON.parse(readFileSync(this.caminho, "utf8"));
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }

  get(chave: string): TokenSalvo | undefined {
    return this.ler()[chave];
  }

  set(chave: string, valor: TokenSalvo | undefined) {
    if (!this.caminho) {
      if (valor) memoria[chave] = valor;
      else delete memoria[chave];
      return;
    }
    const tudo = this.ler();
    if (valor) tudo[chave] = valor;
    else delete tudo[chave];
    mkdirSync(dirname(this.caminho), { recursive: true, mode: 0o700 });
    // escrita atômica: outro processo (CLI, outra janela) nunca lê um arquivo pela metade
    const tmp = `${this.caminho}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(tudo, null, 2), { mode: 0o600 });
    renameSync(tmp, this.caminho);
    try {
      chmodSync(this.caminho, 0o600);
    } catch {
      /* Windows */
    }
  }
}

/** Aceita a semente em base32 ("JBSW Y3DP…") ou a URI otpauth://totp/…?secret=… do QR code. */
export function normalizarSemente(v: string): string {
  let s = v.trim();
  if (/^otpauth:\/\//i.test(s)) {
    s = new URL(s).searchParams.get("secret") ?? "";
  }
  s = s.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!s || /[^A-Z2-7]/.test(s)) {
    throw new Error("Semente 2FA inválida: esperado base32 (letras A–Z e dígitos 2–7) ou URI otpauth://.");
  }
  return s;
}

function base32(s: string): Buffer {
  const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let valor = 0;
  const out: number[] = [];
  for (const c of s) {
    valor = (valor << 5) | alfabeto.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Código TOTP (RFC 6238: SHA-1, passo de 30 s). */
export function totp(semente: string, agoraMs = Date.now(), digitos = 6): string {
  const chave = base32(normalizarSemente(semente));
  const contador = Math.floor(agoraMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const h = createHmac("sha1", chave).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digitos).padStart(digitos, "0");
}
