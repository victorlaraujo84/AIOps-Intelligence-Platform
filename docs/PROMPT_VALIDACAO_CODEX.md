# Prompt de validação técnica — Codex

## Papel e objetivo
Atue como arquiteto sênior, especialista DevSecOps, QA, observabilidade, AIOps e IoT. Faça auditoria **somente leitura** da AIOps Intelligence Platform, confrontando os documentos deste pacote com o código real do repositório. Não implemente correções nesta fase.

## Fontes obrigatórias
Leia `AGENTS.md`, `.agents/skills/aiops-platform-orchestrator/SKILL.md` e os documentos em `docs/`, especialmente arquitetura híbrida, decisões, roadmap, contratos ITSM genéricos, notificações, critérios de aceite e implantação Docker. Liste documentos ausentes.

## Verificações
1. Inventário e aderência: multi-tenancy, RBAC, sites, ativos, serviços, topologia, eventos, métricas, logs, incidentes e RCA.
2. Integrações: Zabbix, PRTG, SLAview (somente mediante documentação real), clima, energia, webhooks, Teams, Telegram Bot, e-mail e ITSM genérico.
3. Coleta nativa: SNMP, MQTT, ICMP, OTLP; não realizar varredura sem autorização explícita.
4. Arquitetura: Express/React, FastAPI, workers, filas, PostgreSQL/PostGIS, SQLite legado, Redis, migrações, RLS, séries temporais e retenção.
5. Segurança: autenticação, segregação por tenant, segredos, SSRF incluindo DNS/redirects, TLS, webhook HMAC, limites, auditoria e prevenção de loops ITSM.
6. Modelos: evidência de treinamento, dados reais, proteção anti-leakage, backtesting cronológico, Shadow Mode, calibração e aprovação humana.
7. Docker: `docker compose config`, builds, healthchecks, persistência, redes, portas expostas, credenciais e recuperação.

## Testes
Execute quando permitido: `npm ci`, `npm run lint`, `npm run build`, `npm test`, testes Python disponíveis, `docker compose config`, `docker compose build` e healthchecks. Registre comando, ambiente, saída e status. Se indisponível, marque NÃO EXECUTADO. Não dispare notificações reais, chamados ITSM ou operações destrutivas.

## Entregáveis obrigatórios
- Relatório executivo e parecer GO / GO COM RESSALVAS / NO-GO.
- Matriz requisito x evidência: IMPLEMENTADO, PARCIAL, NÃO IMPLEMENTADO ou NÃO VERIFICADO.
- Relatório de arquitetura e divergências, com atenção ao SQLite web versus PostgreSQL API.
- Relatório de segurança e riscos P0/P1/P2 com caminhos/linhas e impacto.
- Evidências dos testes realmente executados e limitações.
- Plano de correção em PRs pequenos, dependências e critérios de aceite.
- Checklist de prontidão para implantação Docker.

Não altere código, migrações, configuração nem documentação durante esta auditoria. Aguarde autorização para iniciar correções P0.
