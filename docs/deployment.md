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
