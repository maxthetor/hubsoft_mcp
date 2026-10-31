import { HubsoftError } from "./client.js";

export const API = "/api/v1/integracao";

/** Campos com senhas/segredos (ex.: senha PPPoE em ClienteServicoAutenticacao.password). */
const SENSITIVE = /^(password|senha|secret|client_secret|token|access_token|refresh_token)$|(_password|_senha|_secret)$|^(senha_|password_)/i;

let exposeSecrets = false;
export function setExposeSecrets(v: boolean) {
  exposeSecrets = v;
}

/** Substitui recursivamente o valor de campos sensíveis por "***". */
export function redact(v: unknown): unknown {
  if (exposeSecrets) return v;
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        SENSITIVE.test(k) && x !== null && typeof x !== "object" ? "***" : redact(x),
      ]),
    );
  }
  return v;
}

/** Formata a resposta para o modelo, mascarando segredos e truncando respostas grandes. */
export function ok(data: unknown, maxChars: number) {
  let text = JSON.stringify(redact(data), null, 2);
  if (text.length > maxChars) {
    text =
      text.slice(0, maxChars) +
      `\n\n[... resposta truncada em ${maxChars} caracteres. ` +
      `Refine a busca, use "limit" ou peça outra página.]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

export function fail(err: unknown) {
  const e = err as HubsoftError & { cause?: { code?: string; message?: string } };
  if (e?.message === "fetch failed") {
    const c = e.cause?.code || e.cause?.message || "erro de rede";
    e.message = `Não foi possível conectar ao Hubsoft (${c}). Verifique HUBSOFT_URL e a rede.`;
  }
  const detail = e?.body ? `\nDetalhes: ${JSON.stringify(e.body).slice(0, 1500)}` : "";
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${e?.message ?? String(err)}${detail}` }],
  };
}

/** Executa a função e converte o resultado/erro no formato do MCP. */
export async function run(maxChars: number, fn: () => Promise<unknown>) {
  try {
    return ok(await fn(), maxChars);
  } catch (err) {
    return fail(err);
  }
}
