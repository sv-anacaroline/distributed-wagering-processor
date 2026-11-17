#!/usr/bin/env bash
# Runs AFTER the complete Compose environment and migrations are ready.
# Independent on-demand k6 benchmark. A failing scenario does not prevent
# later scenarios from producing results; exit nonzero after preserving evidence.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p performance/results
export K6_UID="$(id -u)"
export K6_GID="$(id -g)"
exit_status=0

for scenario in smoke load stress spike soak hot-wallet; do
  echo "PERF_SCENARIO_BEGIN $scenario"
  export K6_SCENARIO="$scenario"
  if docker compose -f docker-compose.yml -f docker-compose.k6.yml \
      --profile performance run --rm -e K6_SCENARIO="$scenario" \
      k6 run "/scripts/scenarios/$scenario.js" \
      > "performance/results/$scenario.log" 2>&1; then
    echo "PERF_SCENARIO_EXIT $scenario 0"
  else
    code=$?
    echo "PERF_SCENARIO_EXIT $scenario $code"
    exit_status=1
    tail -n 45 "performance/results/$scenario.log"
  fi

  # Summaries are measured values produced by k6 handleSummary.
  # A machine-readable compact line is also emitted for the reporting workflow.
  if [ -s "performance/results/$scenario-summary.json" ]; then
    python3 - "$scenario" <<'PY'
import json, sys
from pathlib import Path
scenario = sys.argv[1]
data = json.loads(Path(f"performance/results/{scenario}-summary.json").read_text())
keys = (
    "timestamp", "environment", "requests", "rps", "p50_ms", "p95_ms",
    "p99_ms", "error_rate", "processed_bets", "rejected_bets",
    "replays", "invariant_violations", "correctness_rate"
)
row = {"scenario": scenario, **{key: data.get(key) for key in keys}}
print("PERF_RESULT_JSON " + json.dumps(row, separators=(",", ":"), sort_keys=True))
print("PERF_ENDPOINTS_JSON " + json.dumps(
    {"scenario": scenario, "endpoints": data.get("endpoints", {})},
    separators=(",", ":"), sort_keys=True
))
PY
  else
    echo "PERF_RESULT_MISSING $scenario"
    exit_status=1
  fi
done

python3 scripts/summarize-performance.py performance/results || exit_status=1
exit "$exit_status"
