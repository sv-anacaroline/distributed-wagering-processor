# Infrastructure: Docker, Terraform, AWS and EKS

## Design

| Component | Local | AWS |
| --- | --- | --- |
| Application | NestJS + Bun in Compose | Bun container on EKS (3 pods by default) |
| PostgreSQL | `postgres:17-alpine` volume | Private RDS PostgreSQL |
| SQS | LocalStack or MiniStack | Real SQS FIFO + FIFO DLQ + outbox events |
| Provisioning | `infra/terraform/local` via one-shot Compose service | `infra/terraform/aws` + `infra/terraform/eks-app` |
| IAM | Dummy local credentials | EKS Pod Identity |
| Performance | k6 Compose profile | Financial workload pending |

LocalStack emulates the AWS API; **it does not provide an actual EKS cluster**. LocalStack 2026+ requires an authentication token. MiniStack is an optional token-free SQS emulator.

### Boundaries

- NestJS currently integrates PostgreSQL, SQS FIFO/Outbox and Keycloak OIDC locally.
- The EKS Terraform example is **not production-ready**: it does not yet inject
  the OIDC issuer/JWKS/audience/client allowlist or a secure 32+ character cursor
  secret. Supply these securely before deploying; never use demo credentials.
- SQS FIFO deduplication is not a substitute for SQL transactional idempotency.
- The state is local in the AWS examples. For CI/team usage, move state to encrypted/versioned S3 with appropriate state locking and IAM.
- The AWS example is intentionally development-oriented (single NAT gateway, single-AZ RDS, limited public EKS control-plane access, no public application ingress). Do not claim production readiness.
- RDS is private, the API service is internal, and AWS SDK credentials come from Pod Identity.
- The RDS master password lives in RDS-managed Secrets Manager, not Terraform state or a Kubernetes Secret.
- **Cost warning:** EKS control plane, EC2 instances, NAT gateway, RDS, storage and data transfer are billable.
- The `operator_cidr` must be your own public IPv4 /32 or a trusted VPN CIDR; never set `0.0.0.0/0`.

## Local (Compose + Terraform)

```bash
cp .env.example .env
# Configure LOCALSTACK_AUTH_TOKEN, or change AWS_EMULATOR_IMAGE to MiniStack.
docker compose --profile auth config
docker compose --profile auth up --build -d
docker compose ps
docker compose logs terraform-local
curl http://localhost:3000/health/live
```

The one-shot `terraform-local` service creates three FIFO queues in the emulator, uses Terraform state at `/state/terraform.tfstate`, and stores providers in a dedicated volume. If it fails, inspect the logs and check that the AWS emulator is healthy.

```bash
docker compose --profile distributed up --build -d --scale api-replica=2
bun run test:load
```

`docker compose down -v` permanently removes local database and Terraform volumes.

## AWS deployment (manual, paid resources)

Prerequisites: AWS account with authorized IAM permissions and active billing; AWS CLI v2, Terraform >= 1.13, kubectl, Docker/Buildx, Git and Bun.

### 1. Provision AWS foundation

```bash
cd infra/terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Set operator_cidr to your real operator IP/32.
aws sts get-caller-identity
terraform init
terraform fmt -check
terraform validate
terraform plan -out=aws.tfplan
# Review resources, permissions and expected AWS costs before applying.
terraform apply aws.tfplan
terraform output
```

This provisions a VPC with private and database subnets, NAT, EKS managed node group, ECR, private RDS with managed DB password, three FIFO queues and IAM/Pod Identity. Development-only defaults must be revisited for production.

### 2. Build and push the Bun image to ECR

From `infra/terraform/aws`, after foundation apply:

```bash
REGION=$(terraform output -raw aws_region)
REPO=$(terraform output -raw ecr_repository_url)
CLUSTER=$(terraform output -raw eks_cluster_name)
TAG=$(git rev-parse --short=12 HEAD)
aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${REPO%%/*}"
cd ../../..
docker build --target production -t "$REPO:$TAG" .
docker push "$REPO:$TAG"
```

The repository uses immutable image tags; use a new tag per build. **This document does not run any AWS apply, Docker build or push.**

### 3. Deploy to the cluster

```bash
cd infra/terraform/eks-app
cp terraform.tfvars.example terraform.tfvars
# Fill: cluster name, region, ECR repository and tag, RDS host/secret ARN, SQS URLs.
# Read the values from infra/terraform/aws: terraform output
terraform init
terraform fmt -check
terraform validate
terraform plan -out=app.tfplan
terraform apply app.tfplan
kubectl -n wagering rollout status deployment/wagering-api
kubectl -n wagering get pods
kubectl -n wagering port-forward service/wagering-api 3000:80
# In a second shell: curl http://localhost:3000/health/live
```

The app stack sets Namespace, ServiceAccount, a 3-replica Deployment, and a ClusterIP Service. Pod Identity grants access to the selected SQS queues and RDS-managed secret; a memory-backed volume shares the secret between init and app containers. Replace the temporary `GET /` probes with live/ready endpoints when implemented.

### 4. Teardown

**Data loss warning:** verify backups, costs, Terraform state and ECR image cleanup.

```bash
cd infra/terraform/eks-app && terraform destroy
cd ../aws && terraform destroy
```

Destroy application resources before the AWS cluster. ECR may need images removed before repository deletion; RDS uses development-only settings (no deletion protection, no final snapshot).

## Validation and future work

- Infrastructure files are **declarative and have not been applied**. Run `docker compose config`, `terraform fmt -check`, `terraform init`, `terraform validate`, and `terraform plan` in each applicable stack.
- Test in the target AWS region and verify the available EKS version, quotas, IAM permissions and RDS instance options.
- Generate and commit `bun.lock` after running `bun install`, then freeze dependency installation in Docker.
- Implement MikroORM, migrations, `/health/live`, `/health/ready`, financial use cases, inbox/outbox, workers and concurrency tests in subsequent tasks.
