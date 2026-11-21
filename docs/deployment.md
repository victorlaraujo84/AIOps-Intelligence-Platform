# Guia de Implantação e Operação

## Subir o console em Docker

Em um host com Docker Engine, Compose v2, OpenSSL e portas 80/443 disponíveis, execute na raiz do checkout:

```bash
sh scripts/init-docker-env.sh
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
```

O script cria um `.env` novo com permissão restrita. Se o arquivo já existir, preserve-o e confira os valores na seção de segredos. O perfil padrão inicia Caddy e Web/SQLite. O volume `webdata` guarda o banco e os volumes do Caddy guardam a CA e os certificados.

Para acesso local, copie somente o certificado público da CA, confie nele no cliente e abra `https://localhost`. Use o token de inicialização do `.env` para criar o primeiro administrador.

```bash
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./aiops-local-ca.crt
curl --fail --cacert ./aiops-local-ca.crt https://localhost/api/health
```

Para sair do modo local, configure `AIOPS_HOST` com o nome DNS do console e `AIOPS_BIND_IP` com o IP da interface do host. Planeje DNS, firewall, controle de saída HTTP e os demais gates de produção do runbook antes de expor a stack. O proxy usa um IP interno reservado para que o Web confie apenas nos cabeçalhos encaminhados pelo Caddy. Se houver conflito de rede, ajuste `AIOPS_PROXY_SUBNET` e `AIOPS_PROXY_IP` juntos.

## Perfil opcional de homologação

`docker compose --profile core up -d --build --wait` também inicia PostgreSQL/PostGIS, Redis e FastAPI em uma rede interna. Configure `POSTGRES_PASSWORD` para uma base nova. O Web continua usando SQLite. O health do FastAPI verifica se seu processo responde. A validação de RLS e a migração da base Web são etapas separadas.

### Migrações do PostgreSQL

O serviço `postgres-migrate` aplica os SQLs versionados antes de a API iniciar. Ele registra cada arquivo e seu SHA-256 em `aiops_admin.schema_migrations`. A transação inclui o histórico e o schema, e o lock impede duas aplicações simultâneas no mesmo banco. Em volumes já gerenciados pelo serviço, use o mesmo projeto Compose, banco e credenciais. Para mudanças futuras, adicione um SQL numerado e registre sua ordem e checksum no executor antes de publicar. O executor recusa alterações de checksum em versões registradas.

Os volumes criados pelo Compose anterior podem ter os SQLs 001 e 002 aplicados sem histórico. Faça backup, confira a origem do schema e rode a adoção uma vez depois de o PostgreSQL estar saudável:

```bash
AIOPS_POSTGRES_ADOPT_LEGACY=true docker compose --profile core run --rm --no-deps postgres-migrate
docker compose --profile core up -d --wait
```

A adoção confere as tabelas, extensões e políticas esperadas. Se apenas a versão 001 estiver presente, a versão 002 será aplicada na mesma transação. Se encontrar uma versão parcial ou divergente, o executor interrompe a adoção para revisão. O histórico distingue versões adotadas das aplicadas. As verificações de adoção não substituem a revisão do schema e do backup antes da atualização.

Falhas durante a execução revertem a transação. Para reverter uma migração já concluída, restaure o backup em um banco separado, valide os dados e planeje o retorno antes de mudar a conexão. O SQLite do console não participa desse procedimento.

### Isolamento de leitura no PostgreSQL

A migração 003 cria `aiops_tenant_reader`, um papel sem login próprio, com leitura por tenant de inventário, telemetria e incidentes. O papel lê apenas as colunas operacionais de conectores e auditoria. Credenciais, usuários, partições diretas, histórico de migrações e escrita ficam fora do papel.

Na futura integração do backend, autentique a operação e resolva o tenant antes de abrir a transação de leitura. Use uma conta de serviço com permissão para assumir apenas o papel necessário e defina o UUID com parâmetro da aplicação:

```sql
BEGIN;
SET LOCAL ROLE aiops_tenant_reader;
SELECT set_config('app.current_tenant_id', $1::uuid::text, true);
-- Consultas de leitura no mesmo cliente da transação.
COMMIT;
```

A configuração é local à transação. O backend deve controlar o valor a partir da sessão autenticada, pois o PostgreSQL trata o parâmetro de sessão como contexto fornecido pelo cliente de banco. Reserve essa conta ao backend de confiança. A criação da conta de login, a integração de runtime e as permissões de escrita permanecem etapas separadas.

### Integridade de vínculos por tenant

A migração 004 valida as referências de inventário, topologia, serviços, eventos, incidentes, métricas, logs, anomalias e checkpoints usando o par `(tenant_id, id)`. Nas referências opcionais, a remoção do objeto limpa apenas o campo do vínculo. As referências de autoria e aprovação usam o modelo de usuários administrativos existente.

Ao atualizar um banco com dados, a migração valida os vínculos já cadastrados. Um vínculo divergente interrompe a transação e mantém a versão anterior. Corrija os registros com base na origem dos dados, em uma etapa revisada antes de reexecutar o migrador. Aplique em janela de manutenção, pois a validação das chaves pode bloquear gravações.

### Ensaio do inventário SQLite → PostgreSQL

A migração 005 aceita a taxonomia extensível do SQLite. Ao excluir um site, o PostgreSQL preserva o ativo e limpa o vínculo, conforme o comportamento do console.

Crie o snapshot pelo contêiner Web e guarde-o em um diretório privado. O comando usa o backup online do SQLite e confere a integridade da cópia.

```bash
umask 077
backup_dir=$(mktemp -d)
docker compose exec -T web node scripts/backup-web-sqlite.mjs > "$backup_dir/aiops.db"
```

Para testar a restauração, passe a cópia a um contêiner sem rede. O teste inicia o Web com um SQLite temporário e confere o status de saúde e a inicialização já realizada. Use um arquivo de ambiente de teste com as chaves exigidas pelo Web.

```bash
image=$(docker compose images -q web)
docker run --rm -i --network none --env-file /caminho/privado/teste.env \
  -e NODE_ENV=production --entrypoint sh "$image" \
  scripts/check-sqlite-restore.sh < "$backup_dir/aiops.db"
```

Para o ensaio de migração, use um projeto Compose dedicado com `POSTGRES_DB=aiops_inventory_rehearsal`. Execute a partir do checkout do ensaio e mantenha o `.env` e o backup com permissões restritas.

```bash
export POSTGRES_DB=aiops_inventory_rehearsal
docker compose -p aiops-inventory-rehearsal --profile core up -d --wait postgres
docker compose -p aiops-inventory-rehearsal --profile core run --rm postgres-migrate
python3 scripts/rehearse-inventory-migration.py "$backup_dir/aiops.db" \
  --inventory-project aiops-inventory-rehearsal
```

O ensaio compara contagens e campos normalizados de tenants, concessões, tipos de localidade, categorias, sites, ativos, serviços, dependências e topologia. Valida as referências por tenant e a geometria WGS 84 dos sites verificados. O modo protegido imprime apenas as contagens e termina com `ROLLBACK`. Os modos de inventário e identidade são configurados separadamente.

### Identidades e sessões no PostgreSQL

A migração 006 vincula contas de tenant ao tenant de origem e mantém administradores globais separados. Sessões de usuários de tenant herdam esse vínculo. Administradores globais podem selecionar um tenant ativo, e a exclusão desse tenant limpa a seleção. O banco armazena somente o hash do token de sessão. O papel de leitura de inventário permanece separado da autenticação.

Antes de transferir identidades, confira os vínculos e papéis da origem. A migração valida os usuários já cadastrados e reverte se encontrar uma combinação incompatível de papel e tenant. Em mudanças futuras de papel ou tenant de um usuário, revogue suas sessões na mesma transação. A troca do banco de autenticação deve exigir novo login. A transferência de usuários e hashes de senha e a ativação do novo backend ainda requerem validação e planejamento próprios.

#### Ensaio protegido de identidades

No mesmo projeto descartável do ensaio de inventário, com a migração 006 aplicada, execute:

```bash
python3 scripts/rehearse-inventory-migration.py /caminho/privado/snapshot.db \
  --identity-project aiops-inventory-rehearsal
```

Use `--env-file` se o projeto usa um arquivo de variáveis diferente de `.env`. O modo protegido envia a operação diretamente ao PostgreSQL e imprime apenas as contagens. Ele confere os vínculos, papéis, estado da conta e a igualdade do hash scrypt antes de reverter a transação. As sessões permanecem fora da transferência. Mantenha o backup em armazenamento restrito e use o modo apenas no Docker de homologação dedicado.

### Autenticação FastAPI em homologação

A migração 007 disponibiliza a autenticação PostgreSQL para o perfil interno `core`. Em um banco de homologação, crie uma conta de serviço dedicada e conceda o papel do autenticador. No `psql`, configure a senha de forma interativa:

```sql
CREATE ROLE aiops_auth_runtime LOGIN;
GRANT aiops_authenticator TO aiops_auth_runtime;
\password aiops_auth_runtime
```

Forneça `AIOPS_POSTGRES_AUTH_DSN` e um `AIOPS_POSTGRES_AUTH_SESSION_SECRET` próprio, aleatório, de pelo menos 32 bytes. Os valores devem ficar no ambiente protegido. Sem essas configurações, a autenticação FastAPI fica desabilitada. O serviço rejeita o uso da conta administrativa de migração.

Os endpoints internos são `POST /api/v1/auth/login`, `GET /api/v1/auth/me` e `POST /api/v1/auth/logout`. Use o token Bearer devolvido pelo login. Contas vinculadas a tenant recebem seu próprio contexto. Um administrador global começa com o tenant ativo vazio e seleciona um tenant ativo via `POST /api/v1/auth/switch-tenant`. Mantenha as rotas na rede interna de homologação. O console Web segue autenticando pelo SQLite.

### Inventário FastAPI em homologação

Com as migrações até a 008 e a autenticação PostgreSQL já configurada, provisione uma conta de leitura distinta no `psql`:

```sql
CREATE ROLE aiops_inventory_runtime LOGIN NOINHERIT;
GRANT aiops_tenant_reader TO aiops_inventory_runtime WITH SET TRUE;
\password aiops_inventory_runtime
```

Configure `AIOPS_POSTGRES_INVENTORY_DSN` para essa conta. A API assume o papel de leitura e define o tenant somente para a transação. O contexto vem da sessão Bearer, e o banco aplica as políticas RLS. As rotas de sites, ativos e serviços sob `GET /api/v1/inventory/{resource}` aceitam `limit` e `after` e devolvem `items` e `next_after`. O Web ativo continua usando SQLite para seu inventário.

### Cadastro e atualização de sites

A migração 009 habilita um papel dedicado para criar e editar os campos cadastrais de sites. Provisione uma terceira conta, distinta das contas de autenticação e leitura:

```sql
CREATE ROLE aiops_site_write_runtime LOGIN NOINHERIT;
GRANT aiops_site_writer TO aiops_site_write_runtime WITH SET TRUE;
\password aiops_site_write_runtime
```

Configure `AIOPS_POSTGRES_SITE_WRITE_DSN` para essa conta em homologação. O FastAPI usa `POST /api/v1/inventory/sites` para cadastrar código e nome, com município, UF e criticidade opcionais. `PATCH /api/v1/inventory/sites/{id}` permite editar nome, município, UF e criticidade. A sessão fornece o tenant e a identidade do autor. A alteração e o registro de auditoria são gravados na mesma transação. O papel tem permissões específicas sobre sites e sobre a inserção da auditoria correspondente.

### Cadastro e atualização de ativos

A migração 010 adiciona uma conta de escrita de ativos. Provisione uma conta exclusiva no `psql`.

```sql
CREATE ROLE aiops_asset_write_runtime LOGIN NOINHERIT;
GRANT aiops_asset_writer TO aiops_asset_write_runtime WITH SET TRUE;
\password aiops_asset_write_runtime
```

Configure `AIOPS_POSTGRES_ASSET_WRITE_DSN` no perfil `core`. Use `POST /api/v1/inventory/assets` para cadastrar um ativo com nome e, opcionalmente, hostname, domínio, criticidade, modo de georreferenciamento e site. `PATCH /api/v1/inventory/assets/{id}` altera esses campos. O modo `required` exige um site do mesmo tenant. Ativos lógicos podem ser cadastrados sem site e começam com estado `NO_DATA`. Cada gravação inclui auditoria na mesma transação. Para desativar a escrita, remova esse DSN e recrie a API.

### Cadastro e atualização de serviços

A migração 011 adiciona o papel de escrita de serviços. Provisione uma conta exclusiva no `psql`.

```sql
CREATE ROLE aiops_service_write_runtime LOGIN NOINHERIT;
GRANT aiops_service_writer TO aiops_service_write_runtime WITH SET TRUE;
\password aiops_service_write_runtime
```

Configure `AIOPS_POSTGRES_SERVICE_WRITE_DSN` no perfil `core`. Use `POST /api/v1/inventory/services` para cadastrar código e nome. Domínio, criticidade, equipe responsável, meta de SLA e descrição são opcionais. `PATCH /api/v1/inventory/services/{id}` permite editar os dados cadastrais. O código identifica o serviço dentro do tenant e permanece fixo. A meta de SLA aceita valores de 0 a 100 pontos percentuais. O estado operacional inicial é `NO_DATA`. Cada alteração registra auditoria na mesma transação. Para desativar a escrita, remova esse DSN e recrie a API.

### Dependências de serviços

A migração 012 amplia o papel de serviços para gerenciar vínculos entre um serviço e um ativo ou serviço upstream do mesmo tenant. A API usa os DSNs existentes de leitura e escrita do inventário.

- `GET /api/v1/inventory/services/{id}/dependencies` lista os vínculos e aceita `limit` e `after`.
- `POST /api/v1/inventory/services/{id}/dependencies` recebe `asset_id`, `upstream_service_id` ou ambos. O papel do vínculo aceita `primary`, `redundant` ou `supporting`. O peso deve ser positivo.
- `DELETE /api/v1/inventory/services/{id}/dependencies/{dependency_id}` remove o vínculo indicado.

O banco verifica os vínculos com chaves estrangeiras compostas por tenant. A API serializa a inclusão de vínculos upstream por tenant para impedir ciclos em requisições simultâneas. Cadastro e remoção registram auditoria na transação. O DSN de escrita de serviços controla ambas as operações.

### Topologia de ativos

A migração 013 amplia o papel de escrita de ativos para gerenciar os enlaces no perfil interno `core`. A API usa os DSNs de leitura do inventário e de escrita de ativos.

- `GET /api/v1/inventory/topology/edges` lista enlaces com nomes dos ativos e IDs dos sites.
- `GET /api/v1/inventory/topology/shared-upstream` lista ativos de origem que atendem pelo menos dois destinos distintos. Enlaces paralelos para o mesmo destino contam uma vez.
- `POST /api/v1/inventory/topology/edges` cria um enlace direcionado com ativos de origem e destino e tipo. Aceita operadora, capacidade em Mbps e indicação de redundância.
- `DELETE /api/v1/inventory/topology/edges/{id}` remove o enlace indicado.

As listagens aceitam `limit` e `after`. O PostgreSQL restringe vínculos ao mesmo tenant e impede duplicatas de origem, destino e tipo. A API bloqueia ciclos e registra a criação e remoção na mesma transação que a auditoria. Remover o DSN de escrita de ativos desativa as gravações cadastrais e topológicas.

### Categorias de ativos

A migração 014 habilita o catálogo de categorias no perfil interno `core`. Use `GET /api/v1/inventory/asset-categories` com o DSN de leitura e `POST /api/v1/inventory/asset-categories` com o DSN de escrita de ativos. O cadastro recebe código, rótulo e domínio. O código normalizado é único por tenant. O cadastro e a auditoria são gravados na mesma transação.

O cadastro e a edição de ativos aceitam `category_id` do mesmo tenant. Ao atribuir uma categoria, a API copia seu código para `asset_type_code` e usa o domínio da categoria quando o corpo omite `domain`. Para desvincular, envie `category_id: null` no `PATCH`. Isso limpa o código do vínculo e preserva o domínio cadastrado, a menos que o corpo forneça outro domínio. Um ativo sem categoria conserva seu código de tipo legado.

### Concessões e tipos de localidade

A migração 015 habilita o catálogo geográfico no perfil interno `core`. Use `GET /api/v1/inventory/concessions` e `GET /api/v1/inventory/locality-types` com o DSN de leitura. As duas rotas aceitam `limit` e `after`. Use `POST` nas mesmas rotas com o DSN de escrita de sites. Concessões recebem código, nome e, opcionalmente, região e descrição. Tipos de localidade recebem código, rótulo e descrição opcional.

O cadastro e a edição de sites aceitam `concession_id` e `locality_type_id` do mesmo tenant. Envie `null` em um campo no `PATCH` para remover o vínculo correspondente. O cadastro dos catálogos e as alterações de vínculo são auditados na mesma transação.

### Endereço e verificação de coordenadas de sites

A migração 016 permite informar `address` e `cep` no cadastro e na edição de sites. A API guarda o CEP com oito dígitos e aceita entrada com ou sem hífen. Os sites novos começam com coordenadas pendentes.

Use `PATCH /api/v1/inventory/sites/{id}/verify-coords` após conferir o ponto. Envie latitude e longitude numéricas em graus. A API grava o ponto PostGIS em WGS 84, marca a origem como `manual_verificada` e registra as coordenadas e o autor na auditoria. Use essa rota para alterar o ponto. A verificação usa o DSN de escrita de sites.

### Marcadores de sites para o mapa

A migração 017 cria um índice por tenant, latitude e longitude para os sites verificados. Consulte `GET /api/v1/inventory/sites/map?west=-47&south=-24&east=-46&north=-23` com o DSN de leitura do inventário. Os limites são inclusivos e usam graus em WGS 84. Uma janela com `west` maior que `east` atravessa o antimeridiano.

A API retorna marcadores com ponto verificado do tenant da sessão. Use `limit` para pedir até 500 marcadores. Quando houver `next_after`, passe esse valor como `after` na próxima consulta com os mesmos limites.

### Console PostgreSQL de homologação

A migração 018 permite que o administrador global liste tenants ativos para seleção. Contas de tenant recebem o próprio tenant. O Web usa uma sessão PostgreSQL independente, com cookie HTTPS, para o inventário de consulta e o mapa.

Configure os DSNs de autenticação e leitura e provisione as contas de teste no PostgreSQL. Suba um projeto de homologação com o arquivo Compose adicional.

```bash
docker compose -f compose.yaml -f compose.postgres-console.yaml --profile core up -d --build --wait
```

Acesse `/postgres-inventory` pelo HTTPS do proxy. Entre com uma conta PostgreSQL da homologação. Administradores globais selecionam o tenant antes de abrir o inventário. O piloto oferece consulta de sites, ativos, serviços, categorias, concessões, tipos de localidade e mapa de sites verificados. O Compose adicional conecta o Web à rede interna do FastAPI. Para retirar o piloto, recrie o Web com o Compose principal.

#### Carga inicial em paralelo com a homologação

Use um projeto Compose separado, com `POSTGRES_DB=aiops_inventory_pilot`, sub-rede e IP de proxy distintos. Inclua `compose.postgres-pilot.yaml` para publicar HTTPS em loopback, na porta `9443` por padrão, e abrir diretamente o inventário de consulta. Configure um hostname distinto, como `AIOPS_HOST=pilot.localhost`, para separar os cookies do console principal. Configure os DSNs de autenticação e leitura para esse banco com papéis exclusivos.

```bash
docker compose -f compose.yaml -f compose.postgres-console.yaml -f compose.postgres-pilot.yaml \
  -p aiops-postgres-pilot --profile core up -d --wait postgres
docker compose -f compose.yaml -f compose.postgres-console.yaml -f compose.postgres-pilot.yaml \
  -p aiops-postgres-pilot --profile core run --rm --no-deps postgres-migrate
python3 scripts/rehearse-inventory-migration.py "$backup_dir/aiops.db" \
  --pilot-project aiops-postgres-pilot
docker compose -f compose.yaml -f compose.postgres-console.yaml -f compose.postgres-pilot.yaml \
  -p aiops-postgres-pilot --profile core up -d --build --wait
```

A carga grava o inventário e os hashes de autenticação em uma transação, somente no banco dedicado e vazio. Inicie uma nova sessão no piloto com as credenciais da cópia. O piloto representa o momento do backup. Para voltar ao console original, acesse o endereço habitual e pare o projeto piloto com `docker compose stop` usando os mesmos arquivos e nome de projeto.

#### Cadastro de tenants no piloto

Aplique a migração 020 e habilite `AIOPS_POSTGRES_PILOT_CREATE_TENANTS=true` ao recriar o Web. Use **Novo tenant** com uma conta de administrador global. Informe o nome e, se necessário, o identificador e o documento. O PostgreSQL cria o tenant, os catálogos padrão de categorias e tipos de localidade e o registro de auditoria em uma transação. Se a sessão ainda estiver sem tenant ativo, o novo tenant passa a ser o ativo. Quando já existe uma seleção ativa, o novo tenant fica disponível no seletor. Para retirar o cadastro pelo navegador, desabilite a flag e recrie o Web.

#### Administração de usuários do tenant no piloto

Aplique a migração 019 antes de habilitar `AIOPS_POSTGRES_PILOT_MANAGE_USERS=true` e recrie a API e o Web do piloto. A aba **Usuários** fica disponível para administradores. O administrador global seleciona primeiro o tenant. A aba lista contas do tenant, cria administradores de tenant, operadores e leitores, e permite ativar ou desativar essas contas. A desativação encerra as sessões da conta na mesma transação que registra a auditoria. Para retirar o acesso pelo navegador, remova a flag e recrie o Web. A migração adiciona funções de banco e pode permanecer instalada com a flag desabilitada.

#### Cadastro e edição de sites no piloto

Configure `AIOPS_POSTGRES_SITE_WRITE_DSN` com uma conta dedicada ao papel de sites e defina `AIOPS_POSTGRES_PILOT_WRITE_SITES=true` no ambiente do projeto piloto. Recrie o Web e a API com os mesmos arquivos Compose. O formulário permite cadastrar e editar sites, incluindo vínculos com concessões e tipos de localidade do tenant selecionado. Cada alteração é auditada. As gravações pertencem ao banco PostgreSQL do piloto.

Ao trocar de tenant em outra aba, salve apenas depois de atualizar a sessão nesta aba. A API confere se o tenant do formulário corresponde à sessão. Para voltar ao modo de consulta, remova a flag e recrie o Web.

Use **Verificar coordenadas** na linha do site para informar latitude e longitude em graus decimais. A confirmação grava a geometria no PostGIS, registra o autor e torna o ponto visível no mapa do tenant.

A partir da migração 022, administradores podem usar **Excluir** na aba **Sites** com a escrita de sites habilitada. O site sai do inventário e do mapa. Ativos, eventos, incidentes, amostras de métricas e logs vinculados permanecem, com a referência ao site removida. Ativos configurados com **Site obrigatório** mantêm essa configuração e precisam de um novo vínculo ao editar o cadastro. A exclusão e o registro de auditoria acontecem na mesma transação.

#### Cadastro e edição de ativos no piloto

Configure `AIOPS_POSTGRES_ASSET_WRITE_DSN` com uma conta dedicada ao papel de ativos e defina `AIOPS_POSTGRES_PILOT_WRITE_ASSETS=true`. Recrie o Web e a API do piloto. Em **Ativos**, use **Novo ativo** ou **Editar** para cadastrar o nome, hostname, criticidade, domínio e vínculos com o catálogo. O modo **Site obrigatório** exige um site do mesmo tenant. O modo **Sem localização física** permite ativos lógicos. Ao atribuir uma categoria, a API usa o domínio do catálogo quando a gravação omite esse campo.

As alterações são feitas no PostgreSQL do piloto, com auditoria e verificação do tenant selecionado. Para devolver os ativos ao modo de consulta, remova a flag e recrie o Web.

A partir da migração 023, administradores podem usar **Excluir** na aba **Ativos** quando a escrita de ativos estiver habilitada. Apenas os enlaces e as dependências de serviço desse ativo são removidos com ele. Os outros ativos, serviços, eventos, incidentes, métricas, logs e anomalias permanecem. As referências ao ativo excluído são limpas e a operação é registrada na auditoria na mesma transação.

#### Cadastro de catálogos no piloto

Operadores e administradores podem cadastrar itens no tenant selecionado. **Categorias** usa a configuração de escrita de ativos. **Concessões** e **Tipos de localidade** usam a configuração de escrita de sites. O PostgreSQL confere o tenant ativo, impede códigos duplicados dentro do tenant e audita os cadastros. Os novos itens ficam disponíveis ao abrir os formulários de ativos e sites. A consulta permanece disponível quando a escrita está desabilitada.

A partir da migração 021, administradores podem usar **Excluir** na aba **Concessões**, com a escrita de sites habilitada. A confirmação informa que os sites vinculados serão desvinculados. A exclusão, a limpeza do vínculo e o registro de auditoria acontecem na mesma transação. Para retirar a operação do navegador, desabilite a escrita de sites e recrie o Web.

#### Enlaces entre ativos no piloto

Abra **Topologia** para consultar os enlaces do tenant ativo. Com a escrita de ativos habilitada, use **Novo enlace** para selecionar origem e destino, informar o tipo e, opcionalmente, o provedor, a capacidade em Mbps e a redundância. A remoção requer confirmação no navegador. O PostgreSQL bloqueia ciclos e vínculos entre tenants, audita as inclusões e remoções e mantém os ativos vinculados. Para deixar a aba em modo de consulta, desabilite a flag de escrita de ativos e recrie o Web.

#### Cadastro e edição de serviços no piloto

Configure `AIOPS_POSTGRES_SERVICE_WRITE_DSN` com uma conta dedicada ao papel de serviços e defina `AIOPS_POSTGRES_PILOT_WRITE_SERVICES=true`. Recrie o Web e a API do piloto. Em **Serviços**, use **Novo serviço** ou **Editar**. Informe o código no cadastro e preencha a meta de SLA em percentual de 0 a 100. Deixe a meta em branco para omitir ou remover o valor. A equipe responsável e a descrição são opcionais.

As gravações são auditadas no PostgreSQL do piloto e verificam o tenant selecionado. Para devolver os serviços ao modo de consulta, remova a flag e recrie o Web.

Em **Serviços**, abra **Dependências** na linha de um serviço para consultar os vínculos. Com a escrita de serviços habilitada, o piloto permite vincular ativos e serviços upstream do tenant selecionado, definir papel e peso e remover vínculos. A API bloqueia ciclos e registra as adições e remoções na auditoria.

A partir da migração 024, administradores podem usar **Excluir** na aba **Serviços** com a escrita de serviços habilitada. O PostgreSQL remove as dependências do serviço e os vínculos de outros serviços com ele. Os demais serviços, ativos, métricas, logs e anomalias permanecem. As referências históricas ao serviço excluído são limpas e a operação é registrada na auditoria na mesma transação.

#### Consulta de auditoria no piloto

Abra **Auditoria** para consultar as ações registradas no tenant ativo, da mais recente para a mais antiga. A consulta funciona para contas de leitura e usa o DSN de inventário. A tela mostra horário, ação, papel do autor e recurso. Respeita as permissões das colunas de auditoria do PostgreSQL. Para voltar aos registros anteriores, use **Mais resultados**.

A aba reflete os registros presentes no PostgreSQL. O histórico do console principal continua no SQLite até sua migração.

## Segredos e configuração
Configure os valores por ambiente ou secret store. O Web valida a configuração antes de abrir o banco.

- `AUTH_SESSION_SECRET` e `CREDENTIAL_ENCRYPTION_KEY` devem receber valores distintos e aleatórios e de pelo menos 32 bytes em produção. Preserve os valores já utilizados ao atualizar uma implantação.
- Se a implantação anterior usava `data/.runtime_secrets.json`, migre `sessionSecret` para `AUTH_SESSION_SECRET` e configure `CREDENTIAL_ENCRYPTION_KEY` como `hex:<credKeyHex>` com os 64 dígitos do arquivo. Esse formato preserva a chave AES original. Faça a transferência diretamente para o secret store, com acesso restrito.
- Trocar o segredo de sessão encerra as sessões existentes. A chave de cifra só deve ser substituída após recriptografar as credenciais ou planejar seu recadastro.
- Use um `POSTGRES_PASSWORD` aleatório para o perfil `core`. Em um volume PostgreSQL existente, a variável não altera a senha já registrada no banco.

## Inicialização e proxy TLS

- Sirva o console por HTTPS. O cookie de produção usa `Secure`, `HttpOnly` e `SameSite=Lax`. Integrações que usam Bearer continuam autenticando pelo cabeçalho.
- Fora do Compose, preencha `AIOPS_TRUST_PROXY` somente com os IPs ou CIDRs do proxy TLS confiável. Configure esse proxy para controlar os cabeçalhos encaminhados e restrinja o acesso direto ao Web.
- Para uma base vazia, provisione `AIOPS_BOOTSTRAP_TOKEN` com um valor aleatório de pelo menos 32 bytes. Informe-o na tela de inicialização ou no cabeçalho `X-Bootstrap-Token` do pedido de bootstrap. Remova-o do ambiente após concluir a criação do primeiro administrador.

## Destinos externos dos conectores

O cliente de saída do Web exige a URL HTTPS final, valida o certificado e usa apenas os endereços públicos aprovados na resolução DNS da própria conexão. Respostas com redirecionamento são recusadas. Se um conector existente estiver configurado com HTTP ou com uma URL que redireciona, ajuste para o endpoint HTTPS final documentado antes de testá-lo. Conectores em redes privadas exigem um coletor ou caminho de saída autorizado separado.

O teste de conectividade verifica a resposta do endpoint. A confirmação de ingestão recente requer uma execução de sincronização com dados válidos.

## Atualização do SQLite e rollback

A migração v3 preserva os logs e limpa apenas os vínculos com sites ausentes ou de outro tenant. Ela também bloqueia novos vínculos inválidos no banco. Antes de atualizar, faça um backup verificado do SQLite e registre o ponto de restauração. Para reverter sem desfazer essa proteção, volte à versão anterior da aplicação preservando a base atual. Se precisar voltar ao estado anterior dos vínculos, restaure o backup com a aplicação parada e reconcilie os registros criados após o backup.

Se o volume Web veio de uma imagem que rodava como root, faça backup, pare Web e proxy e ajuste o proprietário antes de subir a nova imagem. Execute com o mesmo projeto e volume do ambiente original.

```bash
docker compose stop proxy web
docker compose build web
docker compose run --rm --no-deps --user 0 --entrypoint sh web -c 'chown -R node:node /app/data'
docker compose up -d --wait
```

Use `docker compose down` para parar a stack preservando os volumes. Para diagnóstico, use `docker compose ps` e `docker compose logs --tail=100 proxy web`.

## Backup e Restore (SQLite local e PostgreSQL)
- **SQLite (`data/aiops.db`):** utilizar `sqlite3 data/aiops.db ".backup 'backup.db'"` com WAL consolidado.
- **PostgreSQL (`compose.yaml`):** `pg_dump -Fc -U aiops aiops_platform > backup.dump` e `pg_restore -d aiops_platform backup.dump`.
- O procedimento deve ser validado com restauração periódica em ambiente de homologação (Etapa D).

## Compose unificado PostgreSQL

A composição usa PostgreSQL para autenticação, inventário, auditoria e consulta operacional. O Web usa a prontidão da API PostgreSQL e o projeto não monta o volume SQLite. PostgreSQL e Redis ficam na rede interna do Compose.

A partir do checkout da versão, prepare um arquivo privado e inicialize o banco em um projeto dedicado. Ajuste `AIOPS_HOST`, o IP de escuta e a rede do proxy no arquivo conforme o ambiente. Ao usar imagens publicadas, configure `AIOPS_WEB_IMAGE` e `AIOPS_API_IMAGE` com a mesma versão e autentique o Docker no registro quando necessário.

```bash
release_env=/caminho/privado/postgres.env
project=aiops-postgres
python3 scripts/provision-postgres-release.py --env-file "$release_env" --project "$project" prepare
dc() {
  docker compose --env-file "$release_env" -f compose.yaml -f compose.postgres-release.yaml \
    --profile core -p "$project" "$@"
}
dc up -d --wait postgres
dc run --rm --no-deps postgres-migrate
python3 scripts/provision-postgres-release.py --env-file "$release_env" --project "$project" roles
```

Para uma instalação nova, inicialize um administrador global com o comando a seguir. A senha é solicitada no terminal. Crie o tenant inicial pelo console.

```bash
python3 scripts/provision-postgres-release.py --env-file "$release_env" --project "$project" bootstrap \
  --email admin@example.invalid --name 'Administrador'
```

Para uma atualização, use um backup SQLite íntegro em vez do bootstrap. O banco alvo deve estar vazio. A carga verifica o conteúdo de cada tabela, os vínculos e as coordenadas verificadas. Senhas existentes são preservadas e as sessões exigem novo login. A trilha histórica inclui os registros globais, cuja leitura pelo console continua restrita ao tenant selecionado. O valor histórico `unknown` de IP da auditoria é tratado como ausência de endereço.

```bash
python3 scripts/rehearse-inventory-migration.py /caminho/privado/aiops.db \
  --release-project "$project" --env-file "$release_env"
```

Com imagens publicadas, use `dc pull web api` e `dc up -d --no-build --wait`. Para construir a partir do checkout, use `dc up -d --build --wait`. Valide login, seleção do tenant, cadastro e auditoria após subir a stack. A rota `/api/health` devolve erro de disponibilidade se o Web perder acesso à API PostgreSQL ou se ela perder a conexão ao banco.

Em **Incidentes**, abra **Detalhes** para consultar evidências, site, ativo e eventos vinculados. Operadores e administradores podem corrigir a categoria, reconhecer ou resolver um incidente com a escrita habilitada. Após uma revisão concorrente, volte à lista e reabra o incidente antes de salvar. O estado, a identificação do revisor e a auditoria são confirmados juntos. Uma revisão não envia notificações nem atualiza tickets externos nesta versão.

As telas de conectores, eventos, incidentes, métricas, logs e anomalias apresentam o histórico armazenado. Para substituir a instância legada, o aceite precisa cobrir a configuração e execução de conectores, a ingestão, a operação de incidentes, os relatórios e as integrações efetivamente usadas. Mantenha o arquivo privado e os volumes dos dois ambientes até concluir o ensaio de retorno. Durante a janela, suspenda os escritores legados antes do backup final e valide o PostgreSQL com `AIOPS_POSTGRES_RELEASE_WRITES=false`. Concluído o aceite, defina a variável como `true` e recrie a API e o Web para liberar gravações. Após gravações no PostgreSQL, restaure o serviço sem descartar esses dados ou execute a reconciliação acordada.
