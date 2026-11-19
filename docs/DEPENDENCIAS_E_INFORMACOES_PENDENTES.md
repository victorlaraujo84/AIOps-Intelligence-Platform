# Informações pendentes antes das integrações reais

| Tema | Necessário | Regra até disponibilização |
|---|---|---|
| SLAview Telcomanager | versão, documentação API, URL, método de autenticação, escopo e payload anonimizado | `NOT_CONFIGURED`, sem endpoints inventados |
| Zabbix | versão, API, conta read-only, hosts e templates autorizados | testes em homologação |
| MQTT | broker, TLS, tópicos, QoS, formato, identidade, taxa e retenção | contrato/fixtures apenas |
| SNMP | equipamentos, v3, MIBs/OIDs, escopo de rede e cadência | nenhuma varredura |
| OTLP | sinais desejados, atributos, cardinalidade e exporters | definir receiver e segurança antes de habilitar |
| CSV energia ~3 GB | cabeçalho, amostra anonimizada, período, timezone, semântica, encoding | sem inferir colunas nem importar no Git |
| Dimensionamento | tenants, ativos, eventos/s, amostras/s, retenção, SLA de consulta | benchmark antes de TSDB/broker |
| Docker | SO, CPU/RAM, discos, DNS, domínio, TLS, backup, redes e proxy | deployment de homologação primeiro |
| ML | rótulos confiáveis, histórico, latências, janelas, incidentes e topologia | `MODEL_NOT_VALIDATED` |

**Proteção de segredos:** fornecer chaves somente por secret store/variáveis seguras no ambiente; nunca colar credenciais em chats, issues ou Markdown.

- **ITSM genérico aprovado:** fornecedor real de homologação, API documentada, URL, autenticação, sandbox, campos/estados, permissões e política de sincronização continuam pendentes.
