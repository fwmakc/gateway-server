# Load Test Results

**Date:** 2026-09-30
**Runner:** `./load-tests/run-load.sh` (k6 in Docker, single dev machine)
**Stack:** full compose (nginx → auth/api/event/message → pgbouncer → postgres),
per-service cpu limits as in docker-compose.yml (auth 1.0, api 1.0, event 1.0,
postgres 1.5, nginx 0.5). Node 24-alpine, PostgreSQL 16-alpine.
**Data:** 200 load users (100 bcrypt cost-10, 100 cost-12), 200 posts,
10 categories, 30 tags.

## Summary (ceiling mode — rate limits raised, measures the CPU ceiling)

| Scenario | Throughput | avg | p(95) | Failures | Reading |
|----------|-----------|-----|-------|----------|---------|
| Login storm, bcrypt **cost 10** | **15.0 logins/s** | 1452 ms* | 1602 ms* | 0% | the per-core login ceiling |
| Login storm, bcrypt **cost 12** | **4.1 logins/s** | 4734 ms* | 5900 ms* | 0% | cost 12 is **3.7× more expensive** |
| Full path (register → email → confirm → login → self) | 12.9 req/s HTTP | iteration 6.8 s | 17.0 s | 0% | dominated by the mail-queue poll (5 s) |
| Read-heavy API through nginx | **392 req/s** @20 VU | 9.4 ms | 13.0 ms | 0% | not saturated — latency-bound |
| Event ingest (POST /events) | **91.6 events/s** | 19.1 ms | 73.2 ms | 0% | deliveries 4978/4978 delivered |
| Webhook → mail queue → MailHog | drain **10 mails/s** | — | — | 0% | `WORKER_INTERVAL_MS × BATCH_SIZE` = 5 s × 50, by design |

\* storm latency at 20 VUs is queueing, not service slowness: a single login
takes **75 ms** (bcrypt cost 10 ≈ 55 ms + refresh INSERT + audit event +
JWT sign). 20 concurrent bcrypts serialize on the auth container's single
CPU — docker stats shows **auth-server at 92–95% CPU** during the storm,
postgres ~5–9%, everything else idle.

## The bcrypt cost 10 vs 12 decision, with data

- Single login: **75 ms at cost 10**; cost 12 multiplies the bcrypt part by
  2^2 = 4× → ~270 ms (measured aggregate: 3.7× throughput drop).
- Per core: ~**13 logins/s at cost 10** vs ~**3.5 at cost 12**.
- Example sizing: 1000 logins/min peak (16.7/s) needs 2 replicas at cost 10,
  5 replicas at cost 12.
- Decision: **bcrypt stays at cost 10** (per project constraint). When
  hardware allows, the honest lever is replicas, not the cost factor.
  Revisit only if the customer's audit demands cost ≥ 12 — then budget 4×
  auth capacity.

## nginx limit_req vs auth throttler interaction (realistic mode)

With stock limits (nginx `auth_limit` 5 r/s burst 10, `api_limit` 10 r/s
burst 20 per IP; auth throttler 5/min login per IP):

| Scenario | Attempted | Rejected | Behavior |
|----------|-----------|----------|----------|
| Read-heavy flood | 500 req/s | **98.2%** (429) | nginx rejects in ~1.9 ms, api-server never sees the flood |
| Login storm through nginx | 215 req/s | **99.9%** (429) | the expensive bcrypt path is never reached — edge absorbs it |

Conclusion: the protection layers stack correctly (nginx first, cheap 429s;
throttler second, per-IP per-route; bcrypt last). A flood from one IP never
warms a single bcrypt. The residual risk is distributed-source floods —
that is capacity planning (replicas), not rate limiting.

## HA run — 2 replicas per service (2026-09-30, ceiling mode)

Same runner, `SCALE=2` (`run-load.sh` adds `--scale <svc>=2` for
auth/api/event/message). Each service got its own replica: nginx upstreams
use `least_conn` + `resolve`, so every scenario below ran against both
replicas (verified: nginx access log split ~50/50 between the two auth IPs).

| Scenario | 1 replica | 2 replicas | Scaling |
|----------|-----------|------------|---------|
| Login storm, bcrypt cost 10 | 15.0 logins/s | **28.0 logins/s** (0.4% fail) | ~1.9× |
| Login storm, bcrypt cost 12 | 4.1 logins/s | **7.9 logins/s** (1.8% fail) | ~1.9× |
| Read-heavy API through nginx | 392 req/s, 0% fail | **394 req/s, 0% fail** | already latency-bound |
| Full path (register→email→confirm→login→self) | 12.9 req/s | **8.8 req/s, 0% fail** | mail-queue bound (by design) |
| Event ingest → webhook → MailHog | 91.6 events/s | **93.3 events/s, 0% fail** | mail-queue bound (by design) |

The storm residual failures are the bcrypt queue tail at 20 VUs exceeding
nginx's 10 s `proxy_read_timeout` (max latencies 9.4–11.6 s) — an edge
config property of the ceiling run, not replica misbehavior.

Reads and the event bus were already at their bottleneck (nginx edge
latency, the deliberate 10 mails/s queue), so replicas don't move them —
the win is where CPU is the ceiling: bcrypt logins scale near-linearly
until both containers saturate.

Two shared-state fixes made this run correct (both shipped):

- **JWT signing keys** (gateway compose): auth used to mint *ephemeral*
  RS256 keys per boot (`JWT_PRIVATE_KEY_PATH` unset) — replicas rejected
  each other's tokens with 401s. The compose now runs a one-shot
  `auth-keys` job that generates a shared key pair into the `auth_keys`
  volume; auth mounts it read-only. Token issued by replica A validates on
  replica B (and every other service via JWKS).
- **Throttler storage** (`THROTTLE_STORAGE=redis` in this run): counters
  in Redis, shared by both replicas (verified: the same Redis key
  increments regardless of which replica serves the request). Without it,
  2 replicas allow ~2× the configured limits.

Known artifact of the first (pre-fix) run: ~1–4% of storm requests 500'd
in the first seconds after boot — the Redis-backed throttler connected
lazily and fail-closed on the not-yet-open stream. auth 0.9.0 connects at
boot; the clean re-run shows only the timeout tail noted above.

Also fixed during this run (pre-existing bugs the HA scenarios surfaced):

- `event-server` audit store crashed every `audit.event` publish with
  `No metadata for "AuditEventEntity"` — the entity was never registered
  in the DataSource (`entities: [...]` listed only the bus entities), and
  smoke never looked at the `audit_events` table. Audit records now append.
- `load-tests/auth-full-path.js` read confirm codes from quoted-printable
  mail bodies (`=3D` prefix) and accepted `200 {"success":false}` as
  confirm success — both corrected; scenario is 0% fail end to end.
- `load-tests/api-read-heavy.js` sent `relations=tags,category,account`
  (comma string) — the API expects an array
  (`relations[0][name]=tags&...`); the old form 500s in
  `find.helper.ts` (toolkit regression worth fixing separately).

## Event pipeline under load

- Ingest (`POST /events`, internal key): ~90 events/s sustained, p95 73 ms,
  0 failures at 10 VUs.
- Delivery worker (`BATCH_SIZE=50`, 500 ms interval) kept up: 4978/4978
  deliveries `delivered` after the run.
- The mail queue is the deliberate bottleneck: 10 mails/s
  (5 s × 50). A 5.5k-event backlog drains in ~9 min — fine for real
  registration traffic, worth remembering when wiring up bulk imports.

## Environment notes for reproducers

- `run-load.sh` ceiling mode raises the auth throttler via
  `THROTTLE_*` env (auth-server ≥ 0.8.10) and mounts a generated
  `nginx-loadtest.conf` (zones 500r/s / 250r/s, bigger bursts).
- `INTERNAL_API_KEY` is read from the stack's `.env` — `POST /events` is
  guarded (401 without it, verified).
- MailHog search API v2 returns `items`; the mail worker polls every 5 s,
  so full-path iterations are seconds, not milliseconds.
- Git Bash (MSYS) rewrites container paths — the runner uses
  `MSYS_NO_PATHCONV=1` + `cygpath -m` for the k6 mount.
- NestJS answers **201** on POST; checks accept 200/201.

## Historical (2026-08-03, pre-hardening stack)

The August numbers (query matrix 59 req/s, mixed 129 req/s, auth 50%
redirect failures) were taken before the throttler hardening, audit
logging and the Access-model fixes; the auth rows were measurement artifacts
(redirects to nonexistent frontend URLs). Superseded by this run; the
api query-matrix scripts remain usable but their `viewCount` ordering was
updated to `createdAt` (the column no longer exists).
