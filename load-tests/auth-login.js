import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const AUTH = __ENV.AUTH_URL || 'http://auth-server:3001';
const errors = new Counter('login_errors');

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.1'],
  },
};

export default function () {
  // Try login with a seeded test user
  // User was seeded via SQL — password is 'hashed_password' (not a real hash)
  // This test measures the framework overhead of the login endpoint
  const payload = JSON.stringify({
    username: 'user_1',
    password: 'wrong_password',
    client_id: 'dummy-client-id',
  });

  const res = http.post(`${AUTH}/account/login`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  const ok = check(res, {
    'login responded': (r) => r.status === 200 || r.status === 401 || r.status === 403,
  });

  if (!ok) errors.add(1);
  sleep(0.2);
}
