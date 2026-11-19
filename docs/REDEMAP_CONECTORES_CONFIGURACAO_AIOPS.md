# RedeMap → AIOps Intelligence Platform — Inventário e configuração de conectores

**Origem inspecionada:** [victorlaraujo84/RedeMap](https://github.com/victorlaraujo84/RedeMap), branch `main`, arquivos `README.md`, `package.json`, `src/services/database.ts`, `src/services/csvParser.ts`, `src/services/correlationEngine.ts` e `.env.example`.

**Objetivo:** reaproveitar as definições e contratos de integração do RedeMap em um **novo projeto independente**, sem assumir que os conectores existentes já executem chamadas reais ou que seus endpoints estejam corretos. Este documento é um guia de configuração e migração; **não é uma certificação de conectividade**.

## 1. Inventário encontrado no código

As definições abaixo foram extraídas da constante `DEFAULT_API_INTEGRATIONS` em `src/services/database.ts`.

| ID no RedeMap | Provedor | URL base configurada | Caminho configurado | Autenticação | Timeout | Polling | Estado no código |
|---|---|---|---|---|---|---|---|
| `api-osm-leaflet` | OpenStreetMap / CartoDB | `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png` | — | nenhuma | 4 s | — | `active: true` |
| `api-inmet` | INMET | `https://apitempo.inmet.gov.br` | `/estacao/dados` | nenhuma | 8 s | 15 min | `active: true` |
| `api-open-meteo` | Open-Meteo | `https://api.open-meteo.com/v1/forecast` | — | nenhuma | 5 s | 30 min | `active: true` |
| `api-cemaden` | CEMADEN | `https://www.cemaden.gov.br` | `/alertas` | nenhuma | 7 s | 10 min | `active: true` |
| `api-cptec` | CPTEC/INPE | `http://servicos.cptec.inpe.br/XML` | `/cidade/previsao.xml` | nenhuma | 6 s | 60 min | `active: true` |
| `api-google-maps` | Google Maps | `https://maps.googleapis.com` | — | API key | 5 s | — | `active: true` |
| `api-brasil-cep` | BrasilAPI | `https://brasilapi.com.br/api/cep/v2/` | — | nenhuma | 4 s | — | `active: true` |

**Atenção:** `active: true`, `lastStatus: 'ok'`, latências e horários de último teste estão **preenchidos estaticamente no código**. Não comprovam disponibilidade, sucesso de autenticação ou chamadas executadas. Alguns caminhos são apenas configurações declaradas e precisam de verificação contra a documentação do provedor; não devem ser usados cegamente como endpoints de produção.

### Outras integrações e mecanismos identificados

- `src/services/csvParser.ts`: importação/exportação CSV de inventário com PapaParse; campos `Hostname`, `TIPO`, `Operadora`, `Localidade`, `IP`, `Modelo`, `Serial`; lógica de atualização por nome/serial.
- `src/services/correlationEngine.ts`: importação CSV de alarmes e incidentes, com correlação meteorológica **simulada**.
- `README.md`: referência a visualização geográfica/topológica, cadastro de sites e importação CSV.
- `.env.example`: `GEMINI_API_KEY`, `VITE_GOOGLE_MAPS_API_KEY` e `APP_URL`.

**Não foi identificado, nos arquivos inspecionados, um conector de API SLAview validado.** O SLAview deve ser implementado como conector separado quando o tenant fornecer versão, método de acesso e documentação. Também não se deve presumir um conector Zabbix/PRTG funcional com base neste inventário parcial.

## 2. Bloqueadores para reutilização direta em produção

1. `src/services/correlationEngine.ts` usa `Math.random()` para gerar rajadas e precipitação e constrói descrições de evidência sem consulta real a uma fonte meteorológica. **Não reutilizar esse motor para RCA ou previsão real.**
2. O parser de alarmes/incidentess atribui horários, tickets, localidades e outros valores de fallback quando campos estão ausentes. **Substituir por validação e registros rejeitados/quarentenados.**
3. `src/services/csvParser.ts` gera coordenadas, IPs e seriais aleatórios quando não encontra dados; também preenche modelos de equipamento por padrão. **Eliminar esse comportamento na nova aplicação.**
4. `src/services/database.ts` contém usuários e inventário pré-carregados e credenciais de exemplo; **não migrar seeds de demonstração para produção**.
5. `src/services/database.ts` mantém status/latências de conectores estáticos. O estado real deve vir de testes HTTP executados pelo backend e persistidos em `connector_runs`.
6. O RedeMap usa Vite/React e lógica de persistência no frontend; a nova plataforma precisa mover credenciais, conectores, persistência e regras de tenant para o backend.
7. Mapas públicos e serviços gratuitos podem ter termos de uso, limites e políticas de atribuição; **não assumir uso ilimitado**.

## 3. Arquitetura de migração recomendada

```text
RedeMap (referência de contratos e UX)
          |
          v
AIOps Intelligence Platform
  services/api/             FastAPI + autenticação + RBAC
  services/connectors/
    inmet.py                estações/observações
    open_meteo.py           previsão e histórico
    cemaden.py              alertas (endpoint a validar)
    cptec.py                previsão (endpoint a validar)
    brasilapi_cep.py        CEP/endereço; geocodificação verificável
    slaview.py              pendente de informações do tenant
    energy_csv.py           importação incremental do CSV real 2026
  services/ingestion/       agendamento, retries, deduplicação
  services/correlation/     associação espaço-temporal e topologia
  services/ml_engine/       LightGBM/XGBoost; datasets point-in-time
  apps/web/                 dashboard, mapas, integrações
```

**Persistência:** PostgreSQL/PostGIS para a operação multi-tenant. O CSV de energia de ~3 GB pode ser convertido para SQLite ou consultado por DuckDB, com pipeline incremental e preservação do original. Escolher o mecanismo após inspeção do esquema e benchmark.

## 4. Configuração segura proposta

Exemplo de variáveis de ambiente do **novo backend** (não é um `.env` existente do RedeMap):

```dotenv
# Meteorologia: URLs e endpoints finais devem ser verificados
INMET_BASE_URL=https://apitempo.inmet.gov.br
OPEN_METEO_FORECAST_URL=https://api.open-meteo.com/v1/forecast
CEMADEN_ENABLED=false
CPTEC_ENABLED=false

# Mapas: somente se o tenant optar por Google Maps
GOOGLE_MAPS_API_KEY=

# SLAview: manter desabilitado até validação da API/versão
SLAVIEW_ENABLED=false
SLAVIEW_BASE_URL=
SLAVIEW_AUTH_METHOD=
SLAVIEW_SECRET_REF=

# Energia: volume somente leitura
ENERGY_CSV_PATH=/data/input/energia_2026.csv
ENERGY_IMPORT_BATCH_ROWS=50000

# Segurança e observabilidade
CONNECTOR_DEFAULT_TIMEOUT_SECONDS=10
CONNECTOR_RETRY_MAX=3
CONNECTOR_LOG_REDACT_SECRETS=true
```

**Não armazenar segredos no frontend, GitHub ou no arquivo Markdown.** Usar secrets do ambiente de implantação. `SLAVIEW_SECRET_REF` deve apontar para um segredo, nunca conter a senha.

## 5. Contrato mínimo de um conector

Cada conector deve expor operações equivalentes a:

- `validate_config(config)`: valida esquema e campos obrigatórios sem realizar efeitos externos.
- `test_connection(config)`: realiza requisição real e registra HTTP status, duração, horário e mensagem de erro sanitizada.
- `discover_capabilities(config)`: declara quais recursos são efetivamente suportados.
- `fetch(start_utc, end_utc, cursor, tenant_id)`: coleta paginada ou em lotes, com limites e timeouts.
- `normalize(raw_record)`: produz registro tipado com `source`, `tenant_id`, `event_time_utc`, `observed_at_utc`, `ingested_at_utc`, `quality_flag` e identificador idempotente.
- `health()`: indica `NOT_CONFIGURED`, `CONNECTED`, `DEGRADED`, `FAILED` ou `DISABLED`, baseado em evidências reais.

Previsões meteorológicas devem preservar `forecast_issued_at_utc`, quando disponível. Para backtesting, usar apenas previsões emitidas antes do instante de decisão, nunca observações futuras como se fossem previsões.

## 6. Checklist de configuração por integração

### INMET
- [ ] Confirmar endpoints e formato de resposta atuais no provedor.
- [ ] Consultar estações por região e identificar distância real ao site.
- [ ] Validar unidades, UTC, campos ausentes e atrasos de publicação.
- [ ] Registrar coleta real e política de retry/rate limit.

### Open-Meteo
- [ ] Configurar coordenadas verificadas por site.
- [ ] Selecionar variáveis horárias necessárias (chuva, vento, temperatura etc.).
- [ ] Armazenar o instante de emissão das previsões e distinguir APIs de observação/histórico/previsão.
- [ ] Verificar termos de uso, limites e disponibilidade de arquivo histórico de previsões.

### CEMADEN e CPTEC
- [ ] Validar os serviços e URLs atuais; os caminhos do RedeMap não são evidência suficiente.
- [ ] Documentar autenticação, disponibilidade, cobertura e licença.
- [ ] Habilitar somente após teste de resposta real.

### Cartografia e CEP
- [ ] Configurar tiles Leaflet com atribuição e política de uso compatível.
- [ ] Validar chave Google Maps somente se necessária.
- [ ] Consultar BrasilAPI e, se aplicável, ViaCEP; **CEP não garante coordenada exata**.
- [ ] Exigir confirmação de latitude/longitude antes de usar em correlação geográfica.

### SLAview — aguardando tenant
- [ ] Identificar versão e edição instalada.
- [ ] Receber URL/base de acesso e documentação da API/integração.
- [ ] Identificar autenticação e liberação de IP/VPN.
- [ ] Verificar acesso a inventário, alarmes, disponibilidade e históricos.
- [ ] Definir paginação, janelas temporais e limites.
- [ ] Executar teste somente leitura e registrar resposta real.
- [ ] Não inventar endpoints ou alegar conectividade antes do teste.

### Energia — CSV real de 2026
- [ ] Inspecionar cabeçalho, delimitador, encoding e esquema.
- [ ] Importar em lotes para SQLite ou DuckDB, mantendo original intacto.
- [ ] Validar contagens, duplicações, datas, localidades e períodos de interrupção.
- [ ] Criar índices/partições conforme padrão de consulta.
- [ ] Documentar vínculo de unidades de energia com sites e tenants.

## 7. Regras de aceite para AI Studio, GitHub e Codex

1. **AI Studio:** gerar interfaces e contratos, mas não declarar conectores como ativos sem backend e teste real.
2. **GitHub:** publicar código e documentação, jamais chaves, senhas, CSV de 3 GB ou bases privadas.
3. **Codex + AIOps Validation Skill v3.0:** auditar os conectores, remover simulações, implementar ingestão reproduzível e testes de integração.
4. **Produção:** habilitar cada integração somente com evidência de sucesso, logs sanitizados, amostras reais e verificação de isolamento multi-tenant.
5. **Sem dados:** mostrar `NOT_CONFIGURED`, `NO_DATA` ou `SOURCE_UNAVAILABLE`; jamais gerar telemetria substituta.

## 8. Fontes de código consultadas

- [RedeMap — README](https://github.com/victorlaraujo84/RedeMap/blob/main/README.md)
- [RedeMap — definições das integrações e dados padrão](https://github.com/victorlaraujo84/RedeMap/blob/main/src/services/database.ts)
- [RedeMap — importação de inventário CSV](https://github.com/victorlaraujo84/RedeMap/blob/main/src/services/csvParser.ts)
- [RedeMap — correlação e importação de alarmes](https://github.com/victorlaraujo84/RedeMap/blob/main/src/services/correlationEngine.ts)
- [RedeMap — dependências](https://github.com/victorlaraujo84/RedeMap/blob/main/package.json)
- [RedeMap — variáveis de ambiente](https://github.com/victorlaraujo84/RedeMap/blob/main/.env.example)

> **Estado desta análise:** inventário de conectores declarados e revisão direcionada dos arquivos citados; não foi executado o projeto nem realizado teste HTTP com os provedores.
