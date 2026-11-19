# Plano de implementação — ITSM genérico (Codex + Harness)

## Decisão
Primeiro adapter ITSM = **genérico configurável por tenant**; não escolher fornecedor nem presumir endpoints. Manter suporte futuro a adapters específicos. O hub de notificações continua independente do ITSM, mas compartilha outbox/worker quando apropriado.

| PR | Prioridade | Dono | Entregável | Critério de saída |
|---|---|---|---|---|
| ITSM-00 | P0 | Codex | ADR, threat model, capabilities, contratos e revisão de persistência | aprovação humana, sem alterações operacionais |
| ITSM-01 | P0 | Codex | schema/migração de integrações, mapeamentos, vínculos, sync/outbox, RBAC/RLS | testes tenant, rollback e preservação de dados |
| ITSM-02 | P0 | Codex | serviço de orquestração, fila, workers, idempotência, retries/DLQ | crash/restart, 429, timeout ambíguo e reconciliação |
| ITSM-03 | P1 | Harness (isolado), Codex integra | parser/mapeador JSON seguro, schemas, fixtures e testes | sem execução arbitrária, campos inválidos bloqueados |
| ITSM-04 | P1 | Codex | adapter HTTP genérico, segurança e teste de capacidade não destrutivo | SSRF, redirects, auth, TLS e evidências reais |
| ITSM-05 | P1 | Harness UI isolada; Codex integra | tela de configuração, preview de mapeamento, status e histórico | sem segredo exposto, estados honestos, RBAC |
| ITSM-06 | P2 | Codex | inbound opcional, polling, mapeamento bidirecional e anti-loop | replay, conflito, versionamento, política de autoridade |
| ITSM-07 | P1/P2 | Codex | Docker worker, egress, observabilidade, runbook, E2E sandbox | fluxo ponta a ponta comprovado e rollback |

**Dependências:** PR-00 do projeto; persistência unificada PostgreSQL e outbox do hub; aprovação de rede e sandbox antes de chamadas reais. O Codex não deve implementar operações de fornecedor sem documentação.

## Handoff obrigatório do DeepSeek Harness
Entrada: contrato versionado, arquivos permitidos, fixtures sem dados reais, critérios de aceite. Saída: patch isolado, testes, instruções de execução, limitações e `HANDOFF.md`. Proibido editar `AGENTS.md`, migrações, auth, secrets, compose ou worker central sem aprovação explícita. Codex executa validações e decide merge.

## Checklist de evidência
- `npm run lint`, `npm run build`, `npm test` e testes Python quando aplicáveis (registrar saídas reais).
- Testes DB real com PostgreSQL/RLS, não somente mocks.
- Teste webhook outbound e ITSM outbound com mock local **rotulado teste**, seguido de sandbox real.
- `docker compose config`, health checks, persistência, restart e logs sanitizados.
- Estado `NOT_CONFIGURED` para integração sem endpoint/credencial; `NOT_TESTED` em relatórios de verificação não realizada.
