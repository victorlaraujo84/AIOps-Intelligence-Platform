# Importação do pacote documental — 19/11/2026

## Origem e escopo

Pacote fornecido pelo usuário: `AIOPS_CODEX_PROJETO_COMPLETO_2026-11-19.zip`.
SHA-256: `310b5f54ee3db9403b1d09f32e318e559ac191c8c55aac8c0faca9f79926007a`.
Base local revisada: `fe4df4034c2f1e1c5bba659dd104d27d83eb8a89`.

Importação autorizada somente de documentação e skill, em branch separada. O ZIP foi extraído fora do repositório após validação dos caminhos. Foram incorporados seus 28 arquivos, incluindo os guias de entrada necessários às referências de AGENTS.md. O anexo ZIP não integra o commit. Código da aplicação, dependências, migrations e Compose foram preservados.

## Conflitos e decisões da incorporação

| Item | Divergência | Tratamento |
|---|---|---|
| docs/INSTRUCOES_AI_STUDIO_AIOPS_HIBRIDA.md | Único arquivo do ZIP que já existia; versão local era um resumo de sete linhas com afirmação de fases executadas | Adotado o conteúdo completo recebido, que distingue requisitos, análise e autorização de implementação; versão anterior permanece no histórico Git |
| .agents/skills/README.md | Placeholder anterior descrevia somente uma skill futura | Atualizado para listar a skill instalada e distinguir as históricas ausentes |
| docs/ESTADO_ATUAL_E_GAPS.md | CHECKs rígidos e ausência de serviços/métricas/logs já não descrevem fe4df40 | Corrigidas essas linhas; implementação classificada como parcial, sem aprovação operacional |
| docs/DISCOVERY_TECNICO_AIOPS.md | Inspeção histórica sem SHA contém afirmações superadas pelo código atual | Preservado o relato com aviso explícito de caráter histórico e divergências |
| docs/ARQUITETURA_HIBRIDA.md | Catálogo services constava apenas como proposto | Reconhecida a implementação parcial Express/SQLite, sem presumir integração de produção |
| README_INICIO_CODEX.md e docs/CRITERIOS_ACEITE_E_ENTREGAVEIS.md | Trechos antigos exigiam escolha inicial de produto ITSM, mas a decisão final é adapter genérico | Harmonizados com ITSM genérico por tenant; destino/API/sandbox reais continuam pendentes |
| docs/architecture.md e docs/discovery.md preexistentes | Referência a 001_init_postgres.sql, que não existe, e afirmações de particionamento/testes não comprovadas nesta importação | Preservados como documentação anterior; arquivo real é infra/migrations/001_initial_schema.sql; rever no próximo Discovery |
| Roadmaps e prioridades | Pacote usa P0/P1/P2 como fases e propõe PRs 00–22/ITSM-00–07; auditoria anterior usa severidade e outra sequência | Backlogs são propostas; não equivalem a severidades de vulnerabilidade ou autorização para implementar |

Quebras de linha Markdown recebidas com dois espaços finais foram normalizadas para a forma explícita com barra invertida nos quatro documentos apontados por `git diff --check`, preservando a apresentação sem whitespace residual.

## Leitura e fonte de evidência

Começar por README_INICIO_CODEX.md e AGENTS.md. DECISOES_E_ESCOPO.md e ITSM_GENERICO_CONTRATOS.md registram a decisão final do primeiro ITSM genérico. Arquitetura, roadmaps e contratos descrevem alvos; não certificam entrega. Discovery e validation-report anteriores são registros históricos, sujeitos a confirmação no commit em análise. Código e testes realmente executados prevalecem para afirmações de implementação.

Esta importação resolve as ausências documentais detectadas na auditoria anterior; não corrige seus achados de código e não muda o parecer NO-GO de produção. Também não executa automaticamente os prompts incluídos no pacote.

## Verificação desta entrega

- Conferir presença dos dez documentos obrigatórios anteriormente ausentes e dos 28 arquivos recebidos.
- Revisar diff, ausência de marcadores de conflito e referências locais dos documentos de entrada.
- Confirmar que o commit contém somente Markdown/YAML de documentação e skill.
- Não executar build/testes de aplicação: esta entrega não modifica runtime.
- Não fazer push, merge, implantação, envio de notificações ou abertura de chamados nesta entrega.

## Reversão

Reverter o commit documental com `git revert <commit-da-importacao>`, após conferir a branch e alterações locais. O código da aplicação não é afetado por esta entrega.
