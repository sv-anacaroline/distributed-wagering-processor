# Relatório de desempenho — k6 (rotina independente)

Voltar ao [relatório central](TEST_RESULTS.md) e consultar
[o procedimento de execução](PERFORMANCE.md).

## Estado das medições

**Nenhuma medição k6 foi executada e comprovada nesta entrega.**
Os scripts foram reescritos para a API financeira real; a CI de qualidade
compila/valida TypeScript, realiza integração real e gera cobertura,
**mas não executa carga k6**, por decisão de projeto.

Os resultados de carga só serão preenchidos a partir dos JSON gerados
pela execução explícita `bun run test:load:<cenario>` ou do pipeline
CircleCI `run_performance=true`. Não são estimados.

| Cenário | Execução | RPS | p50 | p95 | p99 | Erros | Violações financeiras |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| smoke | Não executado | — | — | — | — | — | — |
| load | Não executado | — | — | — | — | — | — |
| stress | Não executado | — | — | — | — | — | — |
| spike | Não executado | — | — | — | — | — | — |
| soak | Não executado | — | — | — | — | — | — |
| hot-wallet | Não executado | — | — | — | — | — | — |

## Cobertura funcional do workload

Cada iteração financeira testa duas apostas de 80 BRL disputando wallet
de 100 BRL: um `PROCESSED`, um `REJECTED/INSUFFICIENT_FUNDS`,
saldo 20 BRL, versão 2, um único DEBIT mais o CREDIT de abertura,
replay idempotente histórico e reconciliação consistente.

O cenário `hot-wallet` compartilha **a mesma carteira** entre VUs e
verifica os mesmos invariantes depois da disputa.

Rotas medidas e identificadas por tag `endpoint`:
`GET /`, `GET /health/live`, `GET /health/ready`,
`POST /wallets`, `GET /wallets/:walletId`,
`GET /wallets/:walletId/ledger`,
`POST /wallets/:walletId/reconciliation`,
`POST /wagering/transactions`,
`GET /wagering/transactions/:transactionId`,
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`,
`GET /internal/metrics`.

O monitor utiliza identidade OIDC independente do provider financeiro.
HTTP 422 de rejeição financeira esperada não é contado como falha de
transporte. Respostas inesperadas e violações financeiras são contabilizadas.

## Campos produzidos

O arquivo `performance/results/<cenario>-summary.json` registra
`environment`, `baseUrl`, `requests`, `rps`, `p50_ms`,
`p95_ms`, `p99_ms`, `error_rate`, `processed_bets`,
`rejected_bets`, `replays`, `invariant_violations`,
`correctness_rate`, métricas individuais do k6 e submétricas por rota.

`lock_conflicts` e `outbox_lag_ms` aparecem como `null` caso a
telemetria da aplicação não esteja instrumentada. Não equivalem a zero.

## Para registrar um benchmark reprodutível

Anotar junto ao JSON: commit, data/hora, Bun e k6, hardware/CPU/memória,
VUs, duração, número de réplicas, volume da base, SQS utilizado, porta,
limites/p95 e quantidade de erros e violações. Comparar cenários somente
sob condições controladas. O desafio não impõe uma meta de RPS.

**Aceitação de merge:** os resultados do k6 são evidência opcional.
Não existe threshold k6 configurado como status obrigatório do PR.
