# Gateway — Nginx Reverse Proxy + Docker Compose

Path-based routing to all microservices. Single entry point (port 80).

## Routing

| Path | Service | Port |
|------|---------|------|
| `/account`, `/token`, `/auth`, `/.well-known` | auth-server | 3001 |
| `/files`, `/uploads` | file-server | 3002 |
| `/mail` | message-server | 3003 |
| `/socket.io/` | chat-server | 3004 |
| Everything else | api-server | 5000 |

## Features

- **Rate limiting**: 5 req/s for auth endpoints, 10 req/s for general API
- **CORS**: per-origin with credentials, preflight handling
- **WebSocket**: `/socket.io/` proxied with Upgrade headers
- **Large uploads**: 50MB max body for `/files` and `/uploads`

## Usage

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f nginx

# Stop
docker-compose down
```

## Services

Each service has its own directory with Dockerfile (TODO):
- `../auth-server/` — OAuth2 authorization server
- `../api-server/` — Core CRUD API
- `../file-server/` — File upload and processing
- `../message-server/` — Email and notifications
- `../chat-server/` — WebSocket chat

## Infrastructure

- **PostgreSQL** (port 5432) — shared database
- **Redis** (port 6379) — event bus + job queues (Stage 9)
