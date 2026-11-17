# Relatório central de testes — Distributed Wagering Processor

**Escopo:** requisitos das seções 5–14 do desafio Jungle Gaming. Esta página é o índice
de resultados, evidências e procedimentos; os detalhes estão nos documentos vinculados.

## Evidência executada

Referência verificada: commit `5f2f042`, [job PostgreSQL / cobertura da CI](https://github.com/sv-anacaroline/distributed-wagering-processor/actions/runs/44003014324/job/133771467291).
O job de testes foi concluído com sucesso; o check de formatação dessa revisão
ainda falhava e foi corrigido em commit posterior. Os números abaixo se referem
**exclusivamente à execução citada**, não a resultados de outra execução ou ao k6.

| Execução | Cenários concluídos | Linhas LCOV | Funções LCOV |
| --- | ---: | ---: | ---: |
| Unidade (Bun, `src/`) | 178 testes | 82,67% | 87,78% |
| Integração + HTTP E2E (Bun, `test/`) | 83 testes | — | — |
| Unidade + integração (banco isolado) | 261 testes | 97,36% | 98,42% |
| Keycloak com tokens reais | Sucesso em job separado | Não incluído no LCOV | Não incluído no LCOV |
| k6 financeiro | **6 cenários executados com sucesso em workflow independente** ([run #44005374904](https://github.com/sv-anacaroline/distributed-wagering-processor/actions/runs/44005374904)) | Não aplicável | Não aplicável |

Arquivos e interpretação: [relatório de cobertura](TEST_COVERAGE.md).
Cenários de k6, metodologia, resultados reais de 17/11/2026 e status: [relatório de performance](PERFORMANCE_REPORT.md)
e [manual de execução do k6](PERFORMANCE.md).

## Matriz de cobertura de requisitos

| Requisito | Casos exercitados | Referência principal |
| --- | --- | --- |
| Money decimal exato, não-negatividade, saldo e versão | Quantização de duas casas, moeda diferente, ledger aritmético, saldo negativo e crédito limite | `src/domain/money.spec.ts`, `src/domain/wallet.spec.ts`, `test/domain-schema.integration.test.ts` |
| BET/WIN/LOSS | Crédito, débito, rejeição de saldo, LOSS sem ledger nem evento de saldo | `src/application/wager-rules.spec.ts`, `test/process-wager.integration.test.ts`, `test/event-matrix.integration.test.ts` |
| REFUND/ROLLBACK | Valor completo, referências válidas/inválidas, reversões cruzadas, saldo insuficiente distinto | `src/domain/wager-transaction.spec.ts`, `test/process-wager.integration.test.ts`, `test/event-matrix.integration.test.ts` |
| Fora de ordem | PENDING_REFERENCE, retry persistido, resolução, TTL, rejeição por referência ausente | `test/event-matrix.integration.test.ts`, `test/sqs-events.integration.test.ts` |
| Replay/idempotência | Mesmo header/payload, payload conflitante, 50 apostas, dedup Inbox por messageId | `test/process-wager.integration.test.ts`, `test/sqs-inbox.integration.test.ts`, `test/distributed-concurrency.integration.test.ts` |
| Concorrência | Duas BETs de 80 sobre 100, ≥3 processos Bun, hot wallet e wallets distintas | `test/distributed-concurrency.integration.test.ts`, `test/concurrency-locks.integration.test.ts` |
| Evento WagerTransactionProcessed | BET, WIN, LOSS, REFUND, ROLLBACK e abertura; causalidade e versão | `test/event-matrix.integration.test.ts`, `test/sqs-events.integration.test.ts` |
| Evento WagerTransactionRejected | Saldo insuficiente, reversão repetida, expiração, limite monetário | `test/event-matrix.integration.test.ts`, `test/sqs-inbox.integration.test.ts` |
| Evento WagerTransactionPendingReference | Publica quando entra em espera, sem saldo/ledger, e finaliza depois | `test/event-matrix.integration.test.ts`, `test/sqs-events.integration.test.ts` |
| Evento WalletBalanceChanged | Apenas saldo modificado, valor exato, walletVersion, ordem causal por wallet | `test/event-matrix.integration.test.ts`, `src/domain/wallet-balance-changed.spec.ts` |
| Inbox/Outbox SQL | Mesmo commit, unicidade, append-only, payload/versão imutáveis, fencing | `test/sqs-inbox.integration.test.ts`, `test/domain-schema.integration.test.ts`, `test/sqs-events.integration.test.ts` |
| Publicação SQS FIFO | Mensagem real, groups/IDs, 3 publishers, publisher morto, retry e lease expirado | `test/sqs-events.integration.test.ts`, `src/events/outbox-publisher.spec.ts` |
| Tratamento de falhas | DLQ após tentativas, mensagem inválida, falha de ACK, commit antes de crash, SIGTERM | `test/sqs-events.integration.test.ts`, `src/events/sqs-wager-consumer.spec.ts` |
| REST + autorização | Carteiras/ledger/reconciliação/consultas, OIDC e isolamento entre providers | `test/http-api.e2e.test.ts`, `test/auth-keycloak.e2e.test.ts` |
| k6 | Todas as rotas HTTP + disputa por saldo, replay, ledger/reconciliação e hot wallet | `performance/utils/http.js`, `performance/scenarios/*.js`; **execução sob demanda** |

Uma matriz de casos não prova exaustividade matemática. Os casos acima cobrem as
transições e falhas especificadas no enunciado; carga e variabilidade operacional
só podem ser qualificadas após execução medida.

## CI e critérios de aprovação

- [CircleCI](../.circleci/config.yml): `quality-static`, `quality-financial` e
  `quality-auth` são obrigatórios na configuração. Para executar efetivamente no
  CircleCI, **o projeto precisa estar conectado à plataforma** e esses checks
  precisam ser definidos como requeridos no repositório.
- [GitHub Actions](../.github/workflows/ci.yml): validação de PR e artefatos LCOV
  unitário/integrado. O job auth usa Keycloak real.
- A execução combinada de cobertura usa **um segundo PostgreSQL recém-criado**
  (`wagering_coverage`) para não depender de dados persistidos em testes anteriores.
- A cobertura integrada impõe piso de 70% de linhas e funções; relatório por arquivo
  e LCOV completo ficam nos artefatos da CI.
- **O k6 nunca integra os checks obrigatórios de merge.** A execução é uma rotina
  independente via pipeline opcional `run_performance=true` do CircleCI ou comandos
  locais; seus valores medidos devem ser registrados no
  [relatório de performance](PERFORMANCE_REPORT.md).

A configuração da CI não demonstra, por si só, que um projeto CircleCI já está
ativado ou que determinada carga k6 tenha sido executada.
