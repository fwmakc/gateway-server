import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const AUTH = __ENV.AUTH_URL || 'http://auth-server:3001';
const errors = new Counter('register_errors');

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.1'],
  },
};

export default function () {
  const email = `k6test_${Date.now()}_${Math.random().toString(36).slice(2)}@test.local`;
  const payload = JSON.stringify({
    username: email,
    password: 'TestPass123!',
    client_id: 'dummy-client-id',
  });

  const res = http.post(`${AUTH}/account/register`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  const ok = check(res, {
    'register responded': (r) => r.status === 201 || r.status === 200 || r.status === 409,
  });

  if (!ok) errors.add(1);
  sleep(0.5);
}
