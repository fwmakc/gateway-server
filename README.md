# Gateway Server

[![CI](https://github.com/fwmakc/gateway-server/actions/workflows/test.yml/badge.svg)](https://github.com/fwmakc/gateway-server/actions/workflows/test.yml)
[![Version](https://img.shields.io/badge/version-v0.3.0-blue)](https://github.com/fwmakc/gateway-server/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/fwmakc/gateway-server/blob/master/LICENSE)

> Reference architecture: full-stack orchestration — Nginx gateway, Docker Compose, health checks, 7 services.

## What This Is

A **working scaffold** — not a demo, not a toy. Production-ready Docker Compose
setup with Nginx gateway, rate limiting, CORS, health checks, and automatic
database creation. Clone it, customize the domain entities in api-server,
deploy to production.

Part of a [microservices stack](https://github.com/fwmakc/gateway-server) —
this repo orchestrates all services: auth, API, events, files, email, chat.

## Reference Architecture

Each service in the stack demonstrates a pattern. Together they form a
reference implementation for building NestJS microservices on a shared toolkit.

```
                       ┌──────────┐
                       │  nginx   │ :80
                       │ gateway  │
                       └────┬─────┘
          ┌────────────────┼────────────────┐
          │                │                │
   ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
   │ auth-server │  │  api-server │  │ file-server │
   │   :3001     │  │    :5000    │  │    :3002    │
   │ auth pattern│  │ CRUD pattern│  │  stateless  │
   └──────┬──────┘  └──────┬──────┘  └─────────────┘
          │                │
          │     ┌──────────┘
          │     │
   ┌──────▼─────▼─────┐     ┌──────────────┐
   │  event-server    │────►│message-server│
   │     :3005        │     │    :3003     │
   │ event bus pat.   │     │ worker pat.  │
   └──────────────────┘     └──────────────┘
```

| Service | Pattern | Port |
|---------|---------|------|
| [auth-server](https://github.com/fwmakc/auth-server) | Auth: JWT/JWKS, SSO, event-driven lifecycle | 3001 |
| [api-server](https://github.com/fwmakc/api-server) | Domain CRUD: EntityController, access levels | 5000 |
| [file-server](https://github.com/fwmakc/file-server) | Stateless: uploads, image processing, no DB | 3002 |
| [event-server](https://github.com/fwmakc/event-server) | Event bus: pluggable transport, typed contracts | 3005 |
| [message-server](https://github.com/fwmakc/message-server) | Background worker: queue, retry, templates | 3003 |
| [chat-server](https://github.com/fwmakc/chat-server) | Realtime: WebSocket, Redis adapter (stub) | 3004 |
| [scaffold](https://github.com/fwmakc/scaffold) | Template: 5-min bootstrap | — |

## When to Use This Stack

**Use it if:**

- You need microservices from day one and want a working reference, not a blank NestJS project
- You want to study a real NestJS microservices codebase with auth, event bus, and CRUD patterns
- You need a prototype/MVP with registration, CRUD API, and event-driven email "right now"
- You're building a product that will grow — start with the toolkit in a monolith, split when needed

**Consider alternatives if:**

- You need multi-tenancy (`tenant_id` scoping) — requires forking the toolkit
- You need >1000 events/sec — switch the event bus to Kafka (the `IEventClient` interface supports this)
- You want a community-supported framework with paid support — this is a fork-first codebase

See [toolkit Limitations](https://github.com/fwmakc/api-server-toolkit#limitations) and
[FAQ](https://github.com/fwmakc/api-server-toolkit#faq-addressing-common-concerns) for details.

## FAQ: Addressing Common Concerns

### "Single maintainer — what if you stop?"

Fork-first codebase. You own the code from day one — no SaaS dependency, no API
key to revoke. The toolkit ships with 111 tests and full type declarations.
Forking is the enterprise pattern (internal Spring forks, Keycloak forks).

### "Only `isSuperuser` for admin?"

Set `SUPERUSER_FIELD=role` and `SUPERUSER_VALUE=admin` in your `.env`. Works with any
JWT field and value(s). For full RBAC, add `@UseGuards(RbacGuard)` — the 5
access levels are CRUD presets, not a security model. See
[toolkit FAQ](https://github.com/fwmakc/api-server-toolkit#faq-addressing-common-concerns).

### "Hardcoded to `account` table?"

Set `OWNER_TABLE=user` in your `.env`. All ownership queries, bind scoping, and
field security use your table name — no per-controller overrides needed.

### "B2B SaaS with multi-tenancy?"

Multi-tenancy requires a fork, but the fork touches 5-7 files. You inherit
CRUD generation, Swagger, relations, and field security — you only build the
tenant layer. See [toolkit Scenario 3](https://github.com/fwmakc/api-server-toolkit#scenario-3-completely-custom-identity-model-fork-required).

### "Microservices overhead at the start?"

`docker compose up -d` — one command. Or use just api-server + toolkit as a
monolith. `EntityController` works identically in a single process. Split into
microservices when you need to, not before.

### "HTTP webhooks instead of Kafka?"

`IEventClient` is transport-agnostic. `HttpEventClient` needs no broker — zero
ops overhead. When you need Kafka throughput, implement `KafkaEventClient` —
services don't change. The event-server is an abstraction layer, not a
replacement for your message queue.

## Docker Compose

### Structure

- `docker-compose.yml` — production services (nginx, auth, event, api, file, message, postgres)
- `docker-compose.override.yml` — dev additions (MailHog, Redis, chat-server, PostgreSQL port, DB_SYNCHRONIZE=true)

Docker Compose auto-merges both files. For production:
```bash
docker compose -f docker-compose.yml up -d --build
```

### Networks

| Network | Services |
|---------|----------|
| `frontend` | nginx ↔ app services |
| `backend` | app services ↔ postgres |

Nginx is on `frontend` only. PostgreSQL is on `backend` only. App services are on both.

### Healthchecks

All services have healthchecks (`/health` endpoint). `depends_on` uses
`condition: service_healthy` to ensure correct startup order.

### Build context

All Dockerfiles use parent context (`context: ..`). The toolkit and event-server contracts
are copied locally during build — no GitHub fetch needed.

## Architecture

```
                         ┌──────────┐
                         │  nginx   │ :80
                         │ gateway  │
                         └────┬─────┘
           ┌─────────────────┼──────────────────┐
           │                 │                  │
    ┌──────▼──────┐  ┌───────▼───────┐  ┌──────▼──────┐
    │ auth-server │  │  api-server   │  │   optional  │
    │    :3001    │  │     :5000     │  │ file/msg/chat│
    └──────┬──────┘  └───────┬───────┘  └─────────────┘
           │                 │
           │     ┌───────────┘
           │     │
    ┌──────▼─────▼──┐
    │ event-server  │ :3005 (internal, not proxied by nginx)
    │ webhook broker│
    └──────┬────────┘
           │
    ┌──────▼──────┐
    │  postgres   │ :5432
    │  redis :6379│
    └─────────────┘
```

### Repository Map

| Repo | Role | Port | CI |
|------|------|------|----|
| [`gateway-server`](.) | nginx reverse proxy + docker-compose | 80 | — |
| [`auth-server`](https://github.com/fwmakc/auth-server) | OAuth2, JWT (RS256), JWKS, social SSO | 3001 | [![Tests](https://github.com/fwmakc/auth-server/actions/workflows/test.yml/badge.svg)](https://github.com/fwmakc/auth-server/actions/workflows/test.yml) |
| [`event-server`](https://github.com/fwmakc/event-server) | Webhook-based pub/sub event broker | 3005 | [![Tests](https://github.com/fwmakc/event-server/actions/workflows/test.yml/badge.svg)](https://github.com/fwmakc/event-server/actions/workflows/test.yml) |
| [`api-server-toolkit`](https://github.com/fwmakc/api-server-toolkit) | CRUD engine, guards, decorators, bootstrap(), HealthModule | — | — |
| [`scaffold`](https://github.com/fwmakc/scaffold) | Minimal template for new services (9-line main.ts) | — | — |
| [`api-server`](https://github.com/fwmakc/api-server) | Domain CRUD entities (reference: persons, posts) | 5000 | [![Tests](https://github.com/fwmakc/api-server/actions/workflows/test.yml/badge.svg)](https://github.com/fwmakc/api-server/actions/workflows/test.yml) |
| [`file-server`](https://github.com/fwmakc/file-server) | File upload, image resize | 3002 | — |
| [`message-server`](https://github.com/fwmakc/message-server) | Email notifications (subscribes to events) | 3003 | — |
| [`chat-server`](https://github.com/fwmakc/chat-server) | WebSocket chat (Socket.IO) | 3004 | — |

### Core vs Domain

**Core** — stable infrastructure, doesn't change between projects:
- `auth-server` — OAuth2 provider, JWT signing (RS256 with auto-generated keys), social SSO (Google, Leader-ID, UNTI/2030)
- `event-server` — central event broker. Services publish events via HTTP; subscribers register webhook URLs and receive deliveries with retry + exponential backoff
- `api-server-toolkit` — npm package: auto-generating CRUD controllers, access control guards, column factories, Swagger docs
- `gateway-server` — nginx routing, rate limiting, CORS, WebSocket support

**Domain** — clone per project:
- `api-server` — defines project-specific entities. The reference implementation includes `persons`, `posts`, `categories`, `tags`. Replace these with your own

**Optional** — enable as needed:
- `file-server` — file upload + resize
- `message-server` — email sending, subscribes to event-server webhooks
- `chat-server` — real-time chat via Socket.IO (requires Redis for multi-instance adapter)

## Event Flow

Event-server replaces the old Redis Streams event bus with a webhook-based approach:

```
auth-server                    event-server                   message-server
    │                               │                               │
    │  POST /events                 │                               │
    │  { pattern: "user.registered",│                               │
    │    payload: {...} }           │                               │
    │ ────────────────────────────► │                               │
    │                               │  stores Event +               │
    │                               │  creates Deliveries           │
    │                               │  for all Subscribers          │
    │                               │                               │
    │                               │  worker picks up Delivery     │
    │                               │  POST /webhooks/events        │
    │                               │ ────────────────────────────► │
    │                               │                               │
    │                               │  ◄── 200 OK ───────────────── │
    │                               │  marks Delivery delivered     │
```

- **Publish**: any service sends `POST /events` to event-server with `{ pattern, payload, source }`
- **Subscribe**: services register `POST /subscribe` with a webhook URL and event patterns
- **Delivery**: event-server's background worker delivers via HTTP in parallel, with retry (exponential backoff) and circuit breaker (auto-deactivates subscribers after repeated permanent failures)

## Access Control Model

Five independent restriction levels per CRUD operation. Each operation (create, read, update, delete) gets its **own** level — they are configured independently and are **not cumulative**.

| Level | Authentication | Row scoping |
|-------|---------------|-------------|
| `public` | Token optional | None |
| `account` | Token required (401) | None — sees all records |
| `owner` | Token required (401) | `WHERE account.id = caller.id` |
| `admin` | Token required (401) | 403 if `!isSuperuser` |
| `closed` | Route not generated | — |

**Full documentation**: [api-server-toolkit/README.md — Access Control Model](https://github.com/fwmakc/api-server-toolkit/blob/master/README.md#access-control-model)

Quick example:

```typescript
@EntityController({
  name: "posts",
  dto: PostDto,
  entity: PostEntity,
  operations: {
    create: "account",
    read: "public",
    update: "owner",
    delete: "superuser",
  },
})
```

## api-server-toolkit

The shared npm package provides auto-generating CRUD controllers with per-operation access control, Swagger docs, and TypeORM row-level security.

**Full API reference**: [api-server-toolkit/README.md](https://github.com/fwmakc/api-server-toolkit/blob/master/README.md)

Key exports: `EntityController`, `CommonService`, `CommonDto`, `Account()`, `Self()`, `FieldAccess`, column factories, `PermissionRegistry`.

Installed as `github:fwmakc/api-server-toolkit#v0.9.0`. In the monorepo Docker setup, Dockerfiles override the npm-installed version with local source from `api-server-toolkit/dist/` + `/src/`.

## Nginx Routing

| Path | Service |
|------|---------|
| `/account`, `/token`, `/auth`, `/.well-known` | auth-server |
| `/swagger`, `/redoc` | auth-server |
| `/files`, `/uploads` | file-server |
| `/mail` | message-server |
| `/socket.io/` | chat-server (WebSocket upgrade) |
| Everything else (`/`) | api-server |

Rate limiting: auth endpoints 5 req/s, API endpoints 10 req/s.

## Quick Start

### Prerequisites

- Docker + Docker Compose
- All repos cloned as sibling directories:
  ```
  servers/
    gateway-server/  ← you are here
    auth-server/
    api-server/
    event-server/
    api-server-toolkit/
    scaffold/          (template for new services)
    file-server/       (optional)
    message-server/    (optional)
    chat-server/       (optional, dev only)
  ```
  See `clone-all.ps1` / `clone-all.sh` to clone everything in one command.

### Run (development)

```bash
cp .env.example .env

# Start everything (includes MailHog, Redis, chat-server via auto-merged override)
docker compose up -d --build

# Or start only core services
docker compose up -d nginx auth-server event-server api-server postgres
```

Services at `http://localhost` (port 80).
MailHog web UI at `http://localhost:8025`.
PostgreSQL at `localhost:5432`.

### Run (production)

```bash
docker compose -f docker-compose.yml up -d --build
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERNAL_API_KEY` | `changeme` | Shared key for service-to-service auth |
| `SESSION_SECRET` | `dev-session-secret` | Session encryption key |
| `LEADER_CLIENT_ID` | `dummy-client-id` | Leader-ID OAuth |
| `UNTI_CLIENT_ID` | `dummy-client-id` | UNTI/2035 OAuth |
| `GOOGLE_CLIENT_ID` | `dummy-client-id` | Google OAuth |

## Infrastructure

### PostgreSQL 16

User: `root` / Password: `${DB_PASSWORD:-1234}` (override in `.env`)

Databases (auto-created by `init-databases.sh`):

| Database | Used by |
|----------|---------|
| `auth_server` | auth-server |
| `api_server` | api-server |
| `event_server` | event-server |
| `message_server` | message-server |

Port `5432` exposed in dev override only.

### Redis 7

Dev override only. Used by chat-server (Socket.IO adapter).

### MailHog

Dev override only. SMTP on `:1025`, web UI on `:8025`.

## AI-friendly documentation

Each service has auto-generated AI context files:
- `ai-context.md` — structured reference (controllers, routes, services, entities, DTOs)
- Swagger UI at `/swagger` — interactive API exploration
- ReDoc at `/redoc` — readable API documentation

Run `npm run ai-context` in any service to regenerate.

## Starting a New Project

### Option A: Clone the scaffold (recommended for new microservices)

1. **Clone scaffold:**
   ```bash
   git clone https://github.com/fwmakc/scaffold.git my-service
   cd my-service
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Add your entities and modules** in `src/`:
   ```
   src/
     main.ts           # 9 lines — uses bootstrap() from toolkit
     app.module.ts     # HealthModule.forRoot("my-service") + your modules
     products/
       products.entity.ts
       products.dto.ts
       products.controller.ts
   ```

4. **Add to `docker-compose.yml`** in gateway-server, then:
   ```bash
   docker compose up -d --build my-service
   ```

### Option B: Clone api-server (for replacing the main CRUD API)

1. **Clone api-server:**
   ```bash
   git clone https://github.com/fwmakc/api-server.git my-project-server
   ```

2. **Replace domain entities** in `src/db/` with your own

3. **Register modules** in `src/app.imports.ts`

4. **Update `docker-compose.yml`** in gateway

### What's in the scaffold

The scaffold uses `bootstrap()` from `api-server-toolkit` — a shared startup function
that handles Sentry, helmet, ValidationPipe, Swagger, graceful shutdown, and more.
Each service's `main.ts` is ~10 lines instead of ~100+:

```typescript
import { bootstrap } from "api-server-toolkit/bootstrap";
import { AppModule } from "@src/app.module";

bootstrap({
  module: AppModule,
  serviceName: "my-service",
  cors: true,
});
```

`HealthModule` provides `GET /health` out of the box — no boilerplate needed.

## Standalone Mode (Monolith)

You can run **api-server alone** without auth-server, event-server, or any other service.
This is useful for prototyping, testing, or when you simply need a CRUD API without authentication.

### How it works

The CRUD engine's access control has five levels. In standalone mode:

| Access level | Works standalone? | Why |
|---|---|---|
| `public` | **Yes** | Token optional — `JwtPublicGuard` ignores missing/invalid tokens |
| `account` | No (401) | Requires valid JWT signed by auth-server |
| `owner` | No (401) | Same — needs JWT to identify the owner |
| `admin` | No (401) | Same — needs JWT + `isSuperuser` |
| `closed` | N/A | Route not generated |

### Quick start (standalone)

```bash
git clone https://github.com/fwmakc/api-server.git
cd api-server
npm install

# Minimal .env — only database needed
cat > .env <<EOF
NODE_ENV=development
PORT=5000
IP=localhost
DB_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_NAME=api_server
DB_USER=root
DB_PASSWORD=1234
DB_SYNCHRONIZE=true
SWAGGER_PREFIX=swagger
EOF

npm run dev
```

Swagger UI at `http://localhost:5000/swagger`.
Health check at `http://localhost:5000/health`.

### Define public entities

```typescript
@EntityController({
  name: "products",
  dto: ProductDto,
  entity: ProductEntity,
  operations: {
    create: "public",   // No auth needed
    read: "public",
    update: "public",
    delete: "public",
  },
})
```

### Add auth later

When you're ready for authentication:

1. Start auth-server:
   ```bash
   docker compose up -d auth-server
   ```

2. Add to api-server `.env`:
   ```env
   AUTH_SERVER_URL=http://auth-server:3001
   ```

3. Change access levels from `public` to `account`/`owner`/`admin` as needed.

No code changes required — just configuration.

## Backend-Only — Bring Your Own Frontend

This stack provides the **complete backend** — auth, CRUD, events, files, email.
No frontend included, by design.

All APIs are REST + JSON, fully documented via Swagger/ReDoc. Build your
frontend in React, Vue, Next.js, Nuxt, React Native, Flutter — anything
that speaks HTTP. The auth flow is standard OAuth2, so any OAuth2 client
library works.

You get a production-ready backend without the pain of wiring it up yourself:
no weeks spent configuring auth, setting up CRUD patterns, building event
delivery, or wiring Docker Compose. Clone, customize the domain entities,
deploy.

## Testing

Each service has its own test suite run via GitHub Actions CI:

| Service | Tests | Command |
|---------|-------|---------|
| api-server-toolkit | 111 | `npm test` (8 suites: guards, pipes, search, http, etc.) |
| auth-server | 41 | `npm test` (cross-env TZ=UTC jest --runInBand) |
| api-server | 368 | `npm test` (jest --runInBand) |
| event-server | 33 | `npm test` (5 suites: events, subscribers, delivery, worker, auth) |
| message-server | 33 | `npm test` (5 suites: webhooks, mail, queue, worker, subscriber) |
| file-server | 52 | `npm test` (7 suites: handlers, service, orchestrator) |

Tests use real PostgreSQL (not mocked) with `dropSchema: true` + `synchronize: true` for clean state.

---

## Versioning

All services in the fwmakc stack share the same **major version**. Same major = guaranteed compatibility.

| Level | Scope | Example |
|-------|-------|---------|
| **Major** | Shared across ALL services. A breaking change in any service bumps the major for everyone. | toolkit 2.x → 3.0.0 ⟹ all services tag v3.0.0 |
| **Minor** | Independent per service. New features (additive). | auth-server 2.1.0 → 2.2.0 |
| **Patch** | Independent per service. Bug fixes. | event-server 2.0.0 → 2.0.1 |

### What triggers a major bump

A breaking change at any intersection point:

- **api-server-toolkit** — guards, columns, decorators, EntityController, bootstrap, services
- **event-server contracts** — DTO field removed/renamed, required field added
- **Inter-service API** — JWT claim format, `X-Internal-Api-Key` scheme, webhook contract
- **Public API** — any endpoint that another service depends on

### What does NOT trigger a major bump

- Bug fixes, performance improvements
- New features (additive — new optional fields, new endpoints)
- Internal refactoring that doesn't change interfaces

### Alignment process

When a service makes a breaking change (e.g., toolkit 2.x → 3.0.0):

1. The changing service bumps its major and tags the release
2. **All other services** get a stack alignment commit:
   - Bump `version` in `package.json`
   - Add CHANGELOG entry: `chore: stack v3 alignment`
   - Update dependency pins if needed
   - Tag `v3.0.0`
3. All services are now on stack v3

### Current versions

| Service | Version |
|---------|---------|
| [api-server-toolkit](https://github.com/fwmakc/api-server-toolkit) | v0.9.0 |
| [event-server](https://github.com/fwmakc/event-server) | v0.5.0 |
| [auth-server](https://github.com/fwmakc/auth-server) | v0.5.0 |
| [message-server](https://github.com/fwmakc/message-server) | v0.4.0 |
| [file-server](https://github.com/fwmakc/file-server) | v0.4.0 |
| [chat-server](https://github.com/fwmakc/chat-server) | v0.1.0 |
| [api-server](https://github.com/fwmakc/api-server) | v0.5.0 |
| [gateway-server](https://github.com/fwmakc/gateway-server) | v0.3.0 |
| [scaffold](https://github.com/fwmakc/scaffold) | v0.1.0 |
