# ARCHITECTURE — Distributed Wagering Processor

## Escopo desta etapa

Modelagem enxuta, sem decorators NestJS, MikroORM ou infraestrutura dentro de
`src/domain/`. Cada objeto, evento e método com comportamento foi acompanhado
de testes unitários pelo Bun. O PostgreSQL fornece as garantias persistentes.

**Este PR não implementa a API de wallet/wagering, o processamento SQS, o
use case transacional, o publisher, a reconciliação ou testes de concorrência
com múltiplos processos.** Essas são as próximas entregas; não atribuir
garantia ponta a ponta antes delas.

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
  Futuro caso de uso: `SELECT ... FOR UPDATE` por `walletId`, efetuar
  mudanças, persistir wallet + ledger + wager + inbox (quando SQS) + outbox
  juntos, então fazer commit; ack SQS apenas depois.
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

## Próximos passos

1. APIs HTTP para wallets/wagers, autenticação de provider e mapeamento do contrato.
2. Consumers Inbox/SQS + publisher da Outbox com retries, lease, DLQ e shutdown seguro.
3. Abertura de wallets via caso de uso próprio e adapters ORM necessários.
4. Testes reais de atomicidade/races com >=3 instâncias, 50 requisições
   idênticas e duas BET de 80.00 contra saldo 100.00.
5. Reconciliação, logs/métricas e health endpoints.
