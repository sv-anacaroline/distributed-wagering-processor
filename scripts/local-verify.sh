#!/usr/bin/env bash
# Full real SQS input -> Inbox -> financial transaction -> ledger -> Outbox.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose --profile full exec -T api bun scripts/local-events.ts demo
