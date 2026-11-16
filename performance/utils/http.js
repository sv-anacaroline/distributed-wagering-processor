import http from 'k6/http';
import { check, fail, sleep } from 'k6';

const baseUrl = (__ENV.BASE_URL || 'http://api:3000').replace(/\/$/, '');

export function waitForApp() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = http.get(`${baseUrl}/`, { timeout: '3s' });
    if (response.status === 200) return;
    sleep(1);
  }
  fail(`NestJS starter not reachable at ${baseUrl}/`);
}

export function getRoot() {
  const response = http.get(`${baseUrl}/`, { tags: { endpoint: 'starter-root' } });
  check(response, {
    'GET / responds 200': (r) => r.status === 200,
    'GET / returns Hello World': (r) => r.body === 'Hello World!',
  });
  sleep(0.1);
}
