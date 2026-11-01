#!/usr/bin/env bash
#
# Apply db/migrations/*.sql to a Postgres database, in order, stopping on the
# first error. Your connection string (with password) stays on your machine —
# it is never printed.
#
# Usage:
#   ./scripts/apply-migrations.sh "postgresql://postgres:PASSWORD@HOST:5432/samdoctor?sslmode=require"
#
# Or set it in the environment first (avoids it landing in your shell history):
#   read -rs PGURL          # paste the URL, press enter (input hidden)
#   export PGURL
#   ./scripts/apply-migrations.sh
#
set -euo pipefail

PGURL="${1:-${PGURL:-}}"
if [[ -z "$PGURL" ]]; then
  echo "❌ No connection string. Pass it as an argument or set \$PGURL." >&2
  echo "   See the header of this script for usage." >&2
  exit 1
fi

# Resolve the migrations dir relative to this script, so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG_DIR="$SCRIPT_DIR/../db/migrations"

echo "▶ Applying migrations from $MIG_DIR"
shopt -s nullglob
files=("$MIG_DIR"/*.sql)
if (( ${#files[@]} == 0 )); then
  echo "❌ No .sql files found in $MIG_DIR" >&2
  exit 1
fi

# Sort by filename so 001 → 013 run in order.
IFS=$'\n' sorted=($(sort <<<"${files[*]}")); unset IFS

for f in "${sorted[@]}"; do
  echo "  → $(basename "$f")"
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo ""
echo "✅ All migrations applied. Tables now in the database:"
psql "$PGURL" -c "\dt"
