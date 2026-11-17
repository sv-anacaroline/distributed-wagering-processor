// Thresholds measure the financial API, including invariant failures.
export function thresholdsFor(scenario) {
  const p95ByScenario = {
    smoke: 1500,
    load: 2500,
    stress: 4000,
    spike: 4000,
    soak: 2500,
    'hot-wallet': 4000,
  };
  const p95 = Number(__ENV.K6_P95_MS || p95ByScenario[scenario]);
  return {
    http_req_failed: ['rate<0.01'],
    [`http_req_duration{endpoint:${scenario === 'hot-wallet' ? 'wager-bet' : 'wager-racing-bet'}}`]:
      [`p(95)<${p95}`],
    financial_correctness: ['rate==1'],
    financial_invariant_violations: ['count==0'],
    checks: ['rate==1'],
  };
}
