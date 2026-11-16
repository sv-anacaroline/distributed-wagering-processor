# API REST — Seção 9

Implementação em `src/http/`, usando NestJS 12 e PostgreSQL/MikroORM.
Os endpoints HTTP são apenas adapters do caso de uso `ProcessWager`
desenvolvido na seção 7, com locks por wallet da seção 8.

## Preparação

```bash
cp .env.example .env
docker compose up -d postgres aws-emulator
bun install --frozen-lockfile
bun run db:migrate:up
HTTP_AUTH_MODE=disabled bun run start:dev
```

`HTTP_AUTH_MODE=disabled` é permitido **somente** em dev/testes. Em
`NODE_ENV=production` não há bypass: configure um IdP OIDC externo
(Keycloak/Zitadel ou equivalente). Nenhuma senha/usuário é armazenado
pela aplicação.

## Autenticação — Seção 2

Todas as rotas de `/wallets`, `/wagering`, `/providers` e
`/internal/metrics` exigem Bearer JWT RS256 validado com JWKS, salvo o
bypass explicitamente configurado em ambiente não produtivo.
`/health/live` e `/health/ready` **não** exigem autenticação.

Variáveis obrigatórias no modo seguro:

- `OIDC_ISSUER`: issuer exato do token, por exemplo
  `http://keycloak:8080/realms/wagering`
- `OIDC_JWKS_URL`: endpoint JWKS publicado pelo IdP, por exemplo
  `http://keycloak:8080/realms/wagering/protocol/openid-connect/certs`
- `OIDC_AUDIENCE`: identificador desta API, por exemplo `wagering-api`
- `PAGINATION_CURSOR_SECRET`: segredo **compartilhado** entre instâncias,
  32+ caracteres em produção. Rotacione com planejamento: cursores
  emitidos antes da troca deixam de ser aceitos.
- `HTTP_AUTH_MODE`: `oidc` em produção; `disabled` somente dev/teste.

O IdP deve incluir o claim assinado `provider_id` nas chamadas dos
endpoints de transações: seu valor deve corresponder ao `providerId`
do body/URL. O código não confia no ID enviado pelo cliente sozinho.
Cache de JWKS por 5 minutos é cache de **chaves públicas**, não de
idempotência financeira. Ainda falta, para uma autorização refinada,
mapear ownership da wallet para o provedor autenticado; autenticação
não implica autorização de carteira multi-tenant. Não publicar
a API externa sem definir essa política conforme o cenário de negócio.

## Endpoints

| Método | Caminho | Código de sucesso | Observação |
| --- | --- | --- | --- |
| POST | /wallets | 201 | Uma wallet por playerId e moeda |
| GET | /wallets/:walletId | 200 | Balance exato como string |
| GET | /wallets/:walletId/ledger | 200 | Cursor HMAC opaco, limit default 50, max 100 |
| POST | /wallets/:walletId/reconciliation | 200 | Snapshot consistente, sem autocorreção |
| POST | /wagering/transactions | 200/202/422 | Com Idempotency-Key obrigatório |
| GET | /wagering/transactions/:transactionId | 200 | Inclui estado e snapshot persistidos |
| GET | /providers/:providerId/wagering/transactions/:externalTransactionId | 200 | Identidade externa por provedor |
| GET | /health/live | 200 | Processo NestJS |
| GET | /health/ready | 200/503 | PostgreSQL + alcance de SQS |
| GET | /internal/metrics | 200 | Counter auditável de divergências, protegido |

### Criar wallet

```http
POST /wallets
Content-Type: application/json

{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}
```

Se o saldo for positivo, a mesma transação PostgreSQL cria wallet (versão 1),
`OPENING` interna `PROCESSED` e exatamente um ledger `CREDIT` de
abertura com `balanceBefore = 0.00`. Saldo zero não cria OPENING.
Duplicidade `(playerId,currency)` é 409. Não publica o evento de abertura
diretamente no SQS.

### Submeter wagering

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
Content-Type: application/json

{"providerId":"provider-a","externalTransactionId":"transaction-123",
 "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
 "walletId":"0192f291-27dd-7d3f-8071-5f8685deef37",
 "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
 "money":{"amount":"25.00","currency":"BRL"}}
```

Retorno 200 para PROCESSED, 202 para PENDING_REFERENCE, 422 para
REJECTED. O response contém `transactionId`, `status`, `balance`,
`walletVersion`, `observedAt`, `idempotentReplay` e, se houver,
`failureCode`. Uma resposta original rejeitada pode ser replay de 422,
com `idempotentReplay=true`; não é um segundo débito/crédito.

A `Idempotency-Key` é **obrigatória**; o default recomendado é
`providerId:externalTransactionId`. O hash persistido é SHA-256 do JSON
construído com os campos de negócio em **ordem determinística explícita**:
`providerId, externalTransactionId, walletId, playerId, roundId, gameId,
kind, amount, currency, referenceExternalTransactionId` (null quando
ausente). Essa ordem é parte do contrato de hash versionado; o header
e os metadados HTTP são excluídos do hash. `amount` continua string
decimal exata. A API não usa a ordem de inserção de propriedades
do JSON recebido.

Mesmo identificador + mesmo conteúdo devolve snapshot original,
com saldo **daquele instante**. Conteúdo divergente -> HTTP 409
`IDEMPOTENCY_CONFLICT`; não sobrescreve a operação anterior.
`OPENING` é vedada na API.

### Consultar ledger

`GET /wallets/:walletId/ledger?limit=50&cursor=...` retorna
`{ "items": [...], "nextCursor": "..." | null }`.
Paginação keyset ordenada por `created_at DESC,id DESC`, usando
índice da wallet. O cursor contém walletId + data + id assinados
por HMAC-SHA256, codificados em base64url. Recusa adulteração
e uso em outra wallet; não assume ordem global entre wallets.

### Reconciliação e métricas

`POST /wallets/:walletId/reconciliation` compara o saldo materializado
com a soma algébrica exata dos lançamentos do ledger. Usa snapshot
PostgreSQL `REPEATABLE READ`, evitando bloquear outras wallets
na leitura. Retorna `walletId`, `storedBalance`, `calculatedBalance`,
`difference` (assinado quando necessário), `consistent`,
`checkedEntries`.

Se houver divergência, **não** altera saldo nem ledger: grava anomalia em
`wallet_reconciliation_anomalies` (migration versionada), registra
log estruturado e incrementa o contador persistente consultável em
`GET /internal/metrics`. A métrica `wallet_reconciliation_divergences_total`
é derivada do total dessas anomalias, estável entre instâncias.

### Health

- `/health/live`: retorno imediato; não faz I/O externo.
- `/health/ready`: `SELECT 1` no PostgreSQL e chamada HTTP curta ao
  endpoint SQS (`SQS_ENDPOINT_URL` ou endpoint regional AWS).
  Responde 503 quando uma dependência não é alcançável.
  A verificação atual é **de rede/serviço**, não comprova IAM,
  permissões de QueueUrl, consumo ou publicação — a validação funcional
  de SQS fica para a seção 10/11.

### Mapeamento de erros

| Status | Situação |
| --- | --- |
| 400 | Payload/header/UUID/currency inválido |
| 401 | Bearer ausente ou JWT inválido |
| 403 | Provider do token diferente do body/URL |
| 404 | Wallet ou transação inexistente |
| 409 | Duplicidade de wallet ou conflito de idempotência |
| 422 | Regra financeira rejeitou a operação; `failureCode` estável |
| 202 | Referência ainda pendente — aceite durável |
| 503 | Dependência crítica ou falha transitória identificada |
| 500 | Erro inesperado não exposto ao provedor |

## Testes

```bash
HTTP_AUTH_MODE=disabled bun run test:api:e2e
bun run test
bun run test:e2e
bun run typecheck
bun run lint
```

`test/http-api.e2e.test.ts` valida HTTP real + PostgreSQL:
criação atomizada, duplicidade, ledger e paginação, cabeçalhos,
replay e conflito, saldos, estados, duas BET concorrentes, reconciliação,
health com serviço SQS HTTP simulado. A publicação/consumo assíncrono
da Outbox ficará para testes SQS da etapa seguinte.

**Nota sobre cobertura:** `src/application/process-wager.ts` exige
PostgreSQL real, portanto fica fora da métrica de cobertura unitária
do Bun e é exigido nos testes E2E/integração. O percentual mínimo
dos módulos unitários não foi reduzido. Não usar mocks de transação
para simular concorrência financeira.
