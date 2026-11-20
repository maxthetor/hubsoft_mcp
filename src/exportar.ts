import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubsoftError, type HubsoftClient } from "./client.js";

/**
 * Base das ferramentas de exportação (somente GET).
 *
 *  - CSV UTF-8 com BOM, separador ";", CRLF; arquivo novo a cada execução (nunca sobrescreve);
 *  - paginação automática com limite de requisições por base (padrão 20 req/s);
 *  - HTTP 429: espera `retry_after` (sem contar como tentativa);
 *  - falha de rede/5xx: até 3 tentativas por página; se a página não vier, a exportação para
 *    nela e o resultado diz de qual página retomar.
 */

const num = (nome: string, padrao: number) => {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v > 0 ? v : padrao;
};

export const TENTATIVAS = 3;
const MAX_429_POR_PAGINA = 10;
const MAX_ESPERA_S = 120;
const MAX_PAGINAS = 5000;

// ---------------------------------------------------------------- limite de requisições

interface Limite {
  proximo: number;
  pausadoAte: number;
}
const limites = new Map<string, Limite>();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a vez de enviar uma requisição a esta base (compartilhado entre chamadas paralelas).
 * Usa 90% do limite: a latência da rede pode aproximar as chegadas no Hubsoft.
 */
async function vez(base: string) {
  const intervalo = 1000 / (num("HUBSOFT_EXPORT_REQ_S", 20) * 0.9);
  const l = limites.get(base) ?? { proximo: 0, pausadoAte: 0 };
  limites.set(base, l);
  const agora = Date.now();
  const quando = Math.max(agora, l.proximo, l.pausadoAte);
  l.proximo = quando + intervalo;
  if (quando > agora) await dormir(quando - agora);
}

function pausar(base: string, segundos: number) {
  const l = limites.get(base) ?? { proximo: 0, pausadoAte: 0 };
  l.pausadoAte = Math.max(l.pausadoAte, Date.now() + Math.min(segundos, MAX_ESPERA_S) * 1000);
  limites.set(base, l);
}

// ---------------------------------------------------------------- requisição com novas tentativas

export interface Contadores {
  requisicoes: number;
  esperas_429: number;
  novas_tentativas: number;
}

export type Resposta = { ok: true; body: any } | { ok: false; erro: string };

/** GET com até 3 tentativas (rede, 5xx, 408); 429 espera retry_after; outros 4xx falham na hora. */
export async function obter(
  hs: HubsoftClient,
  rota: string,
  query: Record<string, string | number>,
  cont: Contadores,
): Promise<Resposta> {
  const base = hs.config.baseUrl;
  const esperaMs = num("HUBSOFT_EXPORT_ESPERA_MS", 1000);
  let erro = "";
  let esperas = 0;
  for (let tentativa = 1; tentativa <= TENTATIVAS; ) {
    await vez(base);
    cont.requisicoes++;
    let r;
    try {
      r = await hs.raw("GET", rota, { query });
    } catch (e) {
      // falha de autenticação (2FA pendente, credencial inválida) não melhora repetindo
      if (e instanceof HubsoftError) throw e;
      erro = `erro de rede: ${(e as any)?.cause?.code ?? (e as Error).message}`;
      if (tentativa++ < TENTATIVAS) {
        cont.novas_tentativas++;
        await dormir(esperaMs * (tentativa - 1));
      }
      continue;
    }
    if (r.status === 429) {
      cont.esperas_429++;
      if (++esperas > MAX_429_POR_PAGINA) return { ok: false, erro: `HTTP 429 repetido ${esperas - 1} vezes` };
      pausar(base, r.retryAfter ?? 1);
      continue; // não conta como tentativa
    }
    if (r.ok) return { ok: true, body: r.body };
    const msg = r.body?.msg || r.body?.message || r.body?.error || "";
    const detalhes = Array.isArray(r.body?.errors) ? ` ${r.body.errors.join(" ")}` : "";
    erro = `HTTP ${r.status}${msg ? `: ${msg}` : ""}${detalhes}`;
    if (r.status < 500 && r.status !== 408) return { ok: false, erro };
    if (tentativa++ < TENTATIVAS) {
      cont.novas_tentativas++;
      await dormir(esperaMs * (tentativa - 1));
    }
  }
  return { ok: false, erro: `${erro} (após ${TENTATIVAS} tentativas)` };
}

// ---------------------------------------------------------------- paginação

export interface ResultadoPaginacao extends Contadores {
  paginas_lidas: number;
  total_registros?: number;
  ultima_pagina?: number;
  /** Página que falhou (as anteriores foram lidas; dela em diante, não). */
  pagina_falhou?: number;
  erros: string[];
}

/**
 * Lê `rota` página a página (a API numera a partir de 0) e entrega cada lote, em ordem, a
 * `aoLer`. Busca até `HUBSOFT_EXPORT_PARALELO` páginas ao mesmo tempo, sempre dentro do limite
 * de requisições. Se uma página falhar após as tentativas, para nela (nada depois dela é usado).
 */
export async function paginar(opts: {
  hs: HubsoftClient;
  rota: string;
  query: Record<string, string | number>;
  chave: string;
  paginaInicial?: number;
  aoLer: (itens: any[]) => void;
  progresso?: (lidas: number, total?: number) => void;
}): Promise<ResultadoPaginacao> {
  const paralelo = Math.min(10, Math.floor(num("HUBSOFT_EXPORT_PARALELO", 4)));
  const res: ResultadoPaginacao = { paginas_lidas: 0, requisicoes: 0, esperas_429: 0, novas_tentativas: 0, erros: [] };
  const inicio = Math.max(0, Math.floor(opts.paginaInicial ?? 0));
  const ler = (p: number) => obter(opts.hs, opts.rota, { ...opts.query, pagina: p }, res);
  const lista = (body: any): any[] => (Array.isArray(body?.[opts.chave]) ? body[opts.chave] : []);

  const primeira = await ler(inicio);
  if (!primeira.ok) {
    res.pagina_falhou = inicio;
    res.erros.push(`página ${inicio}: ${primeira.erro}`);
    return res;
  }
  const pg = primeira.body?.paginacao;
  res.total_registros = pg?.total_registros === undefined ? undefined : Number(pg.total_registros);
  const ultima = Math.min(Number(pg?.ultima_pagina ?? inicio), inicio + MAX_PAGINAS - 1);
  res.ultima_pagina = Number(pg?.ultima_pagina ?? inicio);
  opts.aoLer(lista(primeira.body));
  res.paginas_lidas++;
  const total = ultima - inicio + 1;
  opts.progresso?.(res.paginas_lidas, total);

  for (let p = inicio + 1; p <= ultima; p += paralelo) {
    const nums = Array.from({ length: Math.min(paralelo, ultima - p + 1) }, (_, i) => p + i);
    const lote = await Promise.all(nums.map(ler));
    for (let i = 0; i < lote.length; i++) {
      const r = lote[i];
      if (!r.ok) {
        res.pagina_falhou = nums[i];
        res.erros.push(`página ${nums[i]}: ${r.erro}`);
        return res;
      }
      opts.aoLer(lista(r.body));
      res.paginas_lidas++;
    }
    opts.progresso?.(res.paginas_lidas, total);
  }
  if (res.ultima_pagina > ultima) res.erros.push(`limite de segurança de ${MAX_PAGINAS} páginas atingido`);
  return res;
}

// ---------------------------------------------------------------- CSV

/** Campos que nunca entram numa exportação (LGPD), mesmo quando vêm em colunas dinâmicas. */
export const CAMPO_PESSOAL =
  /cpf|cnpj|(^|_)rg(_|$)|telefone|celular|whatsapp|e_?mail|endereco|logradouro|bairro|(^|_)cep(_|$)|complemento|senha|password|secret|token|nascimento/i;

function celula(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function gerarCsv(colunas: string[], linhas: Record<string, unknown>[]): string {
  const out = [colunas.map(celula).join(";")];
  for (const l of linhas) out.push(colunas.map((c) => celula(l[c])).join(";"));
  return "﻿" + out.join("\r\n") + "\r\n";
}

const dois = (n: number) => String(n).padStart(2, "0");
function carimbo(d = new Date()) {
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}_${dois(d.getHours())}-${dois(d.getMinutes())}-${dois(d.getSeconds())}`;
}

/** Grava um CSV novo em `dir`: <tipo>_<base>_<data-hora>[_parcial][_N].csv. Nunca sobrescreve. */
export function gravarCsv(
  dir: string,
  tipo: string,
  base: string,
  colunas: string[],
  linhas: Record<string, unknown>[],
  parcial = false,
): string {
  mkdirSync(dir, { recursive: true });
  const nome = `${tipo}_${base}_${carimbo()}${parcial ? "_parcial" : ""}`;
  const dados = gerarCsv(colunas, linhas);
  for (let n = 1; n < 1000; n++) {
    const arquivo = join(dir, `${nome}${n > 1 ? `_${n}` : ""}.csv`);
    try {
      writeFileSync(arquivo, dados, { encoding: "utf8", flag: "wx" });
      return arquivo;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`Não foi possível criar um arquivo novo para ${nome} em ${dir}.`);
}

export const juntar = (v: unknown[]) => v.filter((x) => x !== null && x !== undefined && x !== "").join("|");
export const segundos = (inicio: number) => Math.round((Date.now() - inicio) / 100) / 10;
