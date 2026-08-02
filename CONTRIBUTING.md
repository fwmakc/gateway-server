# Contributing to gateway-server

Thanks for your interest in contributing! This is the orchestration layer for
the [fwmakc microservices stack](https://github.com/fwmakc/gateway-server).

## What This Repo Contains

- `docker-compose.yml` — all 7 services + PostgreSQL + Redis + Nginx
- `docker-compose.override.yml` — dev-only overrides (chat-server, debug ports)
- `nginx.conf` / `proxy.conf` — reverse proxy configuration
- `init-databases.sh` — creates per-service PostgreSQL databases on first run
- `clone-all.ps1` / `clone-all.sh` — clone all 9 repos as sibling directories

## Development Setup

```bash
git clone https://github.com/fwmakc/gateway-server.git
cd gateway-server
cp .env.example .env
# Edit .env: set DB_PASSWORD, INTERNAL_API_KEY, JWT keys, SMTP, OAuth secrets
docker compose up -d
```

All services available via Nginx on port **80**.

### Backend-only (without Docker)

To run services locally without Docker:

```bash
# Clone all repos side by side:
./clone-all.sh   # or ./clone-all.ps1 on Windows

# Start infrastructure only:
docker compose up -d postgres redis

# Run each service in its own terminal:
cd auth-server && npm run dev
cd event-server && npm run dev
# etc.
```

## Running Tests

Each service has its own test suite:

```bash
# From any service directory:
npm test
```

| Service | Tests |
|---------|-------|
| api-server-toolkit | 111 |
| auth-server | 41 |
| api-server | 368 |
| event-server | 33 |
| message-server | 33 |
| file-server | 52 |

## Code Style

- YAML for Docker Compose (2-space indent)
- Nginx config follows standard conventions
- Shell scripts use `set -e` for fail-fast

## Pull Request Process

1. Fork the repo, create a branch from `master`
2. Make your changes
3. Test with `docker compose up -d --build`
4. Verify all services start and health checks pass
5. Create a pull request with a clear description
