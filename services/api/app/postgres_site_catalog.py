import re
from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from .postgres_auth import AUTH_HEADERS, get_current_session
from .postgres_inventory import COLUMNS
from .postgres_inventory_write import Name, audit_inventory_write, inventory_write_transaction
from .postgres_site_write import Code, get_site_write_pool


router = APIRouter(prefix="/api/v1/inventory", tags=["inventory"])
CONCESSION_FIELDS = COLUMNS["concessions"]
LOCALITY_TYPE_FIELDS = COLUMNS["locality-types"]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]


class CreateConcession(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Code
    name: Name
    region: Name | None = None
    description: Description | None = None


class CreateLocalityType(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Code
    label: Name
    description: Description | None = None


@router.post("/concessions", status_code=201)
async def create_concession(
    body: CreateConcession,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_site_write_pool)],
):
    async with inventory_write_transaction(pool, identity, "aiops_site_writer") as (connection, tenant):
        concession = await connection.fetchrow(
            f"""
            INSERT INTO public.concessions (tenant_id, code, name, region, description)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (tenant_id, code) DO NOTHING
            RETURNING {CONCESSION_FIELDS}
            """,
            tenant, body.code.upper(), body.name, body.region, body.description,
        )
        if concession is None:
            raise HTTPException(409, "Código de concessão já existe neste tenant.", headers=AUTH_HEADERS)
        await audit_inventory_write(connection, tenant, identity, "CONCESSION_CREATED", "concession", concession["id"])
    response.headers.update(AUTH_HEADERS)
    return dict(concession)


@router.post("/locality-types", status_code=201)
async def create_locality_type(
    body: CreateLocalityType,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_site_write_pool)],
):
    code = re.sub(r"[^A-Z0-9_]", "_", body.code.upper())
    async with inventory_write_transaction(pool, identity, "aiops_site_writer") as (connection, tenant):
        locality_type = await connection.fetchrow(
            f"""
            INSERT INTO public.locality_types (tenant_id, code, label, description)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (tenant_id, code) DO NOTHING
            RETURNING {LOCALITY_TYPE_FIELDS}
            """,
            tenant, code, body.label, body.description,
        )
        if locality_type is None:
            raise HTTPException(409, "Tipo de localidade já cadastrado neste tenant.", headers=AUTH_HEADERS)
        await audit_inventory_write(
            connection, tenant, identity, "LOCALITY_TYPE_CREATED", "locality_type", locality_type["id"],
        )
    response.headers.update(AUTH_HEADERS)
    return dict(locality_type)
