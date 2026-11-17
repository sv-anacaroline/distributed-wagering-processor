"""Build an auditable aggregation from k6-generated measurements only."""
import json
import sys
from pathlib import Path

results = Path(sys.argv[1] if len(sys.argv) > 1 else "performance/results")
scenarios = ("smoke", "load", "stress", "spike", "soak", "hot-wallet")
rows = []
for scenario in scenarios:
    path = results / f"{scenario}-summary.json"
    if not path.exists():
        rows.append({"scenario": scenario, "status": "not-measured"})
        continue
    data = json.loads(path.read_text())
    rows.append({
        "scenario": scenario,
        "status": "measured",
        **{
            key: data.get(key)
            for key in ("timestamp", "environment", "requests", "rps", "p50_ms",
                        "p95_ms", "p99_ms", "error_rate", "processed_bets",
                        "rejected_bets", "replays", "invariant_violations", "correctness_rate")
        }
    })
output = results / "benchmark-index.json"
output.write_text(json.dumps({"results": rows}, indent=2, sort_keys=True) + "\n")
print("PERF_BENCHMARK_INDEX " + json.dumps(rows, separators=(",", ":"), sort_keys=True))
if any(row["status"] != "measured" for row in rows):
    raise SystemExit("Incomplete benchmark: missing one or more k6 measured summaries")
