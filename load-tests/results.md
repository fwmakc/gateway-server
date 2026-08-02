# Load Test Results

**Date:** 2026-08-03
**Environment:** Docker (local), Node.js 22-alpine, PostgreSQL 16-alpine
**Test Data:** 200 posts, 10 categories, 30 tags, 5 accounts, 928 post-tag links

---

## Summary

| Test | Requests | req/s | avg | p(95) | Failures |
|------|----------|-------|-----|-------|----------|
| Query Matrix (6 scenarios) | 5,173 | 59.4 | 10.4ms | 19.9ms | 0% |
| Mixed Workload (20 VUs) | 7,063 | 128.7 | 7.1ms | 13.2ms | 4.9%* |
| Event Publish | 490 | 17.8 | 6.9ms | 9.5ms | 0% |
| Auth Register | 342 | 12.3 | 189.6ms | 394.3ms | 50%** |
| Auth Login | 2,094 | 76.6 | 42.9ms | 256.6ms | 50%** |

\* Write attempts (5% of traffic) returned 401 (expected — no JWT in test).
\*\* Auth endpoints respond correctly, but server-side redirects to frontend URLs fail without nginx.

---

## 1. API Query Matrix (`api-query-matrix.js`)

6 scenarios × 10 VUs × 15s each. Tests light/medium/heavy queries with batch loading (`join=false`) vs SQL JOIN (`join=true`).

### Overall

| Metric | Value |
|--------|-------|
| Total requests | 5,173 |
| Throughput | 59.4 req/s |
| Avg latency | 10.39ms |
| Median | 8.52ms |
| p(90) | 16.49ms |
| p(95) | 19.87ms |
| Max | 1.82s (cold start spike) |
| Failure rate | 0% |
| Data received | 113 MB (1.3 MB/s) |

### Scenario Breakdown

Each scenario ran 10 concurrent VUs for 15 seconds.

| Scenario | Query | Limit | Relations | Filter |
|----------|-------|-------|-----------|--------|
| light_batch | Simple list | 10 | None | None |
| light_join | Simple list + JOIN | 10 | None | None |
| medium_batch | List + relations | 20 | tags, category, account | None |
| medium_join | List + relations + JOIN | 20 | tags, category, account | None |
| heavy_batch | Filtered + relations + sort | 50 | tags, category, account | `isPublished=1`, `viewCount DESC` |
| heavy_join | Filtered + relations + JOIN + sort | 50 | tags, category, account | `isPublished=1`, `viewCount DESC` |

### Key Finding: Batch Loading vs SQL JOIN

With 200 rows and 3 relation endpoints (tags M:N, category M:1, account M:1):

- **Batch loading (default):** Separate queries per relation type, results merged in app memory. Faster for small result sets — avoids JOIN row multiplication.
- **SQL JOIN (`join=true`):** Single query with JOINs. Comparable performance at this scale.

At 10 VUs, both modes maintained sub-20ms p(95). The framework defaults to batch loading, which avoids Cartesian product issues with multiple M:N relations.

---

## 2. Mixed Workload (`api-mixed-workload.js`)

20 VUs for 60 seconds. Realistic traffic distribution.

### Traffic Distribution

| Pattern | % | Description |
|---------|---|-------------|
| Light | 60% | List posts (5-25 items, no relations) |
| Medium | 25% | List with relations (10-30 items) |
| Heavy | 10% | Filtered + relations + sort (50 items) |
| Write | 5% | Create post (requires JWT → 401) |

### Results

| Metric | Value |
|--------|-------|
| Total requests | 7,063 |
| Throughput | 128.7 req/s |
| Avg latency | 7.11ms |
| Median | 4.15ms |
| p(90) | 10.62ms |
| p(95) | 13.24ms |
| Max | 1.83s |
| Write attempts | 349 (all 401 — expected) |
| p(95) threshold | < 500ms ✓ |

---

## 3. Event Publish (`event-publish.js`)

5 VUs for 30 seconds. Publishes events via internal API.

### Results

| Metric | Value |
|--------|-------|
| Total requests | 490 |
| Throughput | 17.8 req/s |
| Avg latency | 6.92ms |
| Median | 6.36ms |
| p(90) | 8.68ms |
| p(95) | 9.54ms |
| Max | 53.03ms |
| Failure rate | 0% |

---

## 4. Auth Endpoints (`auth-register.js`, `auth-login.js`)

### Registration (`POST /account/register`)

5 VUs for 30 seconds. Each iteration registers a unique email.

| Metric | Value |
|--------|-------|
| Total requests | 342 (171 initial + 171 redirects) |
| Endpoint latency | ~190ms avg (includes DB write + event publish) |
| Failure rate | 50% (redirect half fails — see note) |

### Login (`POST /account/login`)

10 VUs for 30 seconds. Tests with invalid credentials.

| Metric | Value |
|--------|-------|
| Total requests | 2,094 (1,047 initial + 1,047 redirects) |
| Endpoint latency | ~3ms avg (fast rejection) |
| Failure rate | 50% (redirect half fails — see note) |

### Note on Auth Test Limitations

The auth-server issues HTTP redirects to frontend URLs (`FORM_REGISTER_COMPLETE`, `FORM_LOGIN`) after processing auth requests. In the load test environment, nginx is not running, so the redirect target (`http://localhost/...`) returns connection refused. The auth endpoints themselves respond correctly — the 50% failure rate is from the redirect chain, not the auth logic.

To get clean auth metrics, either:
1. Start the nginx container (`docker compose up nginx`)
2. Set `FORM_*` env vars to `http://auth-server:3001/...` (loopback)
3. Test only the initial endpoint response (ignore redirects)

---

## Test Configuration

### Infrastructure

| Component | Version |
|-----------|---------|
| Node.js | 22-alpine |
| PostgreSQL | 16-alpine |
| NestJS | 11.x |
| TypeORM | 0.3.x |
| k6 | latest (Docker) |
| Docker network | `gateway-server_backend` |

### Running the Tests

```bash
# Start the stack
docker compose up -d postgres auth-server event-server api-server message-server mailhog

# Seed test data
cat load-tests/seed.sql | docker exec -i gateway-server-postgres-1 psql -U root -d api_server
cat load-tests/seed-tags.sql | docker exec -i gateway-server-postgres-1 psql -U root -d api_server

# Run a test
docker run --rm --network gateway-server_backend \
  -v ./load-tests:/scripts \
  grafana/k6 run --quiet /scripts/api-query-matrix.js
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `API_URL` | `http://api-server:5000` | API server URL |
| `AUTH_URL` | `http://auth-server:3001` | Auth server URL |
| `EVENT_URL` | `http://event-server:3005` | Event server URL |
| `INTERNAL_API_KEY` | `changeme` | Internal API key for service-to-service |
