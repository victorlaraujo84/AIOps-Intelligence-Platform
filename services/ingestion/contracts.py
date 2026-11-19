"""
Contrato dos conectores reais de ingestão (Rede, Energia e Clima).
Proibido simular respostas de APIs externas ou gerar telemetria sintética em produção.
"""
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class SyncResult:
    status: str  # SUCCESS | PARTIAL | ERROR | NOT_CONFIGURED
    records_ingested: int
    records_deduplicated: int
    error_message: str | None = None


class BaseConnector(Protocol):
    connector_type: str

    async def test_connectivity(self) -> tuple[bool, str]: ...
    async def fetch_and_normalize(self, tenant_id: str) -> SyncResult: ...
