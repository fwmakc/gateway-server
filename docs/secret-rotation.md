# Secret rotation runbook

All secrets in the stack are rotatable without downtime. The mechanisms are
built in (toolkit 0.25.0 / auth-server 0.11.0); this document is the procedure.
General shape of every rotation: **introduce the new secret alongside the old
one → move the callers/data → retire the old secret.** Never delete the old
secret in the same step that introduces the new one.

## 1. JWT signing keys (RS256)

Tokens carry a `kid` header; auth-server signs with the current pair and
verifies tokens against the current key **plus** every key listed in
`JWT_PREVIOUS_PUBLIC_KEY_PATHS` (those keys are also published in
`/.well-known/jwks.json`, so api/file/message verify old tokens through the
same JWKS — no consumer changes needed).

```
cd gateway-server

# 1. Generate a new pair, keep the retired public key in the volume
./scripts/rotate-jwt-keys.sh

# 2. Overlap window: retired key stays verifiable
echo 'JWT_PREVIOUS_PUBLIC_KEY_PATHS=/keys/jwt-public-retired.pem' >> .env
docker compose up -d auth-server

# 3. Verify: JWKS lists two keys; tokens issued before rotation still work
curl -s http://localhost:8080/auth/.well-known/jwks.json | jq '.keys | length'

# 4. After max access-token TTL (default 15m) + buffer:
#    remove JWT_PREVIOUS_PUBLIC_KEY_PATHS from .env, then
docker compose up -d auth-server
./scripts/rotate-jwt-keys.sh --cleanup
```

Notes:
- Refresh tokens are opaque DB rows — unaffected by key rotation; sessions
  survive. Only outstanding access tokens (≤ 15 min) need the overlap window.
- auth-server fails fast at boot if a listed previous-key file is missing —
  fix or remove the env, do not ignore.
- Ephemeral-key fallback (no key files): every restart invalidates all
  tokens. If you are in that state, just set up the `auth-keys` job/keys —
  rotation procedures assume persistent keys.

## 2. AES key (2FA secrets, OAuth tokens)

Envelopes are versioned: `{ v, encrypted, iv }` (rows written before the
mechanism have no `v` = version 1). New writes use the **highest configured**
key version; decryption dispatches on the stored version. Old-key rows
decrypt transparently — the system works mid-rotation without a big-bang
migration.

```
# 1. Generate the next version and pass it to auth-server
echo "AES_SECRET_V2=$(openssl rand -hex 32)" >> .env
docker compose up -d auth-server

# 2. Dry run — shows how many envelopes would be re-encrypted
docker compose exec auth-server node scripts/reencrypt-aes.mjs

# 3. Apply (idempotent; safe to re-run)
docker compose exec auth-server node scripts/reencrypt-aes.mjs --apply

# 4. When every table reports 0 remaining v:1 rows and 0 failed:
#    remove AES_SECRET from .env (keep AES_SECRET_V2) and restart auth
docker compose up -d auth-server
```

Notes:
- The script covers `account_strategies.access_token/refresh_token` and
  `account_two_factor.secret`. If a row's key version is not configured the
  run reports it as failed and exits 1 — **do not retire the old key** until
  it reports clean.
- Failures after retiring the old key look like
  `AES key version 1 is not configured (AES_SECRET is missing)` — restore the
  env and re-run the script.
- Rolling to v3 later: same procedure with `AES_SECRET_V3`, keep `V2` for the
  overlap, etc.

## 3. Internal API key (service-to-service)

Every service validates `X-Internal-Api-Key` against `INTERNAL_API_KEY`,
plus the optional `INTERNAL_API_KEY_PREVIOUS` (comma-separated) rotation
window. Callers send one key; validators accept either during the window.

```
# 1. Generate the new key; keep the old one for the window
NEW=$(openssl rand -hex 32)
# .env:  INTERNAL_API_KEY=$NEW
#        INTERNAL_API_KEY_PREVIOUS=<old-key>
docker compose up -d auth-server event-server message-server file-server
# + restart whichever standalone services (api-server, …) validate the key

# 2. Move callers: any client that SENDS X-Internal-Api-Key switches to $NEW
#    (external scripts, CI jobs, api-server in its own deployment).

# 3. Retire: remove INTERNAL_API_KEY_PREVIOUS from .env and restart.
```

During the window both keys pass validation; after removal only the current
one does.

## 4. External API keys (`API_KEYS`)

Already a comma-separated list with per-key constant-time comparison —
rotation is purely additive: append the new key, hand it out, then remove the
old entry from the list and restart. No overlap env needed; the list **is**
the overlap window.

## 5. Database credentials

Postgres (single instance behind pgbouncer; all stack DBs share one role per
`DB_USER`):

```
# 1. Set the new password in Postgres
docker compose exec postgres psql -U root -c "ALTER USER root WITH PASSWORD '<new>';"

# 2. Update .env (DB_PASSWORD) — pgbouncer must see it too
#    (pgbouncer reads user/password from its userlist / env — restart it):
docker compose up -d pgbouncer

# 3. Rolling restart of the consumers (they hold pooled connections):
docker compose up -d auth-server event-server message-server file-server
```

Notes:
- Do it in a low-traffic window: step 3 drops pooled connections (brief
  request errors while replicas come back).
- pgbouncer `auth_type` must match how the password is stored — with the
  default `md5`/`scram-sha-256` config an `ALTER USER` is enough; if
  `auth_type=trust` inside the docker network, rotate anyway (defense in
  depth) but know the DB accepts the old password until Postgres itself is
  reloaded.
- Multi-user hardening (separate roles per service, `ALTER ROLE … RENAME`,
  managed Postgres rotation) is an infra decision — see PLAN.md HA item.

## What rotates automatically / what does not

| Secret | Mechanism | Downtime |
|---|---|---|
| JWT RS256 pair | `kid` + `JWT_PREVIOUS_PUBLIC_KEY_PATHS` overlap | none |
| AES (2FA, OAuth) | versioned envelopes + `reencrypt-aes.mjs` | none |
| `INTERNAL_API_KEY` | `INTERNAL_API_KEY_PREVIOUS` window | none |
| `API_KEYS` | list is the window | none |
| DB password | ALTER USER + rolling restart | seconds (connection drain) |
