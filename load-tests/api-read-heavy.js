import http from 'k6/http';
import { check, sleep } from 'k6';

// Read-heavy API traffic through nginx — the full edge chain
// (nginx limit_req → api-server → pgbouncer → postgres), unlike
// api-query-matrix.js / api-mixed-workload.js which bypass nginx.
//
// The default api_limit zone is 10 r/s per IP with burst=20: a single k6
// source IP saturates it immediately, and the interesting number becomes
// nginx's own throughput. run-load.sh generates nginx-loadtest.conf with
// raised zone rates for ceiling runs; run this against the default config
// to verify the edge behaves (429s, clean 503s, no queue collapse).
//
//   k6 run -e BASE_URL=http://nginx -e VUS=20 -e DURATION=60s api-read-heavy.js

const BASE = __ENV.BASE_URL || 'http://nginx';
const VUS = parseInt(__ENV.VUS || '20', 10);
const DURATION = __ENV.DURATION || '60s';

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    // 429/503 from nginx rate limiting count as failures — set per mode:
    // default config tolerates them, ceiling config must stay near zero
    http_req_failed: ['rate<0.5'],
  },
};

const RELATIONS = encodeURIComponent('tags,category,account');
const PUBLISHED = encodeURIComponent(JSON.stringify({ isPublished: 1 }));
const HEAVY_ORDER = encodeURIComponent(JSON.stringify({ createdAt: 'DESC' }));

export default function () {
  // 60% light lists, 25% lists with relations, 10% heavy filtered, 5% 404s
  const roll = Math.random();
  let res;
  if (roll < 0.6) {
    res = http.get(`${BASE}/posts/find?limit=10`);
  } else if (roll < 0.85) {
    res = http.get(`${BASE}/posts/find?limit=20&relations=${RELATIONS}`);
  } else if (roll < 0.95) {
    res = http.get(
      `${BASE}/posts/find?limit=50&relations=${RELATIONS}&where=${PUBLISHED}&order=${HEAVY_ORDER}`,
    );
  } else {
    res = http.get(`${BASE}/posts/find?limit=10&where[id]=99999999`);
  }
  check(res, {
    'list or rate-limited': (r) => r.status === 200 || r.status === 429,
  });
  sleep(0.05);
}
