# P0 — validação de literais de endereço para destinos HTTP

Base: `dc12a36bf9615b86d6227c81c20e45f4876a20e3`, após a homologação Docker local. Incremento em `codex/ssrf-ip-literals`, dependente do PR Docker; não altera schema, dados ou integrações externas.

## Evidência e impacto

`validateExternalUrl` em `src/server/security.ts` aceitava `http://[::ffff:127.0.0.1]/`: o parser WHATWG normaliza o endereço para `::ffff:7f00:1`, e a verificação anterior procurava apenas a notação IPv4 decimal após `::ffff:`. A classificação IPv6 também verificava somente o prefixo textual `fe80:`, deixando passar outros endereços de `fe80::/10`. Hostnames como `localhost.` contornavam a comparação textual. O efeito potencial era permitir configurações de destinos internos em rotas que dependem desse validador; não foi executado acesso a esses destinos.

## Correção e política

- Rejeitar literais IPv4 privados, compartilhados, link-local, loopback, documentação, benchmark, multicast, reservados e alocações especiais da IANA. A política é conservadora: bloqueia integralmente os blocos especiais, inclusive exceções globalmente roteáveis em alguns deles (AS112, AMT e anycast).
- Para IPv6, aceitar somente unicast global `2000::/3`, excluindo `2001::/23`, `2001:db8::/32`, `2002::/16` e `3fff::/20`. Isso rejeita endereços mapeados/traduzidos de IPv4, inclusive quando o IPv4 embutido é público. Não habilita NAT64/6to4 ou destinos especiais por exceção.
- Normalizar o ponto DNS final para aplicar o bloqueio de hostnames internos.
- Preservar validação de protocolo, credenciais em URL e destinos públicos comuns. Não há bypass global para redes privadas.

Referências consultadas em 2026-11-20: [registro IPv4 da IANA](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) e [registro IPv6 da IANA](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml). A política escolhida é mais restritiva que a classificação de alcance global desses registros.

## Validação

- Três categorias de testes falharam antes da correção: IPv4 em IPv6, faixas especiais e ponto final DNS; destinos públicos passaram. A revisão identificou três blocos especiais adicionais; o teste respectivo também falhou antes de corrigir esses blocos.
- `npm test`: 25 testes passaram, incluindo cinco novos testes de regressão, testes multi-tenant, RBAC e integrações locais com fixtures isoladas.
- `npm run lint` e `npm run build`: passaram. Permanecem avisos de configuração Vite com `__dirname` e bundle acima de 500 kB.
- Imagem web Docker construída com sucesso; `node scripts/test-compose-local.mjs` passou em `aiops-smoke-22f6d37a23d8`, incluindo autenticação/RBAC, inventário, ingestão idempotente, conexões autenticadas, persistência e backup/restore. Projeto e volumes de fixtures removidos ao encerrar.
- Nenhuma chamada a IP externo, scan, coleta ou notificação foi executada pelos novos testes; são verificações offline de classificação de URLs.

## Limites e próximos passos

O achado SSRF permanece **PARCIAL**: ainda faltam resolução DNS com rejeição de respostas privadas, fixação do endereço aprovado no socket (anti-rebinding), política de redirects e cliente HTTP compartilhado para todos os caminhos de saída. Um hostname público pode resolver para rede privada; bloquear literais não resolve esse problema. Redes internas do Compose continuam sendo uma proteção adicional na homologação, sem substituir a correção do cliente HTTP.

O ambiente local já em execução permanece na versão Docker anterior; este incremento é entregue para revisão em PR separado. Não houve implantação em produção. Rollback: reverter somente o commit deste incremento; não exige migração nem alteração do `.env` ou dos volumes. A reversão reabre os casos bloqueados, portanto só deve ocorrer com egress restrito.

O PR é empilhado sobre `codex/docker-local-homologation` para exibir apenas o incremento de segurança. O workflow atual dispara em PRs destinados a `main`; enquanto a base for a branch Docker, não há CI automático novo. Após integrar o PR Docker, redirecionar a base deste PR para `main` e exigir CI verde antes do merge. As evidências acima são execuções locais, não resultados de um CI deste incremento.
