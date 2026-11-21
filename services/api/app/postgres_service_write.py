from contextlib import asynccontextmanager
import os
import re
from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .postgres_auth import AUTH_HEADERS, get_current_session
from .postgres_inventory import COLUMNS, inventory_role_pool
from .postgres_inventory_write import Criticality, Domain, Name, audit_inventory_write, inventory_write_transaction


class ServiceWriteRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def validate_request(request: Request):
            try:
                return await handler(request)
            except RequestValidationError:
                raise HTTPException(422, "Dados cadastrais do serviço inválidos.", headers=AUTH_HEADERS) from None

        return validate_request


router = APIRouter(prefix="/api/v1/inventory/services", tags=["inventory"], route_class=ServiceWriteRoute)
SERVICE_FIELDS = COLUMNS["services"]
Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]
SlaPercentage = Annotated[float, Field(strict=True, ge=0, le=100, allow_inf_nan=False)]

CHECK_WRITER_ROLE = """
SELECT pg_has_role(current_user, 'aiops_service_writer', 'SET')
  AND NOT (
    pg_has_role(current_user, 'aiops_service_writer', 'USAGE')
    OR pg_has_role(current_user, 'aiops_authenticator', 'MEMBER')
    OR pg_has_role(current_user, 'aiops_tenant_reader', 'MEMBER')
    OR pg_has_role(current_user, 'aiops_site_writer', 'MEMBER')
    OR pg_has_role(current_user, 'aiops_asset_writer', 'MEMBER')
    OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR has_schema_privilege(current_user, 'aiops_admin', 'USAGE')
    OR has_schema_privilege(current_user, 'aiops_auth', 'USAGE')
    OR has_any_column_privilege(current_user, 'public.users', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.sessions', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.service_dependencies', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_any_column_privilege(current_user, 'public.services', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege(current_user, 'public.services', 'DELETE, TRUNCATE, TRIGGER')
    OR has_any_column_privilege(current_user, 'public.audit_logs', 'SELECT, INSERT, UPDATE, REFERENCES')
  )
FROM pg_roles r WHERE r.rolname = current_user
"""


class CreateService(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Code
    name: Name
    domain: Domain = "ti"
    criticality: Criticality = "alta"
    owner_team: Name | None = None
    sla_target_pct: SlaPercentage | None = None
    description: Description | None = None


class UpdateService(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    domain: Domain | None = None
    criticality: Criticality | None = None
    owner_team: Name | None = None
    sla_target_pct: SlaPercentage | None = None
    description: Description | None = None


@asynccontextmanager
async def postgres_service_write_lifespan(app: FastAPI):
    dsn = os.environ.get("AIOPS_POSTGRES_SERVICE_WRITE_DSN", "")
    app.state.service_write_pool = None
    if not dsn:
        yield
        return
    if app.state.postgres_auth is None:
        raise RuntimeError("A gravação de serviços exige a autenticação PostgreSQL configurada.")

    async with inventory_role_pool(
        dsn, CHECK_WRITER_ROLE, "Configure uma conta que possa assumir apenas aiops_service_writer sem herdar acesso.",
    ) as pool:
        app.state.service_write_pool = pool
        try:
            yield
        finally:
            app.state.service_write_pool = None


def get_service_write_pool(request: Request) -> asyncpg.Pool:
    pool = request.app.state.service_write_pool
    if pool is None:
        raise HTTPException(503, "Gravação PostgreSQL de serviços desabilitada.", headers=AUTH_HEADERS)
    return pool


@router.post("", status_code=201)
async def create_service(
    body: CreateService,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_service_write_pool)],
):
    code = re.sub(r"[^A-Z0-9_-]", "_", body.code.upper())
    async with inventory_write_transaction(pool, identity, "aiops_service_writer") as (connection, tenant):
        service = await connection.fetchrow(
            f"""
            INSERT INTO public.services (tenant_id, code, name, domain, criticality, owner_team, sla_target_pct, description)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING {SERVICE_FIELDS}
            """,
            tenant, code, body.name, body.domain, body.criticality, body.owner_team, body.sla_target_pct, body.description,
        )
        await audit_inventory_write(connection, tenant, identity, "SERVICE_CREATED", "service", service["id"])
    response.headers.update(AUTH_HEADERS)
    return dict(service)


@router.patch("/{service_id}")
async def update_service(
    service_id: UUID,
    body: UpdateService,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_service_write_pool)],
):
    changes = body.model_dump(exclude_unset=True)
    required_fields = ("name", "domain", "criticality")
    if not changes or any(field in changes and changes[field] is None for field in required_fields):
        raise HTTPException(422, "Informe campos válidos para atualizar o serviço.", headers=AUTH_HEADERS)

    # Os nomes das colunas vêm dos campos declarados em UpdateService.
    assignments = ", ".join(f"{field} = ${index}" for index, field in enumerate(changes, 3))
    async with inventory_write_transaction(pool, identity, "aiops_service_writer") as (connection, tenant):
        service = await connection.fetchrow(
            f"""
            UPDATE public.services SET {assignments}, updated_at_utc = now()
            WHERE id = $1 AND tenant_id = $2 RETURNING {SERVICE_FIELDS}
            """,
            service_id, tenant, *changes.values(),
        )
        if service is None:
            raise HTTPException(404, "Serviço não encontrado.", headers=AUTH_HEADERS)
        await audit_inventory_write(connection, tenant, identity, "SERVICE_UPDATED", "service", service_id)
    response.headers.update(AUTH_HEADERS)
    return dict(service)
