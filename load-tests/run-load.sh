#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Load-test runner: boots the stack, seeds the user pool, runs the k6
# scenarios and prints one headline line per scenario.
#
# Usage (from gateway-server/):
#   ./load-tests/run-load.sh                    # ceiling mode, all scenarios
#   ./load-tests/run-load.sh storm10 read       # subset
#   MODE=realistic ./load-tests/run-load.sh read
#
# Modes:
#   ceiling    — auth throttler raised to 100k/min and nginx zones raised
#                (generated nginx-loadtest.conf): measures the service CPU
#                ceiling. Default.
#   realistic  — stock config (auth 3-5/min per IP, nginx 5-10 r/s per IP):
#                verifies the edge protection behaves (429s are expected —
#                the point is watching the limiters, not the app).
#
# Multi-replica soak (HA):
#   THROTTLE_STORAGE=redis SCALE="auth-server=2 api-server=2 event-server=2
#   message-server=2" ./load-tests/run-load.sh
#   SCALE adds `--scale` flags to the boot command; auth counters then live
#   in Redis so the replicas enforce one shared limit. SKIP_BOOT=1 keeps
#   the current replica counts (a plain `up -d` would reset them to 1).
#
# Scenarios: storm10 storm12 fullpath read webhook
# ═══════════════════════════════════════════════════════════════
set -uo pipefail
cd "$(dirname "$0")/.."

MODE="${MODE:-ceiling}"
SCALE="${SCALE:-}"
SCALE_OPTS=()
for pair in $SCALE; do SCALE_OPTS+=(--scale "$pair"); done
VUS_STORM="${VUS_STORM:-20}"
VUS_FULLPATH="${VUS_FULLPATH:-5}"
VUS_READ="${VUS_READ:-20}"
VUS_WEBHOOK="${VUS_WEBHOOK:-10}"
DURATION="${DURATION:-60s}"
SCENARIOS=("$@")
[ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(storm10 storm12 fullpath read webhook)

OUT=load-tests/out
mkdir -p "$OUT"
K6_IMAGE="grafana/k6:latest"
K6_NETS=(--network gateway-server_backend --network gateway-server_frontend)

step() { printf '\n== %s\n' "$*"; }

# ── 1. Stack ────────────────────────────────────────────────────
step "1. Stack (mode: $MODE)"
# SKIP_BOOT=1 still runs `up -d` (fast, images cached) but skips --build;
# set it when iterating on scenarios with unchanged images.
BUILD_FLAG="--build"
[ "${SKIP_BOOT:-0}" = 1 ] && BUILD_FLAG=""
if [ "$MODE" = ceiling ]; then
  # generated nginx conf — derived from the live nginx.conf so it can't drift
  sed -e 's/rate=10r\/s/rate=500r\/s/' \
      -e 's/rate=5r\/s/rate=250r\/s/' \
      -e 's/burst=10/burst=200/' \
      -e 's/burst=20/burst=400/' \
      -e 's/burst=5/burst=100/' \
      nginx.conf > load-tests/nginx-loadtest.conf
  COMPOSE_FILES=(-f docker-compose.yml -f load-tests/docker-compose.loadtest.yml)
else
  COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.override.yml)
fi
# redis: shared throttle storage when THROTTLE_STORAGE=redis (HA soak)
docker compose "${COMPOSE_FILES[@]}" up -d $BUILD_FLAG \
  ${SCALE_OPTS[@]+"${SCALE_OPTS[@]}"} \
  redis auth-server event-server api-server message-server nginx mailhog \
  || { echo "   boot failed (build or up error), aborting"; exit 1; }

step "2. Waiting for /health"
for i in $(seq 1 60); do
  ok=1
  for svc in auth-server:3001 api-server:5000 event-server:3005 message-server:3003; do
    name="${svc%%:*}"; port="${svc##*:}"
    # every replica must answer (docker compose ps -q returns one id per replica)
    for cid in $(docker compose ps -q "$name"); do
      docker exec "$cid" wget -qO- "http://127.0.0.1:$port/health" >/dev/null 2>&1 || ok=0
    done
  done
  [ "$ok" = 1 ] && break
  sleep 2
done
[ "$ok" = 1 ] && echo "   all services healthy" || { echo "   services not healthy, aborting"; exit 1; }
for svc in auth-server api-server event-server message-server; do
  n=$(docker compose ps -q "$svc" | wc -l | tr -d ' ')
  echo "   $svc replicas: $n"
done

# ── 2. Seed ─────────────────────────────────────────────────────
step "3. Seed (load users + posts)"
docker compose exec -T postgres psql -U root -d auth_server < load-tests/seed-load.sql >/dev/null
cat load-tests/seed.sql | docker compose exec -T postgres psql -U root -d api_server 2>/dev/null | tail -1
cat load-tests/seed-tags.sql | docker compose exec -T postgres psql -U root -d api_server 2>/dev/null | tail -1

k6() { # k6 <outname> [env=value...] -- script.js
  local name="$1"; shift
  local envs=() script=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--" ]; then script="$2"; break; fi
    envs+=(-e "$1"); shift
  done
  echo "--- $name (${script}, $(printf '%s ' "${envs[@]}"))"
  # MSYS_NO_PATHCONV + cygpath: Git Bash otherwise rewrites the container
  # paths (/scripts/...) into host paths and k6 never finds the script
  local scripts_dir
  scripts_dir=$(cygpath -m "$(pwd)/load-tests")
  MSYS_NO_PATHCONV=1 docker run --rm "${K6_NETS[@]}" -v "${scripts_dir}:/scripts" \
    "$K6_IMAGE" run --quiet "${envs[@]}" \
    --summary-export "/scripts/out/$name.json" "/scripts/$script" \
    > "$OUT/$name.txt" 2>&1
  tail -2 "$OUT/$name.txt" | head -1
  python - "$OUT/$name.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    m = d.get("metrics", {})
    def vals(name):
        # summary-export nests values directly under the metric name
        v = m.get(name) or m.get(name + "{expected_response:true}") or {}
        return v.get("values", v)
    dur = vals("http_req_duration")
    reqs = vals("http_reqs")
    f = vals("http_req_failed")
    fail = f.get("rate", f.get("value", 0))
    iters = vals("iteration_duration")
    print(f"   RESULT {sys.argv[1].split('/')[-1].replace('.json','')}: "
          f"req/s={reqs.get('rate', 0):.1f} avg={dur.get('avg', 0):.1f}ms "
          f"p(95)={dur.get('p(95)', 0):.1f}ms max={dur.get('max', 0):.1f}ms "
          f"failed={fail*100:.1f}%")
    if iters:
        print(f"          iteration avg={iters.get('avg',0):.0f}ms p(95)={iters.get('p(95)',0):.0f}ms")
except Exception as e:
    print(f"   RESULT parse failed: {e}")
PY
}

# background CPU sampler for the whole suite → out/stats.log
stats_pid=""
sample_stats() {
  while :; do
    date +%H:%M:%S
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'       | grep gateway-server | tr '
' ' '
    echo
    sleep 3
  done
}
start_stats() { sample_stats > "$OUT/stats.log" 2>&1 & stats_pid=$!; }
stop_stats()  { [ -n "$stats_pid" ] && kill "$stats_pid" 2>/dev/null; }

mailhog_total() {
  curl -s "http://localhost:8025/api/v2/messages?limit=1" | python -c "import json,sys; print(json.load(sys.stdin).get('total', 0))" 2>/dev/null || echo "?"
}

start_stats
trap stop_stats EXIT

for s in "${SCENARIOS[@]}"; do
  case "$s" in
    storm10)
      step "4. Login storm — bcrypt cost 10"
      if [ "$MODE" = ceiling ]; then
        k6 storm10 "AUTH_URL=http://auth-server:3001" "USERS_PREFIX=load" "USERS_COUNT=100" "VUS=$VUS_STORM" "DURATION=$DURATION" -- auth-login-storm.js
      else
        k6 storm10 "AUTH_URL=http://nginx" "USERS_PREFIX=load" "USERS_COUNT=100" "VUS=$VUS_STORM" "DURATION=$DURATION" -- auth-login-storm.js
      fi
      ;;
    storm12)
      step "5. Login storm — bcrypt cost 12"
      if [ "$MODE" = ceiling ]; then
        k6 storm12 "AUTH_URL=http://auth-server:3001" "USERS_PREFIX=load12" "USERS_COUNT=100" "VUS=$VUS_STORM" "DURATION=$DURATION" -- auth-login-storm.js
      else
        k6 storm12 "AUTH_URL=http://nginx" "USERS_PREFIX=load12" "USERS_COUNT=100" "VUS=$VUS_STORM" "DURATION=$DURATION" -- auth-login-storm.js
      fi
      ;;
    fullpath)
      step "6. Register → confirm (email) → login → self"
      if [ "$MODE" = ceiling ]; then
        k6 fullpath "AUTH_URL=http://auth-server:3001" "MAILHOG_URL=http://mailhog:8025" "VUS=$VUS_FULLPATH" "DURATION=$DURATION" -- auth-full-path.js
      else
        k6 fullpath "AUTH_URL=http://nginx" "MAILHOG_URL=http://mailhog:8025" "VUS=$VUS_FULLPATH" "DURATION=$DURATION" -- auth-full-path.js
      fi
      ;;
    read)
      step "7. Read-heavy API through nginx"
      k6 read "BASE_URL=http://nginx" "VUS=$VUS_READ" "DURATION=$DURATION" -- api-read-heavy.js
      ;;
    webhook)
      step "8. Webhook delivery under load"
      BEFORE=$(mailhog_total)
      # the internal key guards POST /events — take the stack's real one
      KEY="${INTERNAL_API_KEY:-$(grep '^INTERNAL_API_KEY=' .env | cut -d= -f2)}"
      k6 webhook "EVENT_URL=http://event-server:3005" "INTERNAL_API_KEY=$KEY" "VUS=$VUS_WEBHOOK" "DURATION=$DURATION" -- event-webhook-load.js
      # drain watch: poll MailHog until the count stabilizes (the mail
      # worker drains at WORKER_INTERVAL_MS × BATCH_SIZE mails/s by design)
      PREV="$BEFORE"; STABLE=0; i=0
      for i in $(seq 1 12); do
        sleep 10
        CUR=$(mailhog_total)
        [ "$CUR" = "$PREV" ] && STABLE=$((STABLE + 1)) || STABLE=0
        PREV="$CUR"
        [ "$STABLE" -ge 2 ] && break
      done
      AFTER="$PREV"
      echo "   MailHog messages: $BEFORE → $AFTER (delivered $((AFTER - BEFORE)) total; stable after ~$((10 * i))s)"
      ;;
    *) echo "unknown scenario: $s" ;;
  esac
done

step "Done (mode: $MODE) — details in $OUT/*.txt, raw summaries in $OUT/*.json"
