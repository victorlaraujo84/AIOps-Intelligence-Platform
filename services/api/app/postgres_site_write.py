from contextlib import asynccontextmanager
import os
from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from .postgres_auth import AUTH_HEADERS, get_current_session
from .postgres_inventory import COLUMNS, inventory_role_pool
from .postgres_inventory_write import Criticality, Name, audit_inventory_write, inventory_write_transaction


router = APIRouter(prefix="/api/v1/inventory/sites", tags=["inventory"])
SITE_FIELDS = COLUMNS["sites"]
Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
State = Annotated[str, StringConstraints(strip_whitespace=True, to_upper=True, pattern=r"^[A-Za-z]{2}$")]

CHECK_WRITER_ROLE = """
SELECT pg_has_role(current_user, 'aiops_site_writer', 'SET')
  AND NOT (
    pg_has_role(current_user, 'aiops_site_writer', 'USAGE')
    OR pg_has_role(current_user, 'aiops_authenticator', 'MEMBER')
    OR pg_has_role(current_user, 'aiops_tenant_reader', 'MEMBER')
    OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR has_schema_privilege(current_user, 'aiops_admin', 'USAGE')
    OR has_schema_privilege(current_user, 'aiops_auth', 'USAGE')
    OR has_any_column_privilege(current_user, 'public.users', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.sessions', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.sites', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege(current_user, 'public.sites', 'DELETE, TRUNCATE, TRIGGER')
    OR has_any_column_privilege(current_user, 'public.audit_logs', 'SELECT, INSERT, UPDATE, REFERENCES')
  )
FROM pg_roles r WHERE r.rolname = current_user
"""


class CreateSite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Code
    name: Name
    municipality: Name | None = None
    uf: State | None = None
    criticality: Criticality = "media"


class UpdateSite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    municipality: Name | None = None
    uf: State | None = None
    criticality: Criticality | None = None


@asynccontextmanager
async def postgres_site_write_lifespan(app: FastAPI):
    dsn = os.environ.get("AIOPS_POSTGRES_SITE_WRITE_DSN", "")
    app.state.site_write_pool = None
    if not dsn:
        yield
        return
    if app.state.postgres_auth is None:
        raise RuntimeError("A gravação de sites exige a autenticação PostgreSQL configurada.")

    async with inventory_role_pool(
        dsn, CHECK_WRITER_ROLE, "Configure uma conta que possa assumir apenas aiops_site_writer sem herdar acesso.",
    ) as pool:
        app.state.site_write_pool = pool
        try:
            yield
        finally:
            app.state.site_write_pool = None


def get_site_write_pool(request: Request) -> asyncpg.Pool:
    pool = request.app.state.site_write_pool
    if pool is None:
        raise HTTPException(503, "Gravação PostgreSQL de sites desabilitada.", headers=AUTH_HEADERS)
    return pool


@router.post("", status_code=201)
async def create_site(
    body: CreateSite,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_site_write_pool)],
):
    async with inventory_write_transaction(pool, identity, "aiops_site_writer") as (connection, tenant):
        site = await connection.fetchrow(
            f"""
            INSERT INTO public.sites (tenant_id, code, name, municipality, uf, criticality)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING {SITE_FIELDS}
            """,
            tenant, body.code.upper(), body.name, body.municipality, body.uf, body.criticality,
        )
        await audit_inventory_write(connection, tenant, identity, "SITE_CREATED", "site", site["id"])
    response.headers.update(AUTH_HEADERS)
    return dict(site)


@router.patch("/{site_id}")
async def update_site(
    site_id: UUID,
    body: UpdateSite,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_site_write_pool)],
):
    changes = body.model_dump(exclude_unset=True)
    if not changes or any(field in changes and changes[field] is None for field in ("name", "criticality")):
        raise HTTPException(422, "Informe campos válidos para atualizar o site.", headers=AUTH_HEADERS)

    # Os únicos nomes possíveis vêm dos campos declarados em UpdateSite.
    assignments = ", ".join(f"{field} = ${index}" for index, field in enumerate(changes, 3))
    async with inventory_write_transaction(pool, identity, "aiops_site_writer") as (connection, tenant):
        site = await connection.fetchrow(
            f"""
            UPDATE public.sites SET {assignments}, updated_at_utc = now()
            WHERE id = $1 AND tenant_id = $2 RETURNING {SITE_FIELDS}
            """,
            site_id, tenant, *changes.values(),
        )
        if site is None:
            raise HTTPException(404, "Site não encontrado.", headers=AUTH_HEADERS)
        await audit_inventory_write(connection, tenant, identity, "SITE_UPDATED", "site", site_id)
    response.headers.update(AUTH_HEADERS)
    return dict(site)
