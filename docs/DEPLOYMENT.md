# Deployment & Operations Guide

Production runbook for the stack: what each service exists for, how they are
wired, how to deploy from zero, how to upgrade, and what has actually been
verified under load. Concepts and internals live in the
[README](../README.md); this document is the operational view.

Companion documents:

| Document | Content |
|----------|---------|
| [README](../README.md) | architecture, nginx routing, scaling internals, monitoring |
| [docs/s3-storage.md](s3-storage.md) | S3 storage profile (SeaweedFS), presigned URLs, public/CDN mode |
| [docs/secret-rotation.md](secret-rotation.md) | zero-downtime rotation: internal key, JWT keys, AES secret |
| [load-tests/results.md](../load-tests/results.md) | measured evidence behind every number quoted here |

---

## 1. What each service is for

| Service | Port | Why it exists | Owns (DB) | Edge route |
|---------|------|---------------|-----------|------------|
| [auth-server](https://github.com/fwmakc/auth-server) | 3001 | Identity: accounts, registration/confirm, OAuth2 password grant, JWT RS256 signing + JWKS, refresh rotation, 2FA, social SSO, password policy, rate limiting | `auth_server` | `/account`, `/token`, `/auth`, `/.well-known`, `/users`, `/roles`, `/clients`, `/userinfo`, `/swagger` |
| [api-server](https://github.com/fwmakc/api-server) | 5000 | The domain CRUD API — the public BFF. Entities, access control, search; the project-specific service (clone per product) | `api_server` | everything else (`/`) |
| [file-server](https://github.com/fwmakc/file-server) | 3002 | Uploads/downloads, image processing, PDF generation, per-file ACL (ownership/sharing), local or S3 storage | `file_server` (ACL) | `/files`, `/uploads` |
| [message-server](https://github.com/fwmakc/message-server) | 3003 | Outbound email: postgres-backed queue, retries with backoff, per-domain rate buckets, EJS templates, suppression list | `message_server` | none (`/mail` → 404) |
| [event-server](https://github.com/fwmakc/event-server) | 3005 | Central event bus: typed contracts, HTTP webhook deliveries with retry + circuit breaker, tamper-evident audit store | `event_server` | none (internal only) |
| nginx | 80/443 | Edge: TLS termination, routing, CORS allowlist, per-IP rate limiting, `/uploads` edge cache | — | all of the above |
| postgres | 5432 | Single Postgres 16, one database per service, `init-databases.sh` on first boot | — | — |
| pgbouncer | 5432 (internal) | Transaction-mode pooler — Postgres sees ~25 real connections regardless of replica count | — | — |
| redis | 6379 | Shared rate-limit store for auth (`THROTTLE_STORAGE=redis`). Required for multi-replica auth; counters are ephemeral by design | — | — |
| s3 (SeaweedFS) | 9000 | Object storage behind the S3 profile. Private by default; public/CDN mode is opt-in | — | prod: `https://s3.<domain>` subdomain |
| auth-keys | — | One-shot job: generates the shared RS256 pair into the `auth_keys` volume (multi-replica-safe token validation) | — | — |
| prometheus + grafana | 3000 | Monitoring profile (`--profile monitoring`): `/metrics` scrape every 15 s, 15 d retention | — | grafana UI only |

Not deployed: `chat-server` (frozen skeleton, v0.1.3), `api-server-scaffold`
(template for new services), `api-server-toolkit` (npm library baked into the
images at build time).

## 2. How the services are wired

```
   browser / API client
          │ TLS
   ┌──────▼─────── nginx ──────────────────────────────────────┐
   │  /account /token /auth /.well-known → auth-server :3001   │
   │  /files /uploads                    → file-server :3002   │
   │  /*                                 → api-server  :5000   │
   └───────────────────────────────────────────────────────────┘
          │              (frontend network)
   ┌──────▼──────┐  JWT verified locally via JWKS (no auth call
   │  services   │  on the hot path); roles cached, invalidated
   └──────┬──────┘  by user.* events within seconds
          │  X-Internal-Api-Key (service-to-service)
   ┌──────▼────────────── event-server :3005 ─────────────────┐
   │  POST /events → deliveries → webhook POST /webhooks/     │
   │  events to subscribers (HMAC-SHA256 when WEBHOOK_SECRET  │
   │  is set), retry + exponential backoff + circuit breaker  │
   └──────┬───────────────────────────────────────────────────┘
          │                    │
   ┌──────▼──────┐      ┌──────▼────────┐
   │ pgbouncer   │      │ message-server│ → SMTP (real relay in prod)
   └──────┬──────┘      └───────────────┘
   ┌──────▼──────┐
   │  postgres   │   redis (auth throttler)   s3/SeaweedFS (file backend)
   └─────────────┘
```

**Trust boundaries** (each layer is independent — a breach of one does not
open the next):

| Boundary | Mechanism |
|----------|-----------|
| Edge | TLS 1.2/1.3 (`nginx-ssl.conf`), CORS origin allowlist, per-IP `limit_req`/`limit_conn`, security headers |
| Client → API | JWT RS256, verified via `/.well-known/jwks.json`; optional `iss`/`aud` binding (`JWT_ISSUER`/`JWT_AUDIENCE`) |
| Service → service | `X-Internal-Api-Key` (timing-safe compare; rotation window via `INTERNAL_API_KEY_PREVIOUS`) |
| Bus → subscribers | optional HMAC-SHA256 signature + 300 s replay window (`WEBHOOK_SECRET`) |
| Outbound webhooks | anti-SSRF egress policy (`WEBHOOK_EGRESS_MODE=internal\|public\|allowlist`) |
| Storage | file ACL on every `/uploads` request; S3 SigV4; bucket private by default |
| DB | never exposed: postgres on the `backend` network only, port published in dev override only |

## 3. Deploy from scratch

### Prerequisites

- A Linux host with Docker + Compose v2. All service repos cloned as sibling
  directories (`clone-all.sh`); images build from local sources
  (`build:` contexts — the Dockerfiles copy the toolkit and event contracts
  in, no GitHub fetch at build time).
- DNS record(s) for the API domain (and `s3.<domain>` if using the S3
  profile with presigned URLs).

### 1. Configure `.env`

```bash
cp .env.example .env
```

**Required** — compose refuses to start without them (no insecure defaults):

| Variable | Generate | Purpose |
|----------|----------|---------|
| `DB_PASSWORD` | `openssl rand -hex 16` | Postgres superuser password |
| `INTERNAL_API_KEY` | `openssl rand -hex 32` | Service-to-service auth, shared stack-wide |
| `AES_SECRET` | `openssl rand -hex 32` | auth-server: encrypts 2FA secrets + OAuth tokens |

**Required in production, dev-defaulted in compose:**

| Variable | Why |
|----------|-----|
| `SMTP_HOST/PORT/USER/PASSWORD/SECURE/SENDER_*` | compose defaults point at MailHog, which does not exist outside dev — mail fails silently in the queue until set |
| `FORM_CONFIRM`, `FORM_RESET`, `FORM_LOGIN`, `FORM_REGISTER*`, `FORM_*_COMPLETE` | links embedded in emails; compose defaults are `http://localhost/...` |

**Recommended:**

| Variable | Why |
|----------|-----|
| `WEBHOOK_SECRET` (`openssl rand -hex 32`) | HMAC-signed bus deliveries (same value to event-server and every subscriber) |
| `JWT_ISSUER` + `JWT_AUDIENCE` | binds tokens to your deployment; set identical stack-wide, roll out in one deploy |
| `THROTTLE_STORAGE=redis` | mandatory the moment auth-server runs 2+ replicas — otherwise each replica enforces its own counters (effective limits × N) |
| `TWO_FACTOR_ENABLED` | off by default; enable if you offer TOTP/email-code 2FA |
| SSO `*_CLIENT_ID/SECRET` | social login; absent = those providers fail closed |

**S3 profile additionally requires:** `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, and in prod `S3_PRESIGN_ENDPOINT=https://s3.<domain>`
(subdomain passthrough to `s3:9000` — SigV4 covers the Host, path rewrites
break signatures). Bucket is **private by default**; public/CDN mode is the
explicit opt-in `S3_PUBLIC_BUCKET=true` + `S3_PUBLIC_URL` (see
[s3-storage.md](s3-storage.md)).

Sentry per service (`SENTRY_DSN`, `SENTRY_ENV`) is not in the compose
environment blocks by design — add the two vars to a service's `environment:`
(or an `env_file:`) when you want it wired.

### 2. Bring up

```bash
# Production (base file only — the override is a DEV file:
# it adds MailHog and publishes postgres:5432):
docker compose -f docker-compose.yml up -d --build

# With S3 storage:
docker compose -f docker-compose.yml -f docker-compose.s3.yml up -d --build

# With monitoring:
docker compose -f docker-compose.yml -f docker-compose.s3.yml \
  --profile monitoring up -d --build
```

First boot, in order: `auth-keys` generates the RS256 pair → postgres
initializes (`init-databases.sh` creates `auth_server`, `api_server`,
`event_server`, `message_server`, `file_server` + test DBs) → pgbouncer
healthy → each service applies its TypeORM migrations **on boot under a
pg advisory lock** (simultaneous replica boots serialize; an empty DB
self-initializes — there is no `DB_SYNCHRONIZE` anywhere) → nginx starts
last (`service_healthy` on auth + api).

### 3. TLS + domain

Switch nginx to `nginx-ssl.conf` (HTTP→HTTPS 301, HSTS, TLS 1.2+1.3),
mount certs into `./ssl`, add your domain to the CORS allowlist map in the
conf. Step-by-step: README → *TLS termination*. For the S3 profile, route
`s3.<domain>` to port 9000 and set `S3_PRESIGN_ENDPOINT`.

### 4. Post-deploy verification

```bash
curl -f http://localhost/nginx-health                          # edge up
curl -f http://localhost/health                                # api-server
curl -f http://localhost/health/storage                        # file-server → S3 HeadBucket
./smoke.sh                                # BASE=https://your-domain ./smoke.sh
```

`smoke.sh` walks the full chain (register → confirm → login → JWT → api →
event recorded) and exits non-zero on any failure — wire it as a post-deploy
gate. Every service also exposes `GET /health` (Docker `HEALTHCHECK` drives
compose ordering); Prometheus users get `http_requests_total` /
`http_request_duration_seconds` per service.

## 4. Upgrades and rollbacks

- Services version independently (semver tags); consumers pin exact tags.
  Upgrade procedure and the versions table: README → *Versioning*.
- **Deploy a service:** `docker compose -f docker-compose.yml up -d --build
  <service>`. Boot migrations run under the advisory lock, so rolling
  replicas serialize; additive-first migrations (expand-contract) keep the
  old image runnable against the new schema.
- **Multi-replica fleets:** boot migrations leave the restart path entirely
  by running them once per deploy instead (`npm run migration:run` in the
  service repo) — see the note in README → *Docker Compose*.
- **Rollback:** redeploy the previous tag. Because migrations are
  additive-first, the previous image runs against the newer schema; the
  drop/rename half of a contract migration lands only after the fleet has
  moved.
- **JWT key rotation / secret rotation:** zero-downtime procedures in
  [secret-rotation.md](secret-rotation.md); helpers in `scripts/`.

## 5. Scaling

nginx upstreams use `least_conn` + `resolve` (Docker DNS re-resolved every
10 s) + `max_fails=3 fail_timeout=30s` — `--scale` replicas join and leave
rotation automatically. Internals and the connection-sizing math: README →
*Horizontal Scaling*.

What is **measured** (not projected):

| Change | Result |
|--------|--------|
| auth 1 → 2 replicas | logins 15.0 → 28.0/s (~1.9×, bcrypt cost 10 is the ceiling per core) |
| api 1 → 2 replicas | 392 → 394 rps — reads were already latency-bound, not CPU-bound |
| domain read storm 1 → 4 replicas (LMS case, 2026-10-08) | 1318 rps aggregate, 0% errors |
| event/message replicas | ingest flat (~95/s) — the mail queue is the deliberate bottleneck |

Prerequisites per service:

- **auth-server**: `THROTTLE_STORAGE=redis` (shared counters — verified in
  the HA run), shared JWT keys (the `auth-keys` volume — default in compose).
- **api-server / event-server**: stateless, postgres via pgbouncer; safe to
  scale.
- **file-server**: scale **only** on the S3 backend — the local driver uses
  a per-container volume. Each replica subscribes to `user.*` events under
  its own hostname URL; after scaling up/down, prune dead per-replica
  subscriber entries in event-server (`GET /subscribe` to list, `DELETE
  /subscribe/:id` to remove).
- **message-server**: the queue is postgres-backed (`SKIP LOCKED`) so
  replicas don't double-send, but per-domain rate buckets are in-process —
  N replicas = N× the domain cap. Stay at 1 replica until volume demands
  more; fleet-wide pacing is a Redis upgrade (documented in its README).
- **postgres**: pgbouncer keeps real connections ~25 per DB regardless of
  replica count.

## 6. Day-2 operations

| Task | How |
|------|-----|
| Backups | `./backup.sh [dir]` — gzip'ed SQL dump per production DB (test DBs excluded). Schedule with cron/systemd on the host; ship the dir off-machine. Restore: `gunzip < dump.sql.gz \| docker compose exec -T postgres psql -U root -d <db>`. Verify restores regularly — an untested backup is not a backup. |
| Secret rotation | internal key, JWT keys, AES secret: zero-downtime procedures in [secret-rotation.md](secret-rotation.md) |
| Monitoring | `--profile monitoring`: Prometheus (15 s scrape, 15 d) + Grafana on `:3000` (change the default admin password). Alert candidates: `rate(http_requests_total{status=~"5.."}[5m])`, `/health` flaps, `mail_jobs` pending depth, event delivery backlog, `pg_data` / `s3_data` disk |
| Logs | every service logs JSON (`LOG_FORMAT=json`) with request ids; nginx access log carries `rt=$request_time` |
| Edge cache purge | `docker compose exec nginx sh -c 'rm -rf /var/cache/nginx/uploads/*'` |
| Mail queue health | `mail_jobs` table: `pending` depth and `failed` rows; hard bounces land in `mail_suppressions` and publish `mail.bounced` |

## 7. Verification record

What the stack has actually been proven by, with dates. Details and raw
numbers: [load-tests/results.md](../load-tests/results.md) and the per-service
README "Production notes" sections.

| When | What ran | Result |
|------|----------|--------|
| CI, every push | unit/integration suites, real Postgres | toolkit 111 · api 368 · auth 41 · file 52 · event 33 · message 33 |
| 2026-09-30 | HA run — 2 replicas per service | logins ~1.9×, reads/event ingest flat (bottleneck-bound), 50/50 traffic split verified |
| 2026-10-02 | re-baseline + chaos | login ceiling 17.8/s per replica (bcrypt cost 10); auth replica SIGKILL mid-storm → 1.93% fail in a ~40 s window, survivor carried 100%; event-server killed mid-burst → every accepted event delivered |
| 2026-10-02 | full e2e | `e2e-auth` 43/43, `e2e-cases` 60/60 (register→confirm→login→CRUD→ACL→events, real SMTP + real Postgres) |
| 2026-10-05 | live pentest pass (`pentest-live.mjs`) | 27/27 — JWT forgery/replay, cross-tenant writes, ACL/404-masking, throttle math, injection probes |
| 2026-10-05 | adversarial storm 7.4 | 0 unexpected 5xx, 0 cross-user writes, audit chain intact under a browse+write+bruteforce mix |
| 2026-10-07 | static edge cache | 30 r/s asset load: 64.5% → 0% 429; 11.4k r/s flood → file-server at 0.44% CPU |
| 2026-10-08 | wave-14 full regression re-run (v0.32.0 stack) | baselines reproduced (17.3 logins/s, 361.7 read rps, ~52 files/s); identity storm (1000 users, 2FA enrolment) — throttle trips exactly at limit, 0 letters lost; activity storm — 7208/7208 answers, 0 duplicates, 4-replica scale 1318 rps; mailburst 1000 letters @ ~21.4/s, 0 lost |
| 2026-10-08 | LMS case (waves 7–14) | production-shaped domain workload on the stack for six waves: capacity/overbooking races, moderation, per-replica event fan-out, role-grant propagation measured at 3.0 s / revoke 1.5 s |

**Honest scope of that evidence:** every number above comes from a
single-host Docker Compose stand (multi-replica yes — up to 4 replicas of a
service; **multi-host was not exercised**). The design carries multi-host
(stateless services, DNS-based upstream discovery, shared Redis counters,
advisory-lock migrations), but cross-machine deployment is orchestrator
territory (Compose on one host per machine, Swarm, k8s) and has no measured
record here. Treat the load numbers as per-core-reference, not SLA.

## 8. Production decisions you accept by deploying

1. **bcrypt stays at cost 10** (project constraint). The scaling lever is
   replicas (~17.8 logins/s per core); cost 12 measures 3.7× more expensive.
2. **Deactivation is a soft delete.** An already-issued access JWT stays
   valid until expiry; role/active changes propagate to consumers in seconds
   via `user.*` events (measured: grant 3.0 s, revoke 1.5 s), not instantly.
   Instant revocation would require token introspection or short access TTLs.
3. **Rate limiting is in-memory by default** (single-replica semantics).
   Multi-replica auth requires `THROTTLE_STORAGE=redis` — documented, not
   enforced.
4. **The event bus is at-least-once after acceptance.** A publish rejected
   during event-server downtime is the publisher's loss; use the toolkit
   `OutboxModule` (transactional outbox) when an event must not be lost.
5. **Mail is deliberately slow.** The queue paces itself (5 s poll × 50
   batch, per-domain token buckets) to protect sender reputation. It is a
   pacing device, not a latency buffer.
6. **The S3 bucket is private by default.** Public/CDN mode is opt-in; even
   then, privacy is enforced at the `/uploads` proxy (ACL + 404-masking),
   not at the bucket.
7. **chat-server is frozen** (v0.1.3 skeleton) and not part of the compose
   stack.

## 9. Quick reference

```bash
# bring up (prod / prod+S3 / monitoring)
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.s3.yml up -d --build
docker compose -f docker-compose.yml --profile monitoring up -d

# scale (auth needs THROTTLE_STORAGE=redis in .env first)
docker compose -f docker-compose.yml up -d --scale auth-server=2 --scale api-server=3

# verify / operate
./smoke.sh                                   # post-deploy gate
./backup.sh /mnt/backups                     # all production DBs
docker compose logs -f auth-server           # JSON logs
docker compose exec nginx sh -c 'rm -rf /var/cache/nginx/uploads/*'
```

| Port | Thing | Exposed? |
|------|-------|----------|
| 80 / 443 | nginx | yes (host) |
| 3000 | Grafana (monitoring profile) | yes (host) |
| 3001/3002/3003/3005/5000 | auth / file / message / event / api | internal networks only |
| 5432 | postgres via pgbouncer | dev override only |
| 6379 | redis | backend network only |
| 9000 | SeaweedFS S3 | dev: `127.0.0.1:9000` · prod: `s3.<domain>` edge route |
| 8025 | MailHog UI | dev override only |
