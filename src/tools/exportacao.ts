import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { API, run } from "../util.js";
import { CAMPO_PESSOAL, gravarCsv, juntar, obter, paginar, segundos, type Contadores, type ResultadoPaginacao } from "../exportar.js";

/**
 * Exportações para CSV (somente GET). O resultado devolvido ao modelo é só o resumo
 * (arquivo, linhas, páginas, tempo, erros): nenhuma linha de dados passa pela conversa.
 * As colunas são uma lista fechada, sem CPF/CNPJ, RG, telefones, e-mails, endereços nem senhas.
 */

export const COLUNAS_SERVICOS = [
  "base", "id_cliente", "codigo_cliente", "nome_razaosocial", "tipo_pessoa",
  "id_cliente_servico", "numero_plano", "plano", "tecnologia", "status", "status_prefixo",
  "login", "mac_addr", "phy_addr", "interface_nome", "interface_tipo",
  "equipamento_conexao_nome", "equipamento_conexao_ip", "interface_roteamento_nome",
  "equipamento_roteamento_nome", "equipamento_roteamento_ip", "cpes_ids", "cpes_phy_addr", "qtd_cpes",
];

export const COLUNAS_CPES = [
  "id_cpe", "phy_addr", "data_ultima_atualizacao", "id_cliente_servico", "login", "status_servico", "cliente",
];

export const COLUNAS_EQUIPAMENTOS = [
  "id_equipamento", "nome", "ipv4", "tipo", "modelo", "fabricante", "autentica_radius",
  "id_interface_conexao", "interface_nome", "interface_tipo", "chassi", "slot", "pon", "vlan", "max_clientes",
  "roteamento_interface_nome", "roteamento_equipamento_nome", "roteamento_equipamento_ip",
];

const RELACOES = "interface,equipamento_conexao,interface_roteamento,equipamento_roteamento,cpes";

const pagInicial = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Página inicial (a API começa em 0). Use só para retomar uma exportação que parou, com o valor de retomar_de_pagina.");

/** Envia notifications/progress quando o cliente pediu (evita timeout em exportações longas). */
function progresso(extra: any, rotulo: string) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || typeof extra?.sendNotification !== "function") return undefined;
  return (lidas: number, total?: number) => {
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: lidas, ...(total ? { total } : {}), message: `${rotulo}: ${lidas}${total ? `/${total}` : ""} páginas` },
      })
      .catch(() => {});
  };
}

/** Resumo padrão de uma exportação paginada. */
function resumo(arquivo: string, linhas: number, r: ResultadoPaginacao, inicio: number, extra: Record<string, unknown> = {}) {
  const completo = r.pagina_falhou === undefined && !r.erros.length;
  return {
    arquivo,
    linhas,
    paginas_lidas: r.paginas_lidas,
    tempo_s: segundos(inicio),
    erros: r.erros,
    completo,
    ...(r.pagina_falhou !== undefined ? { retomar_de_pagina: r.pagina_falhou } : {}),
    ...(r.esperas_429 ? { esperas_429: r.esperas_429 } : {}),
    ...(r.novas_tentativas ? { novas_tentativas: r.novas_tentativas } : {}),
    ...extra,
  };
}

export function linhasServicos(base: string, c: any): Record<string, unknown>[] {
  return (c?.servicos ?? []).map((s: any) => {
    const cpes: any[] = Array.isArray(s?.cpes) ? s.cpes : [];
    return {
      base,
      id_cliente: c.id_cliente,
      codigo_cliente: c.codigo_cliente,
      nome_razaosocial: c.nome_razaosocial,
      tipo_pessoa: c.tipo_pessoa,
      id_cliente_servico: s.id_cliente_servico,
      numero_plano: s.numero_plano,
      plano: s.nome,
      tecnologia: s.tecnologia,
      status: s.status,
      status_prefixo: s.status_prefixo,
      login: s.login,
      mac_addr: s.mac_addr,
      phy_addr: s.phy_addr,
      interface_nome: s.interface?.nome,
      interface_tipo: s.interface?.tipo,
      equipamento_conexao_nome: s.equipamento_conexao?.nome,
      equipamento_conexao_ip: s.equipamento_conexao?.ipv4,
      interface_roteamento_nome: s.interface_roteamento?.nome,
      equipamento_roteamento_nome: s.equipamento_roteamento?.nome,
      equipamento_roteamento_ip: s.equipamento_roteamento?.ipv4,
      cpes_ids: juntar(cpes.map((x) => x?.id_cpe)),
      cpes_phy_addr: juntar(cpes.map((x) => x?.phy_addr)),
      qtd_cpes: cpes.length,
    };
  });
}

export function linhasCpe(cpe: any): Record<string, unknown>[] {
  const base = { id_cpe: cpe?.id_cpe, phy_addr: cpe?.phy_addr, data_ultima_atualizacao: cpe?.data_ultima_atualizacao };
  const servicos: any[] = Array.isArray(cpe?.servicos) ? cpe.servicos : [];
  if (!servicos.length) return [base];
  return servicos.map((s) => ({
    ...base,
    id_cliente_servico: s?.id_cliente_servico,
    login: s?.login,
    status_servico: s?.status,
    cliente: s?.cliente,
  }));
}

/** Detalhe da interface conforme o tipo: interface_gpon, interface_vlan, interface_wireless… */
function detalheInterface(i: any): any {
  const porTipo = i?.[`interface_${String(i?.tipo ?? "").toLowerCase()}`];
  if (porTipo && typeof porTipo === "object") return porTipo;
  const k = Object.keys(i ?? {}).find((x) => x.startsWith("interface_") && x !== "interface_conexao_roteamento" && i[x] && typeof i[x] === "object");
  return k ? i[k] : {};
}

export function linhasEquipamento(e: any): Record<string, unknown>[] {
  const base = {
    id_equipamento: e?.id_equipamento,
    nome: e?.nome,
    ipv4: e?.ipv4,
    tipo: e?.tipo,
    modelo: e?.modelo,
    fabricante: e?.fabricante,
    autentica_radius: e?.autentica_radius,
  };
  const ifs: any[] = Array.isArray(e?.interfaces) ? e.interfaces : [];
  if (!ifs.length) return [base];
  return ifs.map((i) => {
    const d = detalheInterface(i);
    const rot = i?.interface_conexao_roteamento;
    return {
      ...base,
      id_interface_conexao: i?.id_interface_conexao,
      interface_nome: i?.nome,
      interface_tipo: i?.tipo,
      chassi: d?.chassi,
      slot: d?.slot,
      pon: d?.pon,
      vlan: d?.vlan ?? d?.tag,
      max_clientes: d?.max_clientes,
      roteamento_interface_nome: rot?.nome,
      roteamento_equipamento_nome: rot?.equipamento_conexao?.nome,
      roteamento_equipamento_ip: rot?.equipamento_conexao?.ipv4,
    };
  });
}

/** POPs: campos simples que vierem (sem dados pessoais) + equipamentos resumidos. */
export function tabelaPops(pops: any[]) {
  const colunas = ["id_pop", "nome"];
  const linhas = pops.map((p) => {
    const l: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p ?? {})) {
      if (CAMPO_PESSOAL.test(k) || (v !== null && typeof v === "object")) continue;
      l[k] = v;
      if (!colunas.includes(k)) colunas.push(k);
    }
    const eqs: any[] = Array.isArray(p?.equipamentos) ? p.equipamentos : [];
    l.qtd_equipamentos = eqs.length;
    l.equipamentos_ids = juntar(eqs.map((x) => x?.id_equipamento));
    l.equipamentos_nomes = juntar(eqs.map((x) => x?.nome));
    return l;
  });
  colunas.push("qtd_equipamentos", "equipamentos_ids", "equipamentos_nomes");
  return { colunas, linhas };
}

export function registerExportacao(server: McpServer, hs: HubsoftClient) {
  const max = hs.config.maxResponseChars;
  const base = hs.config.nome;
  const dir = () => hs.config.exportDir;
  const anotacoes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const regra =
    " Só GET no Hubsoft; grava um CSV novo (UTF-8 com BOM, separador ';') em HUBSOFT_EXPORT_DIR e devolve " +
    "apenas o resumo (arquivo, linhas, páginas, tempo, erros), nunca os dados. Sem CPF/CNPJ, RG, telefones, " +
    "e-mails, endereços nem senhas. Exige servidor com UMA base. Se parar no meio, o arquivo sai como _parcial " +
    "e o resumo traz retomar_de_pagina.";

  server.registerTool(
    "hubsoft_exportar_servicos",
    {
      title: "Exportar serviços para CSV",
      description:
        "Exporta para CSV todos os serviços de clientes não cancelados da base (REST cliente/todos com as relações " +
        "de interface, equipamentos e CPEs), uma linha por serviço: cliente, plano, status, login, MAC/phy_addr, " +
        "OLT/PON, BNG e CPEs vinculadas." + regra,
      inputSchema: { pagina_inicial: pagInicial },
      annotations: { title: "Exportar serviços para CSV", ...anotacoes },
    },
    async ({ pagina_inicial }: { pagina_inicial?: number }, extra?: any) =>
      run(max, async () => {
        const inicio = Date.now();
        const linhas: Record<string, unknown>[] = [];
        const servicos = new Set<string>();
        const clientes = new Set<string>();
        let duplicados = 0;
        const r = await paginar({
          hs,
          rota: `${API}/cliente/todos`,
          query: { itens_por_pagina: 100, cancelado: "nao", relacoes: RELACOES },
          chave: "clientes",
          paginaInicial: pagina_inicial,
          progresso: progresso(extra, "serviços"),
          aoLer: (lote) => {
            for (const c of lote) {
              clientes.add(String(c?.id_cliente ?? c?.codigo_cliente));
              for (const l of linhasServicos(base, c)) {
                const id = String(l.id_cliente_servico);
                if (servicos.has(id)) duplicados++;
                else {
                  servicos.add(id);
                  linhas.push(l);
                }
              }
            }
          },
        });
        const parcial = r.pagina_falhou !== undefined;
        const arquivo = gravarCsv(dir(), "servicos", base, COLUNAS_SERVICOS, linhas, parcial);
        const aviso =
          !parcial && !pagina_inicial && r.total_registros !== undefined && clientes.size < r.total_registros
            ? `A API informou ${r.total_registros} clientes e foram lidos ${clientes.size} (a paginação pode ter pulado registros).`
            : undefined;
        return resumo(arquivo, linhas.length, r, inicio, {
          ...(duplicados ? { duplicados_descartados: duplicados } : {}),
          ...(aviso ? { aviso } : {}),
        });
      }),
  );

  server.registerTool(
    "hubsoft_exportar_cpes",
    {
      title: "Exportar CPEs para CSV",
      description:
        "Exporta para CSV o inventário de CPEs/ONUs da base (REST rede/cpe/todos, com e sem assinante), uma linha " +
        "por par CPE × serviço (CPE sem serviço = 1 linha com o serviço vazio): id_cpe, phy_addr, última " +
        "atualização, serviço, login, status e o texto do cliente como vem (incluindo '(INATIVO)')." + regra,
      inputSchema: { pagina_inicial: pagInicial },
      annotations: { title: "Exportar CPEs para CSV", ...anotacoes },
    },
    async ({ pagina_inicial }: { pagina_inicial?: number }, extra?: any) =>
      run(max, async () => {
        const inicio = Date.now();
        const linhas: Record<string, unknown>[] = [];
        const vistos = new Set<string>();
        let duplicados = 0;
        const r = await paginar({
          hs,
          rota: `${API}/rede/cpe/todos`,
          query: { itens_por_pagina: 500, somente_assinante_associado: "nao" },
          chave: "cpes",
          paginaInicial: pagina_inicial,
          progresso: progresso(extra, "CPEs"),
          aoLer: (lote) => {
            for (const c of lote) {
              const id = String(c?.id_cpe);
              if (vistos.has(id)) {
                duplicados++;
                continue;
              }
              vistos.add(id);
              linhas.push(...linhasCpe(c));
            }
          },
        });
        const parcial = r.pagina_falhou !== undefined;
        const arquivo = gravarCsv(dir(), "cpes", base, COLUNAS_CPES, linhas, parcial);
        const aviso =
          !parcial && !pagina_inicial && r.total_registros !== undefined && vistos.size < r.total_registros
            ? `A API informou ${r.total_registros} CPEs e foram lidas ${vistos.size} (a paginação pode ter pulado registros).`
            : undefined;
        return resumo(arquivo, linhas.length, r, inicio, {
          ...(duplicados ? { duplicados_descartados: duplicados } : {}),
          ...(aviso ? { aviso } : {}),
        });
      }),
  );

  server.registerTool(
    "hubsoft_exportar_equipamentos",
    {
      title: "Exportar equipamentos e POPs para CSV",
      description:
        "Exporta para CSV os equipamentos de rede da base (REST rede/equipamento), uma linha por interface " +
        "(OLT/PON com chassi/slot/pon, VLAN, roteamento/BNG; equipamento sem interface = 1 linha), e os POPs " +
        "(REST rede/pop) num segundo CSV." + regra,
      inputSchema: {},
      annotations: { title: "Exportar equipamentos e POPs para CSV", ...anotacoes },
    },
    async () =>
      run(max, async () => {
        const inicio = Date.now();
        const cont: Contadores = { requisicoes: 0, esperas_429: 0, novas_tentativas: 0 };
        const erros: string[] = [];
        const arquivos: Record<string, { arquivo: string; linhas: number }> = {};
        let paginas = 0;

        const eq = await obter(hs, `${API}/rede/equipamento`, {}, cont);
        if (eq.ok) {
          paginas++;
          const linhas = (Array.isArray(eq.body?.equipamentos) ? eq.body.equipamentos : []).flatMap(linhasEquipamento);
          arquivos.equipamentos = { arquivo: gravarCsv(dir(), "equipamentos", base, COLUNAS_EQUIPAMENTOS, linhas), linhas: linhas.length };
        } else erros.push(`rede/equipamento: ${eq.erro}`);

        const pop = await obter(hs, `${API}/rede/pop`, {}, cont);
        if (pop.ok) {
          paginas++;
          const t = tabelaPops(Array.isArray(pop.body?.pops) ? pop.body.pops : []);
          arquivos.pops = { arquivo: gravarCsv(dir(), "pops", base, t.colunas, t.linhas), linhas: t.linhas.length };
        } else erros.push(`rede/pop: ${pop.erro}`);

        if (!paginas) throw new Error(`Nada foi exportado. ${erros.join(" | ")}`);
        return {
          arquivos,
          paginas_lidas: paginas,
          tempo_s: segundos(inicio),
          erros,
          completo: !erros.length,
          ...(cont.esperas_429 ? { esperas_429: cont.esperas_429 } : {}),
          ...(cont.novas_tentativas ? { novas_tentativas: cont.novas_tentativas } : {}),
        };
      }),
  );
}
