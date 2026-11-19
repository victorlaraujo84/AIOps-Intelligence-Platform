# AIOps Intelligence Platform — Pacote consolidado para Codex

Este pacote consolida a documentação de construção e evolução da plataforma híbrida de monitoramento TI, redes, telecom, IoT, energia e ambiente, incluindo notificações multicanal e ITSM genérico. É **documentação e skill**, não contém o código-fonte nem credenciais.

## Instalação no repositório
1. Crie uma branch documental.
2. Copie `AGENTS.md`, `.agents/` e `docs/` para a raiz do repositório, preservando caminhos.
3. Compare e revise conflitos com arquivos existentes antes de sobrescrever.
4. Faça commit e abra PR para revisão.
5. No Codex, comece por `docs/PROMPT_VALIDACAO_CODEX.md` (auditoria somente leitura) e, após aprovação, `docs/PROMPT_INICIAL_CODEX.md`.

## Documentos essenciais
- `AGENTS.md`: regras gerais.
- `.agents/skills/aiops-platform-orchestrator/SKILL.md`: skill do projeto.
- `docs/VISAO_PRODUTO_HIBRIDA.md`, `docs/DECISOES_E_ESCOPO.md`: produto e decisões.
- `docs/ARQUITETURA_HIBRIDA.md`: arquitetura.
- `docs/ROADMAP_TECNICO_HIBRIDO.md`: evolução em fases.
- `docs/NOTIFICACOES_WEBHOOKS_ITSM.md`: notificações e ITSM.
- `docs/ITSM_GENERICO_CONTRATOS.md`: contrato ITSM genérico.
- `docs/PLANO_IMPLEMENTACAO_ITSM_GENERICO_CODEX.md`: implementação ITSM.
- `docs/PLANO_CODEX_DEEPSEEK_HARNESS.md`: distribuição de tarefas.
- `docs/IMPLANTACAO_DOCKER_RUNBOOK.md`: implantação.
- `docs/CRITERIOS_ACEITE_E_ENTREGAVEIS.md`: aceitação.
- `docs/PROMPT_VALIDACAO_CODEX.md`: validação inicial.

## Observações
Os documentos representam requisitos e decisões, não comprovação de funcionalidades operacionais. Valide o código e execute testes no ambiente real. Não presuma acesso ou credenciais de sistemas externos.
