import os
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .postgres_auth import AUTH_HEADERS, PostgresAuth, get_auth, get_token, unauthorized


router = APIRouter(prefix="/api/v1/inventory/webhooks", tags=["notifications"])
Tenant = Annotated[UUID, Header(alias="X-AIOps-Expected-Tenant")]
Auth = Annotated[PostgresAuth, Depends(get_auth)]
Token = Annotated[str, Depends(get_token)]
EventType = Literal["incident.opened", "incident.acknowledged", "incident.resolved", "incident.reopened"]


class WebhookChannel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    origin: Annotated[str, StringConstraints(max_length=255)]
    event_types: Annotated[list[EventType], Field(min_length=1, max_length=4)]
    critical_only: Annotated[bool, Field(strict=True)] = True


class WebhookState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: Annotated[bool, Field(strict=True)]


async def webhook_query(auth, token, query, tenant, *args, write=False):
    if os.environ.get("AIOPS_POSTGRES_NOTIFICATIONS") != "true" or (
        write and os.environ.get("AIOPS_POSTGRES_NOTIFICATION_WRITES") != "true"
    ):
        raise HTTPException(404, "Operação de notificações desabilitada.", headers=AUTH_HEADERS)
    try:
        return await auth.pool.fetch(query, auth.token_hash(token), tenant, *args, timeout=5)
    except asyncpg.PostgresError as error:
        if error.sqlstate == "28000":
            raise unauthorized() from None
        errors = {
            "42501": (403, "Acesso restrito aos administradores."),
            "P1001": (409, "Selecione ou confirme o tenant ativo."),
            "P1040": (409, "Limite de canais deste tenant atingido."),
            "P1041": (404, "Canal indisponível neste tenant."),
            "23505": (409, "Já existe um canal com esse nome."),
            "23514": (422, "Dados ou origem do webhook inválidos."),
            "22023": (422, "Política de webhook inválida."),
        }
        status, message = errors.get(error.sqlstate, (503, "Notificações temporariamente indisponíveis."))
    except (asyncpg.InterfaceError, OSError, TimeoutError):
        status, message = 503, "Notificações temporariamente indisponíveis."
    raise HTTPException(status, message, headers=AUTH_HEADERS) from None


@router.get("")
async def list_channels(response: Response, tenant: Tenant, auth: Auth, token: Token):
    rows = await webhook_query(auth, token, "SELECT * FROM aiops_auth.list_webhook_channels($1, $2)", tenant)
    response.headers.update(AUTH_HEADERS)
    return {"items": [dict(row) for row in rows]}


@router.post("", status_code=201)
async def create_channel(body: WebhookChannel, response: Response, tenant: Tenant, auth: Auth, token: Token):
    rows = await webhook_query(
        auth, token, "SELECT aiops_auth.create_webhook_channel($1, $2, $3, $4, $5, $6) AS id",
        tenant, body.name, body.origin, body.event_types, body.critical_only, write=True,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(rows[0])


@router.patch("/{channel}/status")
async def set_channel(channel: UUID, body: WebhookState, response: Response, tenant: Tenant, auth: Auth, token: Token):
    rows = await webhook_query(
        auth, token, "SELECT aiops_auth.set_webhook_channel($1, $2, $3, $4) AS enabled",
        tenant, channel, body.enabled, write=True,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(rows[0])


@router.get("/{channel}/deliveries")
async def list_deliveries(channel: UUID, response: Response, tenant: Tenant, auth: Auth, token: Token):
    rows = await webhook_query(auth, token, "SELECT * FROM aiops_auth.list_webhook_deliveries($1, $2, $3)", tenant, channel)
    response.headers.update(AUTH_HEADERS)
    return {"items": [dict(row) for row in rows]}
