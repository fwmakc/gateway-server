import http from 'k6/http';
import { check, sleep } from 'k6';

// Full register → confirm → login → /account/self path, the way a real user
// drives it: the confirm code is taken from the email MailHog received
// (event bus → message-server → SMTP), so every iteration also exercises
// user.registered delivery, the mail queue and MailHog.
//
// Requires ceiling mode (raised THROTTLE_AUTH_STRICT_LIMIT) — at the default
// 3 registers/min/IP the throttler, not the app, is the bottleneck.
//
//   k6 run -e VUS=5 -e DURATION=60s auth-full-path.js

const AUTH = __ENV.AUTH_URL || 'http://auth-server:3001';
const MAILHOG = __ENV.MAILHOG_URL || 'http://mailhog:8025';
const PASSWORD = 'FullPath123!';
const VUS = parseInt(__ENV.VUS || '5', 10);
const DURATION = __ENV.DURATION || '60s';

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // end-to-end iteration (register → mail → confirm → login → self)
    iteration_duration: ['p(95)<15000'],
  },
};

function waitForEmail(to, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = http.get(
      `${MAILHOG}/api/v2/search?kind=to&query=${encodeURIComponent(to)}&limit=50`,
    );
    if (res.status === 200) {
      const data = res.json();
      // MailHog v2 returns `items` (v1 returned `messages`)
      for (const msg of data.items ?? data.messages ?? []) {
        // nodemailer sends HTML quoted-printable: the literal `=` of `?code=`
        // arrives as `=3D`, plus soft line breaks `=\r\n` — decode first, or
        // the extracted code is prefixed with `3D` and confirm rejects it.
        const body = String(msg.Content?.Body ?? '')
          .replace(/=\r\n/g, '')
          .replace(/=\n/g, '')
          .replace(/=3D/g, '=');
        const m = body.match(/[?&]code=([A-Za-z0-9_-]+)/);
        if (m) return m[1];
      }
    }
    sleep(0.5);
  }
  return null;
}

export default function () {
  const email = `full_${Date.now()}_${__VU}_${__ITER}@test.local`;

  // 1. register
  let res = http.post(
    `${AUTH}/account/methods/register`,
    JSON.stringify({ username: email, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const registered = check(res, {
    'register 201/200': (r) => r.status === 200 || r.status === 201,
  });

  // 2. confirm via the emailed code (proves the event → mail pipeline)
  const code = waitForEmail(email);
  check(code, { 'confirm code arrived by email': (c) => !!c });
  if (!registered || !code) return;

  res = http.get(`${AUTH}/account/methods/confirm/${code}`);
  check(res, {
    // the API answers business failures with HTTP 200 + success:false —
    // a bare status check would green-light an invalid code
    'confirm success': (r) => r.status < 300 && r.json('success') === true,
  });

  // 3. login
  res = http.post(
    `${AUTH}/account/methods/login`,
    JSON.stringify({ username: email, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
  );
  const token = res.status === 200 || res.status === 201
    ? res.json('access_token')
    : null;
  check(res, { 'login issued access_token': (r) => !!token });
  if (!token) return;

  // 4. authenticated request
  res = http.get(`${AUTH}/account/self`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(res, { '/account/self 200': (r) => r.status === 200 });

  sleep(0.2);
}
