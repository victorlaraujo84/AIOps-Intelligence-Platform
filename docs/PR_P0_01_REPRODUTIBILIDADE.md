# P0-01 — Instalação, build e testes reproduzíveis

Base: `f29e3b054c1ef4086db71ed4f5628f026ea70b83`.
Branch: `codex/p0-reproducible-builds`.
Autorização: implementação iniciada após aprovação do Discovery pelo usuário.

## Escopo e decisões

- Adotar npm e `package-lock.json`, alinhados ao CI e ao Dockerfile web.
- Usar Node 22 como referência de CI/Docker e registrar resultados locais com a versão efetivamente utilizada.
- Executar typecheck, build, testes TypeScript e os contratos Python existentes.
- Remover o lockfile Bun para evitar duas resoluções concorrentes.
- Não alterar autenticação, tenancy, migrations, conectores ou governança ML neste incremento.

O baseline falhou com `npm ci` por ausência do lockfile npm. A primeira resolução pelo registry também falhou: o `esbuild ^0.25.0` declarado diretamente conflita com o peer opcional de Vite 8. Não há importação direta de esbuild no projeto; remover essa dependência permite que as ferramentas resolvam suas próprias versões compatíveis, sem `--force` ou `--legacy-peer-deps`.

Outra falha reproduzida: npm sintetiza `node-gyp rebuild` durante `npm ci` de better-sqlite3 13, apesar de `gypfile: false` e dos binários N-API incluídos. A instalação tentou localizar Python/toolchain de compilação. O comportamento está registrado no [npm/cli #9837](https://github.com/npm/cli/issues/9837). A configuração `.npmrc` desativa scripts automáticos de dependências; `npm run check:sqlite`, os testes e o build verificam explicitamente os binários utilizados. Não instalar toolchains globais nem executar scripts de terceiros para contornar essa falha.

## Plano e critérios de aceite

1. Resolver e versionar dependências com npm, sem ignorar conflitos de peer.
2. Executar `npm ci` com o lockfile e verificar que ele permanece inalterado.
3. Executar `npm run lint`, `npm run build` e `npm test`; corrigir somente incompatibilidades necessárias para esses comandos.
4. Executar testes Python no CI e preservar a verificação de sintaxe de todos os módulos.
5. Registrar evidências, limitações e revisão do diff.

## Evidências de execução — 19/11/2026

Ambientes: Windows x64 com Node **22.23.5** e npm **11.20.0**; imagem `node:22-alpine` com Node **22.23.5** e npm **10.9.9**; Python local **3.12.14**. O Node 22 local foi obtido do site oficial e verificado contra o SHA-256 publicado, sem alterar a instalação global.

| Verificação | Resultado observado |
|---|---|
| Baseline `npm ci` | Falhou por ausência de lockfile; resolução inicial também revelou o conflito esbuild/Vite |
| `npm ci --no-audit --no-fund` com `.npmrc` | Passou após desativar scripts automáticos; 224 pacotes instalados |
| `npm ci --offline --no-audit --no-fund` no Node 22 | Passou usando cache local; SHA-256 do lockfile permaneceu inalterado |
| Consistência de package.json/lockfile | Dependências runtime/dev coincidem; registros opcionais Alpine/musl preservados |
| `npm run check:sqlite` | Passou em Windows x64 e Linux x64/musl, usando banco em memória |
| `npm run lint` | Passou em Windows e dentro da imagem Alpine |
| `npm run build` | Passou em Windows e durante o build Docker |
| `npm test` | 14 testes passaram em Windows e os mesmos 14 passaram dentro da imagem Alpine |
| `python -m compileall -q services backtesting tests` | Passou |
| `python -B -m unittest discover -s tests/unit -p "test_python_*.py" -v` | 5 testes passaram no Python 3.12.14 |
| `docker build --progress=plain -f infra/docker/Dockerfile.web -t aiops-platform:p0-reproducibility-f29e3b0 .` | Passou; instalação, verificação nativa e bundle executados no build |
| `docker compose --env-file .env.example config --no-env-resolution --quiet` | Passou somente a validação estrutural com exemplos; `.env` real não foi criado |
| Revisão independente | Corrigidos contexto Docker, dependência runtime tsx e preservação da cobertura de sintaxe Python |

A primeira execução dos testes HTTP dentro do sandbox falhou em quatro casos com `fetch failed`. Um servidor HTTP mínimo confirmou `connect EACCES 127.0.0.1`: restrição do ambiente, sem alteração no código testado. A repetição com loopback permitido aprovou todos os 14 testes. No Docker, typecheck/testes rodaram em containers `--rm --network none`, sem portas publicadas nem volumes de produção.

O contexto Docker passou a excluir node_modules/dist locais, .env, bancos, caches, .git e anexos; a imagem instala suas próprias dependências pelo lockfile. `tsx` é dependência explícita de execução para `npm start`.

## Limites e avisos

- CI remoto ainda não executado; a matriz Python 3.11/3.12 foi configurada, mas só Python 3.12 foi executado localmente.
- A imagem FastAPI e a stack completa não foram construídas/homologadas neste incremento. Nenhum serviço de produção foi iniciado.
- Vite emitiu avisos sobre o uso existente de `__dirname` no config e chunk principal de aproximadamente 925 kB; build terminou com exit 0. O npm também reportou a depreciação transitiva de node-domexception.
- Testes usam fixtures isoladas. Não foram acionados conectores, notificações, tickets ou treinamento com dados reais.

## Rollback

Reverter o commit deste incremento. Não há alteração persistente de banco nem migração de dados. A reversão também restaura as limitações do baseline anterior.

## Risco residual

Esta entrega não resolve os demais achados de segurança e arquitetura. O parecer de produção permanece NO-GO até correção e homologação dos bloqueadores.
