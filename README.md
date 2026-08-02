# Gateway Server

> Nginx reverse proxy + Docker Compose orchestration for the microservices stack.

See the [root README](https://github.com/fwmakc/gateway-server#readme) for the full
architecture overview, service map, and design decisions.

## Docker Compose

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
    delete: "admin",
  },
})
```

## api-server-toolkit

The shared npm package provides auto-generating CRUD controllers with per-operation access control, Swagger docs, and TypeORM row-level security.

**Full API reference**: [api-server-toolkit/README.md](https://github.com/fwmakc/api-server-toolkit/blob/master/README.md)

Key exports: `EntityController`, `CommonService`, `CommonDto`, `Account()`, `Self()`, `FieldAccess`, column factories, `PermissionRegistry`.

Installed as `github:fwmakc/api-server-toolkit#v2.1.0`. In the monorepo Docker setup, Dockerfiles override the npm-installed version with local source from `api-server-toolkit/dist/` + `/src/`.

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
