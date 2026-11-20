# Guia de Implantação e Operação

## 1. Segredos Obrigatórios em Produção
Configure os valores por ambiente ou secret store. O Web valida a configuração antes de abrir o banco.

- `AUTH_SESSION_SECRET` e `CREDENTIAL_ENCRYPTION_KEY` devem receber valores distintos e aleatórios e de pelo menos 32 bytes em produção. Preserve os valores já utilizados ao atualizar uma implantação.
- Se a implantação anterior usava `data/.runtime_secrets.json`, migre `sessionSecret` para `AUTH_SESSION_SECRET` e configure `CREDENTIAL_ENCRYPTION_KEY` como `hex:<credKeyHex>` com os 64 dígitos do arquivo. Esse formato preserva a chave AES original. Faça a transferência diretamente para o secret store, com acesso restrito.
- Trocar o segredo de sessão encerra as sessões existentes. A chave de cifra só deve ser substituída após recriptografar as credenciais ou planejar seu recadastro.
- Configure `POSTGRES_PASSWORD` e `DATABASE_URL` de forma consistente.

## Inicialização e proxy TLS

- Sirva o console por HTTPS. O cookie de produção usa `Secure`, `HttpOnly` e `SameSite=Lax`. Integrações que usam Bearer continuam autenticando pelo cabeçalho.
- Preencha `AIOPS_TRUST_PROXY` somente com os IPs ou CIDRs do proxy confiável. Configure esse proxy para controlar os cabeçalhos encaminhados e restrinja o acesso direto ao Web.
- Para uma base vazia, provisione `AIOPS_BOOTSTRAP_TOKEN` com um valor aleatório de pelo menos 32 bytes. Informe-o na tela de inicialização ou no cabeçalho `X-Bootstrap-Token` do pedido de bootstrap. Remova-o do ambiente após concluir a criação do primeiro administrador.

## Atualização do SQLite e rollback

A migração v3 preserva os logs e limpa apenas os vínculos com sites ausentes ou de outro tenant. Ela também bloqueia novos vínculos inválidos no banco. Antes de atualizar, faça um backup verificado do SQLite e registre o ponto de restauração. Para reverter sem desfazer essa proteção, volte à versão anterior da aplicação preservando a base atual. Se precisar voltar ao estado anterior dos vínculos, restaure o backup com a aplicação parada e reconcilie os registros criados após o backup.

## 2. Backup e Restore (SQLite local e PostgreSQL)
- **SQLite (`data/aiops.db`):** utilizar `sqlite3 data/aiops.db ".backup 'backup.db'"` com WAL consolidado.
- **PostgreSQL (`compose.yaml`):** `pg_dump -Fc -U aiops aiops_platform > backup.dump` e `pg_restore -d aiops_platform backup.dump`.
- O procedimento deve ser validado com restauração periódica em ambiente de homologação (Etapa D).
