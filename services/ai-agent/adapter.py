"""
Adaptadores opcionais para o Agente de IA Híbrido (offline, openai, ollama).
Nunca envia dados sem data_sharing_authorized=True.
"""
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class AiProviderPolicy:
    mode: Literal["offline", "openai", "ollama"]
    data_sharing_authorized: bool = False
    timeout_ms: int = 15000

    def can_transmit_external(self) -> bool:
        if self.mode == "offline":
            return False
        if self.mode == "openai":
            return self.data_sharing_authorized
        return self.data_sharing_authorized
