#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# Backup all production databases of the stack.
#
# Usage:
#   ./backup.sh                    # → ./backups/<db>_<timestamp>.sql.gz
#   ./backup.sh /path/to/backups   # custom output dir
#
# Test databases (*_test) are skipped. Restore: see README «Backups».
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

OUT_DIR="${1:-./backups}"
STAMP="$(date +%Y%m%d_%H%M%S)"
PG_USER="${DB_USER:-root}"

mkdir -p "$OUT_DIR"

if ! docker compose ps --status running postgres | grep -q postgres; then
  echo "error: postgres container is not running (docker compose up -d first)" >&2
  exit 1
fi

dbs="$(docker compose exec -T postgres psql -U "$PG_USER" -At -d postgres \
  -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datname NOT LIKE '%_test'")"

if [ -z "$dbs" ]; then
  echo "error: no databases found" >&2
  exit 1
fi

for db in $dbs; do
  file="$OUT_DIR/${db}_${STAMP}.sql.gz"
  echo "→ dumping $db"
  docker compose exec -T postgres pg_dump -U "$PG_USER" --no-owner --no-privileges "$db" \
    | gzip > "$file"
  echo "  done: $file"
done

echo "All backups written to $OUT_DIR"
