import http from 'k6/http';
import { check, sleep } from 'k6';

// Webhook delivery under load: publishes valid `user.registered` events
// straight to event-server (internal API). Each accepted event is delivered
// over the webhook bus to every subscribed service — message-server receives
// it, queues a mail job and pushes it to MailHog. Ingest latency (this
// script) + the MailHog message-count delta around the run (run-load.sh)
// give the delivery throughput of the whole event pipeline.
//
//   k6 run -e VUS=10 -e DURATION=30s event-webhook-load.js

const EVENT = __ENV.EVENT_URL || 'http://event-server:3005';
const KEY = __ENV.INTERNAL_API_KEY || 'changeme';
const VUS = parseInt(__ENV.VUS || '10', 10);
const DURATION = __ENV.DURATION || '30s';

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

const headers = {
  'Content-Type': 'application/json',
  'X-Internal-Api-Key': KEY,
};

export default function () {
  // userId must be a number: the strict contract validation rejects strings
  // (a real lesson from the smoke test — string userIds failed every
  // user.* delivery)
  const payload = JSON.stringify({
    pattern: 'user.registered',
    source: 'k6-load-test',
    payload: {
      userId: __VU * 100000 + __ITER,
      username: `load_${__VU}_${__ITER}@test.local`,
      email: `load_${__VU}_${__ITER}@test.local`,
      // without confirmUrl message-server treats the registration as
      // "already activated" and queues no mail (by design) — with it the
      // full webhook → mail-queue → SMTP pipeline is exercised
      confirmUrl: `http://localhost/confirm?code=k6_${__VU}_${__ITER}`,
    },
  });

  const res = http.post(`${EVENT}/events`, payload, { headers });

  check(res, {
    'event accepted': (r) => r.status === 200 || r.status === 201 || r.status === 202,
  });

  sleep(0.1);
}
