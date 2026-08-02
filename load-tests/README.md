# Load Tests

k6 load test scripts for the NestJS microservices stack.

## Scripts

| Script | Target | VUs | Duration | Description |
|--------|--------|-----|----------|-------------|
| `api-query-matrix.js` | api-server | 10 per scenario | ~87s | 6 scenarios: light/medium/heavy × batch/JOIN |
| `api-mixed-workload.js` | api-server | 20 | 60s | 60% light, 25% medium, 10% heavy, 5% writes |
| `event-publish.js` | event-server | 5 | 30s | Event publishing via internal API |
| `auth-register.js` | auth-server | 5 | 30s | User registration |
| `auth-login.js` | auth-server | 10 | 30s | Login attempts (invalid credentials) |

## Prerequisites

1. Start the Docker stack:

```bash
docker compose up -d postgres auth-server event-server api-server message-server mailhog
```

2. Seed test data (200 posts, 10 categories, 30 tags, 5 accounts):

```bash
cat load-tests/seed.sql | docker exec -i gateway-server-postgres-1 psql -U root -d api_server
cat load-tests/seed-tags.sql | docker exec -i gateway-server-postgres-1 psql -U root -d api_server
```

## Running Tests

```bash
# Run from the gateway-server directory
docker run --rm --network gateway-server_backend \
  -v ./load-tests:/scripts \
  grafana/k6 run --quiet /scripts/api-query-matrix.js
```

Override service URLs for external testing:

```bash
docker run --rm --network gateway-server_backend \
  -e API_URL=http://api-server:5000 \
  -v ./load-tests:/scripts \
  grafana/k6 run /scripts/api-mixed-workload.js
```

## Results

See [results.md](./results.md) for the latest benchmark results.

## What's Being Tested

### Query Performance

The toolkit's `CommonService` supports two relation loading strategies:

- **Batch loading** (`join=false`, default): Fetches the main query first, then loads relations in separate batched queries. Avoids JOIN row multiplication.
- **SQL JOIN** (`join=true`): Uses TypeORM's relation JOIN in a single query.

The query matrix test compares both strategies across three complexity levels to identify when each approach is faster.
