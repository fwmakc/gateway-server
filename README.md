# Gateway — Nginx Reverse Proxy + Docker Compose

Single entry point (port 80) for the microservices stack. Path-based routing, rate limiting, CORS, WebSocket support.

## Architecture: Core + Domain

```
CORE (stable, shared across projects)
  auth-server/     OAuth2, JWT/JWKS, social login
  shared/          @core/common (CRUD engine, guards, event bus)
  gateway/         this repo (nginx + docker-compose)

DOMAIN (clone per project)
  api-server/      CRUD entities (persons, posts, settings, ...)

OPTIONAL (enable as needed)
  file-server/     file upload + resize
  message-server/  email + notifications
  chat-server/     WebSocket chat
```

### Core vs Domain

**Core services** are stable infrastructure. They don't change between projects:
- `auth-server` — OAuth2 provider, JWT signing (RS256), social SSO
- `shared` — `@core/common` npm package: CRUD base classes, decorators, guards, event bus
- `gateway` — nginx routing + docker-compose orchestration

**Domain service** is the project-specific part. Clone `api-server` for each new project:
- Replace entities in `src/db/` with your own
- Entities like `persons`, `posts`, `categories`, `tags` serve as reference examples
- Infrastructure (JWT verification, DB config, Swagger, Sentry) stays the same

## Routing

| Path | Service | Port |
|------|---------|------|
| `/account`, `/token`, `/auth`, `/.well-known` | auth-server | 3001 |
| `/files`, `/uploads` | file-server | 3002 |
| `/mail` | message-server | 3003 |
| `/socket.io/` | chat-server | 3004 |
| Everything else | api-server | 5000 |

## Usage

```bash
# Start all services
docker compose up -d

# Start only core + domain (no optional services)
docker compose up -d nginx auth-server api-server postgres redis

# View logs
docker compose logs -f api-server

# Stop
docker compose down
```

## Starting a New Project

1. Clone `api-server` repo and rename it:
   ```bash
   git clone https://github.com/fwmakc/api-server.git my-project-server
   ```

2. Update `docker-compose.yml` in gateway:
   - Rename `api-server` service to `my-project-server`
   - Update build context and dockerfile path
   - Uncomment optional services if needed

3. Add your entities in `src/db/`:
   ```
   src/db/
     products/
       products.entity.ts
       products.dto.ts
       products.service.ts
       products.controller.ts
   ```

4. Register modules in `src/app.imports.ts`

5. `docker compose up -d`

## Infrastructure

- **PostgreSQL 16** (port 5432) — two databases: `auth_server` + `api_server`
- **Redis 7** (port 6379) — event bus + job queues

## Environment Variables

See `.env.example` for all supported variables. Key ones:

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_SECRET` | `dev-session-secret` | Session encryption key |
| `INTERNAL_API_KEY` | `changeme` | Inter-service HTTP auth |
| `LEADER_CLIENT_ID` | `dummy-client-id` | Leader-ID OAuth |
| `GOOGLE_CLIENT_ID` | `dummy-client-id` | Google OAuth |
| `UNTI_CLIENT_ID` | `dummy-client-id` | UNTI/2035 OAuth |
