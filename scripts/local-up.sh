#!/usr/bin/env bash
# Idempotent, non-destructive bring-up of every local dependency and worker.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo "Docker and Docker Compose are required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required for readiness checks" >&2; exit 1; }
docker compose version >/dev/null
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example; development secrets only."
fi
compose() { docker compose --profile full --profile observability "$@"; }
echo "Starting fresh-compatible PostgreSQL, SQS, Terraform and Keycloak..."
compose up -d --build postgres aws-emulator terraform-local keycloak loki tempo otel-collector prometheus grafana
echo "Applying migrations BEFORE starting consumers and publishers..."
compose run --rm --no-deps api bun run db:migrate:up
echo "Starting API, Inbox consumer, Outbox publisher and reference retry..."
compose up -d --build api wager-sqs-consumer wager-outbox-publisher reference-retry-worker
api_port="$(compose port api 3000 | awk -F: '{print $NF}')"
grafana_port="$(compose port grafana 3000 | awk -F: '{print $NF}')"
keycloak_port="$(compose port keycloak 8080 | awk -F: '{print $NF}')"
for attempt in $(seq 1 120); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${api_port}/health/ready" >/dev/null 2>&1 &&
     curl -fsS --max-time 3 "http://127.0.0.1:${grafana_port}/api/health" >/dev/null 2>&1 &&
     curl -fsS --max-time 3 "http://127.0.0.1:${keycloak_port}/realms/wagering/.well-known/openid-configuration" >/dev/null 2>&1; then
    echo "LOCAL READY: API=127.0.0.1:${api_port}, Keycloak=127.0.0.1:${keycloak_port}, Grafana=127.0.0.1:${grafana_port}"
    echo "Run: bash scripts/local-verify.sh"
    echo "Grafana dashboard: http://127.0.0.1:${grafana_port}/d/wagering-observability"
    exit 0
  fi
  sleep 2
done
echo "Environment did not become ready; preserving volumes for inspection." >&2
compose ps
compose logs --tail=90 api postgres keycloak aws-emulator terraform-local grafana loki tempo prometheus otel-collector
exit 1
