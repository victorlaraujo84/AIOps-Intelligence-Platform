# Homologação Docker local

Base: `a068775ceb097ee55e87a4c1b63520525b86d0a1`.
Branch: `codex/docker-local-homologation`.
Autorização: preparação e execução local aprovadas após apresentação do escopo.

## Arquitetura e limites

- Web Express/React usa SQLite em volume `webdata`. Este continua sendo o armazenamento efetivo da aplicação.
- FastAPI fornece saúde e governança, sem implementar as operações do Express em PostgreSQL.
- PostgreSQL/PostGIS e Redis autenticado estão na rede privada backend. O teste verifica conectividade real a partir da API, mas isso não implementa persistência unificada ou workers.
- Um gateway Nginx não root publica somente em 127.0.0.1 e encaminha para web/API por destinos fixos. Apenas o gateway participa da rede edge; web/API/banco/Redis permanecem em frontend/backend internos, sem egress para conectores. Não há destinos de notificações nem tickets configurados.
- Web/API executam sem root, com filesystem de imagem somente leitura, /tmp temporário e sem capabilities adicionais. O volume SQLite permanece gravável pelo usuário node.
- A imagem API fixa dependências em constraints.txt. Treinamento/ML opcional permanece em requirements-ml.txt e não é instalado na imagem básica.
- Esta é uma homologação local sem TLS; implantação pública e produção continuam NO-GO pelos achados da auditoria.

## Início

Pré-requisitos: Docker Engine/Desktop e Compose com suporte a `up --wait`; Node 22 e npm para scripts de configuração/teste. A primeira construção exige acesso aos registries de imagens e pacotes.

```bash
npm ci --no-audit --no-fund
npm run docker:init
npm run docker:check-env
npm run docker:build
npm run docker:test
npm run docker:up
```

`docker:init` cria .env com quatro segredos aleatórios, sem imprimir valores e sem sobrescrever arquivo existente. Se .env já existe, valide-o com docker:check-env e ajuste-o localmente conforme .env.example. Variáveis exportadas no shell têm precedência, como no Compose. As senhas locais precisam ter 64 caracteres hexadecimais; identificadores PostgreSQL seguem o formato validado pelo script para formar URLs consistentes.

Acesse http://127.0.0.1:3000 e crie o primeiro administrador. O projeto de homologação inicia vazio, sem usuários ou telemetria fictícios. WEB_PORT e API_PORT podem ser ajustadas no .env se houver conflito. FastAPI está em http://127.0.0.1:8000/health; sua resposta é apenas liveness, não prova de backend integrado.

## Testes automatizados e isolamento

`docker:test` usa imagens previamente construídas e um nome aleatório `aiops-smoke-<id>`, quatro segredos efêmeros independentes, banco/usuário de fixture, portas temporárias em loopback e volumes exclusivos. As fixtures identificadas são usadas somente nesse projeto. O script verifica:

- Portas privadas das aplicações e bancos, gateway em localhost, redes internas e execução não root de gateway/web/API.
- Conexões reais autenticadas de Python para PostgreSQL e Redis; extensão PostGIS.
- Redirecionamento FastAPI preservando a porta pública e acesso após recriação da API sem reiniciar o gateway; resolução DNS Docker renovada a cada cinco segundos.
- Login, rejeição sem autenticação, bloqueio de escrita do viewer, inventário, ingestão idempotente e ML não validado.
- Sessão e inventário SQLite preservados após restart.
- Backup SQLite consistente via better-sqlite3.backup e restauração com o escritor parado.
- Persistência PostgreSQL/Redis após restart; pg_dump/pg_restore em banco separado.

No encerramento, apenas o projeto aleatório de teste e seus volumes são removidos. O projeto de homologação e o banco real do usuário não são usados por esse teste. A validação não substitui testes RLS com papel restrito, contratos de conectores ou backtesting real.

## Operação e persistência

```bash
docker compose ps
npm run docker:down
npm run docker:up
```

`down` preserva volumes. Evite `down --volumes` no projeto de homologação: esse comando apaga os dados. Preserve o mesmo COMPOSE_PROJECT_NAME e os segredos do .env para continuar acessando volumes, sessões e credenciais criptografadas.

### Reaproveitamento de instalação anterior

O projeto padrão `aiops-local` cria volumes próprios; não migra automaticamente os dados de outro projeto Compose ou de um arquivo SQLite no host. A preparação de permissões da imagem atende volumes novos. Volumes antigos gravados por root podem impedir a escrita do usuário node.

Antes de reutilizar dados: identificar o projeto e o volume efetivamente montado pelo container antigo via `docker inspect` (consultar somente Mounts), preservar as chaves originais, executar backup consistente e copiá-lo para armazenamento protegido. Parar o serviço escritor daquele projeto e confirmar que nenhum outro container escreve no volume. Conferir o UID/GID de node na imagem com `docker compose run --rm --no-deps --entrypoint id web node`. Em operação de manutenção explicitamente direcionada ao volume identificado, ajustar proprietário de `/app/data` e seus arquivos para esse UID/GID, mantendo o escritor parado. Não executar chown em diretórios calculados ou em todos os volumes Docker. Só então configurar o volume existente e o projeto correto, iniciar e conferir dados/sessões. Este procedimento para volumes legados está documentado, mas não foi executado em dados existentes do usuário nesta entrega.

Backup SQLite online, no próprio volume:

```bash
docker compose exec -T web node --input-type=module -e "import fs from 'node:fs'; import Database from 'better-sqlite3'; fs.mkdirSync('/app/data/backups',{recursive:true}); const db=new Database('/app/data/aiops.db'); await db.backup('/app/data/backups/aiops.db'); db.close();"
```

Copie backups para armazenamento protegido fora do host/volume e preserve as chaves separadamente. A restauração precisa parar o escritor, validar o backup e tratar WAL/SHM antes de substituir o banco; o procedimento automatizado é ensaiado somente no projeto descartável. Para restaurar dados reais, planejar a operação e verificar o alvo e a autorização antes de sobrescrever qualquer arquivo.

## Evidências desta entrega

Execução local em 2026-11-20, Docker Desktop/Compose, Node 22.23.5 e Python 3.12.14:

| Verificação | Resultado observado |
|---|---|
| `npm run lint` | Passou (`tsc --noEmit`). |
| `npm run build` | Passou; avisos existentes de chunk acima de 500 kB e uso de `__dirname` na configuração Vite. |
| `npm test` | 20 testes passaram, incluindo integração, segurança multi-tenant e seis testes de configuração local. |
| `python -B -m unittest discover -s tests/unit -p "test_python_*.py" -v` | 5 testes passaram. São contratos/lógica; não validam modelos com dados reais. |
| `docker compose config --quiet` | Passou durante o smoke. |
| `docker compose build` | Imagens web e API construídas; SQLite nativo verificado no build. Dependências Python fixadas em constraints.txt. |
| `node scripts/test-compose-local.mjs` | Passou em `aiops-smoke-e59a191f9061`; conexões autenticadas, redirecionamento/recriação de API, login/RBAC/inventário/ingestão, restart, persistência e backup/restore verificados. Projeto e volumes descartáveis removidos no encerramento. |
| Homologação `aiops-local` | Cinco serviços healthy; HTML web em 127.0.0.1:3000, FastAPI em 127.0.0.1:8000/health; `/api/auth/status` confirmou `bootstrap_required: true`. Ambiente sem usuários de teste, deixado em execução. Somente gateway publica portas, ambas em loopback. |

O ensaio recriou a API, mas não força mudança de IP; a recuperação após mudança efetiva de endereço depende da resolução dinâmica configurada e não foi demonstrada separadamente.

Falhas encontradas e corrigidas antes do aceite: publicação direta de portas em redes internas não ficou acessível pelo host (resolvida com gateway); smoke assumia um envelope de resposta inexistente no cadastro do conector (adequado ao contrato real `{ id, status }`). A revisão estática também resultou em segredos efêmeros exclusivos de teste, validação decimal de portas, resolução DNS dinâmica, preservação de Host com porta e orientação de volumes legados. Nenhuma falha inicial foi contabilizada como teste aprovado.

## Pendências e rollback

Continuam pendentes correções SSRF/tenancy/ingestão, persistência unificada/RLS, workers, conectores reais, notificações, ITSM e governança ML. Nenhuma integração externa foi habilitada.

Para reverter este incremento: parar somente o projeto de homologação sem remover volumes, reverter o commit e preservar .env/backups. Não executar automaticamente uma versão anterior com credenciais ou dados incompatíveis. Não há alteração nas migrations de domínio nesta entrega.
