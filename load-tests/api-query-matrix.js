import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.API_URL || 'http://api-server:5000';

const errors = new Counter('query_errors');

const relations = encodeURIComponent(
  JSON.stringify([{ name: 'tags' }, { name: 'category' }, { name: 'account' }])
);

export const options = {
  scenarios: {
    light_batch: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      tags: { query: 'light', mode: 'batch' },
      exec: 'light_batch',
    },
    light_join: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      tags: { query: 'light', mode: 'join' },
      exec: 'light_join',
      startTime: '16s',
    },
    medium_batch: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      tags: { query: 'medium', mode: 'batch' },
      exec: 'medium_batch',
      startTime: '32s',
    },
    medium_join: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      tags: { query: 'medium', mode: 'join' },
      exec: 'medium_join',
      startTime: '48s',
    },
    heavy_batch: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      tags: { query: 'heavy', mode: 'batch' },
      exec: 'heavy_batch',
      startTime: '64s',
    },
    heavy_join: {
      executor: 'constant-vus',
      vus: 10,
      duration: '15s',
      tags: { query: 'heavy', mode: 'join' },
      exec: 'heavy_join',
      startTime: '80s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
};

function req(url) {
  const res = http.get(url);
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has body': (r) => r.body && r.body.length > 2,
  });
  if (!ok) errors.add(1);
  return res;
}

export function light_batch() {
  req(`${BASE}/posts/find?limit=10`);
  sleep(0.1);
}
export function light_join() {
  req(`${BASE}/posts/find?limit=10&join=true`);
  sleep(0.1);
}
export function medium_batch() {
  req(`${BASE}/posts/find?limit=20&relations=${relations}`);
  sleep(0.2);
}
export function medium_join() {
  req(`${BASE}/posts/find?limit=20&relations=${relations}&join=true`);
  sleep(0.2);
}
export function heavy_batch() {
  const where = encodeURIComponent(JSON.stringify({ isPublished: 1 }));
  req(`${BASE}/posts/find?limit=50&relations=${relations}&where=${where}&order=${encodeURIComponent('{"viewCount":"DESC"}')}`);
  sleep(0.3);
}
export function heavy_join() {
  const where = encodeURIComponent(JSON.stringify({ isPublished: 1 }));
  req(`${BASE}/posts/find?limit=50&relations=${relations}&join=true&where=${where}&order=${encodeURIComponent('{"viewCount":"DESC"}')}`);
  sleep(0.3);
}
