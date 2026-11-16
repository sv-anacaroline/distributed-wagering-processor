import http from 'k6/http';
import { check, fail, sleep } from 'k6';

// Baseline only: NestJS starter route. Financial load scenarios come later.
const baseUrl = (__ENV.BASE_URL || 'http://api:3000').replace(/\/$/, '');

export const options = {
  vus: Number(__ENV.K6_VUS || 5),
  duration: __ENV.K6_DURATION || '15s',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<750'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = http.get(`${baseUrl}/`, { timeout: '3s' });
    if (response.status === 200) return;
    sleep(1);
  }
  fail(`NestJS starter was not reachable at ${baseUrl}/`);
}

export default function () {
  const response = http.get(`${baseUrl}/`, { tags: { endpoint: 'starter-root' } });
  check(response, {
    'GET / responds 200': (r) => r.status === 200,
    'GET / has expected payload': (r) => r.body === 'Hello World!',
  });
  sleep(0.1);
}
