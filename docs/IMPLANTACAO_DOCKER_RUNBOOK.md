# Runbook — Docker Compose (desenvolvimento → homologação → produção)

Para o ambiente local implementado, use [DOCKER_HOMOLOGACAO_LOCAL.md](DOCKER_HOMOLOGACAO_LOCAL.md).
As seções abaixo incluem requisitos e planejamento de produção ainda pendentes; não representam homologação pública concluída.

## Premissas
Implantação inicial em host Docker com Compose; separar Web, API, PostgreSQL/PostGIS, Redis e workers conforme necessidade. **Este documento é um plano, não um relato de deploy realizado.** Antes de produção, corrigir a divergência de persistência Web/SQLite vs Python/PostgreSQL.

## 0. Pré-requisitos
- Host Linux atualizado; Docker Engine e Compose plugin suportados; CPU/RAM/disco dimensionados após carga medida.
- DNS, TLS/reverse proxy, firewall, volumes persistentes, relógio NTP, backup externo e monitoramento do próprio stack.
- Branch/commit identificado; `.env` local **fora do Git**; segredos fortes e distintos por ambiente.
- Escopos de rede autorizados para SNMP/MQTT; credenciais read-only e inventário de endpoints.

## 1. Auditoria inicial (não altera produção)
```bash
git status --short
docker version
docker compose version
docker compose config --quiet
# NÃO executar up antes de revisar compose, portas, senhas e volumes.
```
`docker compose config` pode interpolar segredos; não publicar a saída.

## 2. Ajustes P0 do Compose antes de expor serviços
- Remover publicações externas de `postgres:5432` e `redis:6379`; usar rede interna, acesso administrativo via túnel autenticado quando necessário.
- Trocar placeholders `CHANGE_ME_LOCAL_ONLY`; falhar no startup quando faltar segredo obrigatório.
- Expor Web somente atrás de proxy TLS; avaliar não publicar FastAPI diretamente na Internet.
- Separar networks frontend/backend; configurar limites de recursos, restart, health/readiness e volumes.
- Persistir PostgreSQL e Redis conforme política de durabilidade; migrar Web para Postgres antes de desativar SQLite.
- Adicionar usuário não-root, imagens fixadas por versão/digest quando possível, varredura de dependências e políticas de atualização.
- Verificar que os Dockerfiles não copiam `.env`, dados ou segredos para a imagem.

## 3. Sequência sugerida
1. Backup do SQLite e inventário de registros; teste de restore.
2. ADR de banco e migrações; validação em banco descartável com dados de teste rotulados.
3. Testes de API e autorização com PostgreSQL/RLS; testes de migração e rollback.
4. `docker compose build` em homologação; `docker compose up -d` **somente após aprovação**.
5. `docker compose ps` e `docker compose logs --tail=100` sem expor segredos.
6. Smoke tests: login, RBAC, CRUD site/asset, evento idempotente, isolamento tenant, API health, conectores com status honesto.
7. Testes de restart, persistência, backup/restore, perda de Redis, falha de banco e recuperação.
8. Expor ao usuário final apenas após critérios de segurança e operação cumpridos.

## 4. Coletores
- SNMP: v3, ACLs, timeouts, limite de polls, MIB/OID validado, discovery opt-in.
- MQTT: broker TLS, ACL por tenant/tópico, autenticação e QoS; nenhum broker público sem controle.
- Webhooks/OTLP: autenticação, assinatura/replay protection, limites de payload e cardinalidade.
- Redes privadas: coletor/gateway com egress autorizado; evitar bypass global anti-SSRF.

## 5. Operação e observabilidade
Logs estruturados com tenant e correlation ID sem segredos; métricas de fila/lag, jobs, ingestão, deduplicação, latência e falhas; dashboards internos; alertas de source stale; retenção e quotas; rotação de chaves e certificados; backup com restore periódico.

## 6. Critérios de GO de implantação
- Sem portas de DB/Redis expostas publicamente; TLS funcional.
- Migração sem perda e rollback documentado.
- Teste multi-tenant negativo passando em HTTP e workers.
- Recuperação após reinício e restore comprovados.
- Integrações reais testadas ou marcadas `NOT_CONFIGURED`.
- Previsões permanecem `MODEL_NOT_VALIDATED` até aprovação específica.

## 7. Diagnóstico rápido
```bash
docker compose ps
docker compose logs --tail=100 web api postgres redis
docker compose exec postgres pg_isready -U aiops -d aiops_platform
```
Adapte usuário/banco aos valores locais. Evite colar logs contendo dados sensíveis em prompts externos.


## Docker — serviços de saída de notificações
Planejar worker `notification-worker` separado da API/web, consumindo outbox persistente/filas; `redis` e `postgres` apenas na rede interna, sem exposição pública por padrão. Segredos de SMTP, Teams, Telegram, webhook e ITSM por env seguro/secret manager, nunca em `compose.yaml` versionado. Definir healthcheck, limites, logs sanitizados, DLQ, backoff, alertas de falha de entrega e teste de recuperação após restart. Não ativar envios externos antes de configurar destinos e políticas por tenant.
