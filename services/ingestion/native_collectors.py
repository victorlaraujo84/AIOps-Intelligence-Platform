"""
Coletores nativos autorizados (SNMPv3, MQTT/TLS, ICMP, OTLP).
Regra de segurança inegociável: nenhuma varredura ou coleta é permitida fora de `authorized_collection_scopes` do tenant.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
import ipaddress
from typing import Literal, Optional

CollectionProtocol = Literal["snmp_v3", "mqtt", "icmp", "otlp", "http_agent"]


@dataclass(frozen=True)
class AuthorizedScope:
    scope_id: str
    tenant_id: str
    protocol: CollectionProtocol
    target_cidr_or_host: str
    port: Optional[int] = None
    rate_limit_rpm: int = 60
    is_active: bool = True


@dataclass
class NativeCollectionJob:
    tenant_id: str
    protocol: CollectionProtocol
    target: str
    timeout_sec: float = 3.0
    max_retries: int = 1
    metadata: dict[str, str] = field(default_factory=dict)


def is_target_in_scope(target: str, scope_pattern: str) -> bool:
    clean_target = target.strip().lower()
    clean_pattern = scope_pattern.strip().lower()
    if not clean_target or not clean_pattern or clean_pattern == "*":
        return False

    if clean_target == clean_pattern:
        return True

    if "/" in clean_pattern:
        try:
            network = ipaddress.ip_network(clean_pattern, strict=False)
            addr = ipaddress.ip_address(clean_target)
            return addr in network
        except ValueError:
            return False

    if clean_pattern.startswith("*."):
        suffix = clean_pattern[1:]
        return clean_target.endswith(suffix) and len(clean_target) > len(suffix)

    return False


def authorize_collection_job(job: NativeCollectionJob, scopes: list[AuthorizedScope]) -> tuple[bool, Optional[AuthorizedScope], str]:
    for scope in scopes:
        if not scope.is_active:
            continue
        if scope.tenant_id != job.tenant_id or scope.protocol != job.protocol:
            continue
        if is_target_in_scope(job.target, scope.target_cidr_or_host):
            return True, scope, "AUTHORIZED"

    return False, None, f"BLOCKED_OUT_OF_SCOPE: alvo {job.target!r} ({job.protocol}) sem escopo autorizado para tenant {job.tenant_id}"


def build_not_configured_worker_report(protocol: CollectionProtocol) -> dict[str, str]:
    return {
        "protocol": protocol,
        "status": "NOT_CONFIGURED",
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "detail": "Worker nativo aguardando provisionamento em rede interna do cliente com credenciais e escopo aprovados.",
    }
