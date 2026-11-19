"""
Motor determinístico de correlação e RCA (Etapa C).
Categorias suportadas: eletrica, climatica_direta, composta, telecom_outros, desconhecida.
"""
from typing import Literal

RcaCategory = Literal["eletrica", "climatica_direta", "composta", "telecom_outros", "desconhecida"]


def classify_incident_rca(event_types: list[str]) -> RcaCategory:
    has_power = any("power" in t or "ups" in t or "generator" in t for t in event_types)
    has_weather = any("weather" in t or "rain" in t or "wind" in t for t in event_types)
    has_telecom = any("link" in t or "icmp" in t or "network" in t for t in event_types)

    if has_power and has_weather:
        return "composta"
    if has_power:
        return "eletrica"
    if has_weather:
        return "climatica_direta"
    if has_telecom:
        return "telecom_outros"
    return "desconhecida"
