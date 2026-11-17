#!/usr/bin/env bash
# Non-destructive. Never delete user-owned PostgreSQL/Keycloak volumes here.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --profile full --profile observability down --remove-orphans
echo "Stopped. Persistent volumes were retained."
