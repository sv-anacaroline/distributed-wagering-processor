// Each scenario writes a machine-readable summary into performance/results/.
export function handleSummary(data) {
  const scenario = __ENV.K6_SCENARIO || 'smoke';
  const latency = data.metrics.http_req_duration?.values || {};
  const requests = data.metrics.http_reqs?.values || {};
  const failures = data.metrics.http_req_failed?.values || {};
  const summary = {
    scenario,
    timestamp: new Date().toISOString(),
    environment: __ENV.K6_ENVIRONMENT || 'local',
    baseUrl: __ENV.BASE_URL || 'http://api:3000',
    requests: requests.count || 0,
    rps: requests.rate || 0,
    p50_ms: latency.med || 0,
    p95_ms: latency['p(95)'] || 0,
    p99_ms: latency['p(99)'] || 0,
    error_rate: failures.rate || 0,
    metrics: data.metrics,
  };
  return {
    [`/results/${scenario}-summary.json`]: JSON.stringify(summary, null, 2),
    stdout:
      [
        `k6 scenario=${scenario}`,
        `requests=${summary.requests} rps=${summary.rps.toFixed(2)}`,
        `p50=${summary.p50_ms.toFixed(2)}ms p95=${summary.p95_ms.toFixed(2)}ms p99=${summary.p99_ms.toFixed(2)}ms`,
        `errors=${(summary.error_rate * 100).toFixed(2)}%`,
        'Financial correctness is NOT measured by this HTTP baseline.',
      ].join('\n') + '\n',
  };
}
