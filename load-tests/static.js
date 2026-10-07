import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

/**
 * Static-download probe for the /uploads edge (rate zone + proxy_cache).
 *
 * Two modes:
 *   RATE=30 ./run…  → constant-arrival-rate: limiter-safe sustained load
 *                     (one k6 container = one source IP = one per-IP bucket)
 *   VUS=50  ./run…  → constant-vus flood: ceiling mode; 429s are expected
 *                     when the per-IP zone saturates (the threshold failure
 *                     is the point, the counters tell the story)
 *
 * Env: TARGET_URL (required), RATE | VUS, DURATION (default 15s).
 * Results and methodology: load-tests/results.md (static section).
 *
 * Example:
 *   docker run --rm --network <compose>_frontend -v "$PWD/load-tests:/scripts" \
 *     grafana/k6 run /scripts/static.js \
 *     -e TARGET_URL=http://nginx/uploads/site-assets/article.png -e RATE=30
 */
const throttled = new Counter('static_429');
const TARGET = __ENV.TARGET_URL;
const DURATION = __ENV.DURATION || '15s';

export const options = {
  scenarios: {
    load: __ENV.RATE
      ? {
          executor: 'constant-arrival-rate',
          rate: Number(__ENV.RATE),
          timeUnit: '1s',
          preAllocatedVUs: 30,
          maxVUs: 100,
          duration: DURATION,
        }
      : {
          executor: 'constant-vus',
          vus: Number(__ENV.VUS || 50),
          duration: DURATION,
        },
  },
  thresholds: { http_req_failed: ['rate<0.01'] },
};

export default function () {
  const res = http.get(TARGET);
  if (res.status === 429) throttled.add(1);
  check(res, { 'served (200/304)': (r) => r.status === 200 || r.status === 304 });
  sleep(0);
}
