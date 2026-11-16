// Baseline HTTP thresholds only. Financial invariants require separate SQL checks.
export function thresholdsFor(scenario) {
  const p95ByScenario = {
    smoke: 750,
    load: 1000,
    stress: 2000,
    spike: 2000,
    soak: 1000,
  };
  const p95 = Number(__ENV.K6_P95_MS || p95ByScenario[scenario]);
  return {
    http_req_failed: ['rate<0.01'],
    http_req_duration: [`p(95)<${p95}`],
    checks: ['rate>0.99'],
  };
}
