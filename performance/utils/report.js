// Artifacts contain measured k6 figures. Never substitute configured targets for results.
export function handleSummary(data) {
  const scenario = __ENV.K6_SCENARIO || 'smoke';
  const values = (name) => data.metrics[name]?.values || {};
  const latency = values('http_req_duration');
  const requests = values('http_reqs');
  const failures = values('http_req_failed');
  const bets = values('financial_bets_processed');
  const rejections = values('financial_bets_rejected');
  const violations = values('financial_invariant_violations');
  const correctness = values('financial_correctness');
  const summary = {
    scenario,
    timestamp: new Date().toISOString(),
    environment: __ENV.K6_ENVIRONMENT || 'local',
    baseUrl: __ENV.BASE_URL || 'http://api:3000',
    workload:
      scenario === 'hot-wallet'
        ? 'shared wallet across concurrent VUs'
        : 'financial HTTP BET race, idempotent replay, ledger and reconciliation',
    requests: requests.count || 0,
    rps: requests.rate || 0,
    p50_ms: latency.med || 0,
    p95_ms: latency['p(95)'] || 0,
    p99_ms: latency['p(99)'] || 0,
    error_rate: failures.rate || 0,
    processed_bets: bets.count || 0,
    rejected_bets: rejections.count || 0,
    replays: values('financial_idempotent_replays').count || 0,
    invariant_violations: violations.count || 0,
    correctness_rate: correctness.rate || 0,
    endpoints: Object.fromEntries(
      Object.entries(data.metrics)
        .filter(([name]) => name.startsWith('http_req_duration{endpoint:'))
        .map(([name, metric]) => [name, metric.values]),
    ),
    // These metrics require application instrumentation, not k6 assumptions.
    lock_conflicts: data.metrics.financial_lock_conflicts?.values?.count ?? null,
    outbox_lag_ms: data.metrics.financial_outbox_lag_ms?.values ?? null,
    metrics: data.metrics,
  };
  return {
    [`/results/${scenario}-summary.json`]: JSON.stringify(summary, null, 2),
    stdout: [
      `k6 financial scenario=${scenario}`,
      `requests=${summary.requests} rps=${summary.rps.toFixed(2)}`,
      `p50=${summary.p50_ms.toFixed(2)}ms p95=${summary.p95_ms.toFixed(2)}ms p99=${summary.p99_ms.toFixed(2)}ms`,
      `errors=${(summary.error_rate * 100).toFixed(2)}%`,
      `processed=${summary.processed_bets} rejected=${summary.rejected_bets} replay=${summary.replays}`,
      `financial_invariant_violations=${summary.invariant_violations}`,
    ].join('\n') + '\n',
  };
}
