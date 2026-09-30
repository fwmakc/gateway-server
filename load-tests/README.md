# Load Tests

k6 load test scenarios for the NestJS microservices stack, driven by
`run-load.sh` (boots the stack, seeds data, runs k6 in Docker, prints one
headline line per scenario).

## Quick start

```bash
cd gateway-server

# ceiling mode (default): rate limits raised via THROTTLE_* env +
# a generated nginx-loadtest.conf — measures the services' CPU ceiling
./load-tests/run-load.sh                    # all scenarios
./load-tests/run-load.sh storm10 read       # subset

# realistic mode: stock limits (auth 3-5/min per IP, nginx 5-10 r/s per IP)
# — verifies the edge behaves; 429s are the expected outcome
MODE=realistic ./load-tests/run-load.sh read storm10

# iterate without rebuilding images
SKIP_BOOT=1 ./load-tests/run-load.sh webhook

# tuning knobs
VUS_STORM=40 DURATION=120s ./load-tests/run-load.sh storm10
```

Individual k6 runs (after the stack is up):

```bash
docker run --rm --network gateway-server_backend --network gateway-server_frontend \
  -v "$(cygpath -m "$(pwd)/load-tests"):/scripts" grafana/k6:latest \
  run --quiet -e AUTH_URL=http://auth-server:3001 -e USERS_COUNT=100 \
  /scripts/auth-login-storm.js
```

## Scenarios

| Script | Target | Measures |
|--------|--------|----------|
| `auth-login-storm.js` | auth-server | successful-login throughput (full bcrypt + refresh INSERT + audit path); `-e USERS_PREFIX=load\|load12` picks the cost-10 / cost-12 pool from `seed-load.sql` |
| `auth-full-path.js` | auth + event + message + MailHog | register → confirm code from the email → login → `/account/self`; exercises the whole event/mail pipeline |
| `api-read-heavy.js` | nginx → api → postgres | read traffic through the edge (60% light / 25% relations / 10% heavy / 5% misses) |
| `event-webhook-load.js` | event-server → message-server → MailHog | event ingest rate + webhook delivery; MailHog delta measured by the runner |
| `api-query-matrix.js`, `api-mixed-workload.js`, `auth-register.js`, `auth-login.js`, `event-publish.js` | various | the original August scenarios, kept for ad-hoc use (matrix/mixed hit api-server directly) |

## Runner details

- Ceiling mode raises the auth throttler with `THROTTLE_*` env
  (auth-server ≥ 0.8.10) and generates `nginx-loadtest.conf` from the live
  `nginx.conf` (zones → 500r/s / 250r/s) — never deploy that conf anywhere
  reachable.
- `docker-compose.loadtest.yml` is the override with the raised limits +
  MailHog; realistic mode uses the regular `docker-compose.override.yml`.
- Seeds: `seed-load.sql` (200 load users into auth_server; bcrypt hashes for
  both cost variants embedded) and `seed.sql` / `seed-tags.sql`
  (posts/categories/tags into api_server).
- A background sampler records per-container CPU/mem every 3 s to
  `out/stats.log`.
- Results land in `out/<scenario>.txt` (k6 text) and `out/<scenario>.json`
  (raw summary export); headline numbers are printed by the runner.

See [results.md](./results.md) for the 2026-09-30 numbers (login ceiling,
bcrypt cost pricing, edge behavior under flood, event pipeline capacity).
