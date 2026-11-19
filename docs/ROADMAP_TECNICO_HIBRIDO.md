# Roadmap técnico para Codex — arquitetura híbrida

**Data:** 19/11/2026. **Modo inicial:** Discovery e planejamento sem modificar código. PRs seguintes dependem de aprovação.

## P0 — Fundação e segurança
| PR proposto | Entregáveis | Critério de aceite |
|---|---|---|
| 00 Discovery atualizado | inventário de rotas, schemas, testes, conectores, ameaças, gargalos e status real | evidências por arquivo/linha; testes executados com resultados ou bloqueios documentados |
| 01 Persistência de produção | ADR SQLite→PostgreSQL, migrações e caminho de rollback | Web/API compartilham fonte de verdade; isolamento RLS demonstrado |
| 02 Segurança e tenancy | testes cruzados de tenant, SSRF com DNS/redirect, cookies, segredos, filas e RBAC | casos de abuso automatizados; nenhuma credencial exposta |
| 03 Modelo canônico híbrido | entidades serviço/dependências, catálogo extensível, métrica vs evento, timestamps, proveniência | migrações reversíveis, API compatível, testes de unidade e contrato |

## P1 — Ingestão e observabilidade
| PR proposto | Entregáveis | Critério de aceite |
|---|---|---|
| 04 SDK de conectores | contratos, health real, retries, checkpoint, idempotência, limites, logs | testes de contrato com fixtures isoladas; falhas observáveis |
| 05 Integrações existentes | Open-Meteo endurecido; SLAview read-only quando docs chegarem; Zabbix opcional | chamadas reais verificadas em homologação; sem endpoints inventados |
| 06 Ingestão de métricas | pipeline, armazenamento, consulta e retenção | testes de ingestão fora de ordem, duplicatas, cardinalidade e tenant |
| 07 IoT MQTT | conector com TLS, ACL, QoS e normalização | teste com broker de homologação e mensagens reais autorizadas |
| 08 SNMP | polling/traps autorizados, limites, descoberta opt-in | nenhum scan não autorizado; isolamento de redes e credenciais |
| 09 Webhooks/OTLP | ingestão autenticada, schema, proteção replay e limites | testes de carga, segurança e interoperabilidade |
| 10 Energia CSV | importador streaming ~3GB, validação, checkpoint, deduplicação | reprocessamento seguro e métricas reais de throughput |

## P2 — Inteligência e experiência
| PR proposto | Entregáveis | Critério de aceite |
|---|---|---|
| 11 Context engine | correlação entre métricas, eventos, topologia e local | hipóteses RCA auditáveis com evidências e revisão |
| 12 Dashboards | visão por tenant, domínio, ativo, serviço e qualidade | estados honestos sem dados fictícios; RBAC |
| 13 Anomalias | baseline estatístico por métrica/ativo | validação retrospectiva sem vazamento temporal |
| 14 Predição | backtesting, baselines, calibração, Shadow Mode e decisão GO | métricas por horizonte e domínio, aprovação humana |
| 15 Hardening | SLOs, observabilidade interna, backup, restore, testes de carga | critérios de produção acordados e evidenciados |

## Dependências e decisões em aberto
1. SLAview: URL/versão/documentação/autenticação/escopos e amostras reais.
2. CSV energia: cabeçalho, amostra anonimizada, timezone e semântica de eventos.
3. IoT: broker MQTT, tópicos, formatos, identidade de dispositivos, volumes e retenção.
4. SNMP: modelos/OIDs/MIBs, versões, limites e autorização de coleta.
5. Telemetria: ativos, métricas por segundo, cardinalidade de labels, consulta e retenção para decidir TSDB e broker.
6. Topologia: relações físicas, lógicas, de serviço, de energia e gateway; origem e validação.

## Definition of Done para cada PR
Testes reais executados; segurança tenant e autorização cobertas; observabilidade e falhas documentadas; sem dados fictícios em produção; documentação e migrações atualizadas; rollback descrito; benchmark quando alterar pipeline de dados; nenhum segredo em logs/commits.

## Instrução inicial para Codex
Leia `AGENTS.md`, `docs/CONTEXTO_PROJETO.md`, `docs/VISAO_PRODUTO_HIBRIDA.md`, `docs/ARQUITETURA_HIBRIDA.md`, `docs/ROADMAP_TECNICO_HIBRIDO.md` e o Discovery existente. Confronte com código atual. Execute PR 00 **somente como auditoria**, sem modificar código. Entregue matriz implementado/parcial/ausente/não testado, riscos P0/P1/P2, decisões arquiteturais, estimativas relativas e plano de PRs. Aguarde aprovação antes de implementar.


## Extensão aprovada: PRs 16–22 — notificações e ITSM
Acrescentar módulo de comunicação operacional e ITSM. Dependências e critérios em `docs/ROADMAP_NOTIFICACOES_ITSM.md`. PR 16 ADR/contratos (P0), PR 17 outbox/worker (P0), PR 18 webhook de saída (P1), PR 19 Teams/Telegram/e-mail (P1), PR 20 ITSM outbound (P1), PR 21 ITSM bidirecional (P2), PR 22 políticas avançadas e operação (P2).
## Complemento ITSM genérico
O PR 20 de ITSM será detalhado nos incrementos ITSM-00 a ITSM-07, sem substituir o roadmap base. Consultar `docs/PLANO_IMPLEMENTACAO_ITSM_GENERICO_CODEX.md`.
