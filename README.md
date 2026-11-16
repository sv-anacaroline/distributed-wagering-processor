# Distributed Wagering Processor

Desafio técnico da Jungle Gaming: processamento financeiro distribuído de apostas, com foco em precisão monetária, idempotência, concorrência e recuperação após falhas.

> **Estado atual:** apenas o starter NestJS e a infraestrutura declarativa foram configurados. Wallet, ledger, migrations, consumidores, workers e testes financeiros ainda serão implementados. Não confunda o endpoint `GET /` com um health check de produção.

## Stack

| Tecnologia | Uso |
| --- | --- |
| Bun **1.x** (referência: 1.4.4) | Runtime, gerenciamento de pacotes e testes |
| NestJS + TypeScript strict | API |
| PostgreSQL 17 | Banco local (AWS: RDS) |
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

**Lockfile:** ainda é necessário gerar `bun.lock` via `bun install` em ambiente com acesso ao registro npm e versioná-lo. Depois, ajustar o Dockerfile para `bun install --frozen-lockfile` em um commit próprio. Não foi possível gerar esse arquivo neste ambiente.

## Ambiente local com Docker e SQS provisionado pelo Terraform

```bash
cp .env.example .env
```

Edite o `.env`:

- **LocalStack:** use `AWS_EMULATOR_IMAGE=localstack/localstack:latest` e defina `LOCALSTACK_AUTH_TOKEN`.
- **MiniStack (sem token):** use `AWS_EMULATOR_IMAGE=ministackorg/ministack:1.5.40`.

Não versione o arquivo `.env`, tokens, credenciais ou arquivos de estado do Terraform.

```bash
docker compose config
docker compose up --build -d
docker compose ps
docker compose logs terraform-local
curl http://localhost:3000/
```

O Compose inicia **API Bun, PostgreSQL 17, emulador AWS e job de Terraform** que cria:

- `wager-transactions.fifo` (fila de entrada).
- `wager-transactions-dlq.fifo` (dead-letter queue).
- `wager-events.fifo` (saída futura da transactional outbox).

Banco e estado Terraform local usam volumes persistentes. **`docker compose down -v` apaga os volumes e os dados locais.**

Para simular três processos independentes da aplicação:

```bash
docker compose --profile distributed up --build -d --scale api-replica=2
```

Isso **não prova** a correção concorrente: wallet, ledger, idempotência e consumers ainda serão implementados.

## Testes de performance (k6)

Smoke test do **endpoint inicial**, ainda sem transações financeiras:

```bash
# Com os containers configurados e o Bun instalado:
bun run test:load

# Ou sem Bun no host:
docker compose -f docker-compose.yml -f docker-compose.k6.yml \
  --profile performance run --rm k6
```

No `.env`, configure `K6_VUS` e `K6_DURATION`. O cenário reporta latências (incluindo p50/p95/p99), erros HTTP e checks. **A carga financeira com 50 requisições paralelas e >=3 instâncias será implementada depois.**

## AWS / EKS / Terraform

A configuração para AWS está em `infra/terraform/aws`; o Deployment Kubernetes em `infra/terraform/eks-app`. Consulte o guia [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) para instalar, revisar o plano, enviar a imagem Bun ao ECR e implantar a aplicação.

**Não execute `terraform apply` sem verificar custos e o plano.** O EKS usa três réplicas por padrão, um Service interno, Pod Identity e senha RDS gerenciada pelo Secrets Manager.

## Limitações atuais

- Sem ORM, migrations de domínio, validação financeira, inbox/outbox ou consumo efetivo de SQS.
- Kubernetes usa `GET /` temporariamente nas probes; substituir por `/health/live` e `/health/ready`.
- Terraform AWS é um exemplo de desenvolvimento com state local; não é um ambiente de produção pronto.
- Provisionamento real e integração ponta a ponta ainda dependem de validação com Docker, Bun, Terraform e uma conta AWS.
