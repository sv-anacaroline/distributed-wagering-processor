# Regras de negócio — Seção 7

## Escopo

Esta entrega implementa **somente a seção 7**. O fluxo é reutilizável por HTTP ou
SQS no futuro, mas não registra controllers, consumidores, publishers nem
endpoints de operações nesta branch.

- `src/application/wager-rules.ts`: decisões financeiras puras e testáveis.
- `src/application/wager-contracts.ts`: contrato, hash canônico e resposta histórica.
- `src/application/process-wager.ts`: coordenação transacional SQL, wallet
  bloqueada por `FOR UPDATE`, ledger e Outbox atômicos, idempotência e retry.
- `src/application/reference-retry.ts`: política de backoff/TTL.
- `src/workers/reference-retry-worker.ts`: laço agendado sobre linhas devidas.
- `src/jobs/retry-references.ts`: ponto de entrada Bun do worker.
- `src/migrations/Migration20261116213000.ts`: constraints adicionais,
  índice de reversões ativas, retry durável e trigger de referências.

## Efeitos das operações

| Kind | Efeito no saldo | Ledger | Resultado |
| --- | --- | --- | --- |
| BET | Débito | DEBIT | Insuficiência -> REJECTED/INSUFFICIENT_FUNDS |
| WIN | Crédito | CREDIT | Referência à BET opcional, mas validada se informada |
| LOSS | Nenhum | Nenhum | PROCESSED; não incrementa wallet.version |
| REFUND | Crédito integral de BET | CREDIT | Apenas BET PROCESSED e mesmo valor |
| ROLLBACK | Inverso da referência | DEBIT ou CREDIT | BET/WIN/REFUND PROCESSED; mesmo valor |

O `ROLLBACK` de `WIN` ou `REFUND` debita a wallet; se não houver saldo,
fica `REJECTED` com `REVERSAL_INSUFFICIENT_FUNDS`, **distinto** de
`INSUFFICIENT_FUNDS` para apostas.

### Referências e reversões cruzadas

Referência externa: **`(providerId, referenceExternalTransactionId)`**.
Ao resolver, persiste-se o `referenceTransactionId` interno.
A operação deve coincidir em provider, player, wallet, moeda, rodada e jogo.
`REFUND` só aponta para BET; `ROLLBACK` para BET, WIN ou REFUND; nunca LOSS
ou OPENING. Somente reversões de valor integral.

**Decisão adicional confirmada:** uma BET não admite simultaneamente
`REFUND(BET)` e `ROLLBACK(BET)`. A nova constraint SQL reserva a referência
para uma reversão ativa de qualquer um desses dois tipos. Uma tentativa
`REJECTED` não reserva a referência: um novo comando corrigido pode entrar.
Uma reversão processada permanece a compensação única; seu ledger e seu evento
original jamais são apagados. `ROLLBACK(REFUND)` é permitido e depende de
saldo disponível, pois referencia a transação REFUND, não a BET original.

`wallet.version` é a ordem das **mudanças de saldo**, não de todas as
operações: LOSS não a incrementa. UUIDs e timestamps identificam operações,
mas não definem sequência financeira. Ainda não há sequenciador global.

## Idempotência

Duas proteções independentes e persistentes no PostgreSQL:

- `UNIQUE(idempotency_key)`, de escopo global.
- `UNIQUE(provider_id,external_transaction_id)`, por provedor.

O hash SHA-256 considera a representação canônica dos campos do comando,
incluindo `amount` como decimal string; **não** usa o nome das propriedades
JSON nem números de ponto flutuante. Mesma operação e payload devolvem a
`response_snapshot` persistida na transação, com saldo, versão, status,
failureCode e instante originalmente observados. Payload diferente resulta
em `IDEMPOTENCY_CONFLICT`, sem mutação da operação original.

A identidade do comando é gerada antes da gravação. Todos os writers lockam
a **linha da wallet**, nunca um mutex em memória/global. Uma colisão de
unicidade é resolvida consultando o resultado efetivamente confirmado.

## Estados e resultado

- `PROCESSED`: terminal; ledger apenas para operações com efeito financeiro.
- `REJECTED`: terminal, `failureCode` obrigatório; sem ledger.
- `PENDING_REFERENCE`: persistida com agendamento, sem ledger, sem saldo alterado.
- `FAILED`: reservado para erro permanente de infraestrutura auditável.
  Falha temporária SQL/SQS não deve ser marcada FAILED automaticamente.

Todas as alterações financeiras e os eventos Outbox são gravados na mesma
transação SQL. **Não há publicação direta no SQS**. A Outbox representa uma
intenção durável que será publicada por outro componente após o commit.

## Referências fora de ordem (7.1)

- Primeira tentativa sem referência: `PENDING_REFERENCE`, retries 0,
  `nextAttemptAt=agora+5s`, `expiresAt=agora+24h`; gera
  `WagerTransactionPendingReference` na Outbox.
- Worker consulta somente linhas vencidas, serializa o acesso via
  `SELECT ... FOR UPDATE` na wallet e revalida status e agendamento.
- Se a referência segue ausente/não terminal: agendar novamente com
  backoff exponencial, limitado a **15 minutos**, com contador persistido.
- Se referência processada chegou: aplicar a operação original e gerar
  os eventos necessários, sem mudar o ID externo nem criar outra transação.
- Se TTL de **24h** acabou: `REJECTED/REFERENCE_NOT_FOUND`, com
  `WagerTransactionRejected` na Outbox.
- Se referência existe mas foi rejeitada: `REFERENCE_NOT_PROCESSED`.
- A primeira transição pendente gera evento; cada tentativa intermediária de
  retry **não** gera novo evento de pendência, evitando duplicação inútil.

```bash
# PostgreSQL deve estar ativo. Executar migrations antes de iniciar o worker.
bun run db:migrate:up
bun run worker:references

# Ou com Compose:
docker compose --profile reference-worker up -d reference-retry-worker
```

O processo trata SIGINT e SIGTERM, fecha conexões e pode ser reiniciado com
segurança. Como filas são no PostgreSQL, um pod pode substituir outro.
O job **não usa SQS**. Implantação CronJob/EKS e publicação dos eventos
fazem parte das próximas entregas.

## Failure codes

| Código | Significado | Conduta |
| --- | --- | --- |
| INSUFFICIENT_FUNDS | BET sem saldo | Não repetir sem nova condição |
| REVERSAL_INSUFFICIENT_FUNDS | Reversão debita saldo indisponível | Investigar; comando terminal |
| REFERENCE_NOT_FOUND | TTL esgotado sem referência | Investigar operação original |
| REFERENCE_NOT_PROCESSED | Referência terminal não PROCESSED | Corrigir fluxo/provedor |
| INVALID_REFERENCE | Mismatch de provider/wallet/player/round/game/kind | Corrigir payload |
| REFERENCE_AMOUNT_MISMATCH | Valor integral não corresponde | Corrigir valor |
| ALREADY_REVERSED | Compensação já reservada/processada | Não repetir como novo evento |
| CURRENCY_MISMATCH | Moeda incorreta | Corrigir payload |
| IDEMPOTENCY_CONFLICT | Mesmo identificador, payload diferente | Não reenviar sob a mesma identidade |

`IDEMPOTENCY_CONFLICT` é uma falha do **contrato de entrada**, não uma segunda
transação financeira REJECTED. Para erros de infraestrutura desconhecidos,
a transação SQL faz rollback integral; o SQS poderá fazer retry futuramente.

## Concorrência por wallet (seção 8)

`ProcessWager` usa `FOR NO KEY UPDATE` na wallet, idempotência
PostgreSQL e incrementa `wallet.version` apenas quando o saldo muda.
Transações temporariamente abortadas por deadlock, serialization failure
ou lock timeout são reexecutadas do começo com até três tentativas.
As verificações e testes distribuídos estão descritos em
[ARCHITECTURE.md](../ARCHITECTURE.md). Não dependem do transporte HTTP ou
do SQS.

## Testes

```bash
bun run test
# PostgreSQL descartável: primeiro bun run db:migrate:up
bun run test:e2e
bun run lint
bun run typecheck
```

O CI executa testes unitários por função e integrações reais: uma única
movimentação em 50 pedidos idênticos, disputa de duas BET de 80.00 contra
saldo 100.00, replay histórico, rejeições, referências tardias, TTL, Outbox
na mesma transação e unicidade SQL. Não representa ainda testes de SQS,
múltiplos pods nem deploy AWS.
