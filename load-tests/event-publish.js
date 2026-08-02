import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const EVENT = __ENV.EVENT_URL || 'http://event-server:3005';
const KEY = __ENV.INTERNAL_API_KEY || 'changeme';
const errors = new Counter('event_errors');

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.1'],
  },
};

const headers = {
  'Content-Type': 'application/json',
  'X-Internal-Api-Key': KEY,
};

export default function () {
  const payload = JSON.stringify({
    pattern: 'load.test',
    source: 'k6-load-test',
    payload: {
      timestamp: Date.now(),
      vu: __VU,
      iter: __ITER,
      data: 'k6 generated test event for load testing',
    },
  });

  const res = http.post(`${EVENT}/events`, payload, { headers });

  const ok = check(res, {
    'event responded': (r) => r.status === 200 || r.status === 201 || r.status === 202,
  });

  if (!ok) errors.add(1);
  sleep(0.3);
}
