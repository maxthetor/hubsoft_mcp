# Política de Privacidade — hubsoft-mcp

Última atualização: 31 de outubro de 2026

O **hubsoft-mcp** (servidor MCP, CLI, skill e plugin) é software livre (MIT) que roda **no computador de quem o usa**. Ele não tem servidor próprio, não envia dados ao autor do projeto e não usa telemetria.

## Dados coletados

O projeto não coleta dados. Ele lê da API do Hubsoft do **seu provedor** somente o que o assistente de IA solicita para responder às suas perguntas: dados cadastrais de clientes, serviços, autenticação PPPoE, sessões RADIUS, faturas, atendimentos, ordens de serviço e notas fiscais.

## Uso e armazenamento

- As credenciais (URL, client ID, client secret, usuário e senha) ficam somente no seu computador: no armazenamento seguro do Claude Desktop ou do Claude Code, ou em variáveis de ambiente e arquivos `.env` que você mesmo controla.
- O token de acesso do Hubsoft fica apenas na memória do processo, enquanto ele roda.
- Nenhum dado de clientes é gravado em disco pelo projeto.
- Senhas retornadas pelo Hubsoft (ex.: PPPoE) são mascaradas por padrão.

## Compartilhamento com terceiros

Os dados trafegam apenas entre:

1. o seu computador e a **API do Hubsoft do seu provedor** (via HTTPS); e
2. o seu computador e o **assistente de IA que você escolheu** (Claude, OpenCode, Cursor etc.). Nele, os resultados das consultas entram no contexto da conversa e ficam sujeitos à política de privacidade desse fornecedor.

O projeto não compartilha dados com nenhuma outra parte.

## Retenção

O projeto não retém dados. O histórico das conversas segue a política do assistente de IA utilizado. Os dados no Hubsoft seguem a política do seu provedor.

## Responsabilidades (LGPD)

O provedor de internet é o controlador dos dados dos assinantes. Cabe a ele e a quem usa esta ferramenta garantir base legal, acesso mínimo necessário e perfis de permissão adequados no Hubsoft.

## Contato

Dúvidas ou problemas: <https://github.com/maxthetor/hubsoft_mcp/issues>
