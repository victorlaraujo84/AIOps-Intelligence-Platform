# Roadmap incremental — notificações e ITSM

| PR | Prioridade | Responsável sugerido | Entrega | Gate de aceite |
|---|---|---|---|---|
| 16 ADR e contratos de saída | P0 | Codex | especificação de eventos, RBAC, modelo de canal/política e threat model | ADR aprovado; sem chamadas externas |
| 17 Outbox e workers | P0 | Codex | migrações, outbox, idempotência, retry/DLQ e métricas | teste de crash/retry, cross-tenant e rollback |
| 18 Webhook genérico | P1 | Codex; Harness auxilia com fixtures/testes | adapter HTTP, HMAC, templates, destino autorizado | testes reais em endpoint de homologação, SSRF e replay |
| 19 Teams, Telegram e e-mail | P1 | Harness cria adaptadores isolados; Codex revisa e integra | adapters, templates e UI de configuração | testes com credenciais autorizadas; sem fake-success |
| 20 ITSM outbound | P1 | Codex | adapter ITSM **genérico configurável** com capacidades verificadas; criar/consultar e atualizar/resolver somente quando suportado | mapeamento, idempotência e auditoria comprovados |
| 21 ITSM inbound/bidirecional | P2 | Codex | callbacks, polling incremental, reconciliação, anti-loop | assinaturas/replay, conflito e isolamento testados |
| 22 Políticas avançadas e operação | P2 | Harness propõe UI e testes; Codex integra | escalonamento, silêncio, manutenção, métricas e runbook | simulação controlada de falhas com dados de teste identificados |

**Sequenciamento:** PR 16 pode iniciar após o Discovery; PR 17 depende de definição da persistência unificada e modelo canônico; PRs 18–20 dependem do 17; PR 21 depende do 20. A implantação Docker exige worker e fila/DB operacionais, com secrets fora do compose versionado.

**Handoff Harness:** branch/worktree isolada; diff, testes, riscos, documentação, sem acesso a segredos reais, sem editar simultaneamente schema/auth/compose. Codex mantém revisão, integração e merge.

**Desdobramento do PR 20:** executar ITSM-00 a ITSM-07 conforme `docs/PLANO_IMPLEMENTACAO_ITSM_GENERICO_CODEX.md`; PR 21 só após inbound documentado e autorizado.
