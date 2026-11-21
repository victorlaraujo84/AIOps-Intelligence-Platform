import re
from typing import Annotated

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from .postgres_asset_write import get_asset_write_pool
from .postgres_auth import AUTH_HEADERS
from .postgres_inventory import COLUMNS
from .postgres_inventory_write import Domain, Name, audit_inventory_write, inventory_write_identity, inventory_write_transaction


router = APIRouter(prefix="/api/v1/inventory/asset-categories", tags=["inventory"])
CATEGORY_FIELDS = COLUMNS["asset-categories"]
Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


class CreateAssetCategory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Code
    label: Name
    domain: Domain


@router.post("", status_code=201)
async def create_category(
    body: CreateAssetCategory,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(inventory_write_identity)],
    pool: Annotated[asyncpg.Pool, Depends(get_asset_write_pool)],
):
    code = re.sub(r"[^a-z0-9_]", "_", body.code.lower())
    domain = re.sub(r"[^a-z0-9_]", "_", body.domain)
    async with inventory_write_transaction(pool, identity, "aiops_asset_writer") as (connection, tenant):
        category = await connection.fetchrow(
            f"""
            INSERT INTO public.asset_categories (tenant_id, code, label, domain)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (tenant_id, code) DO NOTHING
            RETURNING {CATEGORY_FIELDS}
            """,
            tenant, code, body.label, domain,
        )
        if category is None:
            raise HTTPException(409, "Categoria de ativo já existe neste tenant.", headers=AUTH_HEADERS)
        await audit_inventory_write(connection, tenant, identity, "ASSET_CATEGORY_CREATED", "asset_category", category["id"])
    response.headers.update(AUTH_HEADERS)
    return dict(category)
