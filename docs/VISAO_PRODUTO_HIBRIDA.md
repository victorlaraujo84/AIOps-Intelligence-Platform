# Visão de produto — AIOps Intelligence Platform híbrida

**Decisão:** 19/11/2026 | **Status:** visão-alvo aprovada; implementação sujeita a Discovery, testes e PRs.

## Missão
Unificar a visibilidade e a inteligência operacional de ambientes de TI, rede/telecom, IoT, energia e condições ambientais, integrando ferramentas de monitoramento existentes e oferecendo coleta nativa quando necessário. A plataforma deve ajudar equipes NOC, operações de TI e IoT a reduzir ruído, compreender dependências e agir com evidências.

## Proposta de valor
- **Integração primeiro:** preservar ferramentas existentes (SLAview/Telcomanager, Zabbix e outras mediante validação); não reconstruir integralmente um NMS.
- **Coleta nativa seletiva:** SNMP (polling/traps), MQTT, HTTP/API, webhooks e OTLP, conforme requisitos e controles de segurança.
- **Contexto unificado:** inventário, ativos, serviços, locais, topologia, eventos, métricas, estados, qualidade e proveniência.
- **Inteligência progressiva:** deduplicação, correlação, agrupamento, hipóteses de RCA com evidências, anomalias e previsões somente após validação.
- **Multi-tenant desde a origem:** isolamento em banco, jobs, filas, cache, dashboards, credenciais e coletores.

## Domínios e exemplos
| Domínio | Ativos | Sinais e casos de uso |
|---|---|---|
| TI | hosts, VMs, aplicações, bancos, serviços | CPU, memória, latência, disponibilidade, capacidade |
| Redes/Telecom | roteadores, switches, links, firewalls | interfaces, perda, jitter, disponibilidade, dependências |
| IoT | sensores, gateways, dispositivos de campo | telemetria, heartbeat, bateria, conectividade, limites |
| Energia | UPS, geradores, concessionárias | eventos de falta, autonomia, transferência, tensão |
| Ambiente | estações, sensores, APIs meteorológicas | chuva, vento, temperatura, risco contextual |

## Personas
- Operador NOC: incidentes, correlação, evidências, passagem de turno.
- Engenheiro de infraestrutura: dependências, métricas, capacidade e troubleshooting.
- Operador IoT: dispositivos, qualidade da telemetria, estado de gateways e alertas.
- Administrador do tenant: conectores, permissões, retenção e governança.

## Experiência mínima desejada
Visão geral por tenant e domínio; inventário e descoberta autorizada; dashboards de saúde; eventos e métricas em contexto; mapa opcional para ativos geográficos; topologia de dependências; central de integrações com health real; incidentes com linha do tempo e RCA auditável. Nunca representar ausência de telemetria como funcionamento normal.

## Fora do escopo inicial
Substituição completa de Zabbix/SLAview, automação de remediação sem aprovação, SCADA/controle industrial, descoberta ativa não autorizada, previsões sem backtesting ou ações em dispositivos IoT sem governança específica.

## Indicadores de sucesso propostos
Cobertura de ativos por fonte, frescor de coleta, percentual de eventos normalizados, redução de alertas duplicados, precisão da associação a ativos, tempo de triagem, taxa de RCA com evidências e isolamento multi-tenant demonstrado. Estabelecer baseline real antes de definir metas numéricas.
