# Processamento SQS e Transactional Outbox — Seções 10 e 11

## Escopo e contrato

Os dois workers são **processos Bun separados da API**. Todo comando
financeiro chama `ProcessWager`: não há segunda implementação das
regras de BET/WIN/LOSS/REFUND/ROLLBACK.

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

- Somente os cinco tipos externos são aceitos. `OPENING` continua interno.
- `Money` valida string decimal de 2 casas e moeda; não há float/number
  para dinheiro.
- `messageId` é a identidade lógica da Inbox, **não** o identificador
  atribuído pelo broker (`MessageId`) nem o `ReceiptHandle`.
- `payloadHash` da Inbox = SHA-256 do objeto lógico
  `{messageId,type,occurredAt,data}` já validado/normalizado; todas as
  chaves de objetos JSON ordenadas pelo ponto de código UTF-16.
  `ReceiptHandle`, tentativas, atributos SQS e carimbos de transporte
  não entram no hash. O hash do wager continua separado, com campos
  de negócio e sem identidade de transporte.
- Mensagem com mesmo `(consumer_name,message_id)` e hash diferente é
  **veneno permanente**; será enviada à DLQ, sem segundo movimento.
  Mensagens distintas representando a mesma transação geram Inbox
  distintas, mas reutilizam a mesma transação financeira por idempotência.

## Caminho de entrada

1. SQS FIFO recebe a mensagem em `wager-transactions.fifo`. Recomenda-se
   `MessageGroupId = walletId` e um dedup ID estável por evento lógico;
   a ordenação do broker é otimização, **não** garantia final.
2. O consumidor valida o envelope. Se a mensagem for inválida, vai à DLQ.
3. `ProcessWager.processFromInbox` inicia uma única transação PostgreSQL,
   bloqueia a wallet com `FOR NO KEY UPDATE`, reserva a Inbox com
   `UNIQUE(consumer_name,message_id)`, confirma o hash, aplica as regras,
   persiste wager + wallet + ledger + eventos Outbox e marca
   `inbox.processed_at`. **Tudo no mesmo commit**.
4. Somente depois do commit o consumidor chama `DeleteMessage`.
   Se esse ACK falhar, a futura entrega repete o caminho idempotente
   e não duplica saldo/ledger/outbox.
5. `PROCESSED`, `REJECTED` de negócio e `PENDING_REFERENCE` são
   resultados de negócio/aceite duráveis que fazem ACK. Uma referência
   pendente é resolvida pelo worker da seção 7 e **não** por sleeps SQS.

### Falhas, retry e DLQ

- Payload inválido, `InboxPayloadConflictError`, conflito de idempotência
  ou `DomainError` irrecuperável: envia o corpo original para
  `wager-transactions-dlq.fifo` e só então faz ACK no source.
- Erros transitórios de SQL/rede: **não** fazem ACK; SQS recebe
  `ChangeMessageVisibility` com backoff `1,2,4,8` segundos
  (a partir de `ApproximateReceiveCount`). Uma quinta tentativa
  sem sucesso provoca DLQ, com a redrive policy da infraestrutura
  como rede de segurança (`maxReceiveCount=5`).
- Se o envio à DLQ falhar, **a mensagem original não é deletada**.
  Mantenha alarmes para erro de DLQ e backlog na origem.
- O worker recebe até 10 mensagens por batch, agrupando por
  `MessageGroupId`: cada grupo é processado **serialmente até ACK ou
  DLQ**, enquanto grupos diferentes avançam em paralelo. Se uma
  mensagem precisar de retry, as seguintes do grupo têm a visibilidade
  devolvida sem execução. `Promise.allSettled` espera todos os grupos
  terminarem antes de sair (inclusive no shutdown).
- `SIGTERM`/`SIGINT` interrompem novos receives e aguardam as tarefas
  em curso antes de fechar pools. Uma mensagem ainda não iniciada tem
  visibilidade devolvida (0). Em `SIGKILL`, SQS redeliverá quando
  o visibility timeout expirar (configurado em 60s). Ajustar esse timeout
  se o tempo de SQL/latência ultrapassar o valor.

## Caminho de saída — Outbox

O domínio já tem classes abstrata `IntegrationEvent<T>` e subclasses
concretas versionadas:

| Evento | Condição |
| --- | --- |
| `WagerTransactionProcessed` | Toda transação aplicada, inclusive LOSS |
| `WagerTransactionRejected` | Regra de negócio rejeitada |
| `WagerTransactionPendingReference` | Referência ausente |
| `WalletBalanceChanged` | Ledger efetivamente modifica saldo |
| `WagerTransactionProcessed` + `WalletBalanceChanged` | Também emitidos no `OPENING` interno com saldo positivo, no **mesmo commit SQL** da wallet/ledger |

Os dados carregam somente DTOs imutáveis, incluindo
`MoneyProps {amount:string,currency:string}`. A Outbox serializa o
envelope estável `eventId,eventType,aggregateId,correlationId,causationId?,
occurredAt,version,data`. O banco impede alterar identidade/payload
de eventos já registrados.

A ordem causal de saída por wallet é garantida por uma coluna
`publication_sequence bigint GENERATED ALWAYS AS IDENTITY` do
PostgreSQL. Ela é atribuída aos eventos inseridos sequencialmente
durante o lock transacional da wallet, inclusive quando ambos possuem
o mesmo `occurredAt`. Não usar ordenação por UUID para desempatar
timestamps de eventos causais. A migration
`Migration20261116235500` troca o índice parcial pelo par
`(aggregate_id,publication_sequence)`; ao migrar uma instalação
com backlog anterior, **parar o publisher, migrar e retomar** para
evitar reenfileiramento fora da ordem histórica.

O publisher obtém eventos via uma única instrução SQL `UPDATE ...
FROM (SELECT ... FOR UPDATE SKIP LOCKED)`, usando:
- lease de 45 segundos e `claimed_by` como **token único de tentativa**;
- token de fencing nas atualizações de ACK/retry, impedindo um worker
  antigo de confirmar a publicação depois de perder a posse;
- filtro de head-of-line `NOT EXISTS` por `publication_sequence` + índice parcial
  `outbox_wallet_pending_order_idx`, evitando publicar um evento
  mais recente da mesma wallet antes de um mais antigo;
- `MessageGroupId=aggregateId` (wallet) e
  `MessageDeduplicationId=eventId` (ID fixo do evento);
- confirmação `published_at` **somente após resposta positiva do SendMessage**;
- falha de envio agenda `attempts` + `next_attempt_at` com backoff
  de 1s, 2s, 4s... até 5min. O evento permanece persistido.
  Não se descarta silenciosamente após N falhas: operações devem
  monitorar mensagens com muitas tentativas e corrigir a causa.

**Garantia possível:** entrega *at-least-once*, não *exactly-once* em
dois sistemas. Uma queda depois de `SendMessage` e antes do update
`published_at` pode repetir o evento. A FIFO deduplica IDs de 5
minutos apenas; um futuro assinante dos eventos precisa de uma Inbox
durável por `(consumer_name,eventId)` se fizer efeitos de negócio.
Não confiar na deduplicação FIFO para além dessa janela.

## Comandos

```bash
# Com Bun 1.4.4:
cp .env.example .env
# Para rodar MiniStack sem token, configure AWS_EMULATOR_IMAGE=ministackorg/ministack:1.5.40
docker compose up -d postgres aws-emulator terraform-local
bun run db:migrate:up
bun run worker:sqs
bun run worker:outbox

# Ou ambos os workers via Compose:
docker compose --profile sqs-workers up -d wager-sqs-consumer wager-outbox-publisher

# Testes unitários / SQL / FIFO reais:
bun run test
bun run test:e2e
EVENTS_E2E=1 SQS_ENDPOINT_URL=http://127.0.0.1:4566 bun run test:events:e2e
```

O runner E2E cria filas FIFO temporárias no emulador e as remove ao final.
Requer credenciais `AWS_ACCESS_KEY_ID=test`,
`AWS_SECRET_ACCESS_KEY=test`, PostgreSQL migrado, e o serviço MiniStack
alcançável. Os testes verificam **cada etapa do fluxo**: Inbox gravada, status da
transação, saldo/versão, ledger, payload completo na Outbox ainda não
publicada, ACK da entrada, `published_at` após SQS, envelope recebido
idêntico ao payload SQL, ordenação de eventos, retries, DLQ, falhas injetadas,
reprocessamento de referência e múltiplos publishers concorrentes.
Sem modo `EVENTS_E2E=1`, a suíte que exige SQS real é pulada, mas
as demais suítes unitárias/PostgreSQL continuam rodando.

## Observabilidade e limites de segurança

Monitorar profundidade/idade das filas, número visível da DLQ,
`outbox_messages` pendentes mais antigas, `attempts` elevados,
`claim_expires_at` vencidos, throughput de eventos, falhas de ACK
e deadlocks/lock waits. Alerta operacional quando publisher não
consegue avançar ou DLQ aumenta.

**Auth fica para última entrega**, conforme decisão do projeto.
Ainda não há vínculo criptográfico/autorização de providers a mensagens
na aplicação. Antes de produção: restringir IAM das filas,
definir identidade autenticada do emissor e validar ownership da wallet
nos dois canais (HTTP e SQS); não assumir que providerId do JSON
representa autenticação. Essa pendência é bloqueadora para
uso externo multi-tenant.
