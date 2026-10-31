/**
 * Utilitários de faturas da API REST do Hubsoft.
 *
 * Atenção: a REST devolve datas como "dd/mm/aaaa" (ex.: "05/11/2026"),
 * enquanto o GraphQL usa ISO ("2026-11-05"). Sempre normalize antes de comparar.
 */

const TZ = "America/Sao_Paulo";

/** Converte "dd/mm/aaaa", "aaaa-mm-dd" ou "aaaa-mm-dd hh:mm:ss" para "aaaa-mm-dd". */
export function isoDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** Data de hoje no fuso de Brasília, em "aaaa-mm-dd". */
export function hojeBR(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
}

function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
}

export interface FaturaResumo {
  id_fatura: unknown;
  status: unknown;
  valor: number;
  data_vencimento: string | null;
  dias_atraso?: number;
  vencida: boolean;
  tipo_cobranca?: unknown;
  linha_digitavel?: unknown;
  pix_copia_cola?: unknown;
  link?: unknown;
  id_cliente_servico?: unknown;
  descricao?: string;
}

/** Fatura em aberto considerada vencida: status "vencid*" ou vencimento anterior a hoje. */
export function isVencida(f: any, hoje = hojeBR()): boolean {
  if (f?.quitado === true || f?.data_pagamento) return false;
  if (/vencid/i.test(String(f?.status ?? ""))) return true;
  const d = isoDate(f?.data_vencimento);
  return !!d && d < hoje;
}

/** Versão enxuta da fatura: só o necessário para atendimento e cobrança. */
export function resumirFatura(f: any, hoje = hojeBR()): FaturaResumo {
  const venc = isoDate(f?.data_vencimento);
  const vencida = isVencida(f, hoje);
  const itens: string[] = Array.isArray(f?.detalhamento)
    ? f.detalhamento.map((d: any) => String(d?.descricao ?? "").split(" - ")[0]).filter(Boolean)
    : [];
  return {
    id_fatura: f?.id_fatura,
    status: f?.status,
    valor: Number(f?.valor ?? 0),
    data_vencimento: venc,
    ...(vencida && venc ? { dias_atraso: diasEntre(venc, hoje) } : {}),
    vencida,
    tipo_cobranca: f?.tipo_cobranca,
    linha_digitavel: f?.linha_digitavel ?? undefined,
    pix_copia_cola: f?.pix_copia_cola ?? undefined,
    link: f?.link ?? undefined,
    id_cliente_servico: f?.cliente?.servico?.id_cliente_servico,
    ...(itens.length ? { descricao: [...new Set(itens)].join(" + ") } : {}),
  };
}

const soma = (l: FaturaResumo[]) => Number(l.reduce((s, x) => s + x.valor, 0).toFixed(2));

/**
 * Resumo para a visão 360°: todas as vencidas + a próxima a vencer;
 * as demais futuras (ex.: parcelas de carnê) entram só como contagem e total.
 */
export function resumoFinanceiro(faturas: any[], hoje = hojeBR()) {
  const todas = faturas
    .map((f) => resumirFatura(f, hoje))
    .sort((a, b) => (a.data_vencimento ?? "").localeCompare(b.data_vencimento ?? ""));
  const vencidas = todas.filter((f) => f.vencida);
  const aVencer = todas.filter((f) => !f.vencida);
  const [proxima, ...futuras] = aVencer;
  return {
    hoje,
    em_aberto: { quantidade: todas.length, valor_total: soma(todas) },
    vencidas: { quantidade: vencidas.length, valor_total: soma(vencidas), faturas: vencidas },
    proxima_a_vencer: proxima ?? null,
    demais_a_vencer: {
      quantidade: futuras.length,
      valor_total: soma(futuras),
      vencimentos: futuras.map((f) => f.data_vencimento),
    },
  };
}
