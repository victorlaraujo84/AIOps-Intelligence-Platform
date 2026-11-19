# Instruções para Google AI Studio — Evolução Híbrida da AIOps Intelligence Platform

**Data:** 19/11/2026  
**Repositório:** https://github.com/victorlaraujo84/AIOps-Intelligence-Platform  
**Objetivo:** Evoluir a aplicação existente, sem reconstruí-la, para uma plataforma híbrida de observabilidade e inteligência operacional de TI, redes/telecom, IoT, energia e ambiente.

## 1. Instrução mestre para colar no Google AI Studio

> **Papel:** Atue como arquiteto de software sênior e engenheiro full stack, especialista em AIOps, observabilidade, TI, redes, IoT, segurança e dados.
>
> **Contexto:** Trabalhe sobre o código efetivamente disponível no projeto AIOps Intelligence Platform. O GitHub acima é referência, mas não presuma acesso ao repositório se não estiver conectado ao ambiente. Preserve dados, interfaces, autenticação, isolamento multi-tenant, funcionalidades existentes e compatibilidade.
>
> **Direção aprovada:** Adotar arquitetura híbrida: (1) integração com plataformas existentes, como SLAview e Zabbix; (2) coleta nativa progressiva de TI e IoT por SNMP, MQTT, HTTP, webhooks, ICMP e OpenTelemetry/OTLP. Não implementar todos os protocolos de uma só vez. Não executar descoberta ou varredura de rede sem autorização e escopo explícitos.
>
> **Domínios:** TI (servidores, aplicações, bancos e serviços), redes/telecom, IoT (sensores e gateways), energia (UPS, geradores, concessionárias) e ambiente/clima. Georreferenciamento é opcional para ativos que não têm localização relevante.
>
> **Modelo comum:** Evoluir inventário de tenants, sites, ativos, serviços, interfaces e dependências. Separar métricas de séries temporais, eventos, logs, incidentes e topologia; normalizar origem, tenant, ativo, timestamps, qualidade e unidade. Evitar enums rígidos para novos tipos de ativos e conectores. Não armazenar todas as métricas como eventos genéricos.
>
> **Conectores:** Definir contrato extensível com configuração por tenant, credenciais seguras, teste real de conectividade, sincronização incremental, limites, retries, saúde, auditoria e idempotência. Preservar integrações existentes. SLAview da Telcomanager é dependência pendente de documentação, URL, versão e autenticação: não inventar endpoints. Não tratar status configurado como prova de conectividade.
>
> **Persistência:** Preservar SQLite no ambiente de preview quando necessário, mas planejar uma única fonte operacional de verdade em produção, com PostgreSQL/PostGIS, estratégia de séries temporais a justificar, migração segura e sem perda de dados. Redis apenas quando justificado. Ingestão histórica de CSVs grandes deve ser incremental, com checkpoints, validação, deduplicação e auditoria.
>
> **Inteligência:** Evoluir deduplicação, correlação temporal, geográfica e por dependências, detecção de anomalias, priorização por impacto e RCA baseado em evidências. Modelos preditivos devem manter proteção anti-leakage, backtesting cronológico, calibração, Shadow Mode e aprovação humana antes de publicação. Não apresentar modelos como validados sem evidências.
>
> **Interface:** Preservar o design e evoluir dashboards por tenant, domínio, site, serviço, criticidade e estado; inventário universal; topologia; mapa opcional; central de integrações; incidentes correlacionados e painéis AIOps. Mostrar estados honestos (`NOT_CONFIGURED`, `NO_DATA`, `SOURCE_STALE`, `INSUFFICIENT_DATA`, `MODEL_NOT_VALIDATED`, `PREDICTION_UNAVAILABLE`) quando não houver dados reais.
>
> **Segurança:** Manter autenticação, RBAC, isolamento por tenant, RLS planejado no PostgreSQL, criptografia de credenciais, logs de auditoria, limites de requisição e proteção SSRF. Para coleta interna, projetar coletores autorizados com escopo explícito; nunca desabilitar indiscriminadamente proteções de rede.
>
> **Restrições:** Não recriar do zero; não remover funcionalidades sem justificativa; não inventar telemetria, incidentes, endpoints, testes, resultados ou conectividade; não alterar produção sem aprovação; não declarar funcionalidade pronta quando for apenas contrato, mock ou interface.
>
> **Ordem de execução:** (A) Inspecione o código existente; (B) entregue Discovery e matriz de impacto; (C) apresente arquitetura e plano incremental; (D) aguarde aprovação; (E) implemente somente a fase aprovada, com testes e documentação. Se o ambiente não suportar backend/coletores reais, registre bloqueios e implemente apenas contratos verificáveis.

## 2. Entregas esperadas — primeira execução (somente análise)

| ID | Entrega | Conteúdo mínimo | Critério de aceite |
|---|---|---|---|
| E01 | **Discovery do estado atual** | Inventário de frontend, backend, banco, rotas, segurança, conectores, testes e módulos AIOps; referências a arquivos reais | Cada conclusão indica arquivo/componente e diferencia implementado, parcial, planejado e não verificado |
| E02 | **Matriz de aderência** | Funcionalidade atual × requisito híbrido × lacuna × impacto × prioridade | Inclui TI, redes, IoT, energia, ambiente, multi-tenancy e governança ML |
| E03 | **Arquitetura-alvo** | Diagrama lógico, fluxo de ingestão, serviços, armazenamento, APIs, contratos e limites de confiança | Explica integração externa e coleta nativa sem duplicar responsabilidades |
| E04 | **Plano de dados e migração** | Evolução de ativos, serviços, métricas, logs, eventos e dependências; SQLite → PostgreSQL; séries temporais | Apresenta migração reversível, integridade, retenção e isolamento por tenant |
| E05 | **Análise de segurança** | SSRF, coletores internos, autenticação, RBAC/RLS, segredos, MQTT/SNMP e auditoria | Riscos classificados e controles verificáveis; sem acesso não autorizado |
| E06 | **Roadmap de implementação** | Fases, PRs pequenos, dependências, P0/P1/P2, testes e critérios de aceite | Cada PR tem escopo limitado, evidência de conclusão e rollback quando aplicável |
| E07 | **Relatório de limitações** | Dependências externas e funcionalidades não testadas ou não disponíveis no AI Studio | Nenhuma capacidade é anunciada como operacional sem validação |

**Gate de aprovação:** Não alterar código antes de apresentar E01–E07 e receber autorização explícita para a primeira fase.

## 3. Entregas esperadas — implementação por fases (após aprovação)

### Fase 0 — Preparação e proteção da base (P0)
- Baseline reproduzível: comandos de instalação, build, lint e testes, com resultados reais.
- Inventário de regressões e testes de segurança multi-tenant.
- Plano de migração e estratégia de rollback.
- **Aceite:** estado atual reproduzido; falhas e limitações registradas; nenhuma perda de dados.

### Fase 1 — Núcleo universal de observabilidade (P0)
- Modelo de ativos extensível, serviços e dependências.
- Contratos de métricas, eventos, logs e incidentes separados.
- APIs e telas de inventário compatíveis com dados existentes.
- **Aceite:** novos tipos de ativos podem ser cadastrados sem mudanças rígidas no código; testes de tenant e migração passam.

### Fase 2 — Conectores externos (P1)
- SDK/contrato de conectores, execução auditável, health checks e estados honestos.
- Preservação do Open-Meteo e conectores já disponíveis; expansão condicionada a documentação real.
- SLAview permanece `NOT_CONFIGURED` até confirmação da API.
- **Aceite:** conectores testados com respostas reais ou fixtures explicitamente identificadas como testes; falhas e retries rastreáveis.

### Fase 3 — Coleta nativa autorizada (P1)
- Workers e filas, isolamento por tenant, limites e autenticação.
- Primeiro protocolo selecionado por caso de uso real; evolução posterior para SNMPv3, MQTT/TLS, webhooks e OTLP.
- **Aceite:** coleta só ocorre em alvos autorizados; há testes de timeout, duplicação, falha e segurança.

### Fase 4 — Correlação e inteligência operacional (P1)
- Correlação multidomínio, deduplicação, dependências, hipóteses RCA e evidências.
- Interface de incidentes com origem, temporalidade e justificativa.
- **Aceite:** cenários de teste reproduzíveis e rastreáveis; sem inferir causalidade como certeza.

### Fase 5 — Predição e governança (P2)
- Features sem vazamento temporal; baselines, modelos e avaliação cronológica.
- Shadow Mode, versionamento, métricas, aprovação humana.
- **Aceite:** nenhuma previsão publicada sem dados históricos adequados e aprovação documentada.

### Fase 6 — Homologação e operação (P2)
- Testes de carga, isolamento, retenção, observabilidade dos coletores, backup/restauração e documentação.
- **Aceite:** evidências de testes, critérios GO/NO-GO e runbooks operacionais.

## 4. Formato obrigatório da resposta do AI Studio

1. **Resumo executivo** — situação atual e recomendação.
2. **Evidências do código** — caminhos de arquivos e achados concretos.
3. **Matriz de aderência** — existente, parcial, ausente, não verificado.
4. **Arquitetura proposta** — componentes, fluxos, segurança e dados.
5. **Riscos e bloqueios** — P0/P1/P2, dependências externas.
6. **Backlog de PRs** — objetivo, arquivos prováveis, critérios de aceite, testes e rollback.
7. **Limitações do ambiente** — o que não foi possível verificar.
8. **Pedido de aprovação** — qual será a primeira alteração e por quê.

## 5. Critérios globais de qualidade

- Zero dados operacionais fictícios em produção ou dashboards.
- Zero declarações de testes executados sem logs reais.
- Isolamento multi-tenant validado no servidor e, quando migrado, no banco.
- Segurança por padrão para coletores e conectores.
- Compatibilidade com funcionalidades atuais e migrações auditáveis.
- Contratos documentados e testes automatizados para novas funcionalidades.
- Cada fase deve gerar um resumo de arquivos alterados, testes executados, pendências e próximos passos.

## 6. Como utilizar

1. Abra a aplicação existente no Google AI Studio.
2. Garanta backup ou commit da versão atual.
3. Copie a seção **1. Instrução mestre** para o chat do AI Studio.
4. Envie também as seções **2 a 5** como critérios de entrega, ou anexe este Markdown se o ambiente permitir.
5. Peça a **primeira execução somente de análise**; aprove a implementação depois de revisar E01–E07.
6. Versione este arquivo em `docs/INSTRUCOES_AI_STUDIO_AIOPS_HIBRIDA.md` no GitHub.
