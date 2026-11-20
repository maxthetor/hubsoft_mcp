import { HubsoftError } from "./client.js";

export const API = "/api/v1/integracao";

/** Campos com senhas/segredos (ex.: senha PPPoE em ClienteServicoAutenticacao.password). */
const SENSITIVE = /^(password|senha|secret|client_secret|token|access_token|refresh_token)$|(_password|_senha|_secret)$|^(senha_|password_)/i;

let exposeSecrets = false;
export function setExposeSecrets(v: boolean) {
  exposeSecrets = v;
}

// ---------------------------------------------------------------- LGPD: CPF/CNPJ

/** Dígitos visíveis no fim de um CPF/CNPJ mascarado. */
export const DIGITOS_VISIVEIS = 3;

/** Campos que guardam CPF/CNPJ (cpf_cnpj, cpf, cnpj, documento…). */
const CAMPO_DOC = /(^|_)(cpf|cnpj|cpf_cnpj|cnpj_cpf|documento|doc_cliente)(_|$)/i;

/**
 * Campos cujo texto NÃO é varrido em busca de CPF/CNPJ: identificadores, códigos de boleto/PIX
 * e endereços de hardware, onde uma sequência de 11 ou 14 dígitos é legítima.
 */
const SEM_VARREDURA = /^(id|uuid)(_|$)|(_id|_uuid)$|^codigo|linha_digitavel|codigo_barras|nosso_numero|pix|qr_?code|phy_addr|mac_addr|serial/i;

/** "123.456.789-01" ou 12345678901 → "********901" (mantém o tamanho e os últimos dígitos). */
export function mascararDoc(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return v;
  if (typeof v === "string" && v.includes("*")) return v; // já mascarado (idempotente)
  const d = String(v).replace(/\D/g, "");
  if (!d) return typeof v === "string" ? v : "***";
  return "*".repeat(Math.max(0, d.length - DIGITOS_VISIVEIS)) + d.slice(-DIGITOS_VISIVEIS);
}

// CPF/CNPJ formatados, ou sequências soltas de exatamente 11 ou 14 dígitos.
const DOC_NO_TEXTO =
  /(?<![\w./-])(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14}|\d{11})(?![\w/-]|\.\d)/g;

/** Mascara CPF/CNPJ que apareçam dentro de um texto livre (mensagens, razão social de MEI…). */
export function mascararTexto(s: string): string {
  return s.replace(DOC_NO_TEXTO, (m) => String(mascararDoc(m)));
}

/** Copia profunda com CPF/CNPJ mascarados: por nome do campo e dentro de textos. */
export function mascararDocumentos(v: unknown, chave = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => mascararDocumentos(x, chave));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mascararDocumentos(x, k)]));
  }
  if (CAMPO_DOC.test(chave) && v !== null && typeof v !== "boolean") return mascararDoc(v);
  if (typeof v === "string" && !SEM_VARREDURA.test(chave)) return mascararTexto(v);
  return v;
}

/**
 * Substitui recursivamente o valor de campos sensíveis por "***" e mascara CPF/CNPJ.
 * HUBSOFT_EXPOR_SENHAS só libera senhas; CPF/CNPJ continuam sempre mascarados (LGPD).
 */
export function redact(v: unknown): unknown {
  return mascararDocumentos(exposeSecrets ? v : semSenhas(v));
}

function semSenhas(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(semSenhas);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        SENSITIVE.test(k) && x !== null && typeof x !== "object" ? "***" : semSenhas(x),
      ]),
    );
  }
  return v;
}

/** Formata a resposta para o modelo: JSON compacto (sem indentação), segredos mascarados, truncado se grande. */
export function ok(data: unknown, maxChars: number) {
  let text = JSON.stringify(redact(data));
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
  const detail = e?.body ? `\nDetalhes: ${JSON.stringify(redact(e.body)).slice(0, 1500)}` : "";
  return {
    isError: true,
    content: [{ type: "text" as const, text: mascararTexto(`${e?.message ?? String(err)}${detail}`) }],
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
