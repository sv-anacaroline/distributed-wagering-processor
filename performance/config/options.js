import { thresholdsFor } from './thresholds.js';

const duration = __ENV.K6_DURATION || '15s';
const vus = Number(__ENV.K6_VUS || 5);
const stage = __ENV.K6_STAGE_DURATION || '30s';

const scenarioConfigs = {
  smoke: { executor: 'constant-vus', vus, duration },
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: stage, target: vus },
      { duration: stage, target: vus },
      { duration: stage, target: 0 },
    ],
  },
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: stage, target: vus },
      { duration: stage, target: vus * 2 },
      { duration: stage, target: vus * 4 },
      { duration: stage, target: 0 },
    ],
  },
  spike: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '5s', target: vus },
      { duration: '5s', target: vus * 10 },
      { duration: stage, target: vus * 10 },
      { duration: '5s', target: vus },
    ],
  },
  soak: { executor: 'constant-vus', vus, duration: __ENV.K6_SOAK_DURATION || '10m' },
  'hot-wallet': { executor: 'constant-vus', vus: Math.max(vus, 3), duration },
};

export function optionsFor(scenario) {
  return {
    scenarios: { [scenario]: { ...scenarioConfigs[scenario], gracefulStop: '10s' } },
    thresholds: thresholdsFor(scenario),
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    tags: { test_type: scenario },
  };
}
