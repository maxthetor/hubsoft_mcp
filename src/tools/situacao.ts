import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HubsoftClient } from "../client.js";
import { API, run } from "../util.js";
import { resumoFinanceiro } from "../faturas.js";

const ENDERECO = `endereco numero complemento bairro cep cidade { nome estado { sigla } }`;

const CLIENTE_FIELDS = `
  id_cliente codigo_cliente nome_razaosocial cpf_cnpj tipo_pessoa data_cadastro
  telefone_primario telefone_secundario email_principal
  servicos {
    id_cliente_servico numero_plano valor data_habilitacao data_cancelamento
    servico { descricao }
    servico_status { descricao prefixo }
    endereco_instalacao { endereco_numero { ${ENDERECO} } }
    cliente_servico_autenticacao {
      login mac_addr phy_addr vlan
      interface_conexao { nome equipamento_conexao { nome } }
      status_conexao_radius { status status_em data_inicio_sessao ip_nas ipv4 ipv6_wan ipv6_lan }
    }
  }`;

const Q_CPF = `query ($v: String!) { cliente: clienteByCpfCnpj(cpf_cnpj: $v) { ${CLIENTE_FIELDS} } }`;
const Q_COD = `query ($v: Int!) { cliente: clienteByCodigo(codigo_cliente: $v) { ${CLIENTE_FIELDS} } }`;

function digits(s: string) {
  return s.replace(/\D/g, "");
}

/** Formata CPF/CNPJ com máscara (o Hubsoft pode guardar em qualquer dos formatos). */
function masked(d: string) {
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return d;
}

export function registerSituacao(server: McpServer, hs: HubsoftClient) {
  const { graphqlPath, maxResponseChars: max } = hs.config;

  server.registerTool(
    "hubsoft_situacao_cliente",
    {
      title: "Situação completa do cliente",
      description:
        "Visão 360° de um cliente numa chamada: cadastro, serviços/planos com status, " +
        "endereço de instalação, login PPPoE, MAC/serial da ONU, VLAN, interface/OLT, " +
        "sessão RADIUS (online/offline, IP, NAS) e resumo financeiro (faturas vencidas com " +
        "dias de atraso, PIX e linha digitável, próxima a vencer e total das demais). " +
        "Para o detalhamento de uma fatura use hubsoft_faturas_cliente com detalhado=true. " +
        "Use como primeira ferramenta quando o usuário perguntar sobre um cliente.",
      inputSchema: {
        cpf_cnpj: z.string().optional().describe("CPF ou CNPJ (com ou sem máscara)."),
        codigo_cliente: z.number().int().positive().optional(),
        incluir_cancelados: z
          .boolean()
          .optional()
          .describe("Incluir serviços cancelados (padrão: não)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ cpf_cnpj, codigo_cliente, incluir_cancelados }) =>
      run(max, async () => {
        if (!cpf_cnpj && !codigo_cliente) {
          throw new Error("Informe cpf_cnpj ou codigo_cliente.");
        }

        // 1) Cadastro + serviços + autenticação + RADIUS (GraphQL)
        let cliente: any = null;
        if (graphqlPath) {
          if (codigo_cliente) {
            const r = await hs.post(graphqlPath, { query: Q_COD, variables: { v: codigo_cliente } });
            cliente = r?.data?.cliente ?? null;
          } else {
            const d = digits(cpf_cnpj!);
            for (const v of [d, masked(d)]) {
              const r = await hs.post(graphqlPath, { query: Q_CPF, variables: { v } });
              cliente = r?.data?.cliente ?? null;
              if (cliente) break;
            }
          }
        } else {
          // sem GraphQL: cai para a rota REST
          const r = await hs.get(`${API}/cliente`, {
            busca: codigo_cliente ? "codigo_cliente" : "cpf_cnpj",
            termo_busca: codigo_cliente ? String(codigo_cliente) : digits(cpf_cnpj!),
            limit: 1,
          });
          cliente = r?.clientes?.[0] ?? null;
        }
        if (!cliente) return { encontrado: false, mensagem: "Cliente não encontrado." };

        if (graphqlPath && !incluir_cancelados && Array.isArray(cliente.servicos)) {
          const total = cliente.servicos.length;
          cliente.servicos = cliente.servicos.filter((s: any) => !s.data_cancelamento);
          const ocultos = total - cliente.servicos.length;
          if (ocultos) cliente.servicos_cancelados_ocultos = ocultos;
        }

        // 2) Faturas em aberto (REST — o GraphQL não filtra faturas por cliente)
        let faturas_em_aberto: unknown;
        try {
          const f = await hs.get(`${API}/cliente/financeiro`, {
            busca: "codigo_cliente",
            termo_busca: String(cliente.codigo_cliente),
            apenas_pendente: "sim",
            limit: 60,
          });
          faturas_em_aberto = resumoFinanceiro(f?.faturas ?? []);
        } catch (e) {
          faturas_em_aberto = { erro: (e as Error).message };
        }

        return { encontrado: true, cliente, faturas_em_aberto };
      }),
  );
}
