# Distributed Wagering Processor

Desafio técnico da Jungle Gaming: processamento financeiro distribuído de apostas, com foco em precisão monetária, idempotência, concorrência e recuperação após falhas.

> **Estado atual:** domínio, regras financeiras, concorrência PostgreSQL e **API REST da seção 9** implementados com testes. O processamento HTTP confirma ledger + Outbox no mesmo commit. **Os workers SQS/Outbox e a autenticação HTTP via Keycloak já foram implementados; faltam validações de ambiente de produção, mapeamentos ORM e deploy EKS.** Os health checks são `/health/live` e `/health/ready`, não `GET /`.

## Stack

| Tecnologia | Uso |
| --- | --- |
| Bun **1.x** (referência: 1.4.4) | Runtime, gerenciamento de pacotes e testes |
| NestJS + TypeScript strict | API |
| PostgreSQL 17 + MikroORM 7 | Persistência e migrations versionadas (AWS: RDS) |
| SQS FIFO + FIFO DLQ | Mensageria (LocalStack/MiniStack local; SQS AWS real) |
| Docker Compose | Infraestrutura local |
| Terraform | Provisionamento local, AWS e aplicação Kubernetes |
| EKS + ECR | Execução Kubernetes na AWS |
| k6 | Testes iniciais de carga via container |

## Pré-requisitos

**Desenvolvimento local:** Git, Docker Engine + Compose v2, Bun 1.x e acesso a um registro de pacotes. No Ubuntu:

```bash
sudo apt update
sudo apt install -y git curl unzip
```

- [Docker Engine no Ubuntu](https://docs.docker.com/engine/install/ubuntu/) ou Docker Desktop. Verifique `docker --version` e `docker compose version`.
- [Instalação do Bun](https://bun.sh/docs/installation). Verifique `bun --version`; utilize Bun 1.x.
- [LocalStack](https://docs.localstack.cloud/): versão recente requer `LOCALSTACK_AUTH_TOKEN` no `.env`. Se não tiver token, use a alternativa **MiniStack** documentada abaixo.
- k6, PostgreSQL e Terraform **não precisam ser instalados no host para executar o Compose**, pois rodam como containers.

**Para provisionamento AWS:** conta com acesso de IAM a VPC, EKS, EC2, ECR, RDS, SQS, Secrets Manager e IAM; [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.13, [kubectl](https://kubernetes.io/docs/tasks/tools/), Docker/Buildx e credenciais temporárias configuradas via perfil ou SSO. **EKS, EC2, NAT Gateway e RDS geram custos.**

## Instalação da aplicação com Bun

```bash
git clone https://github.com/sv-anacaroline/distributed-wagering-processor.git
cd distributed-wagering-processor
bun install
bun run start:dev
```

O starter responde em `http://localhost:3000/` com `Hello World!`.

Comandos úteis:

```bash
bun run build
bun run lint
bun run typecheck
bun run test
bun run test:e2e
bun run test:cov
```

**Lockfile:** `bun.lock` é versionado e a instalação no CI/Docker utiliza `bun install --frozen-lockfile` para garantir resolução reproduzível.

## Persistência e migrations (MikroORM)

O MikroORM utiliza o PostgreSQL configurado em `src/mikro-orm.config.ts`. A migration `src/migrations/Migration20261116200000.ts` cria as tabelas financeiras, índices, constraints e triggers. Os mapeamentos MikroORM e os casos de uso serão implementados separadamente. Consulte [ARCHITECTURE.md](ARCHITECTURE.md).

Para trabalhar localmente, copie `.env.example` para `.env` e inicie o PostgreSQL:

```bash
cp .env.example .env
docker compose up -d postgres
bun install
bun run db:debug
bun run db:migrate:up
bun run start:dev
```

No host, o Bun lê o `.env` e conecta em `127.0.0.1:${POSTGRES_PORT}`. Dentro do Compose, a API usa `DB_HOST=postgres`. Na AWS, o RDS usa credenciais fornecidas pelo Secrets Manager.

```bash
# Gerar depois de modelar uma nova entidade
bun run db:migrate:create --name=add_wallet_table

# Inspecionar
bun run db:migrate:pending
bun run db:migrate:list
bun run db:migrate:check

# Aplicar migrations pendentes (uma execução controlada)
bun run db:migrate:up

# Reverter apenas a última migration
bun run db:migrate:rollback
```

As migrations são transacionais, versionadas e com rollback revisável. **Não** executamos migrations automaticamente no bootstrap dos pods. Consulte [docs/PERSISTENCE.md](docs/PERSISTENCE.md).

## Domínio financeiro

O domínio puro está em `src/domain/`: `Money` (bigint centavos, sem floats),
`Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage`,
`OutboxMessage` e quatro eventos versionados, cada qual com testes unitários.
Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para invariantes, status,
restrições de reversão, schema SQL e limites desta etapa.

O teste de schema usa PostgreSQL real no CI (`bun run test:e2e`) e valida
unicidade, trigger de ledger append-only, saldos e versão de carteira.

## Regras de negócio — Seção 7

O caso de uso `src/application/process-wager.ts` aplica BET, WIN, LOSS, REFUND e
ROLLBACK usando lock de linha por wallet e PostgreSQL transacional. As entradas
são independentes de API e SQS; o processador poderá ser chamado por ambos.
Resultados idempotentes usam o saldo e a versão persistidos no instante da
operação original. Referências fora de ordem usam scheduler durável com TTL de
24 horas e backoff exponencial.

```bash
bun run db:migrate:up
bun run worker:references
# Alternativa Compose (perfil opcional):
docker compose --profile reference-worker up -d reference-retry-worker
```

Consulte [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md) para o comportamento
de cada operação, códigos de falha, reversões cruzadas e testes.

## Concorrência sem API nem SQS

A seção 8 é validada com três processos Bun independentes sobre PostgreSQL
compartilhado, lock `FOR NO KEY UPDATE` por wallet, versão do ledger,
retries SQL limitados e testes de idempotência distribuída. Carteiras
distintas processam em paralelo; a mesma wallet continua serializada.

```bash
bun run test:concurrency
```

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para as garantias de
ordenação, os índices utilizados e o diagnóstico de contenção.

## Auth — Keycloak OIDC com isolamento entre providers

O projeto integra **Keycloak** (IdP externo), usando OAuth2
`client_credentials` para `provider-a`, `provider-b` e
`wagering-monitor`. A API valida assinatura RS256, `iss`, `aud`
e `azp` dos access tokens. Somente os OAuth clients de
`OIDC_PROVIDER_CLIENT_IDS` podem executar operações financeiras;
`wagering-monitor` acessa apenas métricas. Não há usuários/senhas locais.

```bash
cp .env.example .env
docker compose --profile auth up -d postgres keycloak
bun run db:migrate:up
OIDC_JWKS_URL=http://localhost:8080/realms/wagering/protocol/openid-connect/certs bun run start:dev
```

Os grants `wallet_provider_grants` são criados com a wallet na mesma
transação SQL. Providers não acessam wallets uns dos outros sem
concessão explícita; health checks continuam públicos.

**[Instruções de Keycloak, tokens, .env, permissões e E2E](docs/AUTH.md)**

Os workers SQS/Outbox já fazem parte da `master`. A seção 2 define
SQS como canal interno confiável; a identidade declarada no envelope
continua sujeita às validações de domínio.

## API REST (Seção 9)

O NestJS expõe `POST /wallets`, consultas de wallet e ledger com cursor
opaco, `POST /wagering/transactions` com `Idempotency-Key` obrigatório,
consultas por ID interno/externo, reconciliação e health checks.
O código HTTP reutiliza `ProcessWager`: não há segunda implementação
de saldo/idempotência.

Para testes sem IdP, use explicitamente `HTTP_AUTH_MODE=disabled`
somente em desenvolvimento. Para testar autenticação real, use o perfil
`auth` do Compose e siga o guia de Keycloak.
Em produção, configure um IdP OIDC RS256/JWKS; a aplicação não implementa
senhas ou sessões próprias. `/health/*` é público.

**[Guia da API, autenticação, exemplos e status HTTP](docs/HTTP_API.md)**

```bash
bun run db:migrate:up
HTTP_AUTH_MODE=disabled bun run start:dev
bun run test:api:e2e
```

## Integração contínua (GitHub Actions)

O workflow `.github/workflows/ci.yml` executa em **pull requests para `master` e pushes na `master`**. Ele instala as dependências via Bun, faz typecheck, lint, testes, build e valida a conexão do MikroORM em um PostgreSQL efêmero.

Após um push na `master`, um segundo job **simula** um roteiro de deploy AWS: planejamento Terraform, build/push ECR, migração única, rollout EKS e smoke tests. Esse job executa **somente comandos `echo`**: não autentica na AWS e não faz deploy.

## Ambiente local com Docker e SQS provisionado pelo Terraform

```bash
cp .env.example .env
```

Edite o `.env`:

- **LocalStack:** use `AWS_EMULATOR_IMAGE=localstack/localstack:latest` e defina `LOCALSTACK_AUTH_TOKEN`.
- **MiniStack (sem token):** use `AWS_EMULATOR_IMAGE=ministackorg/ministack:1.5.40`.

Não versione o arquivo `.env`, tokens, credenciais ou arquivos de estado do Terraform.

```bash
docker compose --profile auth config
docker compose --profile auth up --build -d
docker compose --profile auth ps
docker compose --profile auth logs terraform-local
curl http://localhost:3000/health/live
```

Com `--profile auth`, o Compose inicia **API Bun, Keycloak, PostgreSQL 17,
emulador AWS e job de Terraform** que cria:

- `wager-transactions.fifo` (fila de entrada).
- `wager-transactions-dlq.fifo` (dead-letter queue).
- `wager-events.fifo` (saída futura da transactional outbox).

Banco e estado Terraform local usam volumes persistentes. **`docker compose down -v` apaga os volumes e os dados locais.**

Para simular três processos independentes da aplicação:

```bash
docker compose --profile distributed up --build -d --scale api-replica=2
```

Isso **não prova** a correção concorrente: o domínio e o schema estão prontos, mas os casos de uso com locks SQL, consumidores e workers ainda serão implementados.

## Qualidade de código e testes

A configuração em [docs/CODE_QUALITY.md](docs/CODE_QUALITY.md) descreve EditorConfig,
ESLint com type-check, TypeScript strict, Prettier e testes com Bun.

```bash
bun install
bun run lint
bun run lint:fix
bun run typecheck
bun run format:check
bun run test
bun run test:e2e
bun run test:cov
```

Os PRs para a `master` executam **três checks independentes**: lint/formatação/TypeScript, testes/coverage/PostgreSQL e validação dos cenários k6. O deploy continua simulado. Configure os três checks como *required checks* em Settings → Rules → Rulesets para bloquear merges com CI falhando.

**Testes usam Bun Test**, compatível com a API de asserções Jest. Não adicionamos um segundo test runner porque Bun 1.x é obrigatório no desafio.

## Testes de performance (k6)

Veja [docs/PERFORMANCE.md](docs/PERFORMANCE.md). Scripts k6: smoke, load, stress, spike e soak.
Todos testam **somente a rota inicial** por enquanto, ainda sem transações financeiras:

```bash
# Com os containers configurados e o Bun instalado:
bun run test:load                # alias do smoke
bun run test:load:smoke
bun run test:load:load
bun run test:load:stress
bun run test:load:spike
bun run test:load:soak
```

No `.env`, configure `K6_VUS` e `K6_DURATION`. O cenário reporta latências (incluindo p50/p95/p99), erros HTTP e checks. **Concorrência financeira entre três processos já é testada diretamente contra PostgreSQL; carga HTTP via k6 será configurada em etapa posterior.**

## AWS / EKS / Terraform

A configuração para AWS está em `infra/terraform/aws`; o Deployment Kubernetes em `infra/terraform/eks-app`. Consulte o guia [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) para instalar, revisar o plano, enviar a imagem Bun ao ECR e implantar a aplicação.

**Não execute `terraform apply` sem verificar custos e o plano.** O EKS usa três réplicas por padrão, um Service interno, Pod Identity e senha RDS gerenciada pelo Secrets Manager.

## Eventos FIFO + Transactional Outbox (seções 10/11)

O consumidor SQS usa o **mesmo** `ProcessWager` da API. A Inbox,
o ledger, a transação e a Outbox são confirmados numa única
transação PostgreSQL; só então a mensagem SQS é reconhecida.
O publisher entrega envelopes versionados à fila de eventos via
`FOR UPDATE SKIP LOCKED`/lease/fencing, com agrupamento por wallet.

```bash
bun run worker:sqs
bun run worker:outbox
bun run test:events:e2e
```

Veja [docs/EVENTS.md](docs/EVENTS.md) para setup MiniStack, contratos,
retries, DLQ, semântica at-least-once, crash recovery e testes E2E.

**A autorização de clientes HTTP utiliza grants por wallet. Mensagens SQS são
tratadas como canal interno confiável, com validações de domínio e proteção da fila via IAM.**

## Limitações atuais

- Modelo e regras de negócio implementados, com transações PostgreSQL e Outbox persistida. **A API, workers SQS/Outbox e autorização HTTP de wallet por provider estão implementados; faltam mapeamentos ORM e deploy EKS**.
- Kubernetes usa `/health/live` e `/health/ready` como probes; configurar OIDC, segredo de cursor e acesso SQS/IAM antes do deploy.
- Terraform AWS é um exemplo de desenvolvimento com state local; não é um ambiente de produção pronto.
- Provisionamento real e integração ponta a ponta ainda dependem de validação com Docker, Bun, Terraform e uma conta AWS.
