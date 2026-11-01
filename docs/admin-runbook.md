# Platform administration — runbook

Implements `docs/admin-implementation-requirements.md`. Everything lives under `/admin`.
Nothing here is deployed by this repository change; follow "Deploying" when you are ready.

## 1. What was built

| Requirement | Where |
| --- | --- |
| Staff membership independent of customer roles | `platform_staff` (migration 023); roles `platform_admin`, `platform_viewer`; `src/lib/server/admin/permissions.ts` |
| Login → MFA → admin session | `/admin/login`, `/admin/mfa`, `/admin/logout`, `/admin/reauth`; `auth.ts`, `mfa.ts`, `sessions.ts` |
| All accounts landing page | `/admin` → `/admin/accounts` (`accounts.ts`) |
| Account workspace (9 tabs) | `/admin/accounts/[accountId]/…` |
| All users (incl. no account) | `/admin/users` |
| Stored logs (error, activity, admin audit) | `/admin/logs`, account **Logs** tab (`logs.ts`) |
| Table browser + read-only inline SQL | `/admin/data`, `POST /admin/data/query` (`data/*.ts`, `db/admin/provision_sql_reader.sql`) |
| Customer management with audit | account **Users** tab (`actions.ts`) |
| Staff management | `/admin/staff` (step-up MFA), `scripts/admin-cli.mjs` |
| Hardened diagnostics | `/api/aws/diagnostic`, `/api/sfdc/diagnostic/pricebook` now staff-only (`data.query`) |

Customer routes were **not** changed except: `logError()` now redacts and records `request_id`/account
from the request context, the password-reset action also revokes customer + admin sessions, and
`/api/admin/delete-account` refuses accounts that contain platform staff.

### Roles → permissions

| Permission | `platform_admin` | `platform_viewer` |
| --- | --- | --- |
| `accounts.read`, `users.read`, `logs.read`, `data.read` | ✔ | ✔ |
| `data.query` (run SQL, diagnostics), `accounts.update`, `users.manage`, `staff.manage` | ✔ | ✘ |

Enforced in `requireStaff(event, permission, { freshMfa })` on **every** load, action and API handler
(`src/lib/server/admin/guard.ts`). `hooks.server.ts` re-validates the session *and* staff membership on
every `/admin` request and fails closed.

## 2. First-time setup (local)

```bash
# 1. Apply migrations (023 + 024 are additive; nothing is reset)
./scripts/apply-migrations.sh "$DATABASE_URL"

# 2. Secrets (placeholders are in .env.example)
openssl rand -hex 32        # → ADMIN_MFA_ENCRYPTION_KEY

# 3. Provision the SQL reader role (superuser/DB-owner connection, once per environment)
psql "$OWNER_DATABASE_URL" -v reader_password="$(openssl rand -hex 24)" \
     -v app_role=<role the app connects as> -f db/admin/provision_sql_reader.sql
# → set ADMIN_READONLY_DATABASE_URL=postgresql://admin_sql_reader:<password>@host:5432/db

# 4. Administrators are standalone accounts (own email, password, MFA) created only from the console.
#    They are NOT customer users and may share an email with one.
npm run admin:cli -- create --email you@company.com --role platform_admin --name "Your Name"
npm run admin:cli -- list
# also: set-role, set-password [--require-reset], deactivate, reactivate, reset-mfa
```

The password is never accepted on the command line (`ADMIN_BOOTSTRAP_PASSWORD` env or a hidden prompt).
No default credentials exist.

**Logging in:** `http(s)://<host>/admin` → email + password → on first sign-in scan the QR code with an
authenticator app, enter the 6-digit code, and **save the 10 recovery codes** (shown once, stored only as hashes)
→ you land on **All accounts**. Later sign-ins ask for a TOTP code (or a recovery code).

> Whoever knows a staff member's password can enrol the first authenticator. Grant staff with the CLI,
> have them sign in and enrol immediately, and confirm with `admin:cli -- list` (MFA column).

### Validating the four original requirements

1. **Logs:** `/admin/logs` → Source “All”, scroll with **Older →** until “End of retained records”; filter by date/severity/operation/actor/account/request id/text; expand a row for redacted details.
2. **Data + SQL:** `/admin/data` → pick any table (security tables are metadata-only) → run `select a.name, count(u.id) from accounts a join users u on u.account_id = a.id group by a.name` — header reads **All customers**.
3. **All clients and users:** `/admin/accounts` (every account, incl. no owner / no stores / incomplete onboarding) and `/admin/users` (incl. “No account”).
4. **Landing + workspace:** sign in → **All accounts** → **Open account** → banner “Admin view · <name>”, tabs Overview / Users / Stores / Services & cases / Billing / Documents / Integrations / Logs / Data. **← All accounts** restores your search/page.

## 3. Environment variables

| Variable | Purpose |
| --- | --- |
| `ADMIN_MFA_ENCRYPTION_KEY` | AES-256-GCM key for TOTP secrets (32 bytes, base64 or hex). Required to enrol/verify MFA. |
| `ADMIN_MFA_ENCRYPTION_KEY_PREVIOUS` | Decrypt-only old key during rotation. |
| `ADMIN_MFA_ISSUER` | Label shown in authenticator apps. |
| `ADMIN_READONLY_DATABASE_URL` | Reader-role login for inline SQL. Never falls back to `DATABASE_URL`; the app also refuses a reader that equals `DATABASE_URL`, has elevated attributes, or can touch base tables. Unset ⇒ SQL shows a configuration error, the rest of `/admin` works. |
| `ORIGIN` | Used for the CSRF origin check behind a proxy (already required by adapter-node). |

Production needs HTTPS (cookies are `Secure`, `HttpOnly`, `SameSite=Strict`) and `ORIGIN` set to the public URL.

## 4. Sessions, MFA, throttling

* Opaque 32-byte tokens; only SHA-256 stored. Separate `admin_session` cookie; customer cookies never authenticate admin, and the customer session is ignored on `/admin`.
* Idle timeout **20 min**, absolute **8 h**, membership change step-up freshness **5 min** (re-verify at `/admin/reauth`).
* Revoked on: logout, staff deactivation, role change, MFA reset, any password reset (customer *and* admin sessions).
* Password step: 5 attempts / 15 min per email, 20 per IP (DB-backed, shared across replicas). **Does not lock the underlying customer account.** MFA: 5 attempts per challenge, 10 / 15 min per user. TOTP time-step replay and recovery-code reuse are rejected atomically.
* TOTP: `otplib` v13 (RFC 6238, ±1 step tolerance). QR codes: `qrcode`. SQL parsing: `pgsql-ast-parser`. Tests: `vitest`.

## 5. Inline SQL — how it is constrained

Layers (the database is the primary one):

1. **Reader role** `admin_sql_reader`: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, no memberships, owns nothing, `SELECT` **only** on the reviewed views in the `reporting` schema, `search_path=reporting`, TEMP/CREATE revoked from PUBLIC, 5 s / 1 s timeouts as role defaults.
2. **Reviewed projections** (`db/migrations/024_admin_reporting_views.sql`): secret columns are not selected at all; raw log text/JSON is not projected (read logs via the redacting viewer). Views are `security_barrier`, owned by the migration owner. There is no row-level security in this schema; if RLS is added, `FORCE` it or use `security_invoker` views.
3. **Per-query transaction**: `BEGIN READ ONLY`, `SET LOCAL statement_timeout=5000`, `lock_timeout=1000`, rolled back always.
4. **Parser allowlist** (`sql_validate.ts`): one statement; SELECT/UNION/VALUES/WITH-SELECT; no writable or recursive CTEs, no locking clauses; relations must be reporting views or query-local CTEs (CTE names may not start with `pg_`); only an allowlist of side-effect-free functions; no `reg*`/`oid` casts. Syntax the parser does not understand is rejected (so some valid SQL, e.g. `TABLESAMPLE`, `TABLE x`, `EXPLAIN`, is unsupported by design).
5. **Bounds**: 500 rows displayed (max 1,000), 2 MB, enforced while streaming through a cursor; one query per administrator across replicas (`admin_sql_active`); abort cancels the statement.
6. **Audit**: actor, fingerprint, literal-free summary, duration, row count, outcome (`sql.execute`). Raw SQL text is never stored.

SQL is always **global**: results say “All customers”; nothing is rewritten to be tenant-scoped.

Re-run `db/admin/provision_sql_reader.sql` after any migration that adds a reviewed view (rotates the password, re-grants).

### Known residual risk
* Non-superuser roles can read non-sensitive `pg_settings` (e.g. the *file name* in `ssl_key_file`; not its contents). The validator blocks `pg_*` relations and the role cannot read credential-bearing settings or files; tests assert this.
* `PUBLIC` keeps `EXECUTE` on `plpgsql`/functions by default; anything run via an anonymous `DO` block still executes with the reader's (non-)privileges — tested.

## 6. Data inventory

`src/lib/server/admin/data/inventory.ts` maps **every** table to a projection or a restriction; `tests/admin/inventory_audit.test.ts` fails if a table, a view, or the `hidden` column lists drift from the real schema. A newly added table shows as **“unreviewed — metadata only”** until reviewed.

Metadata-only: `admin_login_challenges`, `admin_rate_limits`, `admin_sql_active`. Everything else has a secret-free view (see the `note`/`hidden` columns in the UI).

Account → table relationships used by the account **Data** tab are the `accountScope` entries in the same file (e.g. `store_documents.store_id → stores.account_id`).

## 7. Derived / unavailable values (never invented)

* **Onboarding** = `accounts.onboarding_completed`.
* **Owner** = earliest user with `users.role='owner'`; else the account's own email; else “unknown”.
* **Salesforce link** = `sfdc_account_id` present (existence only — not a health claim). **Stores** show the *persisted* `spapi_status`/last error, explicitly not a live check.
* **Case workflow status** is owned by Salesforce and not stored locally → shown as unavailable; only cases with uploaded documents are listed.
* Live Salesforce / Stripe lookups are **on demand** (button), 8 s timeout each, showing source + fetched-at + their own error; the page never calls them while rendering lists.

### Editable account fields (ownership)

| Field | Ownership | Behaviour |
| --- | --- | --- |
| `billing_street/city/state/postal_code/country` | shared | local update + audit in one transaction, then push via the existing `updateSalesforceAccount`; result is `synced` / `failed` (with error) / `not_linked`. Audit records `pending` then `success`/`failure` with a correlation id. |
| `phone`, `website` | local only | no Salesforce write-back exists today |
| everything else (name, email, IDs, Stripe) | not editable here | |

Lost-update protection: the form carries a microsecond `updated_at` version; a stale submit is rejected with 409.

## 8. Audit

`admin_audit_events` is append-only (trigger blocks UPDATE/DELETE/TRUNCATE, no FKs so history survives user/account deletion). Recorded: staff login outcomes, MFA failures/recovery, re-auth, logout, staff grant/deactivate/MFA reset, account edits (+ Salesforce sync), customer suspend/reactivate/unlock/revoke/reset, document downloads, SQL runs. Local mutation + success event commit in **one transaction**; downloads and SQL are audited before results are released. Reads of the Logs page are intentionally not audited (avoids recursive noise).

To enforce append-only at the privilege level too, revoke `UPDATE, DELETE, TRUNCATE` on `admin_audit_events` from the app's runtime role (the trigger already blocks it for every role, including the owner).

## 9. Existing machine endpoints (`/api/admin/*`)

All four authenticate with the `x-admin-secret` header (`ADMIN_OPS_SECRET`, timing-safe compare) — **not** with cookies, so a browser session (customer or staff) cannot reach them and CSRF does not apply. The secret is never rendered to or accepted from the browser UI.

| Endpoint | Purpose | Status |
| --- | --- | --- |
| `POST /api/admin/issue-api-key` | mint Salesforce bearer keys | machine-only, unchanged; not exposed in the UI |
| `GET /api/admin/lookup-user` | read-only ID lookup | machine-only, unchanged |
| `DELETE /api/admin/delete-account` | delete account + users | machine-only; now refuses accounts containing platform staff |
| `POST /api/admin/apply-migration` | one-off allow-listed migration | machine-only, unchanged; remove when no longer needed |

Diagnostics: `/api/aws/diagnostic` and `/api/sfdc/diagnostic/pricebook` require a staff session with `data.query`. Clearing the pricebook cache moved from `GET` to `POST`.

## 10. Operations

**Key rotation:** set `ADMIN_MFA_ENCRYPTION_KEY_PREVIOUS=<old>` and `ADMIN_MFA_ENCRYPTION_KEY=<new>` → `npm run admin:cli -- rotate-mfa-key` → remove the previous key.

**Lost authenticator / recovery:** `npm run admin:cli -- reset-mfa --email x` (or Staff → Reset MFA by another admin). Sessions are revoked; the person re-enrols at next sign-in and gets new recovery codes.

**Removing access:** Staff → Deactivate (or `admin:cli -- deactivate --email x`). Last active `platform_admin` can never be removed (advisory lock + DB trigger).

**Reader password rotation:** re-run the provisioning script with a new `reader_password`, update `ADMIN_READONLY_DATABASE_URL`, redeploy.

**Log retention:** nothing is deleted automatically by this feature. Recommended: decide a retention window for `error_log` / `activity_log` with your compliance owner and prune by `created_at` in a scheduled job; **never** delete from `admin_audit_events` (export + archive instead). Housekeeping that *is* automatic: expired MFA challenges, stale rate-limit rows and sessions older than 30 days.

**Rollback:** disable access first (`UPDATE platform_staff SET is_active=false` is blocked for the last admin; instead block `/admin` at the proxy or unset `ADMIN_MFA_ENCRYPTION_KEY`), then run `db/admin/rollback_023_024.sql` (manual, destructive, drops the audit trail — export first). The app code is additive; reverting the commit is enough for customer functionality.

**Deploying:** not done here. When ready: apply 023 and 024, run the reader provisioning script, set the three env vars, deploy, create the first admin with the CLI from a host that can reach the DB (or via your existing ops path), verify with the checklist in §2.

## 11. Verification summary (local, throw-away Postgres 16)

| Check | Result |
| --- | --- |
| `npm run check` | 0 errors; 34 warnings, all pre-existing (none in `/admin` code) |
| `npm run build` | passes |
| `TEST_PG_URL=… npm test` | unit + real-database suites (SQL validator, reader role, auth/MFA/sessions, logs, inventory, workspace isolation, actions/atomicity, correlation) |
| `TEST_PG_URL=… node tests/e2e/smoke.mjs` | 100+ HTTP assertions against the built server (anonymous/customer/viewer/admin, CSRF, tampering, SQL, revocation, recovery codes) |
| `BENCH=1 … tests/admin/bench.test.ts` | seeded 20,000 accounts / 60,000 users / 400,000 log rows (local Postgres, same machine): accounts page p50 47–70 ms, user search ≈120 ms, log newest page <10 ms, 20-page deep cursor ≈8 ms/page, unindexed message search ≈150 ms. Not a production latency promise; add `pg_trgm` indexes if `ILIKE` search becomes slow at larger scale. |

## 12. Limitations / follow-ups

* No impersonation (by design); SQL writes are not supported; no exports; no staff-invite email flow; no billing mutations; no external infrastructure logs.
* Message-text log search and account search by user email use unindexed `ILIKE`.
* No Content-Security-Policy is set (SvelteKit inline hydration scripts would need nonces); the only `{@html}` in admin code is the server-generated MFA QR SVG, enforced by a test.
* Login for staff whose account has `must_reset_password` is refused (generic error) until they reset via the customer flow.
