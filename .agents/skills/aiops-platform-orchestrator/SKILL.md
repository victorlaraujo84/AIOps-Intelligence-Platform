---
name: aiops-platform-orchestrator
description: Orquestra Discovery, arquitetura híbrida TI/IoT, segurança multi-tenant, integração com ferramentas externas, coleta nativa autorizada, Docker Compose e handoff Codex/DeepSeek Harness da AIOps Intelligence Platform.
---

# AIOps Platform Orchestrator — v4.0 (híbrida)

## Quando usar
Quando o usuário pedir Discovery, evolução de arquitetura, integração de monitoramento TI/IoT, planejamento de PRs, Docker/homologação, conectores, telemetria, segurança, correlação, RCA ou distribuição de tarefas entre Codex e Harness.

## Fonte de verdade
Leia `AGENTS.md` e os documentos em `docs/` antes de propor alterações. Priorize o código real e testes executados sobre afirmações de documentos. Identifique o commit auditado. Esta skill **não** substitui as skills históricas de validação de ML; use-as após auditoria e autorização.

## Guardrails
1. Começar em somente leitura (PR-00). Não modificar código ou instalar dependências sem autorização.
2. Não fabricar telemetria, endpoints, conectividade, resultados de testes ou performance.
3. Proteger tenant em API, DB/RLS, jobs, cache, filas e coletores; testes cruzados obrigatórios.
4. Não desabilitar SSRF globalmente; DNS, redirects e redes privadas exigem arquitetura de agentes/allowlist.
5. Nenhum scan, polling, MQTT ou ação em dispositivos sem escopo autorizado.
6. Segredos fora de commits/logs/prompts. Não transmitir dados sensíveis a LLM externo sem autorização.
7. Preservar aplicação e dados existentes; migração e rollback testados.
8. Distinguir evento, métrica, log e trace. Não criar telemetria fictícia.
9. SLAview = Telcomanager; read-only e dependente de documentação real.
10. Predição em NO-GO/Shadow Mode até backtesting cronológico anti-leakage e aprovação humana.

## Workflow
**Fase A — Discovery:** inventário real, matriz de gaps, threat model, testes e ADRs. **Gate humano.**
**Fase B — P0:** unificação de persistência, segurança, modelo canônico híbrido e CI. **Gate humano.**
**Fase C — P1:** SDK de conectores, séries temporais, integrações reais e coleta nativa autorizada, por PRs independentes.
**Fase D — P2:** RCA com evidências, dashboards, anomalias e modelos preditivos validados.
**Fase E — Operação:** Docker Compose seguro, smoke/E2E, restore, carga, observabilidade e documentação.

## Delegação
Codex integra, revisa e faz merge. DeepSeek Harness somente tarefas de escopo estável em branch/worktree isolada, com `HANDOFF.md`, patch, testes e evidências; sem editar simultaneamente schema, auth ou Compose. Ver `docs/PLANO_CODEX_DEEPSEEK_HARNESS.md`.

## Saída esperada
Para cada tarefa: objetivo, evidências (arquivo/linha), classificação implementado/parcial/ausente/não testado, risco P0/P1/P2, decisões abertas, plano incremental, testes realmente executados, critérios de aceite, rollback, dependências e próximos passos.

## Referências
- `references/acceptance-checklist.md`
- `references/docker-checklist.md`
- `docs/ARQUITETURA_HIBRIDA.md`
- `docs/ROADMAP_TECNICO_HIBRIDO.md`
- `docs/ESTADO_ATUAL_E_GAPS.md`


## Expansão v4.2 — Notification & ITSM Integration Hub
Incluir notificações de saída e workflows ITSM no Discovery, arquitetura, threat model, testes e roadmap. Ler obrigatoriamente `docs/NOTIFICACOES_WEBHOOKS_ITSM.md` e `docs/ROADMAP_NOTIFICACOES_ITSM.md`. Separar ingestão de eventos da entrega de notificações; usar outbox transacional, workers, retry/DLQ, deduplicação e trilha de auditoria. Conectores: webhook genérico, Teams, Telegram Bot, SMTP/provedor e ITSM genérico orientado a capacidades; destino real pendente. Não inventar endpoints ou integração operacional. Delegar a Harness apenas adaptadores e testes isolados; Codex é dono de schema, segurança, workers e merge.
## Decisão v4.2 — ITSM genérico
O primeiro adapter ITSM é genérico configurável por tenant. Ler `docs/ITSM_GENERICO_CONTRATOS.md` e `docs/PLANO_IMPLEMENTACAO_ITSM_GENERICO_CODEX.md`; validar capabilities, mapeamento versionado, idempotência e reconciliação após timeout ambíguo. Não criar tickets de teste em produção. Não prometer compatibilidade com produtos não testados.
