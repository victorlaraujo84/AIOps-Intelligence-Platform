# Plano de execução — Codex + DeepSeek Harness

## Princípio
**Codex é o integrador e autoridade de merge.** DeepSeek Harness é um executor auxiliar condicionado à sua disponibilidade real e à capacidade de ler o repositório, executar testes e entregar patches. Não presumir integração nativa, isolamento, permissões ou acesso a segredos. Se não estiver disponível, Codex assume os itens delegados.

## Matriz de responsabilidade
| Trabalho | Responsável | Paralelização | Entrega |
|---|---|---|---|
| Discovery global, ADRs e arquitetura | Codex | primeiro | matriz de evidências, riscos, ADRs |
| Inventário de contratos de API, schemas e rotas | Harness | paralelo, leitura | `docs/reviews/CONTRATOS.md` + propostas |
| Inventário de testes e casos de borda | Harness | paralelo, leitura | plano de testes, fixtures **não produtivas** |
| Revisão de ameaças SNMP/MQTT/SSRF/tenancy | Harness | paralelo, leitura | threat model e casos de teste |
| Migração SQLite/Postgres e RLS | Codex | serial após ADR | migração, teste, rollback |
| Contrato canônico eventos/métricas | Codex | após banco | schemas, migrações, API |
| SDK conectores e ingestão | Codex | após contrato | implementações e testes |
| Parser CSV energia, normalizadores isolados | Harness | branch própria, após contrato | patch + teste + benchmark, sem dados reais no repo |
| Templates de dashboards e estados vazios | Harness | branch própria, após API estabilizada | patch UI, acessibilidade e testes |
| Integração de patches, CI e Docker | Codex | serial | PRs, evidências e release |
| ML/backtesting | Codex com skill de validação | após dados reais | NO-GO até evidência suficiente |

## Protocolo de handoff
1. Codex abre issue/tarefa com objetivo, contratos, arquivos permitidos, dependências, critérios de aceite e branch exclusiva.
2. Harness trabalha sem editar `main`, sem credenciais e sem acesso à produção. Para tarefas de código, usar worktree/branch isolada.
3. Harness entrega `HANDOFF.md` com resumo, caminhos modificados, comandos executados, saída real, testes pendentes, riscos e diff/commit.
4. Codex revisa, rejeita alterações não comprovadas, executa CI e testes de segurança e só então integra por PR.
5. Evitar tarefas simultâneas em schema, autenticação, `compose.yaml`, contratos centrais ou migrations.

## Critérios de delegação
Delegar: extração de documentação, revisão estática, geração de testes, scripts pequenos com contratos estáveis, UI isolada, benchmark reproduzível. **Não delegar autonomamente**: alterações de tenant/RLS, segredos, infraestrutura de produção, migrações destrutivas, publicação de modelos ou ações em dispositivos.

## Prompt de tarefa para Harness
> Leia `AGENTS.md`, `docs/DECISOES_E_ESCOPO.md` e o contrato específico. Sua tarefa é [OBJETIVO]. Trabalhe somente em [ARQUIVOS/PATHS], sem tocar migrations, autenticação, Docker ou segredos. Produza diff/patch, testes executados com saída real e `HANDOFF.md`. Não invente dados ou resultados. Se faltar contexto, reporte bloqueio. Não faça merge.

## Prompt de integração para Codex
> Revise o HANDOFF do Harness e seu patch. Verifique conformidade com AGENTS.md, contratos, tenancy e segurança. Execute testes relevantes, documente riscos e abra PR. Não faça merge se os critérios de aceite falharem.

## Otimização
Limitar trabalho duplicado: Codex audita arquitetura e riscos sistêmicos; Harness audita componentes e testes isolados. Definir ownership por arquivo, PRs pequenos, revisão de diffs e checkpoints após cada marco.


## Delegação específica — notificações/ITSM
**Codex:** ADR, esquema, outbox transacional, workers, fila, multi-tenancy, credenciais, assinatura, segurança de rede, ITSM bidirecional, Compose, CI e merge. **DeepSeek Harness:** pesquisa e proposta de contratos sem inventar APIs, fixtures, testes de contrato, templates de mensagem, documentação e adaptadores isolados de Teams/Telegram/e-mail após contrato aprovado. Sem acesso a tokens reais, sem merge direto e sem mudanças concorrentes em schema/auth/Compose. Ver `docs/ROADMAP_NOTIFICACOES_ITSM.md`.