# Database

Local Postgres 16 for `samdoctor-web`, run via Docker Compose. Schema lives in
`db/migrations/` and is applied automatically on the container's first start.

Connection string (matches `.env.example`):

```
postgresql://postgres:postgres@localhost:5432/samdoctor
```

## Start

```bash
# From samdoctor-web/
docker compose up -d        # starts postgres + redis
docker compose ps           # confirm "healthy"
docker compose logs -f postgres
```

The image is pulled on first run (~150 MB). After `up -d` the schema in
`db/migrations/` is applied automatically, the DB listens on `localhost:5432`,
and your `DATABASE_URL` will work.

## Stop

```bash
docker compose stop         # keep data
docker compose down         # remove containers, keep data volume
docker compose down -v      # remove containers AND wipe data (next `up` re-runs migrations)
```

## Connect

```bash
# psql via the container
docker compose exec postgres psql -U postgres -d samdoctor

# or from the host (requires local psql)
psql "$DATABASE_URL"

# list tables
docker compose exec postgres psql -U postgres -d samdoctor -c '\dt'
```

## Schema changes

Init-script files in `/docker-entrypoint-initdb.d/` only run on an EMPTY data
volume. To apply changes after the initial setup, either:

- **Reset everything** (destroys data):
  ```bash
  docker compose down -v && docker compose up -d
  ```
- **Apply incrementally** — add a new file (`002_*.sql`, `003_*.sql`, …) and
  run it against the live DB:
  ```bash
  docker compose exec -T postgres psql -U postgres -d samdoctor \
    < db/migrations/002_whatever.sql
  ```

## Tables

| Table | Purpose |
| --- | --- |
| `users` | Auth source of truth. UUID PK, unique email, optional password hash, optional Salesforce Contact/Account IDs. |
| `oauth_accounts` | Google/Apple OAuth providers linked to a user. Unique on `(provider, provider_uid)`. |
| `sessions` | Issued JWTs (hashed) for revocation. Indexed on `expires_at` for cleanup sweeps. |
| `activity_log` | Audit/analytics events (login, page_view, action). `event_data` is JSONB. |
| `sfdc_sync_queue` | Outbound Salesforce writes. Worker polls `(status, created_at)` partial index. |
| `sfdc_records` | Local mirror of Salesforce records for offline / performance. PK is `sfdc_id`. |

Detailed column definitions: `db/migrations/001_init.sql`.
