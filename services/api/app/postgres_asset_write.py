from contextlib import asynccontextmanager
import os
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict

from .postgres_auth import AUTH_HEADERS
from .postgres_inventory import COLUMNS, inventory_role_pool
from .postgres_inventory_write import Criticality, Domain, Name, audit_inventory_write, inventory_write_identity, inventory_write_transaction


router = APIRouter(prefix="/api/v1/inventory/assets", tags=["inventory"])
ASSET_FIELDS = COLUMNS["assets"]
GeoreferenceMode = Literal["required", "optional", "none"]

CHECK_WRITER_ROLE = """
SELECT pg_has_role(current_user, 'aiops_asset_writer', 'SET')
  AND NOT (
    pg_has_role(current_user, 'aiops_asset_writer', 'USAGE')
    OR pg_has_role(current_user, 'aiops_authenticator', 'MEMBER')
    OR pg_has_role(current_user, 'aiops_tenant_reader', 'MEMBER')
    OR pg_has_role(current_user, 'aiops_site_writer', 'MEMBER')
    OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR has_schema_privilege(current_user, 'aiops_admin', 'USAGE')
    OR has_schema_privilege(current_user, 'aiops_auth', 'USAGE')
    OR has_any_column_privilege(current_user, 'public.users', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.sessions', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.sites', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_any_column_privilege(current_user, 'public.assets', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege(current_user, 'public.assets', 'DELETE, TRUNCATE, TRIGGER')
    OR has_any_column_privilege(current_user, 'public.asset_categories', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege(current_user, 'public.asset_categories', 'DELETE, TRUNCATE, TRIGGER')
    OR has_any_column_privilege(current_user, 'public.topology_edges', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege(current_user, 'public.topology_edges', 'DELETE, TRUNCATE, TRIGGER')
    OR has_any_column_privilege(current_user, 'public.audit_logs', 'SELECT, INSERT, UPDATE, REFERENCES')
  )
FROM pg_roles r WHERE r.rolname = current_user
"""


class CreateAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    hostname: Name | None = None
    site_id: UUID | None = None
    category_id: UUID | None = None
    domain: Domain = "infra"
    georeference_mode: GeoreferenceMode | None = None
    criticality: Criticality = "media"


class UpdateAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    hostname: Name | None = None
    site_id: UUID | None = None
    category_id: UUID | None = None
    domain: Domain | None = None
    georeference_mode: GeoreferenceMode | None = None
    criticality: Criticality | None = None


@asynccontextmanager
async def postgres_asset_write_lifespan(app: FastAPI):
    dsn = os.environ.get("AIOPS_POSTGRES_ASSET_WRITE_DSN", "")
    app.state.asset_write_pool = None
    if not dsn:
        yield
        return
    if app.state.postgres_auth is None:
        raise RuntimeError("A gravação de ativos exige a autenticação PostgreSQL configurada.")

    async with inventory_role_pool(
        dsn, CHECK_WRITER_ROLE, "Configure uma conta que possa assumir apenas aiops_asset_writer sem herdar acesso.",
    ) as pool:
        app.state.asset_write_pool = pool
        try:
            yield
        finally:
            app.state.asset_write_pool = None


def get_asset_write_pool(request: Request) -> asyncpg.Pool:
    pool = request.app.state.asset_write_pool
    if pool is None:
        raise HTTPException(503, "Gravação PostgreSQL de ativos desabilitada.", headers=AUTH_HEADERS)
    return pool


def validate_site(mode: GeoreferenceMode, site_id: UUID | None):
    if mode == "required" and site_id is None:
        raise HTTPException(422, "Ativos com georreferenciamento obrigatório exigem um site.", headers=AUTH_HEADERS)


async def get_asset_category(connection: asyncpg.Connection, tenant: UUID, category_id: UUID):
    category = await connection.fetchrow(
        "SELECT code, domain FROM public.asset_categories WHERE tenant_id = $1 AND id = $2",
        tenant, category_id,
    )
    if category is None:
        raise HTTPException(422, "Categoria indisponível neste tenant.", headers=AUTH_HEADERS)
    return category


@router.post("", status_code=201)
async def create_asset(
    body: CreateAsset,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(inventory_write_identity)],
    pool: Annotated[asyncpg.Pool, Depends(get_asset_write_pool)],
):
    async with inventory_write_transaction(pool, identity, "aiops_asset_writer") as (connection, tenant):
        mode = body.georeference_mode or ("required" if body.site_id is not None else "none")
        validate_site(mode, body.site_id)
        domain, type_code = body.domain, None
        if body.category_id is not None:
            category = await get_asset_category(connection, tenant, body.category_id)
            type_code = category["code"]
            if "domain" not in body.model_fields_set:
                domain = category["domain"]
        asset = await connection.fetchrow(
            f"""
            INSERT INTO public.assets (
                tenant_id, name, hostname, site_id, domain, georeference_mode, criticality, category_id, asset_type_code
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING {ASSET_FIELDS}
            """,
            tenant, body.name, body.hostname, body.site_id, domain, mode, body.criticality, body.category_id, type_code,
        )
        await audit_inventory_write(connection, tenant, identity, "ASSET_CREATED", "asset", asset["id"])
    response.headers.update(AUTH_HEADERS)
    return dict(asset)


@router.patch("/{asset_id}")
async def update_asset(
    asset_id: UUID,
    body: UpdateAsset,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(inventory_write_identity)],
    pool: Annotated[asyncpg.Pool, Depends(get_asset_write_pool)],
):
    changes = body.model_dump(exclude_unset=True)
    required_fields = ("name", "domain", "georeference_mode", "criticality")
    if not changes or any(field in changes and changes[field] is None for field in required_fields):
        raise HTTPException(422, "Informe campos válidos para atualizar o ativo.", headers=AUTH_HEADERS)

    async with inventory_write_transaction(pool, identity, "aiops_asset_writer") as (connection, tenant):
        updates_site = "site_id" in changes or "georeference_mode" in changes
        if updates_site or "category_id" in changes:
            current = await connection.fetchrow(
                """
                SELECT site_id, georeference_mode, category_id FROM public.assets
                WHERE id = $1 AND tenant_id = $2 FOR UPDATE
                """,
                asset_id, tenant,
            )
            if current is None:
                raise HTTPException(404, "Ativo não encontrado.", headers=AUTH_HEADERS)
            if updates_site:
                validate_site(
                    changes.get("georeference_mode", current["georeference_mode"]),
                    changes.get("site_id", current["site_id"]),
                )
        if "category_id" in changes and changes["category_id"] is not None:
            category = await get_asset_category(connection, tenant, changes["category_id"])
            changes["asset_type_code"] = category["code"]
            changes.setdefault("domain", category["domain"])
        elif "category_id" in changes and current["category_id"] is not None:
            changes["asset_type_code"] = None

        # Os nomes vêm de UpdateAsset e da coluna derivada asset_type_code.
        assignments = ", ".join(f"{field} = ${index}" for index, field in enumerate(changes, 3))
        asset = await connection.fetchrow(
            f"""
            UPDATE public.assets SET {assignments}, updated_at_utc = now()
            WHERE id = $1 AND tenant_id = $2 RETURNING {ASSET_FIELDS}
            """,
            asset_id, tenant, *changes.values(),
        )
        if asset is None:
            raise HTTPException(404, "Ativo não encontrado.", headers=AUTH_HEADERS)
        await audit_inventory_write(connection, tenant, identity, "ASSET_UPDATED", "asset", asset_id)
    response.headers.update(AUTH_HEADERS)
    return dict(asset)


@router.delete("/{asset_id}", status_code=204)
async def delete_asset(
    asset_id: UUID,
    identity: Annotated[asyncpg.Record, Depends(inventory_write_identity)],
    pool: Annotated[asyncpg.Pool, Depends(get_asset_write_pool)],
):
    if identity["role"] not in {"tenant_admin", "super_admin"}:
        raise HTTPException(403, "Apenas administradores podem excluir ativos.", headers=AUTH_HEADERS)
    async with inventory_write_transaction(pool, identity, "aiops_asset_writer") as (connection, tenant):
        removed_id = await connection.fetchval(
            "DELETE FROM public.assets WHERE tenant_id = $1 AND id = $2 RETURNING id",
            tenant, asset_id,
        )
        if removed_id is None:
            raise HTTPException(404, "Ativo não encontrado neste tenant.", headers=AUTH_HEADERS)
        await audit_inventory_write(connection, tenant, identity, "ASSET_DELETED", "asset", removed_id)
    return Response(status_code=204, headers=AUTH_HEADERS)
