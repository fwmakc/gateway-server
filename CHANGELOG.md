# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.4] - 2026-09-30
### Added
- **HA / multi-replica support**: `redis` service (7-alpine, no persistence —
  the throttle counters are ephemeral) and `THROTTLE_STORAGE` / `REDIS_URL`
  pass-through to auth-server. `THROTTLE_STORAGE=redis` + `--scale
  auth-server=N` gives one shared rate-limit counter set instead of N
  independent ones (auth-server ≥ 0.9.0); default (empty) keeps in-memory
  counters — single-replica behavior unchanged.
- **Shared JWT signing keys**: the one-shot `auth-keys` job generates an
  RS256 pair into the `auth_keys` volume; auth-server mounts it read-only
  (`JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH`). Previously auth minted
  ephemeral per-boot keys — replicas rejected each other's tokens (401s on
  every cross-replica request), every restart invalidated all tokens.
- `run-load.sh`: `SCALE="auth-server=2 ..."` env adds `--scale` flags; the
  health gate now checks every replica (`docker compose ps -q` + per-container
  exec) and prints the replica count per service; `redis` joins the boot list.
- HA load-test numbers in `load-tests/results.md` (2 replicas: bcrypt
  login ceiling ~1.8×, reads/event bus unchanged at their bottlenecks).

## [0.5.3] - 2026-09-30
### Added
- **Load-test harness** (`load-tests/`): `run-load.sh` (boot + seed + k6 + CPU
  sampler + headline extraction; ceiling/realistic modes), scenarios
  `auth-login-storm` (bcrypt cost-10 vs cost-12 pools), `auth-full-path`
  (register → emailed code → login → self through the real event/mail
  pipeline), `api-read-heavy` (through nginx), `event-webhook-load`
  (ingest + MailHog drain watch), `seed-load.sql` (200 users, two bcrypt
  cost pools). Numbers in `load-tests/results.md` (login ceiling ~15/s per
  core at cost 10; cost 12 = 3.7×; edge absorbs 98–99% of floods at ~1 ms).
- compose: `THROTTLE_*` env pass-through to auth-server (rate-limit tuning
  per deployment, auth-server ≥ 0.8.10).

### Fixed
- stale `viewCount` ordering in the old k6 matrix/mixed scenarios (column
  no longer exists) → `createdAt`; seed.sql updated to match the current
  posts schema.

## [0.5.2] - 2026-09-30
### Fixed
- `server_tokens off` в nginx.conf и nginx-ssl.conf (self-pentest): версия nginx больше не раскрывается в заголовках ответов и страницах ошибок.
- `limit_req`/`limit_conn` на `location ~ ^/(swagger|redoc)` (self-pentest): swagger генерирует OpenAPI-схему на каждый запрос и был единственным наружным маршрутом без лимитов; теперь `auth_limit burst=5` + `limit_conn 5`.
- nginx-ssl.conf: добавлено объявление `limit_conn_zone conn_limit` (использовалось, но не было объявлено — такой конфиг не прошёл бы `nginx -t`).

## [0.5.1] - 2026-09-29
### Changed
- Compose no longer passes DB_SYNCHRONIZE / DB_MIGRATIONS_RUN to services: schema is owned exclusively by TypeORM migrations and every service applies pending migrations on boot (hardcoded). Dev override no longer flips DB_SYNCHRONIZE.
- README: first-start docs updated (empty database initializes automatically on boot).

## [0.5.0] - 2026-09-28

### Added
- Monitoring profile: Prometheus (`v3.4.1`, 15s scrape, 15d retention) and Grafana (`12.1.0`, auto-provisioned Prometheus datasource, UI on `:3000`). Opt-in via `COMPOSE_PROFILES=monitoring` — the core stack starts without it. Config lives in `monitoring/`.
- All services now expose Prometheus `/metrics` (toolkit `MetricsModule` v0.19.0: `http_requests_total`, `http_request_duration_seconds`, Node.js defaults). Unauthenticated, internal-network-only — nginx does not proxy it.

## [0.4.0] - 2026-09-28

### Fixed
- `init-databases.sh` mount pointed to `/docker-entrypoint-initdb.sh/` — the script never ran, so a fresh `pg_data` volume started with zero stack databases. Now mounted at `/docker-entrypoint-initdb.d/`.

### Changed
- `DB_PASSWORD`, `INTERNAL_API_KEY`, `AES_SECRET` are required — compose interpolates them with `:?` and refuses to start on missing values (insecure defaults `1234`/`changeme` removed).
- chat-server and redis removed from the dev override (chat is frozen: no JWT on WebSocket, no Redis adapter, no storage). Nginx chat upstream/location commented out with restore notes.
- Security headers on all responses: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (HSTS stays in `nginx-ssl.conf`). `X-Internal-Api-Key` removed from browser-facing CORS headers.
- Resource limits (`mem_limit`/`cpus`) for all services.

### Added
- `backup.sh` — gzip'ed pg_dump of all production databases (test DBs excluded) + restore instructions in README.
- `.env.example` rewritten around the required secrets with generation commands.

## [0.3.0] - 2026-08-03

Version reset to pre-release. The gateway server provides Docker Compose orchestration, nginx config, and k6 load tests, but the overall stack is not yet production-hardened.

## [2.0.1] - 2026-08-03

### Added
- k6 load test suite: 5 scenarios covering API query matrix (batch vs JOIN), mixed workload (60% light / 25% medium / 10% heavy / 5% writes), event publishing, auth registration and login.
- Seed SQL scripts for 200 posts, 10 categories, 30 tags, 5 accounts, 928 post-tag links.
- `load-tests/results.md` with benchmark results: 128.7 req/s mixed workload, p(95)=13.2ms, 0% failure rate on read endpoints.

## [2.0.0] - 2026-08-03

### Stack v2 alignment
- Nginx reverse proxy + Docker Compose orchestration
- Clone-all scripts (clone-all.ps1, clone-all.sh)
- Compose for all 7 services + PostgreSQL + Redis
- CI test summary (670 tests across 6 services)
