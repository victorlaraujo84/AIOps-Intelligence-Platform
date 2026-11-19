"""
Motor determinístico de correlação multidomínio e RCA baseado em evidências.
Suporta TI, Redes/Telecom, IoT, Energia e Ambiente/Clima sem afirmar causalidade como certeza absoluta.
"""
from typing import Literal

RcaCategory = Literal[
    "eletrica",
    "climatica_direta",
    "composta",
    "telecom_outros",
    "ti_aplicacao",
    "iot_sensor",
    "desconhecida",
]


def classify_incident_rca(event_types: list[str], domain: str | None = None) -> RcaCategory:
    normalized = [t.lower() for t in event_types]
    dom = (domain or "").lower()

    has_power = any("power" in t or "ups" in t or "generator" in t for t in normalized) or dom == "energia"
    has_weather = any("weather" in t or "rain" in t or "wind" in t for t in normalized) or dom == "ambiente"
    has_ti = any("app" in t or "http" in t or "db" in t or "otlp" in t or "cpu" in t for t in normalized) or dom == "ti"
    has_iot = any("mqtt" in t or "sensor" in t or "iot" in t for t in normalized) or dom == "iot"
    has_telecom = any("link" in t or "icmp" in t or "network" in t or "snmp" in t for t in normalized) or dom == "rede"

    active_domains = sum([has_power, has_weather, has_ti, has_iot, has_telecom])
    if active_domains >= 2:
        return "composta"
    if has_power:
        return "eletrica"
    if has_weather:
        return "climatica_direta"
    if has_ti:
        return "ti_aplicacao"
    if has_iot:
        return "iot_sensor"
    if has_telecom:
        return "telecom_outros"
    return "desconhecida"
