# Bootstrap do projeto AIOps Intelligence Platform — 19/11/2026

**Repositório:** https://github.com/victorlaraujo84/AIOps-Intelligence-Platform\
**Decisão de produto:** observabilidade híbrida de TI, redes/telecom, IoT, energia e ambiente.\
**Estado:** especificação e plano; não significa que conectores, modelos ou implantação estejam funcionais.

> Pacote incorporado sobre o commit `fe4df40`. Consulte [o registro de importação e conflitos](docs/IMPORTACAO_DOCUMENTAL_2026-11-19.md): documentos históricos não comprovam o estado operacional atual. Esta importação não autoriza implementação nem implantação.

## Como usar
1. Crie branch de documentação a partir da `main`, preservando o código.
2. Copie `AGENTS.md` para a raiz, os arquivos `docs/*.md` para `docs/` e a pasta `.agents/skills/aiops-platform-orchestrator/` inteira para o mesmo caminho no repositório.
3. Faça commit dos arquivos de texto. **Não envie `.env`, senhas, credenciais, dados de clientes ou CSV de ~3 GB.**
4. Abra o repositório no Codex, leia `docs/PROMPT_INICIAL_CODEX.md` e execute apenas **PR-00 Discovery** em modo somente leitura.
5. Após o Discovery, aprove as ADRs de persistência, segurança, filas e séries temporais antes de implementar.
6. Use `docs/PLANO_CODEX_DEEPSEEK_HARNESS.md` para distribuir tarefas sem edição simultânea dos mesmos arquivos.
7. Use `docs/IMPLANTACAO_DOCKER_RUNBOOK.md` para preparar homologação e operação.

## Ordem de leitura
`AGENTS.md` → `docs/DECISOES_E_ESCOPO.md` → `docs/VISAO_PRODUTO_HIBRIDA.md` → `docs/ARQUITETURA_HIBRIDA.md` → `docs/ESTADO_ATUAL_E_GAPS.md` → `docs/ROADMAP_TECNICO_HIBRIDO.md` → `docs/PLANO_CODEX_DEEPSEEK_HARNESS.md` → `docs/CRITERIOS_ACEITE_E_ENTREGAVEIS.md`.

## Skills
- **Nova:** `.agents/skills/aiops-platform-orchestrator/SKILL.md` — governança da evolução híbrida, Docker, Codex/Harness.
- **Históricas:** `aiops-intelligence` e `aiops-validation-v3` são habilidades especializadas de auditoria/backtesting; não foram substituídas nem declaradas como validadas. Seus scripts podem ser incorporados separadamente após auditoria.

## Não realizado neste pacote
Não foram executados `docker compose up`, testes de integração, migrações, verificação de API de SLAview, conexão MQTT/SNMP nem benchmark de banco. Os resultados dependem do ambiente do usuário.


## Extensão de escopo: notificações e ITSM
Incluídos `docs/NOTIFICACOES_WEBHOOKS_ITSM.md` e `docs/ROADMAP_NOTIFICACOES_ITSM.md`; documentos centrais e skill foram atualizados. Antes de implementar, definir o destino de homologação do adapter ITSM genérico, destinos autorizados e política de escalonamento. Use o ZIP revisado em vez do pacote anterior para iniciar o Codex.
## Atualização: ITSM genérico
A primeira integração ITSM é genérica configurável por tenant; nenhuma plataforma específica foi escolhida. Leia `docs/ITSM_GENERICO_CONTRATOS.md` e `docs/PLANO_IMPLEMENTACAO_ITSM_GENERICO_CODEX.md`. Não iniciar integração externa sem API documentada e autorização.
