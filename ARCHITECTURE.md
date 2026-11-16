# ARCHITECTURE — Distributed Wagering Processor

## Visão geral

Domínio financeiro enxuto, sem decorators NestJS, MikroORM ou infraestrutura
dentro de `src/domain/`. O caso de uso `ProcessWager` já coordena operações
financeiras e Outbox em transações PostgreSQL. Testes unitários e de integração
com banco real asseguram invariantes, inclusive com três processos Bun
independentes. Nenhum mecanismo de consistência depende de memória local.

**Ainda não implementamos endpoints HTTP financeiros, consumidores SQS,
publisher da Outbox, reconciliação de produção nem deploy EKS dos workers.**
A seção 8 valida concorrência por wallet no PostgreSQL, não a entrega em
ordem dos eventos por SQS.

## Money

- Armazenamento interno de dinheiro: `bigint` em centavos, sem `number`,
  `float`, `double` ou arredondamento. Não foi necessário adicionar decimal.js.
- Entrada `Money.from()`: string decimal não negativa, com **exatamente duas casas**.
  Strings negativas, notação exponencial, NaN e valores além de
  `NUMERIC(20,2)` são rejeitados.
- Operações internas `subtract`/`negate` podem produzir valores negativos para
  cálculos; Wallet nunca aceita saldo negativo.
- Comparações e operações entre moedas distintas lançam erro.
- Persistência planejada: `NUMERIC(20,2)` e moeda separada, reconstituídos
  como `Money` a partir de strings.
- Apenas formato ISO 4217 maiúsculo de três caracteres é validado nesta etapa;
  um catálogo autoritativo de códigos de moedas pode ser adicionado ao contrato
  externo, se exigido. A aplicação poderá operar somente em BRL.

## Wallet / Ledger

- Wallet é aggregate root. `open()` inicia a versão em 1; `credit()` e
  `debit()` criam `WalletLedgerEntry` e incrementam a versão somente quando
  existe movimentação positiva.
- No fluxo de abertura com saldo positivo, o **caso de uso** deverá criar
  a transação interna `OPENING` e seu ledger de crédito na mesma SQL transaction.
- `WalletLedgerEntry` é imutável; `create()` confere a identidade, as moedas,
  o valor positivo e a aritmética exata antes de alterar Wallet.
- Rehidratação reconstruirá estado persistido, sem reexecutar as transições.
- **O modelo em memória não substitui o lock por wallet e a transação SQL**.
  O caso de uso usa `SELECT ... FOR NO KEY UPDATE` por `walletId`, efetua
  movimentações e persiste wallet + ledger + wager + outbox no mesmo commit.
  Quando o consumidor SQS existir, também deverá persistir Inbox nessa
  mesma transação e enviar ack somente depois do commit.
- O ledger SQL tem `wallet_version`. O repositório futuro obtém esse valor
  de `Wallet.version` no mesmo caso de uso em que grava o lançamento.

## WagerTransaction — máquina de estados

| Estado | Transições permitidas |
| --- | --- |
| PENDING | PROCESSED, PENDING_REFERENCE, REJECTED, FAILED |
| PENDING_REFERENCE | PROCESSED, PENDING_REFERENCE, REJECTED, FAILED |
| PROCESSED | Nenhuma |
| REJECTED | Nenhuma |
| FAILED | Nenhuma |

- Estados terminais nunca são reabertos ou sobrescritos. `FAILED` é para erro
  permanente e auditável; falhas temporárias devem manter a operação recuperável.
- `OPENING` é criado apenas pela factory interna `opening()`.
- `BET` gera DEBIT; `WIN` e `REFUND`, CREDIT; `LOSS` não gera ledger.
- `REFUND` referencia somente `BET` processada; `ROLLBACK` referencia
  `BET`, `WIN` ou `REFUND` processada. Nunca `LOSS` ou `OPENING`.
- Referências obrigatórias são IDs externos resolvidos por
  `(providerId, externalTransactionId)`. Moeda, provedor, player,
  wallet e rodada precisam coincidir. REFUND/ROLLBACK exigem valor integral.
- ROLLBACK de uma BET gera crédito; de WIN/REFUND gera débito. Se uma reversão
  debitadora não tiver saldo, o caso de uso a rejeitará com
  `REVERSAL_INSUFFICIENT_FUNDS`, diferente de `INSUFFICIENT_FUNDS` para BET.
- Uma BET admite uma única compensação ativa entre REFUND e ROLLBACK,
  mesmo sendo tipos diferentes. O índice parcial SQL reserva a referência
  somente nos estados PENDING/PENDING_REFERENCE/PROCESSED; rejeições não
  bloqueiam novas tentativas corrigidas.
- `matchesPayload` compara o hash persistido, mas a canonicalização JSON e
  armazenamento de resposta histórica para idempotência ficam no caso de uso.

## Transactional Outbox / Inbox

- Inbox tem identidade `(consumerName, messageId)`, hash do payload e marcação
  de processamento. A deduplicação precisa usar **índice único SQL**, nunca cache.
- Cada evento concreto define `eventType` e `version`, usando
  `IntegrationEvent` como envelope com payload serializável (MoneyProps em
  decimal string), ID de evento estável, correlação e causação.
- Eventos mínimos: `WagerTransactionProcessed` (inclusive LOSS),
  `WagerTransactionRejected`, `WagerTransactionPendingReference`,
  `WalletBalanceChanged` (somente quando há mudança efetiva de saldo).
- `OutboxMessage` armazena snapshot imutável, tentativas e agendamento
  persistível com backoff limitado. **Nenhuma entidade publica no SQS**.
- **Antes do commit:** erro SQL desfaz a alteração financeira, inbox, ledger e
  outbox; nenhum publisher deve ver esse evento.
- **Depois do commit:** worker pode morrer; outro publisher retoma a mensagem
  persistida. Publicar e morrer antes de confirmar pode gerar duplicidade.
  Consumidores devem ser idempotentes; garantia não é exactly-once.
- **Reversão depois do commit:** é uma *nova* WagerTransaction do tipo
  ROLLBACK/REFUND, com novo ledger/outbox; não executamos DELETE nem alteramos
  eventos antigos.
- O esquema inclui `claimed_by` e `claim_expires_at` na outbox para o
  futuro claim concorrente (`FOR UPDATE SKIP LOCKED` + lease). O worker
  e a política final de retomada ainda não estão implementados.

## Esquema PostgreSQL e índices

`src/migrations/Migration20261116200000.ts`:

- `wallets`: `UNIQUE(player_id,currency)`, `balance>=0`,
  `version>=1`, identidade imutável, incremento estrito de versão
  quando o saldo muda.
- `wager_transactions`: `UNIQUE(provider_id,external_transaction_id)`,
  `UNIQUE(idempotency_key)`, checks de kind, status e referências,
  FKs de carteira/moeda/jogador, estados terminais imutáveis.
  `response_snapshot JSONB` reservado para replay HTTP histórico.
- `wallet_ledger_entries`: `NUMERIC(20,2)`, checks de valor/direção/
  aritmética, `UNIQUE(wallet_id,transaction_id)`, `UNIQUE(wallet_id,
  wallet_version)`, FK para a mesma wallet/moeda/transaction, triggers
  contra UPDATE, DELETE e TRUNCATE.
- Triggers **deferrable** verificam saldo final da wallet versus última
  entrada do ledger e continuidade de versões no mesmo commit. Assim uma
  abertura positiva ou mudança de saldo isolada da entrada financeira
  não poderá ser confirmada.
- `inbox_messages`: PK composta do consumidor + ID da mensagem.
- `outbox_messages`: PK no event ID, payload JSONB protegido contra UPDATE,
  progresso de tentativas monotônico, campos de claim, índice parcial de
  eventos pendentes e verificação de identidade do envelope.

Os testes PostgreSQL reais estão em `test/domain-schema.integration.test.ts`.
A CI cria a base, aplica a migration, roda testes, testa o rollback e reaplica
somente no ambiente descartável. O rollback desta migration **apaga tabelas e
dados**: não executar como solução automática para reversões financeiras.

## Regras de negócio — Seção 7 (implementadas)

A implementação é documentada em [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md).
O processador `ProcessWager` utiliza `em.fork().transactional`,
`FOR UPDATE` da wallet e IDs externos de provedor para referências; a Outbox
é inserida na mesma transação que status, saldo e ledger. O hash canônico
SHA-256 e a resposta histórica são persistidos para replays.

A segunda migration `Migration20261116213000.ts` adiciona agendamento de
referência (`attempts`, `nextAttemptAt`, `expiresAt`), unicidade de reversão
ativa entre tipos e validação SQL de referências resolvidas. O worker
`ReferenceRetryWorker` reprocessa pendências persistidas a cada intervalo
sem depender de SQS. `wallet.version` registra apenas mudanças de saldo.

**Ainda não há endpoints, consumidores/publishers SQS, execução EKS do worker
ou fluxo de abertura de wallet pela API.**

## Concorrência e ordenação — Seção 8

**Unidade de concorrência = `walletId`**, não uma fila, processo ou lock global.
`ProcessWager` inicia uma transação PostgreSQL por tentativa, com
`SELECT ... FOR NO KEY UPDATE` na wallet antes de consultar e bloquear
a transação por idempotência. Todas as operações da **mesma wallet** são
serializadas, mas wallets diferentes podem progredir em paralelo.

### Por que FOR NO KEY UPDATE?

O PostgreSQL 17 distingue `FOR NO KEY UPDATE` de `FOR UPDATE`:
ambos bloqueiam outro escritor com lock equivalente, mas a opção mais
restrita não bloqueia `FOR KEY SHARE`, usado na validação de FKs.
Isso permite verificações de referência para a mesma wallet sem sacrificar
a serialização das alterações de saldo. A identidade da wallet e da moeda
é imutável (trigger SQL), então não há atualização de chaves. A escrita
mantém `WHERE version = versão_anterior`, com detecção de conflito e
invariantes no banco. A versão incrementa apenas quando há movimento.

A ordem de aquisição é **wallet → transação existente → referência/ledger/
outbox**. Não fazemos chamadas de rede nem publicamos SQS sob lock.
`LOCK TIMEOUT` (55P03), deadlock (40P01) e serialization failure (40001)
podem reiniciar **a transação inteira**, até **três tentativas**,
com backoff de 10ms/20ms e jitter (até 9ms); o lock é liberado antes
do backoff. A regra de negócio e SQLSTATE 23505 (violação de unicidade)
não são repetidos às cegas. Esgotado o limite, a falha é propagada;
não transformamos erro de infraestrutura em rejeição de saldo.

### Identidade e ordenação

- `transaction.id`: identidade interna; `(providerId,externalTransactionId)`:
  referência estável entre mensagens e providers;
- `wallet.version` e `ledger.wallet_version`: sequência financeira por
  wallet. LOSS, REJECTED e PENDING_REFERENCE não criam número de sequência;
- `eventId`: deduplicação da Outbox, **não** uma ordenação global de eventos;
- SQS FIFO e MessageGroupId poderão reduzir disputa, mas **não** são
  fonte final de consistência. O banco é a autoridade.

### Índices e volume de escrita

Revisamos o caminho crítico:

| Consulta / garantia | Índice existente |
| --- | --- |
| Lock por walletId | `wallets_pkey` |
| Idempotência global | `wager_transactions_idempotency_key_key` |
| ID externo por provedor | `wager_provider_external_unique` |
| Reversões ativas | `wager_one_active_reversal` (parcial) |
| Pendências vencidas | `wager_pending_reference_due_idx` |
| Versão e continuidade do ledger | `ledger_wallet_version_unique` |
| Entrada única por transação | `ledger_wallet_transaction_unique` |
| Próxima publicação Outbox | `outbox_due_idx` (parcial) |

Não criamos índices novos para consultas já atendidas por PK/UNIQUE. Cada
índice adiciona custo às escritas e ao vacuum. A migration
`Migration20261116223000.ts` define `wallets.fillfactor=85`, reservando
espaço para versões HOT. Como `balance`, `version` e `updated_at` não
aparecem nos índices da wallet, atualizações podem evitar manutenção de
índices quando há espaço livre na página. Essa configuração afeta
principalmente inserções/páginas futuras, **não reescreve páginas antigas**.
Monitorar `n_tup_hot_upd / n_tup_upd`, `n_dead_tup`, `idx_scan`,
`pg_locks` e latências de transação antes de ajustar mais parâmetros.

```bash
# Padrão de acesso sem SQS/API, com 3 processos Bun reais:
bun run db:migrate:up
bun run test:concurrency

# Diagnóstico não-destrutivo no PostgreSQL local:
docker compose exec -T postgres psql -U wagering -d wagering \
  < scripts/sql/concurrency-diagnostics.sql
```

### Evidência no CI

A suíte `test/distributed-concurrency.integration.test.ts` inicia **três
processos Bun independentes**, cada um com EntityManager/pool próprios:
duas BET 80.00 simultâneas, 50 pedidos idênticos distribuídos, wallets
sem lock global, e 3 retries disputando a mesma referência. Os testes
não usam HTTP ou SQS. A suíte `test/concurrency-locks.integration.test.ts`
valida diretamente os modos `FOR NO KEY UPDATE`/KEY SHARE e a exclusão
entre escritores no PostgreSQL real. Testes unitários exercitam retries,
classificação de falhas e propriedades financeiras em várias combinações
de centavos, saldo e efeitos de operações.

**Limite de performance:** não há RPS/SLA arbitrário neste desafio.
Operações da *mesma wallet* são necessariamente serializadas e limitadas
pela duração do commit e dos triggers; o throughput agregado cresce
paralelizando **wallets diferentes**. O CI prova propriedades de
concorrência, não um benchmark de saturação. Medições repetidas de
p95/p99, CPU, locks e throughput serão coletadas quando tivermos canal
de requisições real. Nenhum cliente HTTP ou consumidor SQS foi criado.

## Próximos passos

1. APIs HTTP para wallets/wagers, autenticação de provider e mapeamento do contrato.
2. Consumers Inbox/SQS + publisher da Outbox com retries, lease, DLQ e shutdown seguro.
3. Abertura de wallets via caso de uso próprio e adapters ORM necessários.
4. Ampliar os testes distribuídos para chaos/rede e execução em pods EKS.
5. Reconciliação, logs/métricas e health endpoints.
