# FWMAKC Microservices Stack

NestJS + TypeScript microservices architecture with a **Core + Domain** separation. Core services (auth, events, shared CRUD engine) are stable infrastructure reused across projects. Domain services (api-server) are cloned per project with custom entities.

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
| [`gateway`](.) | nginx reverse proxy + docker-compose | 80 | — |
| [`auth-server`](https://github.com/fwmakc/auth-server) | OAuth2, JWT (RS256), JWKS, social SSO | 3001 | [![Tests](https://github.com/fwmakc/auth-server/actions/workflows/test.yml/badge.svg)](https://github.com/fwmakc/auth-server/actions/workflows/test.yml) |
| [`event-server`](https://github.com/fwmakc/event-server) | Webhook-based pub/sub event broker | 3005 | [![Tests](https://github.com/fwmakc/event-server/actions/workflows/test.yml/badge.svg)](https://github.com/fwmakc/event-server/actions/workflows/test.yml) |
| [`shared`](https://github.com/fwmakc/api-server-toolkit) | `api-server-toolkit` — CRUD engine, guards, decorators | — | — |
| [`api-server`](https://github.com/fwmakc/api-server) | Domain CRUD entities (reference: persons, posts) | 5000 | [![Tests](https://github.com/fwmakc/api-server/actions/workflows/test.yml/badge.svg)](https://github.com/fwmakc/api-server/actions/workflows/test.yml) |
| [`file-server`](https://github.com/fwmakc/file-server) | File upload, image resize | 3002 | — |
| [`message-server`](https://github.com/fwmakc/message-server) | Email notifications (subscribes to events) | 3003 | — |
| [`chat-server`](https://github.com/fwmakc/chat-server) | WebSocket chat (Socket.IO) | 3004 | — |

### Core vs Domain

**Core** — stable infrastructure, doesn't change between projects:
- `auth-server` — OAuth2 provider, JWT signing (RS256 with auto-generated keys), social SSO (Google, Leader-ID, UNTI/2030)
- `event-server` — central event broker. Services publish events via HTTP; subscribers register webhook URLs and receive deliveries with retry + exponential backoff
- `shared` — `api-server-toolkit` npm package: auto-generating CRUD controllers, access control guards, column factories, Swagger docs
- `gateway` — nginx routing, rate limiting, CORS, WebSocket support

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
    │  { type: "account.registered",│                               │
    │    data: {...} }              │                               │
    │ ────────────────────────────► │                               │
    │                               │  stores Event +               │
    │                               │  creates Deliveries           │
    │                               │  for all Subscribers          │
    │                               │                               │
    │                               │  worker picks up Delivery     │
    │                               │  POST /mail (webhook)         │
    │                               │ ────────────────────────────► │
    │                               │                               │
    │                               │  ◄── 200 OK ───────────────── │
    │                               │  marks Delivery delivered     │
```

- **Publish**: any service sends `POST /events` to event-server with `{ type, data }`
- **Subscribe**: services register `POST /subscribers` with a webhook URL and event filter
- **Delivery**: event-server's background worker delivers via HTTP with retry (configurable interval, batch size, exponential backoff)

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

Installed as `github:fwmakc/api-server-toolkit#master` (auto-built via `prepare` script).

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
    gateway/      ← you are here
    auth-server/
    api-server/
    event-server/
    api-server-toolkit/
    file-server/  (optional)
    message-server/ (optional)
    chat-server/  (optional)
  ```

### Run

```bash
# Copy env
cp .env.example .env

# Start everything
docker compose up -d

# Or start only core + domain (skip optional services)
docker compose up -d nginx auth-server event-server api-server postgres

# Check status
docker compose ps

# View logs
docker compose logs -f auth-server
```

Services available at `http://localhost` (port 80).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERNAL_API_KEY` | `changeme` | Shared key for service-to-service auth |
| `SESSION_SECRET` | `dev-session-secret` | Session encryption key |
| `LEADER_CLIENT_ID` | `dummy-client-id` | Leader-ID OAuth |
| `UNTI_CLIENT_ID` | `dummy-client-id` | UNTI/2035 OAuth |
| `GOOGLE_CLIENT_ID` | `dummy-client-id` | Google OAuth |

## Infrastructure

### PostgreSQL 16 (port 5432)

User: `root` / Password: `1234`

Databases (auto-created by `init-databases.sh`):

| Database | Used by |
|----------|---------|
| `auth_server` | auth-server |
| `api_server` | api-server |
| `event_server` | event-server |
| `api_server_test` | api-server test suite |
| `api_server_http_test` | api-server HTTP access control tests |

### Redis 7 (port 6379)

Used only by chat-server (Socket.IO adapter for multi-instance). Not required if chat-server is disabled.

## Starting a New Project

1. **Clone api-server:**
   ```bash
   git clone https://github.com/fwmakc/api-server.git my-project-server
   ```

2. **Add your entities** in `src/db/`:
   ```
   src/db/
     products/
       products.entity.ts    # TypeORM entity with @Column factories
       products.dto.ts       # DTO extending CommonDto
       products.service.ts   # extends CommonService<ProductDto, ProductEntity>
       products.controller.ts # @EntityController({ ... })
   ```

3. **Register module** in `src/app.imports.ts`

4. **Update `docker-compose.yml`** in gateway:
   - Rename `api-server` service to your project name
   - Update build context and Dockerfile path

5. **Start:**
   ```bash
   docker compose up -d
   ```

## Testing

Each service has its own test suite run via GitHub Actions CI:

| Service | Tests | Command |
|---------|-------|---------|
| auth-server | 41 | `npm test` (cross-env TZ=UTC jest --runInBand) |
| api-server | 368 | `npm test` (jest --runInBand) |
| event-server | 33 | `npm test` (jest --runInBand) |

Tests use real PostgreSQL (not mocked) with `dropSchema: true` + `synchronize: true` for clean state.
