#!/usr/bin/env bash
# Verify that every migration in db/migrations has been applied to a database.
#
#   ./scripts/verify-migrations.sh "postgresql://user:pass@host:5432/dbname?sslmode=require"
#   or, with DATABASE_URL set:  ./scripts/verify-migrations.sh
#
# Exit code is 0 only when every migration is applied.
set -euo pipefail
PGURL="${1:-${DATABASE_URL:-}}"
if [[ -z "$PGURL" ]]; then
  echo "Usage: $0 <postgres-url>   (or export DATABASE_URL)" >&2
  exit 2
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(psql "$PGURL" -v ON_ERROR_STOP=1 -X -f "$SCRIPT_DIR/../db/verify_migrations.sql")"
echo "$OUT"
if grep -q "MIGRATIONS APPLIED" <<<"$OUT" && ! grep -q "incomplete" <<<"$OUT"; then exit 0; else exit 1; fi
