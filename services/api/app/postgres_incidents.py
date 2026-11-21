import json
import os
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import AwareDatetime, BaseModel, ConfigDict, StringConstraints

from .postgres_auth import AUTH_HEADERS, PostgresAuth, get_auth, get_current_session, get_token, unauthorized
from .postgres_inventory import get_inventory_pool, inventory_read_transaction


router = APIRouter(prefix="/api/v1/inventory/incidents", tags=["incidents"])
ExpectedTenant = Annotated[UUID, Header(alias="X-AIOps-Expected-Tenant")]


class IncidentReview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_review: AwareDatetime | None
    rca_category: Literal[
        "eletrica", "climatica_direta", "composta", "telecom_outros",
        "ti_aplicacao", "iot_sensor", "desconhecida",
    ] | None = None
    status: Literal["OPEN", "ACKNOWLEDGED", "RESOLVED"] | None = None
    review_note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000, pattern=r"^[^\x00]*$")] | None = None


@router.get("/{incident_id}")
async def get_incident(
    incident_id: UUID,
    response: Response,
    expected_tenant: ExpectedTenant,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_inventory_pool)],
    after: UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    if identity["active_tenant_id"] != expected_tenant:
        raise HTTPException(409, "Selecione ou confirme o tenant ativo.", headers=AUTH_HEADERS)

    async with inventory_read_transaction(pool, identity) as (connection, tenant):
        incident = await connection.fetchrow(
            """
            SELECT i.id, i.title, i.status, i.severity, i.rca_category, i.rca_confidence,
                   i.rca_evidence_json, i.rule_version, i.human_reviewed_at_utc,
                   i.opened_at_utc, i.resolved_at_utc, i.impacted_services_count,
                   s.name AS root_site_name, a.name AS root_asset_name
              FROM public.incidents i
              LEFT JOIN public.sites s ON s.tenant_id = i.tenant_id AND s.id = i.root_site_id
              LEFT JOIN public.assets a ON a.tenant_id = i.tenant_id AND a.id = i.root_asset_id
             WHERE i.tenant_id = $1 AND i.id = $2
            """,
            tenant, incident_id,
        )
        if incident is None:
            raise HTTPException(404, "Incidente não encontrado neste tenant.", headers=AUTH_HEADERS)
        events = await connection.fetch(
            """
            SELECT e.id, e.event_type, e.source, e.status, e.observed_at_utc, ie.role_in_incident
              FROM public.incident_events ie
              JOIN public.canonical_events e ON e.tenant_id = ie.tenant_id AND e.id = ie.event_id
             WHERE ie.tenant_id = $1 AND ie.incident_id = $2 AND ($3::uuid IS NULL OR ie.event_id > $3)
             ORDER BY ie.event_id LIMIT $4
            """,
            tenant, incident_id, after, limit + 1,
        )
    details = dict(incident)
    details["rca_evidence"] = json.loads(details.pop("rca_evidence_json"))
    response.headers.update(AUTH_HEADERS)
    return {
        "incident": details,
        "events": [dict(event) for event in events[:limit]],
        "next_after": events[limit - 1]["id"] if len(events) > limit else None,
    }


@router.patch("/{incident_id}/rca-review")
async def review_incident(
    incident_id: UUID,
    body: IncidentReview,
    response: Response,
    expected_tenant: ExpectedTenant,
    auth: Annotated[PostgresAuth, Depends(get_auth)],
    token: Annotated[str, Depends(get_token)],
):
    if os.environ.get("AIOPS_POSTGRES_INCIDENT_WRITES") != "true":
        raise HTTPException(404, "Revisão de incidentes desabilitada.", headers=AUTH_HEADERS)
    try:
        incident = await auth.pool.fetchrow(
            "SELECT * FROM aiops_auth.review_incident($1, $2, $3, $4, $5, $6, $7)",
            auth.token_hash(token), expected_tenant, incident_id, body.expected_review,
            body.rca_category, body.status, body.review_note, timeout=5,
        )
    except asyncpg.PostgresError as error:
        if error.sqlstate == "28000":
            raise unauthorized() from None
        errors = {
            "42501": (403, "Permissão insuficiente para revisar RCA."),
            "22023": (422, "Dados da revisão inválidos."),
            "P1001": (409, "Selecione ou confirme o tenant ativo."),
            "P1003": (404, "Incidente não encontrado neste tenant."),
            "P1005": (409, "O incidente foi revisado. Atualize a consulta e confira as alterações."),
        }
        status, message = errors.get(error.sqlstate, (503, "Revisão de incidentes indisponível."))
        raise HTTPException(status, message, headers=AUTH_HEADERS) from None
    except (asyncpg.InterfaceError, OSError, TimeoutError):
        raise HTTPException(503, "Revisão de incidentes indisponível.", headers=AUTH_HEADERS) from None
    response.headers.update(AUTH_HEADERS)
    return dict(incident)
