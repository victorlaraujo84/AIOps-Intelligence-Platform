import os
from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict

from .postgres_auth import AUTH_HEADERS, PostgresAuth, get_auth, get_token, unauthorized


router = APIRouter(prefix="/api/v1/inventory/incidents", tags=["itsm"])
ExpectedTenant = Annotated[UUID, Header(alias="X-AIOps-Expected-Tenant")]
Auth = Annotated[PostgresAuth, Depends(get_auth)]
Token = Annotated[str, Depends(get_token)]


class TicketRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    integration_id: UUID


async def itsm_query(auth, token, query, tenant, incident, *args):
    try:
        return await auth.pool.fetch(query, auth.token_hash(token), tenant, incident, *args, timeout=5)
    except asyncpg.PostgresError as error:
        if error.sqlstate == "28000":
            raise unauthorized() from None
        errors = {
            "42501": (403, "Permissão insuficiente para solicitar chamado."),
            "P1001": (409, "Selecione ou confirme o tenant ativo."),
            "P1003": (404, "Incidente não encontrado neste tenant."),
            "P1020": (409, "Destino ITSM indisponível."),
        }
        status, message = errors.get(error.sqlstate, (503, "ITSM temporariamente indisponível."))
    except (asyncpg.InterfaceError, OSError, TimeoutError):
        status, message = 503, "ITSM temporariamente indisponível."
    raise HTTPException(status, message, headers=AUTH_HEADERS) from None


@router.get("/{incident_id}/itsm/tickets")
async def list_incident_tickets(incident_id: UUID, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token):
    if os.environ.get("AIOPS_POSTGRES_ITSM") != "true":
        raise HTTPException(404, "ITSM desabilitado.", headers=AUTH_HEADERS)
    rows = await itsm_query(auth, token, "SELECT * FROM aiops_auth.list_incident_itsm($1, $2, $3)", tenant, incident_id)
    response.headers.update(AUTH_HEADERS)
    return {"items": [dict(row) for row in rows]}


@router.post("/{incident_id}/itsm/tickets", status_code=202)
async def request_ticket(
    incident_id: UUID, body: TicketRequest, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token,
):
    if os.environ.get("AIOPS_POSTGRES_ITSM") != "true" or os.environ.get("AIOPS_POSTGRES_INCIDENT_WRITES") != "true":
        raise HTTPException(404, "Operações ITSM desabilitadas.", headers=AUTH_HEADERS)
    rows = await itsm_query(
        auth, token, "SELECT * FROM aiops_auth.request_itsm_creation($1, $2, $3, $4)",
        tenant, incident_id, body.integration_id,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(rows[0])
