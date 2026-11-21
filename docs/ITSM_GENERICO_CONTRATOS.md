# ITSM genérico — contratos e decisões (ADR proposta)

**Decisão aprovada em 2026-11-19:** o primeiro conector ITSM será **genérico, configurável por tenant e orientado a capacidades**. Nenhum fornecedor foi selecionado. Este documento define contratos internos; **não afirma compatibilidade automática com qualquer ITSM**.

## Objetivo e limites
- Integrar incidentes da AIOps a sistemas ITSM com API HTTP documentada, sem acoplar domínio, banco e UI a um fornecedor.
- MVP **outbound**: criar ticket, consultar estado, adicionar comentário e atualizar campos/estado **apenas se o destino suportar**. Resolução remota opcional por política.
- **Inbound** posterior: webhook autenticado ou polling incremental autorizado. Sem assumir que o ITSM oferece webhook, consulta incremental ou idempotency-key.
- Suportar conectores específicos futuros (GLPI, ServiceNow, Jira SM etc.) que implementem a mesma interface.
- Nunca oferecer um mapeador HTTP arbitrário que permita SSRF, extração de segredos ou execução de expressões/código.

## Modelo de capacidade
Cada instância `itsm_integrations` declara capacidades **confirmadas por configuração e teste**: `create_ticket`, `get_ticket`, `update_ticket`, `add_comment`, `resolve_ticket`, `inbound_webhook`, `incremental_poll`, `idempotency_key`, `etag_or_version`. Inicialmente tudo `false` até validação. A UI desabilita ações não suportadas. `configured` não significa `healthy` nem `tested`.

## Interface de adapter (pseudocódigo TypeScript, contrato, não implementação)
```ts
type Result<T> =
  | { ok: true; value: T; externalRequestId?: string }
  | { ok: false; kind: 'AUTH'|'PERMISSION'|'RATE_LIMIT'|'TIMEOUT'|'NETWORK'|'VALIDATION'|'CONFLICT'|'NOT_SUPPORTED'|'REMOTE_ERROR'; retryable: boolean; retryAfterSeconds?: number; safeMessage: string };

interface ItsMAdapter {
  capabilities(): Promise<Result<Capabilities>>;
  createTicket(request: CreateTicketRequest): Promise<Result<ExternalTicket>>;
  getTicket(link: ExternalTicketLink): Promise<Result<ExternalTicket>>;
  updateTicket?(link: ExternalTicketLink, patch: TicketPatch): Promise<Result<ExternalTicket>>;
  addComment?(link: ExternalTicketLink, comment: TicketComment): Promise<Result<ExternalTicket>>;
  resolveTicket?(link: ExternalTicketLink, resolution: TicketResolution): Promise<Result<ExternalTicket>>;
  verifyInbound?(rawBody: Uint8Array, headers: Record<string,string>): Promise<Result<VerifiedRemoteEvent>>;
  pollChanges?(cursor: string | null): Promise<Result<{ changes: VerifiedRemoteEvent[]; nextCursor: string | null }>>;
}
```
`tenant_id` **não é recebido do cliente como autoridade**: injetar contexto autenticado no serviço que chama o adapter. O adapter não recebe segredos em logs nem em payloads de domínio.

## Modelo canônico de ticket
- `local_incident_id`, `tenant_id` (internos), `integration_id`, `correlation_id`, `operation_id` e `idempotency_key`.
- `summary`, `description` sanitizada, `severity`, `priority`, `category`, `service_id?`, `asset_id?`, `site_id?`, `occurred_at_utc`, `evidence_refs[]` (somente referências autorizadas).
- `external_ticket_id`, `external_url` (validada), `external_status`, `external_version?`, `last_sync_at_utc`, `last_sync_direction`, `last_error_code` (sem segredo).
- Não presumir equivalência entre severidade AIOps, impacto, urgência e prioridade ITSM: usar tabela explícita de mapeamento por tenant, com fallback documentado ou bloqueio seguro.

## Mapeamento configurável, seguro e versionado
Configuração por tenant: `base_url` HTTPS permitida, método e **caminhos de operação declarados**, headers permitidos, modo de autenticação suportado, nomes de campos, templates JSON restritos, mapeamento de estados/prioridades, timeouts, rate limits e versão de mapeamento. Não permitir código arbitrário, URL por evento, header Host dinâmico, template capaz de ler credenciais, redirecionamento sem revalidação, ou expressão com acesso ao ambiente. Validar contra JSON Schema e restringir placeholders a campos explicitamente permitidos. Segredos por secret reference; nunca em config JSON exportável.

## Contrato HTTP interno sugerido (API AIOps, sujeito a ADR)
- `POST /api/itsm/integrations` — configura integração para tenant ativo (RBAC admin).
- `POST /api/itsm/integrations/{id}/test` — teste **real e não destrutivo** de autenticação/capacidades, sem criar ticket por padrão.
- `GET /api/itsm/integrations/{id}/capabilities` — retorna capacidades verificadas e data da verificação.
- `POST /api/incidents/{incidentId}/itsm/tickets` — solicita abertura assíncrona, com idempotência; retorna operação `PENDING`, não ticket fictício.
- `GET /api/incidents/{incidentId}/itsm/tickets` — vínculos e estado de sincronização.
- `POST /api/itsm/integrations/{id}/inbound` — somente se a autenticação/assinatura oficial estiver configurada e verificada; caso contrário desabilitado.
Endpoints são **proposta de API interna**, não endpoints de fornecedor.

## Exemplo de comando interno (dados sintéticos de contrato, não evento real)
```json
{
  "schema_version": "1.0",
  "operation_id": "<uuid>",
  "correlation_id": "<uuid>",
  "incident_id": "<uuid>",
  "integration_id": "<uuid>",
  "action": "create_ticket",
  "idempotency_key": "<tenant:integration:incident:action:version>",
  "requested_at_utc": "<ISO-8601>"
}
```

## Consistência, sincronização e loops
1. Alteração local grava operação na outbox **na mesma transação**; worker executa HTTP fora da transação.
2. Garantia **at-least-once**: duplicatas remotas podem ocorrer se o destino não oferecer idempotência. Antes de repetir `create_ticket` após timeout ambíguo, tentar reconciliação por chave de correlação/campo externo, **se API permitir**; caso contrário marcar `NEEDS_RECONCILIATION` e solicitar intervenção, sem criar cegamente outro ticket.
3. Persistir vínculo único por `(tenant_id, integration_id, incident_id, relation_type)` e por `(tenant_id, integration_id, external_ticket_id)` quando conhecido.
4. Fluxo inbound: validar assinatura/autorização, timestamp/replay, tenant derivado da integração, origem e versão; comparar `origin_system`, `operation_id`, `external_version` e política de autoridade; não reenviar mudanças refletidas.
5. Política inicial: **AIOps é autoridade sobre o incidente local**; ITSM é autoridade sobre o ticket remoto. Mudança de estado local a partir do remoto só com mapeamento/autoridade explicitamente aprovados. Conflitos auditados, não sobrescritos silenciosamente.
6. `GET`/consulta não é prova de suporte a criação. Teste de criação só em sandbox autorizado e com limpeza acordada.

## Estados de operação
`NOT_CONFIGURED`, `CONFIGURED`, `TESTING`, `HEALTHY`, `ERROR`, `SOURCE_STALE`, `DISABLED`; operação: `PENDING`, `PROCESSING`, `SUCCEEDED`, `RETRY_SCHEDULED`, `FAILED`, `DEAD_LETTER`, `NEEDS_RECONCILIATION`, `NOT_SUPPORTED`. Não confundir sucesso de enfileiramento com sucesso remoto.

## Segurança e proteção de dados
- TLS, allowlist de hosts e rotas, resolução DNS e redirects revalidados, bloqueio SSRF, egress control, limites de payload, rate limit e timeouts.
- Redes internas: usar agente/worker de rede explicitamente autorizado; **não** relaxar SSRF global.
- Escopo RBAC por tenant, RLS, segredo criptografado e rotação; auditoria sem dados sensíveis; minimização de PII/LGPD.
- Webhook inbound exige verificação real de assinatura ou autenticação oficial. Se inexistente, não ativar webhook; considerar polling com credencial de leitura.

## Aceite do MVP genérico
- CRUD de configuração + RBAC e auditoria; capabilities verdadeiras e demonstráveis.
- Mapeamento por tenant validado com fixtures e contratos; falhas de campos obrigatórios não geram envio.
- Create/outbound via worker, vínculo persistido, idempotência local, timeout ambíguo e reconciliação tratados.
- Testes de isolamento multi-tenant, SSRF/redirect/DNS, auth, 429/Retry-After, 401/403, 5xx, timeout, DLQ, crash/restart e sanitização.
- Prova de ponta a ponta em **sandbox ITSM documentado** antes de declarar integração funcional. Sem sandbox, classificar `NOT_TESTED`/`NOT_CONFIGURED`.
- Documentar quais capacidades são suportadas pelo primeiro destino real; não anunciar integração universal.

## Pendências para implantação real
URL/versão/API do ITSM, autenticação, sandbox, esquema dos tickets, estados e transições, prioridade, regras de sincronização, rede permitida, credenciais e política de compartilhamento. Essas dependências não bloqueiam a criação de contratos, schemas, mocks **explicitamente de teste** e testes unitários.

## Destinos de homologação

Os quatro destinos usam o mesmo contrato interno. Zere as capacidades verificadas ao trocar URL, credencial, versão ou mapeamento. As configurações abaixo ficam em `NOT_CONFIGURED` até o provisionamento de cada sandbox.

| Destino | Contrato a configurar e validar |
|---|---|
| GLPI | Confirme a versão e o escopo de chamados. Para a API V2, derive as rotas e campos do Swagger da instância. O cliente inicial usa a API V1 e encerra a sessão após cada operação. [Documentação GLPI V1](https://github.com/glpi-project/glpi/blob/12.0/bugfixes/apirest.md) · [Documentação GLPI V2](https://help.glpi-project.org/documentation/modules/configuration/general/api/restful-api-v2) |
| ServiceNow | Configure a versão da Table API, a tabela `incident`, as permissões de campo e as transições aprovadas. A referência remota da integração deve guardar o `sys_id`. [Criação de incidentes](https://www.servicenow.com/docs/r/api-reference/rest-api-explorer/t_GetStartedCreateInt.html) · [Table API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html) |
| Jira Service Management | Use o contrato Cloud como referência inicial. Confirme a edição da instância, o service desk, o tipo de solicitação, os campos obrigatórios e as transições disponíveis no projeto. [API de solicitações do JSM Cloud](https://developer.atlassian.com/cloud/jira/service-desk/rest/api-group-request/) |
| TOPdesk | Confirme a versão, o escopo da conta de operador, os campos obrigatórios e os estados disponíveis no sandbox. [API Incident Management](https://developers.topdesk.com/explorer/?page=incident) |

Comece com uma consulta autenticada a um item de teste existente. Valide criação e transições em seguida, com um chamado de teste identificável e limpeza combinada com o responsável pelo sandbox. Registre a evidência de cada capacidade separadamente.


O cliente HTTP inclui criação e consulta. As demais operações aguardam os mapeamentos e o orquestrador. Em uma resposta de criação sem identificador, erro de rede ou falha remota ambígua, o resultado é `NEEDS_RECONCILIATION`. Nenhuma tentativa de criação é repetida automaticamente pelo cliente.

Para verificar apenas a consulta quando houver um sandbox, use `node --import tsx scripts/check-itsm-connection.ts ARQUIVO_PRIVADO ID_DE_TESTE`. O arquivo JSON com permissões `0600` usa `provider`, `baseUrl`, `allowedOrigin` e `auth`. Os valores de `provider` são `glpi`, `servicenow`, `jira-service-management` e `topdesk`. Em `auth`, configure `method` como `glpi_session` com `userToken` e `appToken` opcional, `basic` com `username` e `apiPassword`, ou `bearer` com `accessToken`, conforme o destino. Informe também `callerId` para TOPdesk e `serviceDeskId` e `requestTypeId` para JSM. Configure `allowedOrigin` com a origem HTTPS autorizada e use um chamado de teste existente. A saída do comando registra apenas o resultado da consulta.
