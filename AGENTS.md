# AGENTS.md — AIOps Intelligence Platform

## Missão
Evoluir incrementalmente a aplicação existente para plataforma **híbrida** de observabilidade e inteligência operacional em TI, rede/telecom, IoT, energia e ambiente. Integração externa primeiro; coleta nativa seletiva e autorizada. Não reconstruir a aplicação.

## Documentos mandatórios
Leia `README_INICIO_CODEX.md`, `docs/DECISOES_E_ESCOPO.md`, `docs/ARQUITETURA_HIBRIDA.md`, `docs/ESTADO_ATUAL_E_GAPS.md`, `docs/ROADMAP_TECNICO_HIBRIDO.md`, `docs/PLANO_CODEX_DEEPSEEK_HARNESS.md`, `docs/CRITERIOS_ACEITE_E_ENTREGAVEIS.md`, `docs/IMPLANTACAO_DOCKER_RUNBOOK.md` e a skill `.agents/skills/aiops-platform-orchestrator/SKILL.md`.

## Regras invioláveis
1. **PR-00 somente leitura**: auditar repositório, documentar evidências, riscos, comandos e bloqueios; aguardar aprovação antes de editar código.
2. Não fabricar telemetria, resultados de testes, endpoints, dados geográficos, alertas, previsão, health checks ou integrações. Estados honestos: `NOT_CONFIGURED`, `NO_DATA`, `SOURCE_STALE`, `INSUFFICIENT_DATA`, `MODEL_NOT_VALIDATED`, `PREDICTION_UNAVAILABLE`.
3. Tenant vem de contexto autenticado; impor isolamento em banco/RLS, API, cache, jobs, filas, objetos, conectores e coletores. Testar acesso cruzado.
4. Sem segredo no repositório, prompt, log, trace ou artefato. Exigir configuração por ambiente e rotação; TLS e princípio do menor privilégio.
5. Sem descoberta de rede, scan, SNMP polling, acesso a broker MQTT ou envio a LLM externo sem autorização de escopo e credenciais específicas. Não desabilitar SSRF globalmente para permitir rede interna.
6. SLAview = **Telcomanager** e read-only; versão, URL, autenticação e documentação são pré-requisitos. Não confundir com TRAFip ou CFGtool.
7. Preservar CRUD, autenticação, sites, mapas, topologia, eventos, APIs e dados existentes. Migrações versionadas, reversibilidade e testes de regressão.
8. Separar métricas de eventos e logs; geolocalização opcional para ativos sem localização física. Proveniência, timestamps e idempotência obrigatórios.
9. Predição apenas após validação cronológica anti-leakage, calibração, shadow mode e GO humano. RCA correlacional é hipótese, não causalidade provada.
10. Não considerar serviço pronto porque iniciou ou porque `/health` respondeu; testar fluxos funcionais e integrações reais.

## Trabalho com Codex e DeepSeek Harness
Codex é integrador e dono de ADRs, schema, segurança, migrações, Docker, merge e aceite. Harness recebe tarefas limitadas, preferencialmente somente leitura ou em branch/worktree isolada; entrega relatório, patch, testes e limitações. Codex revisa e executa testes. Não fazer edição concorrente dos mesmos arquivos. Se não houver Harness operacional, Codex executa tudo.

## Workflow por PR
Discovery → ADR aprovada → implementação pequena → lint/build/unit/integration/security → documentação → evidência de execução → rollback → revisão. Todo PR deve apontar riscos, arquivos, testes, limites e critérios de aceite.

## Operação
Docker Compose com serviços isolados; PostgreSQL/PostGIS como fonte transacional alvo, Redis para suporte, Web/API/workers separados. Resolver divergência atual SQLite/Web vs PostgreSQL/Python antes de produção. Não expor PostgreSQL/Redis publicamente. Backup/restore e persistência testados.


## Módulo obrigatório: notificações e ITSM
A plataforma inclui **Notification & ITSM Integration Hub** para saída via webhook genérico, Microsoft Teams, Telegram Bot, e-mail e integração ITSM com sincronização opcional bidirecional. Leia `docs/NOTIFICACOES_WEBHOOKS_ITSM.md` e `docs/ROADMAP_NOTIFICACOES_ITSM.md` antes de alterar incidentes, integrações, jobs ou API. Não confunda webhooks de entrada de telemetria com webhooks de saída. Exigir outbox transacional, entrega at-least-once com idempotência, retries/DLQ, política por tenant, segurança de destino, auditoria, supressão e prevenção de loops ITSM. Nunca afirmar entrega sem confirmação verificável. **Decisão aprovada:** primeira integração ITSM é **genérica, configurável por tenant e orientada a capacidades**; nenhum fornecedor foi escolhido. Ler `docs/ITSM_GENERICO_CONTRATOS.md` e `docs/PLANO_IMPLEMENTACAO_ITSM_GENERICO_CODEX.md`. Não inventar endpoints nem declarar compatibilidade universal.