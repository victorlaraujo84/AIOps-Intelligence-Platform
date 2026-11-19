# Entregas verificáveis e critérios de aceite

## Marco 0 — Discovery (antes de qualquer implementação)
| ID | Entrega | Evidência mínima |
|---|---|---|
| D00.1 | Inventário real do repositório | commit SHA, caminhos, serviços, versões, comandos |
| D00.2 | Matriz implementado/parcial/ausente/não testado | referências de código e testes |
| D00.3 | Mapa de dados e tenancy | tabelas, endpoints, RLS, fluxos de tenant |
| D00.4 | Threat model e riscos P0/P1/P2 | vetores, severidade, mitigação e teste proposto |
| D00.5 | ADRs pendentes | banco, TSDB, filas, agentes, credenciais |
| D00.6 | Plano de migração | backups, transformação, verificação, rollback |
| D00.7 | Roadmap ajustado | PRs com dependências, owners e DoD |
| D00.8 | Relatório de execução | testes realmente executados e bloqueios |

**Gate:** nenhuma mudança de código até revisão do Discovery.

## Marcos de desenvolvimento
| Marco | Entregável | Aceite observável |
|---|---|---|
| M1 | Banco unificado + segurança | Web/API compartilham fonte de verdade; RLS/tenant negativo; rollback e restore |
| M2 | Catálogo universal + topologia | ativos TI/IoT/energia, serviços e dependências; compatibilidade anterior |
| M3 | Métricas e séries temporais | deduplicação, atraso, consulta, retenção, quota e benchmark real |
| M4 | SDK de conectores | contrato, status real, checkpoint, retries, falha parcial e auditoria |
| M5 | Integrações existentes | Zabbix/Open-Meteo conforme credenciais; SLAview só com docs reais |
| M6 | Coleta nativa | SNMP/MQTT/HTTP/OTLP conforme fase; autorização, TLS e testes de integração |
| M7 | Correlação e RCA | incidentes com evidências, versões de regra e revisão humana |
| M8 | Dashboards operacionais | dados reais, filtros tenant/domínio, estados honestos e acessibilidade |
| M9 | Anomalias e ML | datasets point-in-time, backtest, métricas, shadow mode e decisão GO humana |
| M10 | Homologação Docker | testes E2E, segurança, backup/restore, falha/restart e documentação |

## Definition of Done por PR
- Descrição do escopo, ADR/issue, dependências e riscos.
- Testes unitários, integração, segurança e regressão pertinentes **executados**, com comandos/resultado.
- Teste de isolamento tenant onde houver dados/filas/cache/coletores.
- Migração e rollback se houver mudança persistente.
- Health de conectores baseado em evidência; sem mock apresentado como real.
- Observabilidade, documentação, release notes e configuração de ambiente.
- Evidência de comportamento degradado e estados vazios.
- Sem segredos ou dados privados em commit/logs.

## Métricas de sucesso (sem metas fictícias)
Cobertura de ativos, frescor da telemetria, taxa de eventos associados a ativos, redução de duplicatas, latência de ingestão, taxa de alertas falsos, tempo de triagem, eficácia de RCA com revisão e integridade de tenants. Estabelecer baseline antes de prometer percentuais.


## Entregáveis adicionais — Notification & ITSM Hub
- E-N01: ADR, catálogo de canais, políticas, threat model e contratos de eventos.
- E-N02: persistência de canais/políticas/outbox/tentativas/tickets e migrações reversíveis.
- E-N03: worker com entrega at-least-once, idempotência, retries, DLQ, observabilidade e testes.
- E-N04: webhook genérico seguro com payload versionado, assinatura e verificação em homologação.
- E-N05: adaptadores Teams, Telegram Bot e e-mail testados com credenciais autorizadas.
- E-N06: primeiro adapter ITSM genérico outbound, configurável por tenant; validação real depende de destino com API documentada e sandbox autorizado, sem exigir seleção prévia de fornecedor.
- E-N07: sincronização bidirecional, reconciliação e anti-loop com testes.
- E-N08: painel administrativo, políticas de escalonamento, auditoria e runbook de operação.
Todos exigem evidência de testes e isolamento multi-tenant; status não configurado é aceitável enquanto faltarem credenciais.