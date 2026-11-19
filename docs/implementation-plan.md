# Plano de Implementação por Etapas

## Etapa A — Google AI Studio (Atual)
- Estrutura de repositório, `.env.example`, `.gitignore`, `compose.yaml`, migração PostgreSQL/PostGIS/RLS.
- Autenticação real, RBAC (`super_admin`, `tenant_admin`, `tenant_operator`, `tenant_viewer`), isolamento multi-tenant server-side, auditoria.
- CRUD completo de Tenants, Usuários, Concessões, Tipos de Localidade, Categorias, Sites (com CEP BrasilAPI/ViaCEP + geocodificação Nominatim), Ativos e Topologia (`topology_edges` com detecção de ciclos).
- Mapa Leaflet com camadas CartoDB Dark Matter / OSM / Esri Satélite, exibindo exclusivamente sites com coordenadas verificadas.
- Central de Integrações com proteção anti-SSRF, Open-Meteo real, ingestão canônica idempotente e correlação determinística inicial de incidentes/RCA.
- Testes automatizados unitários, de segurança multi-tenant e integração executados contra o servidor real.

## Etapa B — Publicação GitHub
- Revisar histórico para garantir ausência de segredos, publicar no repositório GitHub e habilitar workflow CI (`.github/workflows/ci.yml`).

## Etapa C — Codex + AIOps Validation Skill v3.0
- Instalar Skill `aiops-validation-v3` em `.agents/skills/aiops-validation-v3/`.
- Subir `docker compose up` com PostgreSQL/PostGIS + Redis + FastAPI.
- Implementar workers assíncronos Zabbix/PRTG/UPS, feature engine completo (chuva 1h/3h/6h, rajadas, delta pressão, autonomia UPS) e treinamento/backtesting LightGBM/XGBoost com calibração e SHAP.

## Etapa D — Homologação
- Executar testes RLS no PostgreSQL, validar conectores reais, auditar anti-leakage, aprovar modelos em Shadow Mode e emitir decisão `GO`/`CONDITIONAL`/`NO-GO`.
