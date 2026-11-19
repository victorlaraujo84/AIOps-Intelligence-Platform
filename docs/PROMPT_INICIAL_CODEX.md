# Prompt inicial para Codex — PR-00 Discovery

Atue como arquiteto principal e integrador da **AIOps Intelligence Platform**. Leia `AGENTS.md`, `README_INICIO_CODEX.md`, `.agents/skills/aiops-platform-orchestrator/SKILL.md` e toda a documentação em `docs/` relativa à arquitetura híbrida, estado atual, divisão Codex/DeepSeek Harness, Docker e critérios de aceite.

**Objetivo:** validar a realidade do repositório no commit atual e produzir o Discovery do PR-00. **Não modifique código, migrations, configurações nem arquivos existentes nesta etapa.** Se precisar registrar o relatório, apresente-o na resposta ou solicite autorização para criar um arquivo em branch de documentação.

1. Liste serviços, dependências, versões, endpoints, schemas, testes, Dockerfiles e Compose reais.
2. Classifique funcionalidades como implementadas/parciais/ausentes/não testadas; cite caminhos/linhas e diferencie código de documentação.
3. Verifique a divergência Web SQLite x API PostgreSQL, a aplicação efetiva de RLS e o risco de migração.
4. Avalie SSRF, segredos, portas expostas, auth, multi-tenancy, workers, filas, cache e logs.
5. Mapeie gaps para TI/IoT híbrido: métricas, séries temporais, serviços, topologia, SDK conectores, MQTT, SNMP, OTLP e RCA.
6. Indique testes que puder executar em ambiente isolado; informe comando, saída, falhas e bloqueios. Não invente execução.
7. Produza ADRs propostas e plano de PRs pequenos, com dependências, rollback e critérios de aceite.
8. Sugira tarefas estritamente isoladas para DeepSeek Harness, com ownership de arquivos, sem delegar segurança crítica ou integração final.
9. Apresente uma checklist de preparação Docker e os dados/credenciais/documentos que preciso fornecer, sem solicitá-los em texto aberto.

**Formato da resposta:** resumo executivo; matriz de aderência; P0/P1/P2; decisões abertas; backlog por PR; testes e evidências; bloqueios; recomendação de primeiro PR. Aguarde aprovação.


## Escopo complementar obrigatório no Discovery
Auditar também a lacuna de notificações de saída e ITSM: webhook genérico, Teams, Telegram, e-mail, abertura/atualização/resolução de tickets e sincronização bidirecional futura. Ler `docs/NOTIFICACOES_WEBHOOKS_ITSM.md` e `docs/ROADMAP_NOTIFICACOES_ITSM.md`. Verificar se já existe outbox, worker, policies, retries, DLQ e RBAC por tenant; classificar como implementado/parcial/ausente/não testado com evidências. **Não implementar nesta primeira execução.**
**Decisão adicional aprovada:** primeiro ITSM genérico orientado a capacidades. Inclua `docs/ITSM_GENERICO_CONTRATOS.md` e `docs/PLANO_IMPLEMENTACAO_ITSM_GENERICO_CODEX.md` no Discovery. Identifique gaps e dependências, mas não implemente até aprovação.
