# Registro de decisões e escopo — AIOps híbrida

**Data:** 2026-11-19 | **Natureza:** decisões de produto e arquitetura-alvo, sujeitas a ADRs e validação técnica.

## Decisões aprovadas
- Produto independente do NOC Intelligence Hub, OperaDash, Zabbix-Analyzer e Triggers Factory; integrações futuras não são dependências de bootstrap.
- Arquitetura híbrida: ingestão de ferramentas externas **e** coleta nativa seletiva de TI/IoT.
- Domínios: TI, redes/telecom, IoT, energia e ambiente/clima; mapas opcionais e topologia multidomínio.
- Integrar ferramentas existentes primeiro; não substituir integralmente Zabbix/SLAview.
- Multi-tenant e RBAC com isolamento ponta a ponta; dados operacionais reais e qualidade explícita.
- SLAview é Telcomanager, integração read-only condicionada a documentação/autorização.
- PostgreSQL/PostGIS como alvo de produção; SQLite atual é legado de runtime web até migração validada.
- Redis pode apoiar filas/cache, mas broker, TSDB e retenção exigem ADR/benchmark.
- Docker Compose para implantação inicial; contêineres distintos para Web, API, banco, Redis e workers.
- AIOps por etapas: deduplicação → correlação/topologia → RCA com evidências → anomalias → ML em Shadow Mode.
- IA generativa opcional/offline por padrão; envio externo exige consentimento e minimização de dados.
- Importação de histórico de energia de aproximadamente 3 GB por streaming/checkpoint; schema real pendente.

## Coleta nativa: plano, não funcionalidade existente
SNMP v3 preferencial; MQTT TLS/ACL; webhooks autenticados; HTTP; OTLP; ICMP sob escopo autorizado. Gateways locais para redes privadas com comunicação outbound quando aplicável. Nunca habilitar scans automáticos.

## Não decidido
TSDB específico; broker definitivo; retenção por tenant; cadência e cardinalidade; modelos/OIDs/MIBs SNMP; tópicos/payload MQTT; SLAview API; amostra CSV energia; estratégia final de autenticação entre Node/Python; políticas de alta disponibilidade e recuperação.

## Fora do escopo inicial
SCADA/controle de processo, automação de remediação sem aprovação, substituir NMS inteiro, treinamento preditivo sem dados validados, promessas de SLA ou escalabilidade sem benchmark.


## Decisão aprovada: notificações e ITSM (19/11/2026)
O escopo inclui Notification & ITSM Integration Hub, com notificações via webhook genérico, Microsoft Teams, Telegram Bot e e-mail, além de integração com ferramenta ITSM (a escolher). Políticas por tenant, severidade, supressão, escalonamento, auditoria e entrega confiável são requisitos. Integração bidirecional ITSM é alvo evolutivo; não presumir disponível. Detalhes: `docs/NOTIFICACOES_WEBHOOKS_ITSM.md`.
## Decisão ITSM — 2026-11-19
O primeiro conector ITSM será **genérico configurável por tenant**, baseado em contratos e capacidades verificadas, sem fornecedor selecionado. Outbound primeiro; inbound/polling posteriormente e somente com autenticação e documentação reais. Referência: `docs/ITSM_GENERICO_CONTRATOS.md`.
