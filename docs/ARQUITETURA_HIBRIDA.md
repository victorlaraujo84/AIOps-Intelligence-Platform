# Arquitetura-alvo — observabilidade híbrida TI + IoT

**Status:** proposta de evolução. **Não confundir com arquitetura já entregue.** Código inspecionado em 18–19/11/2026: Express/SQLite, migração PostgreSQL/PostGIS, FastAPI básico, ingestão de eventos e Open-Meteo; validar novamente no Codex.

## Fluxo lógico
```text
Ferramentas existentes: SLAview | Zabbix | PRTG | APIs de energia/clima
Coleta nativa autorizada: SNMP | MQTT | HTTP | Webhooks | OTLP
                         |                  |
                         +--> Adaptadores / gateways -->+
                                                       |
                   Normalização + identidade de ativo + tenant
                                                       |
                   Pipeline durável, validação, idempotência, DLQ
                                                       |
                 +------------------+------------------+
                 |                  |                  |
           Inventário/topologia  Eventos/incidentes  Métricas/logs
                 |                  |                  |
                 +------------ Context Engine ----------+
                                  |
                     Correlação, anomalias, RCA
                                  |
                    ML em Shadow Mode (se validado)
                                  |
                      Dashboards / API / auditoria
```

## Modelo de domínio
- **Tenant e identidade:** `tenant_id` resolvido no servidor, nunca confiado a payload externo.
- **Entidades:** `sites`, `assets`, `services` (implementação parcial no runtime Express/SQLite; integração de produção pendente), `asset_relationships`/`topology_edges` com tipos de dependência física, lógica, serviço, gateway e energia.
- **Sinais distintos:** `canonical_events` para mudanças/ocorrências; `metric_samples` para séries numéricas com `metric_name`, `unit`, `value`, `labels`, `event_time_utc`, `observed_at_utc`, `ingested_at_utc`, `source`, `quality_flag`; logs/traces opcionais por necessidade, com contratos próprios.
- **Inventário e catálogo:** tipagem extensível por domínio/capability, não CHECK rígido que exija migração para cada novo plugin.
- **Proveniência:** identificador externo, conector, versão do esquema, idempotency key, qualidade, timestamps e rastreio de transformações.
- **Incidentes:** evidências verificáveis, hipóteses, versão de regras, revisão humana; não inferir causalidade apenas por coincidência temporal.

## Armazenamento e escala
- PostgreSQL + PostGIS como sistema transacional e geográfico de produção, com RLS testado.
- Avaliar TimescaleDB (se licença/implantação permitirem), particionamento nativo PostgreSQL ou TSDB dedicado após benchmark real de cardinalidade, frequência, retenção e consultas. **Não escolher TSDB sem medição.**
- Redis e filas/streams para buffering, backpressure e workers; escolher broker após levantamento de volume e requisitos de entrega.
- Retenção configurável por tenant, agregações e política de alta cardinalidade; separar dados brutos, agregados e incidentes.
- Resolver divergência atual: Web Express usa SQLite no Compose enquanto Python mira PostgreSQL. Definir fonte única de verdade e migração compatível antes de produção.

## Contrato de conectores
`validate_config`, `test_connection`, `discover_capabilities`, `collect/poll` ou `receive`, `normalize`, `health`, `checkpoint`, `close`. Definir autenticação, TLS, escopos, rate limits, timeouts, retries com jitter, idempotência, paginação, cursor, métricas de saúde, falhas parciais e circuit breaker. Status `HEALTHY` apenas com evidência de conectividade e ingestão recente.

## Coletores nativos
- **SNMP:** v3 preferencial; v2c apenas sob exceção e rede controlada; polling com limites; traps por receptor autenticado/restrito.
- **MQTT:** TLS, ACL por tópico e tenant, QoS configurável, deduplicação, tratamento de mensagens atrasadas e desconexões.
- **HTTP/Webhooks:** autenticação de origem, assinatura quando suportada, proteção contra replay e limites de payload.
- **OTLP:** receiver compatível para métricas/logs/traces quando priorizado; preservar atributos e controlar cardinalidade.
- **Gateways locais:** opcionais para redes privadas/IoT, comunicação outbound e gestão de credenciais/identidade; não expor dispositivos à Internet.
- **SSRF:** revisar validação de DNS, redirects e rebinding; IP privado permitido somente em conectores/agentes internos explicitamente autorizados, com segmentação e allowlist, nunca por bypass global.

## Segurança e governança
RLS e autorização no servidor; isolamento em workers, filas, cache e armazenamento; rotação de segredos; auditoria; RBAC; TLS; políticas por tenant; aprovação antes de qualquer descoberta ativa ou ação remota. Sem dados sintéticos em telas produtivas. Integrações inicialmente read-only. IA generativa opcional, offline por padrão, com autorização explícita para transmissão.

## Motor de inteligência
1. Regras determinísticas e agrupamento por janela/ativo/topologia, com evidência.
2. Baselines e anomalias estatísticas por tipo de métrica e ativo, após dados suficientes.
3. Modelos preditivos por domínio/horizonte, com split cronológico, embargo, anti-leakage, calibração, Shadow Mode e GO humano.
4. Correlacionar clima/energia/rede/IoT sem assumir que toda proximidade temporal indica causa.

## Compatibilidade com o existente
Preservar CRUD, geografia, topologia e contratos existentes. Criar migrações versionadas e testes de regressão; manter API compatível quando possível. Tratar o CSV energético real de ~3 GB via streaming, checkpoints e idempotência; esquema pendente de amostra. SLAview depende de URL, versão, auth e documentação do tenant; não inventar endpoints.


## Camada de comunicação e gestão de serviços — escopo adicional aprovado
Adicionar **Notification & ITSM Integration Hub** após a correlação e o ciclo de vida dos incidentes. Eventos de domínio geram mensagens em outbox transacional; workers independentes aplicam políticas por tenant e entregam notificações via webhook genérico, Microsoft Teams, Telegram Bot e e-mail. Adaptadores ITSM criam/atualizam/resolvem tickets; sincronização bidirecional somente com mapeamento de estados, verificação de callbacks e anti-loop. Ver `docs/NOTIFICACOES_WEBHOOKS_ITSM.md`. Não reutilizar o receptor `webhook_csv` como saída sem contrato específico.
## ITSM genérico — extensão
O Notification & ITSM Integration Hub inclui um serviço de orquestração, adapter HTTP configurável por tenant, registro de capacidades, mapeamento versionado, outbox e workers, links de tickets e reconciliação. Inbound opcional e desabilitado até verificação de autenticação/assinatura. Ver `docs/ITSM_GENERICO_CONTRATOS.md`.
