#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# E2E smoke: auth → api → event through the running stack.
#
# Verifies the full chain with one fresh user:
#   1. every service reports healthy
#   2. POST /account/methods/register        (auth → DB)
#   3. confirm code from DB → GET confirm    (auth → DB)
#   4. POST /account/methods/login           (JWT issued)
#   5. GET /account/self with the token      (JWT accepted)
#   6. GET /posts/find                       (nginx → api → DB)
#   7. user.registered / user.confirmed land in event_server.events
#
# Usage:
#   ./smoke.sh                       # through nginx: BASE=http://localhost (auth+api checked)
#   BASE=http://example.com ./smoke.sh
#   EVENT_BASE=http://localhost:3005 # optional: also health-check event/message/file directly
#   S3_SMOKE=1                       # also exercise the s3 path (presigned
#     PUT/GET + proxy upload) against FILE_BASE; requires FILE_STORAGE=s3
#   # local no-nginx run (services booted directly):
#   AUTH_BASE=http://localhost:3001 API_BASE=http://localhost:5000 \
#     EVENT_BASE=http://localhost:3005 PSQL_CMD="docker exec gateway-server-postgres-1 psql -U root" ./smoke.sh
#
# Note: designed for a single run. Re-running within a minute trips the
# register/login rate limits (3-5/min per IP — behind nginx every client
# shares nginx's IP): 429s there are the throttler working, not a failure.
# ═══════════════════════════════════════════════════════════════
set -uo pipefail

BASE="${BASE:-http://localhost}"
AUTH_BASE="${AUTH_BASE:-$BASE}"
API_BASE="${API_BASE:-$BASE}"
EMAIL="smoke_$(date +%s)_$RANDOM@test.local"
PASSWORD='SmokePass123!'
EVENT_WAIT="${EVENT_WAIT:-8}"
FAILURES=0

step()  { printf '\n== %s\n' "$*"; }
pass()  { printf '   OK  %s\n' "$*"; }
fail()  { printf '   FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
status_of() { curl -s -o /dev/null -w '%{http_code}' "$1" ${2:+-H "$2"}; }

# psql via compose postgres. Override for exotic setups, e.g.:
#   PSQL_CMD="docker exec gateway-server-postgres-1 psql -U root" ./smoke.sh
PSQL_CMD="${PSQL_CMD:-docker compose exec -T postgres psql -U root}"
psql() { $PSQL_CMD -d "$1" -t -Ac "${2:?}"; }

step "1. Health checks"
for name in auth api event message file; do
  base_var="${name^^}_BASE"          # AUTH_BASE / API_BASE / EVENT_BASE / ...
  base="${!base_var:-}"
  [ -z "$base" ] && continue         # service not part of this run
  code="$(status_of "$base/health")"
  [ "$code" = "200" ] && pass "$name /health → 200" || fail "$name /health → $code (expected 200)"
done

step "2. Register $EMAIL"
REGISTER_BODY="{\"username\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
REGISTER_RES="$(curl -s -X POST "$AUTH_BASE/account/methods/register" \
  -H 'Content-Type: application/json' -d "$REGISTER_BODY")"
echo "$REGISTER_RES" | grep -q '"success":true' && pass "register → success" || fail "register → $REGISTER_RES"

step "3. Confirm (code from auth_server DB)"
CONFIRM_CODE="$(psql auth_server "SELECT c.code FROM account_confirm c JOIN accounts a ON a.id = c.account_id WHERE a.username = '$EMAIL' AND c.type = 'code' ORDER BY c.created_at DESC LIMIT 1")"
if [ -n "$CONFIRM_CODE" ] && [ "$CONFIRM_CODE" != "NULL" ]; then
  pass "confirm code found (${#CONFIRM_CODE} chars)"
  CONFIRM_RES="$(curl -s "$AUTH_BASE/account/methods/confirm/$CONFIRM_CODE")"
  echo "$CONFIRM_RES" | grep -q '"success":true' && pass "confirm → success" || fail "confirm → $CONFIRM_RES"
else
  fail "no confirm code in account_confirm for $EMAIL"
fi

step "4. Login"
LOGIN_RES="$(curl -s -X POST "$AUTH_BASE/account/methods/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
TOKEN="$(printf '%s' "$LOGIN_RES" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] && pass "login → access_token issued" || fail "login → no access_token in response"

step "5. Authenticated request (auth /account/self)"
if [ -n "$TOKEN" ]; then
  CODE="$(status_of "$AUTH_BASE/account/self" "Authorization: Bearer $TOKEN")"
  [ "$CODE" = "200" ] && pass "/account/self with JWT → 200" || fail "/account/self with JWT → $CODE (expected 200)"
  CODE="$(status_of "$AUTH_BASE/account/self")"
  [ "$CODE" = "401" ] && pass "/account/self without JWT → 401" || fail "/account/self without JWT → $CODE (expected 401)"
else
  fail "skipped (no token)"
fi

step "6. api-server through the gateway (GET /posts/find)"
CODE="$(status_of "$API_BASE/posts/find")"
[ "$CODE" = "200" ] && pass "GET /posts/find → 200" || fail "GET /posts/find → $CODE (expected 200)"

step "7. Events recorded (event_server DB, waits ${EVENT_WAIT}s for the bus)"
sleep "$EVENT_WAIT"
REGISTERED="$(psql event_server "SELECT count(*) FROM events WHERE pattern = 'user.registered' AND payload::text LIKE '%$EMAIL%'")"
CONFIRMED="$(psql event_server "SELECT count(*) FROM events WHERE pattern = 'user.confirmed' AND payload::text LIKE '%$EMAIL%'")"
[ "${REGISTERED:-0}" -ge 1 ] && pass "user.registered for $EMAIL recorded ($REGISTERED)" || fail "user.registered for $EMAIL not found"
[ "${CONFIRMED:-0}" -ge 1 ] && pass "user.confirmed for $EMAIL recorded ($CONFIRMED)" || fail "user.confirmed for $EMAIL not found"

printf '\n════════════════════════════════════\n'
if [ "$FAILURES" -ne 0 ]; then
  echo "SMOKE FAILED — $FAILURES check(s) failed"
  exit 1
fi
echo 'SMOKE PASSED'
if [ "${S3_SMOKE:-0}" != "1" ]; then
  exit 0
fi

# ─────────────────────────────────────────────────────────────────
# S3 storage path (FILE_STORAGE=s3), S3_SMOKE=1: exercises the
# presigned PUT/GET roundtrip and the multipart proxy upload.
# ─────────────────────────────────────────────────────────────────
FILE_BASE="${FILE_BASE:-$BASE}"

step "8. File storage: s3 backend"
CODE="$(status_of "$FILE_BASE/health/storage")"
if [ "$CODE" = "200" ]; then
  STORAGE="$(curl -s "$FILE_BASE/health/storage")"
  printf '%s' "$STORAGE" | grep -q '"storage":"s3"' \
    && pass "/health/storage → s3" \
    || fail "/health/storage → $STORAGE (expected storage:s3)"
else
  fail "/health/storage → $CODE (expected 200)"
fi

if [ -z "$TOKEN" ]; then
  fail "s3 presign checks skipped (no token from step 4)"
  exit 1
fi

PAYLOAD="smoke-s3-$(date +%s)"
printf '%s' "$PAYLOAD" > "smoke_s3_$$.txt"

step "9. Presigned upload (client → bucket direct)"
PRESIGN_RES="$(curl -s -X POST "$FILE_BASE/files/presign/upload" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"filename\":\"smoke_s3_$$.txt\",\"folder\":\"smoke\"}")"
PRESIGN_URL="$(printf '%s' "$PRESIGN_RES" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
PRESIGN_KEY="$(printf '%s' "$PRESIGN_RES" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
if [ -n "$PRESIGN_URL" ] && [ -n "$PRESIGN_KEY" ]; then
  pass "presign/upload → url + key ($PRESIGN_KEY)"
  PUT_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    -H 'Content-Type: text/plain' --upload-file "smoke_s3_$$.txt" "$PRESIGN_URL")"
  [ "$PUT_CODE" = "200" ] && pass "presigned PUT → 200" || fail "presigned PUT → $PUT_CODE (expected 200)"
  DOWN_RES="$(curl -s -X POST "$FILE_BASE/files/presign/download" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"key\":\"$PRESIGN_KEY\"}")"
  DOWN_URL="$(printf '%s' "$DOWN_RES" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
  if [ -n "$DOWN_URL" ]; then
    GOT="$(curl -s "$DOWN_URL")"
    [ "$GOT" = "$PAYLOAD" ] && pass "presigned GET roundtrip" || fail "presigned GET roundtrip → '$GOT'"
  else
    fail "presign/download → $DOWN_RES"
  fi
else
  fail "presign/upload → $PRESIGN_RES"
fi

step "10. Proxy upload (multipart through the gateway)"
UP_RES="$(curl -s -X POST "$FILE_BASE/files/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@smoke_s3_$$.txt;type=text/plain" -F 'folder=smoke')"
UP_URL="$(printf '%s' "$UP_RES" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
if [ -n "$UP_URL" ]; then
  pass "upload → $UP_URL"
  DL_CODE="$(status_of "$FILE_BASE$UP_URL")"
  [ "$DL_CODE" = "200" ] && pass "download via $UP_URL → 200" || fail "download via $UP_URL → $DL_CODE (expected 200)"
else
  fail "upload → $UP_RES"
fi

rm -f "smoke_s3_$$.txt"

printf '\n════════════════════════════════════\n'
if [ "$FAILURES" -eq 0 ]; then
  echo 'S3 SMOKE PASSED'
  exit 0
fi
echo "S3 SMOKE FAILED — $FAILURES check(s) failed"
exit 1
