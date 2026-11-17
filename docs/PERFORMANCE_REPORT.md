# Relatório de desempenho — k6 (execução real)

Voltar ao [relatório central de testes](TEST_RESULTS.md) ·
[manual e comandos de reprodução](PERFORMANCE.md).

## Execução comprovada

**Status: 6/6 cenários executados com sucesso.** As medições abaixo foram obtidas
de logs e arquivos JSON efetivamente produzidos pelo k6 em **17 de novembro de 2026**.

- **Evidência:** [GitHub Actions — execução #44005374904](https://github.com/sv-anacaroline/distributed-wagering-processor/actions/runs/44005374904); [job de medição](https://github.com/sv-anacaroline/distributed-wagering-processor/actions/runs/44005374904/job/133779316901); artefato `measured-k6-performance` (JSONs e logs por cenário).
- **Código medido:** commit [`ef292975`](https://github.com/sv-anacaroline/distributed-wagering-processor/commit/ef292975782835f5029362a4ece5d29969b3d127), branch `feature/test-coverage-k6`. Atualizações posteriores da branch **não são automaticamente cobertas** por estes números.
- **Ambiente:** runner descartável GitHub Actions `ubuntu-24.04`, Bun 1.4.4, k6 `grafana/k6:1.8.2`, PostgreSQL 17, MiniStack 1.5.40, Keycloak com tokens OIDC assinados, API NestJS e workers.
- **Carga reduzida de validação:** `K6_VUS=2`, `K6_DURATION=8s`, `K6_STAGE_DURATION=6s`, `K6_SOAK_DURATION=20s`; cenário hot wallet utiliza no mínimo 3 VUs. Em rampa, stress chega a 8 VUs e spike a 20 VUs.
- **Dados auditáveis no repositório:** [snapshot JSON da execução](performance-evidence/2026-11-17-k6-measured.json), extraído das linhas `PERF_RESULT_JSON` e `PERF_ENDPOINTS_JSON` dos logs, preservando os percentis por rota e parâmetros da medição.

### Resultado agregado por cenário

Latências p50/p95/p99 em **milissegundos**. RPS indica requisições HTTP por segundo,
incluindo requisições de leitura, autenticação e operações financeiras.

| Cenário | Requisições | RPS | p50 (ms) | p95 (ms) | p99 (ms) | Erros HTTP | Violações financeiras |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Smoke | 1.097 | 135,53 | 1,57 | 8,85 | 16,22 | 0,00% | 0 |
| Load | 1.201 | 146,87 | 1,24 | 7,11 | 9,94 | 0,00% | 0 |
| Stress | 1.201 | 147,78 | 1,19 | 6,89 | 9,32 | 0,00% | 0 |
| Spike | 1.201 | 149,01 | 1,13 | 6,88 | 8,37 | 0,00% | 0 |
| Soak | 1.201 | 149,46 | 1,12 | 6,63 | 8,42 | 0,00% | 0 |
| Hot wallet | 3.647 | 453,82 | 4,05 | 5,41 | 7,15 | 0,00% | 0 |

**Todos os cenários tiveram taxa de correção financeira de 100% nas operações verificadas.**
A rejeição esperada por saldo insuficiente (HTTP 422) não é erro de transporte.

| Cenário | Apostas processadas | Apostas rejeitadas conforme regra | Replays idempotentes | Correção |
| --- | ---: | ---: | ---: | ---: |
| Smoke | 84 | 84 | 84 | 100,00% |
| Load | 92 | 92 | 92 | 100,00% |
| Stress | 92 | 92 | 92 | 100,00% |
| Spike | 92 | 92 | 92 | 100,00% |
| Soak | 92 | 92 | 92 | 100,00% |
| Hot wallet | 1 | 3.637 | 0 | 100,00% |

No hot wallet, os VUs utilizaram a **mesma carteira com R$ 100,00**:
uma aposta de R$ 80,00 foi processada, 3.637 foram rejeitadas corretamente
por saldo insuficiente e o saldo final foi reconciliado em R$ 20,00,
com uma única linha de débito (além da abertura). O cenário reportou
3.647 requisições totais e não apresentou duplicação financeira.

## Latência p95 por rota HTTP (ms)

Valores medidos por trends individuais `financial_route_..._ms`, e não
calculados a partir de médias globais. Nos cenários regulares a leitura e
reconciliação são verificadas após a disputa e o replay.

| Rota | Smoke | Load | Stress | Spike | Soak |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /` | 1,16 | 0,60 | 0,41 | 0,40 | 0,45 |
| `GET /health/live` | 0,73 | 0,59 | 0,48 | 0,27 | 0,72 |
| `GET /health/ready` | 7,97 | 5,21 | 5,96 | 5,06 | 4,48 |
| `POST /wallets` | 9,15 | 6,29 | 6,27 | 4,18 | 4,47 |
| `GET /wallets/:walletId` | 2,78 | 1,25 | 1,20 | 1,01 | 1,05 |
| `GET /wallets/:walletId/ledger` | 3,80 | 1,63 | 1,73 | 1,40 | 1,36 |
| `POST /wallets/:walletId/reconciliation` | 3,81 | 2,40 | 2,01 | 2,09 | 2,08 |
| `POST /wagering/transactions (duas BETs em disputa)` | 12,97 | 9,88 | 8,88 | 8,27 | 7,57 |
| `POST /wagering/transactions (replay/BET)` | 3,93 | 2,32 | 2,36 | 1,98 | 2,10 |
| `GET /wagering/transactions/:transactionId` | 2,95 | 1,60 | 1,37 | 1,43 | 1,31 |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | 2,46 | 1,41 | 1,33 | 1,17 | 1,20 |
| `GET /internal/metrics` | 1,64 | 0,72 | 0,77 | 0,76 | 0,74 |

### Rotas específicas sob concorrência da hot wallet

| Rota | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | ---: | ---: | ---: |
| `POST /wallets` | 3,46 | 3,46 | 3,46 |
| `POST /wagering/transactions (replay/BET)` | 4,05 | 5,39 | 7,06 |
| `GET /wallets/:walletId (hot wallet)` | 1,17 | 1,17 | 1,17 |
| `GET /wallets/:walletId/ledger (hot wallet)` | 0,88 | 0,88 | 0,88 |
| `POST /wallets/:walletId/reconciliation (hot wallet)` | 0,93 | 0,93 | 0,93 |

## O que foi realmente exercitado

Cada iteração regular criou uma carteira com `100.00 BRL`, disputou duas
`BET` de `80.00 BRL`, verificou exatamente uma transação `PROCESSED` e
uma `REJECTED/INSUFFICIENT_FUNDS`, repetiu a operação vencedora com a mesma
chave de idempotência e confirmou o replay da resposta histórica.

Em seguida, validou saldo `20.00`, versão 2, um débito e crédito de abertura
no ledger, reconciliação exata, endpoints de consulta financeira, saúde e
métricas internas usando um client de monitoramento OIDC independente.

O cenário `hot-wallet` disputa uma mesma carteira entre VUs concorrentes e
verifica o saldo final, versão, débito único e reconciliação no teardown.

A matriz de eventos SQS/Outbox, reversões e falhas controladas é coberta
pela suíte de integração; **não são workloads k6 de longa duração**.

## Limitações e interpretação responsável

- **Não é uma medição da máquina local do usuário**, nem teste de escala em EKS,
  nem prova de capacidade máxima. Os valores refletem o runner de CI e
  o banco/IdP/emulador no mesmo host. Em especial, stress/spike/soak foram
  encurtados para validar a rotina; o soak não mede estabilidade por horas.
- `lock_conflicts` e `outbox_lag_ms` não estavam instrumentados no benchmark;
  o JSON os registra como `null`, não como zero.
- Os percentis por rota que possuem uma única observação, especialmente
  verificações finais de hot wallet, devem ser interpretados como amostra
  pontual, não distribuição estatisticamente robusta.
- Não inventar comparações com versões futuras. Uma nova execução deve produzir
  novo JSON e atualizar este relatório com o commit, runner, VUs, duração e data.

## Como repetir (independente dos gates de merge)

```bash
bun run local:up
bun run local:verify
bun run test:load:all
# resultados: performance/results/{smoke,load,stress,spike,soak,hot-wallet}-summary.json
# agregado: performance/results/benchmark-index.json
```

Também há o [workflow de performance sob demanda](../.github/workflows/performance-benchmark.yml)
e o workflow manual do CircleCI `run_performance=true`. O benchmark é
**independente dos checks obrigatórios de merge**: falhas de carga não impedem
o merge, mas devem ser investigadas e registradas.

O desafio não estabelece um RPS mínimo obrigatório; os thresholds k6 são
parâmetros experimentais definidos no repositório.
