# Notification & ITSM Integration Hub — especificação funcional e técnica

**Status:** escopo aprovado em 19/11/2026; **não presumir implementação**. Documento de requisitos para Codex e DeepSeek Harness.

## Objetivo
Converter incidentes correlacionados em comunicações e fluxos de atendimento confiáveis. Separar o pipeline de **ingestão de alertas** do pipeline de **saída de notificações e ITSM**. Suportar múltiplos tenants, regras configuráveis, auditoria e integração segura com ferramentas externas.

## Destinos (MVP e evolução)
| Canal | Abordagem | Dependências / observações |
|---|---|---|
| Webhook genérico | HTTP POST JSON assinado HMAC, versão de schema, headers e autenticação configuráveis | Endpoint fornecido pelo usuário; assinatura, TLS, política de rede e segredo por tenant |
| Microsoft Teams | Adaptador para endpoint de Workflows/Power Automate ou mecanismo oficialmente suportado no tenant | URL e política de autenticação fornecidas; não assumir conectores legados nem inventar payload |
| Telegram Bot | API oficial Bot com token protegido, chat_id autorizado e templates | Bot token, chat_id, limites de envio e consentimento |
| E-mail | SMTP autenticado/TLS ou API de provedor configurado | Host, porta, credenciais, remetente verificado, domínio e política de envio |
| ITSM | Adaptadores específicos por produto e API documentada | **Primeiro adapter = ITSM genérico configurável**; ferramenta real ainda não selecionada; URL, autenticação, mapeamento de campos, estados e permissões |

## Casos de uso
1. Ao abrir incidente crítico validado, notificar canais configurados e, opcionalmente, abrir ticket ITSM.
2. Ao reconhecer, atualizar, escalar ou resolver incidente, emitir notificações conforme política, sem repetir a mesma transição.
3. Relacionar um incidente a um ticket externo e armazenar `external_ticket_id`, `external_url`, `sync_state`, `last_sync_at` e erros.
4. Sincronizar mudanças permitidas do ITSM para o incidente local, com regra explícita de autoridade, prevenção de loops e auditoria.
5. Aplicar regras por tenant, severidade, domínio, site, ativo, horário, equipe e status; suportar silenciamento, manutenção, escalonamento e rate limits.
6. Permitir reenvio controlado, teste de canal e inspeção de histórico de tentativas sem expor segredos.

## Contratos e modelo de dados propostos (nomes sujeitos a ADR)
- `notification_channels`: tenant, tipo, nome, configuração não secreta, referência a segredo, status, política de entrega.
- `notification_policies`: filtros, condições, destinos, horários, cooldown, supressão e versão.
- `notification_templates`: versão, canal, idioma, placeholders aprovados e limite de dados sensíveis.
- `notification_outbox`: evento de domínio, chave de idempotência, tenant, política, destino, payload seguro, estado, próxima tentativa.
- `notification_delivery_attempts`: tentativa, status HTTP/SMTP/API, latência, erro sanitizado, timestamp e correlação.
- `itsm_integrations`: tenant, provedor, configurações, mapeamento, escopo, modo read-only/read-write.
- `itsm_ticket_links`: incidente local, ticket remoto, estado de sincronização, origem e timestamps.
- `itsm_sync_events`: eventos recebidos/enviados, idempotência, versão, decisão de reconciliação e trilha de auditoria.

## Envelope canônico de saída (exemplo de contrato, NÃO evento operacional real)
```json
{
  "schema_version": "1.0",
  "event_id": "<uuid>",
  "event_type": "incident.opened",
  "occurred_at_utc": "<ISO-8601>",
  "incident_id": "<uuid>",
  "severity": "CRITICA",
  "status": "OPEN",
  "asset_id": "<uuid-or-null>",
  "site_id": "<uuid-or-null>",
  "correlation_id": "<uuid>",
  "summary": "<resumo-redigido-conforme-politica>"
}
```
`tenant_id` deve ser imposto pelo contexto autenticado, jamais aceito como autorização do payload externo. Os campos exportados dependem da política de compartilhamento do tenant.

## Entrega confiável e estados
- Outbox transacional + worker independente, fila persistente e processamento **at-least-once**; usar chaves de idempotência e deduplicação no destino quando disponível; não prometer exactly-once.
- Estados: `PENDING`, `PROCESSING`, `DELIVERED`, `RETRY_SCHEDULED`, `FAILED`, `DEAD_LETTER`, `DISABLED`.
- Retentativas com backoff exponencial + jitter, limites, timeout, circuit breaker, DLQ e reprocessamento manual auditado.
- Registrar tentativas sem tokens, cabeçalhos sensíveis, dados pessoais desnecessários ou payloads integrais confidenciais.
- Não disparar chamadas externas dentro da transação de abertura do incidente.

## Segurança
- Credenciais criptografadas/secret manager; rotação, permissões RBAC e isolamento por tenant no DB, worker, fila, cache e API.
- HTTPS/TLS, validação de certificados, allowlist de destinos, DNS e redirect revalidation, prevenção de SSRF e proteção contra exfiltração.
- Webhooks **de entrada** (retorno ITSM) devem validar assinatura ou mecanismo oficial, timestamp/replay, origem quando aplicável e autorização por tenant.
- Minimização e classificação de dados; consentimento e governança para canais externos; observância de LGPD quando aplicável.
- Regras anti-loop ITSM, anti-flood, quiet hours com exceções explícitas para críticos, aprovação de destinos e auditoria.

## Interface administrativa
- Configurar canais e testar conectividade de forma segura.
- Criar políticas de roteamento e escalonamento por tenant.
- Visualizar status de envio, tentativas, falhas e dead letters.
- Mapear estados e campos de tickets ITSM, escolher autoridade de sincronização e ativar bidirecionalidade explicitamente.
- Exibir `NOT_CONFIGURED`, `NO_DATA`, `ERROR` ou equivalente sem apresentar integrações fictícias como operacionais.

## Critérios de aceite
1. Evento `incident.opened` enfileira uma única notificação lógica por política/destino; reprocessamento não gera duplicata lógica.
2. Falha ou indisponibilidade do destino não bloqueia a abertura do incidente.
3. Retries, backoff, DLQ e auditoria demonstrados com testes automatizados.
4. Testes cross-tenant garantem que canal, template, ticket e credencial de outro tenant não sejam acessíveis.
5. Testes SSRF, redirects, DNS, assinatura/replay, logs e sanitização de segredos aprovados.
6. Teams, Telegram e SMTP testados em ambientes autorizados; sem credenciais, marcar pendência, nunca simular sucesso.
7. ITSM: criação, atualização, resolução, recebimento, idempotência, reconciliação e prevenção de loops demonstrados em sandbox documentado.
8. Métricas de entrega: taxa de sucesso, latência, retries, DLQ e falhas por canal, sem cardinalidade excessiva.

## Dependências em aberto
**Resolvido:** primeira integração será ITSM genérico. Qual sistema real servirá de sandbox e quais são seus endpoints documentados? Quais canais são obrigatórios no MVP? Quem fornecerá URLs, bot tokens, SMTP, permissões e sandbox? Qual matriz de severidade, horários e escalonamento? Há requisitos de aprovação para compartilhar incidentes externamente?

## Contrato do ITSM genérico
Ver `docs/ITSM_GENERICO_CONTRATOS.md` e `docs/PLANO_IMPLEMENTACAO_ITSM_GENERICO_CODEX.md`. Não inferir que um adapter HTTP genérico cobre qualquer ITSM sem mapeamento e testes.

## Fila de eventos de incidentes no PostgreSQL

A migração 028 grava mudanças de estado na fila interna na mesma transação que o incidente. Importações históricas por inserção ficam fora da fila. O envelope contém identificadores, estados, severidade e horário, com acesso restrito às funções da fila. O identificador de evento permanece igual em uma nova tentativa.

O papel `aiops_notification_worker` permite reservar um lote com prazo de processamento e concluir apenas a tentativa cujo prazo ainda está válido. Falhas temporárias usam espera exponencial com variação aleatória. Falha permanente ou oito tentativas levam o evento a `DEAD_LETTER`. O estado `PROCESSED` é o reconhecimento do processamento interno. A comprovação de entrega exige o registro separado da tentativa no destino.

A migração prepara o armazenamento e a recuperação de transições. O provisionamento do worker, o roteamento por política, as entregas e a abertura de incidentes por ingestão fazem parte das próximas etapas.

### Entregas de webhook por canal

A migração 034 aplica políticas por tipo de evento e criticidade aos novos eventos de incidente. Cada canal autorizado recebe uma operação durável com chave de idempotência e tentativas próprias. O worker exige origem autorizada e arquivo privado vinculado ao tenant. Respostas temporárias usam espera exponencial, com suporte a `Retry-After`, e chegam à fila de falha definitiva após oito tentativas. Confira a habilitação e o contrato de assinatura no [runbook de implantação](deployment.md#webhooks-de-incidentes).
