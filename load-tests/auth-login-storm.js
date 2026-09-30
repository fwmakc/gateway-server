import http from 'k6/http';
import { check, sleep } from 'k6';

// Login storm: measures the bcrypt price — the sustainable login throughput
// of auth-server. Every iteration is a REAL successful login against
// pre-seeded users (load_<i>@test.local, see seed-load.sql), so the full
// bcrypt compare + refresh-token INSERT + audit event path runs each time.
//
// Auth-server throttles login at THROTTLE_AUTH_LIMIT/min per IP (5/min by
// default). To measure the CPU ceiling rather than the throttle, run with the
// load-test limits raised (run-load.sh ceiling mode does this for you).
// Two user pools exist: cost-10 and cost-12 bcrypt hashes (USERS_PREFIX
// selects the pool) — comparing runs settles the cost 10 vs 12 question.
//
//   k6 run -e USERS_COUNT=100 -e VUS=20 -e DURATION=60s auth-login-storm.js

const AUTH = __ENV.AUTH_URL || 'http://auth-server:3001';
const USERS_COUNT = parseInt(__ENV.USERS_COUNT || '100', 10);
const PREFIX = __ENV.USERS_PREFIX || 'load';
const PASSWORD = __ENV.USERS_PASSWORD || 'LoadPass123!';
const VUS = parseInt(__ENV.VUS || '20', 10);
const DURATION = __ENV.DURATION || '60s';

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    // a storm of successful logins: 429 here means the throttler, not the
    // app, is the ceiling — raise THROTTLE_AUTH_LIMIT for ceiling runs
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // deterministic user per iteration: distinct users across VUs, reused
  // across iterations (refresh-token rows grow per login — that cost is
  // part of the login price)
  const i = ((__VU - 1) * 7 + __ITER * 3) % USERS_COUNT;
  const username = `${PREFIX}_${i}@test.local`;

  const res = http.post(
    `${AUTH}/account/methods/login`,
    JSON.stringify({ username, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
  );

  // NestJS answers 201 Created on POST — accept both
  check(res, {
    'status 2xx': (r) => r.status === 200 || r.status === 201,
    'access_token issued': (r) =>
      (r.status === 200 || r.status === 201) &&
      r.json('access_token') !== undefined,
  });

  sleep(0.1);
}
