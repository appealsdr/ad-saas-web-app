# Platform administration — implementation requirements for Claude

Status: implementation brief. Date: 2026-10-05.

## 1. Assignment

Implement a production-ready platform administration area in this repository. Use the existing SvelteKit 2, Svelte 5, TypeScript, PostgreSQL (`postgres` library), and existing design system. Inspect applicable repository instructions and actual schema before editing. Reuse existing integration services where appropriate. Do not replace the application's authentication framework or upgrade major dependencies solely for this feature.

Deliver working code, incremental migrations, automated tests, and setup/runbook documentation. Do not stop at scaffolding or mock data. Do not deploy, run production migrations, create production administrators, or modify real customer records as part of local implementation.

## 2. User requirements and scope

The platform administrator must:

1. Inspect all retained application log records.
2. Browse all application data tables and run inline SQL against permitted data across all customers.
3. Access all clients and all users, independently of customer account membership.
4. Land on the list of all accounts after login, select an account, and inspect its current setup.

Implementation defaults:

- “Log in to an account” means opening its administrative workspace while retaining the administrator's own identity. Actual user impersonation is a future feature.
- Inline SQL is read-only in this release. Implement validated management actions separately; arbitrary SQL writes are a future feature.
- All tables must be inventoried, including global and security-related tables. Secret columns are excluded from readable projections. Tables with no safe fields show metadata and an explanation.
- Stored logs means database-backed logs, including `error_log`, `activity_log`, and new admin audit records. External hosting logs are outside this release.
- Account lists, account setup views, logs, and SQL are required for completion, not optional later phases.

## 3. Verified starting points

Revalidate these files before implementation; repository changes may occur after this brief.

| Existing area | Relevant files |
| --- | --- |
| Password login | `src/routes/(auth)/login/+page.server.ts` |
| Password/session utilities | `src/lib/server/auth/password.ts`, `session.ts`, `cookie.ts`, `redirects.ts` |
| Request identity | `src/hooks.server.ts`, `src/app.d.ts`, `src/lib/types` |
| Customer roles | `src/lib/server/auth/roles.ts`, `db/migrations/012_account_users.sql` |
| Customer account management | `src/routes/(app)/accounts/+page.server.ts`, `src/lib/server/account/contacts.ts` |
| Customer onboarding guard | `src/routes/(app)/+layout.server.ts` |
| Database access | `src/lib/server/db.ts`, `db/migrations/` |
| Logs | `db/migrations/001_init.sql`, `004_error_log.sql`, `src/lib/server/error_log.ts` |
| Integrations | `src/lib/server/salesforce/`, `stripe.ts`, `spapi.ts`, `storage/` |
| Shared-secret operations | `src/routes/api/admin/` |
| Diagnostics | `src/routes/api/aws/diagnostic/+server.ts`, `src/routes/api/sfdc/diagnostic/pricebook/+server.ts` |

Existing customer roles are `owner`, `admin`, and `member`. These are not platform roles. Current sessions use random opaque tokens, store token hashes, and expire after three hours. The session loader currently does not return a platform role. The existing login has three-attempt/24-hour lockout behavior; do not blindly copy that policy into staff login.

The schema already has `error_log.account_id`. Historical activity records may lack reliable account attribution. Do not rewrite historical ownership using a user's current account.

## 4. Authorization and identity architecture — P0

Create independent platform staff membership. Never reinterpret `users.role = 'admin'` as platform access.

Use two initial platform roles with a server-side permission map:

| Capability | `platform_admin` | `platform_viewer` |
| --- | --- | --- |
| List all accounts/users and inspect setup | Yes | Yes |
| View redacted logs and permitted data | Yes | Yes |
| Execute read-only SQL | Yes | No |
| Update approved account fields | Yes | No |
| Suspend/unlock customer users, initiate resets, revoke sessions | Yes | No |
| Grant/revoke staff membership | Yes | No |

Suggested permission keys: `accounts.read`, `accounts.update`, `users.read`, `users.manage`, `logs.read`, `data.read`, `data.query`, `staff.manage`.

Implement reusable server guards for staff authentication, permission checks, and recent MFA. Enforce them on every protected page load, form action, and API handler. Layout checks and hidden controls are insufficient. Fail closed when membership/session verification fails.

Leave customer account authorization intact. Never remove account filters from customer routes to create admin access. Add explicit staff services accepting target account IDs after permission validation. Check child-record ownership when accessing a user, store, case, or document under a selected account.

No public registration, customer invitation, Google callback, or Salesforce provisioning path can grant platform membership. Do not use email-domain matching as authorization.

## 5. Authentication and sessions — P0

Routes: `/admin/login`, `/admin/mfa`, `/admin/logout`. Keep login/MFA outside protected admin layouts and customer onboarding guards.

Flow: credentials → active staff membership → MFA enrollment/challenge → fully authenticated admin session → `/admin/accounts`. A validated admin-only return URL may preserve an explicitly requested admin deep link.

Reuse password verification. Require TOTP MFA using a maintained implementation; document the selected dependency. Encrypt TOTP secrets with a server-side key, hash recovery codes, and make codes single-use. Provision a short-lived enrollment/challenge state that grants no data access. Limit challenge attempts, reject replay of a used TOTP time step, and implement rate limiting across application replicas. Never persist raw recovery codes or expose enrolled secrets again.

Use a separate opaque admin session cookie and hashed server-side token so a customer session cannot accidentally become administrative. Proposed defaults: 20-minute idle timeout, eight-hour absolute lifetime, five-minute freshness for staff membership changes. Enforce expiry server-side. Rotate tokens on completed authentication. Revalidate staff membership on each protected request.

Use Secure cookies in production, HttpOnly, SameSite, explicit path, HTTPS/proxy configuration, and CSRF/origin validation for mutations. Return generic authentication errors. Do not log credentials or distinguish unknown staff emails from wrong credentials in public responses.

Revoke admin sessions after staff deactivation, password reset, MFA recovery/reset, or role change. Logout revokes its server-side session. Existing password reset paths must revoke both customer and admin sessions where applicable.

Provide an idempotent operator CLI for initial staff creation/granting and MFA recovery, using explicit email input and audit records. No committed default credentials. Serialize membership changes so concurrent operations cannot remove the last active platform admin. Customer-user management must not disable staff accounts through a weaker path.

## 6. Database changes — P0

Add new numbered migrations after the current highest migration; do not assume a fixed number or edit applied migrations.

Required logical entities (names may follow repository conventions):

- `platform_staff`: unique user FK, constrained role, active flag, granted-by actor, timestamps.
- `admin_sessions`: user FK, unique token hash, MFA verification time, last activity, absolute expiry, creation time, revocation metadata.
- MFA credentials and recovery-code hashes; short-lived MFA challenge state.
- `admin_audit_events`: immutable event ID, timestamp, actor ID and durable actor reference, action, target type/ID, target account ID where applicable, outcome, reason, request ID, redacted changes/metadata.

Audit events must survive removal of referenced users/accounts. Index common staff, session, account-log, and audit lookup paths. Store timestamps as `TIMESTAMPTZ` and display timezone explicitly.

Add safe database views/projections and a dedicated SQL-reader role. Keep migration ownership separate from runtime permissions. Runtime administration may insert/read audit records but must not update/delete them. Apply changes incrementally without resetting any data volume.

## 7. Accounts landing page — P0

`/admin` redirects to `/admin/accounts` after authorization. No generic dashboard should interrupt the requested account-first flow.

Account columns: name, local ID, owner/contact, user count, store count, onboarding status, Salesforce account reference, created date. Do not invent status fields; document derived values and show unknown/unavailable states.

Provide search by name, email, local ID, and Salesforce ID; onboarding filter; deterministic sorting; server-side pagination (default 25, maximum 100). Use aggregated queries without per-row integration requests. Every account is reachable, including accounts with missing owners, no stores, incomplete onboarding, or broken integration links.

Row action: “Open account.” Preserve search/page context when returning to the list.

## 8. Account workspace and global users — P0

`/admin/accounts/[accountId]` displays a persistent “Admin view · [account name]” banner, account ID, and return-to-accounts action. Selecting an account must not change the administrator's `users.account_id` or issue a customer session.

Tabs:

| Tab | Required content |
| --- | --- |
| Overview | Company/contact details, onboarding status, setup summary, linked IDs |
| Users | Account users, customer roles, active/locked state, last login |
| Stores | Store details, point of contact, persisted connection state |
| Services/cases | Existing service contracts, cases and available workflow status |
| Billing | Linked payments/subscriptions and authoritative provider status where available |
| Documents | Related store/case documents with authorized downloads |
| Integrations | Linked records, known sync errors, source and freshness of information |
| Logs | Reliably attributed account logs |
| Data | Safe table records linked to this account through documented relationships |

Also provide `/admin/users` for searching all users, including users without accounts, with links to account workspaces.

Load local data even when an integration is unavailable. Fetch external details on demand with timeouts, displaying source, fetched-at timestamp, and independent errors. Do not call a connection “healthy” solely because a token or external ID exists.

Management actions: edit approved account contact/company fields, suspend/reactivate customer users, unlock customer login, initiate existing password-reset delivery, and revoke customer sessions. Require a reason for security actions; show target and confirmation before execution. Never display passwords or return reset tokens to the administrator. Handle unavailable email delivery honestly.

Reuse existing Salesforce update services and synchronization behavior. Document ownership for each edited field; expose pending/failed external synchronization rather than falsely reporting complete success. Protect against lost updates using a version or `updated_at` precondition. Billing changes, refunds, arbitrary case transitions, and permanent deletion are not required in this release.

## 9. Stored application logs — P0

Provide `/admin/logs` with source selection for error, activity, and admin audit records; unified presentation or separate tabs are acceptable. Include all retained records accessible through pagination, not only recent errors.

Filters: date range, source/type, severity where supported, operation/event, actor/user, account, request ID where available, and message text. Details show formatted redacted JSON, message, stack where present, original record ID, and timestamp. Explain missing fields rather than manufacturing values.

Use stable cursor pagination by timestamp and ID; bounded page size and indexed common filters. Add request/account correlation to new relevant log writes. Historical unattributed logs remain visible globally and explicitly unattributed.

Redact secrets before storage and again before rendering legacy data, including nested JSON and stack/message content. Render text safely without HTML interpretation. Do not expose raw logs through SQL views as a way around redaction. Do not emit another access-log record for every audit-page read if that creates recursive noise.

## 10. Data explorer and inline SQL — P0

Provide `/admin/data` containing a table sidebar, column/type/key metadata, a paginated grid, and an inline SQL editor with Run, loading, error, and results states. Display column names, row count, elapsed time, and truncation. Preserve types; handle nulls, dates, JSON, large text, and large numeric values without silent precision loss.

Inventory every application table and explicitly map it to a safe readable projection or metadata-only entry. Include newly discovered tables as metadata-only until reviewed. Hide secret columns rather than retrieving and masking them in JavaScript. Security-table views may expose safe metadata such as IDs and timestamps only. Sensitive JSON fields and log text require safe redacted projections, not raw access.

The global explorer covers all customers. Account workspace data uses explicit known FK/join mappings; global/unrelated tables must be labeled. SQL is global and must display “All customers.” An account ID can be inserted as a parameter/example filter, but never claim arbitrary SQL is automatically tenant-scoped or rewrite it by appending a guessed WHERE clause.

SQL execution requirements:

1. Separate server-only connection using `ADMIN_READONLY_DATABASE_URL`. Never fall back to the application's privileged database connection if missing.
2. Dedicated PostgreSQL login role with SELECT only on reviewed views in an explicit reporting schema; no raw base-table access, schema creation, temporary-table creation, elevated memberships, or ability to become another role. Audit existing PUBLIC grants and callable functions. Views must be owned by an appropriately constrained owner and must not accidentally bypass required row-level policies.
3. Every execution runs in a read-only transaction with transaction-local timeouts. No writes, DDL, COPY, arbitrary command execution, or multiple statements. Use an SQL parser for supported read-query validation; regex checks are not the security boundary. Allow SELECT/read-only CTE queries and deny unsafe functions/constructs. Database privileges remain the primary enforcement layer.
4. Defaults: five-second statement timeout, one-second lock timeout, 500 displayed rows, hard maximum 1,000 rows, two-megabyte response limit, and one active query per administrator across replicas. Enforce bounds while fetching, not after loading an unlimited result into memory. Release/rollback connections on every success, timeout, cancellation, or failure path.
5. Do not permit reading credentials through system catalogs, settings, security-definer functions, extension functions, files, or network helpers. Validate the actual reader role against adversarial queries; do not assume read-only transactions alone make arbitrary SELECT safe.
6. Audit actor, query fingerprint, redacted query summary, duration, row count, and outcome. Never log raw literals that may contain secrets. Avoid returning connection strings or internal credentials in errors.
7. Table-browser sorting/filtering must use identifier allowlists and parameterized values. Free-form SQL is a separate restricted execution path, never interpolation into normal application queries.

If the reader role is not provisioned, show a clear configuration error and keep the rest of administration usable. Ship provisioning instructions and tests proving the actual database role restrictions.

## 11. Audit and existing operations — P0

Record staff login outcomes, MFA recovery, membership changes, customer management, document downloads, and SQL execution. Record acting administrator and target customer separately. For local mutations, commit the mutation and success audit in one transaction; a failed audit insert must roll back the mutation. For external operations, record intent and durable success/failure with a correlation ID and appropriate idempotency.

Never send `ADMIN_OPS_SECRET` to the browser. Inventory current `/api/admin/*` routes and document which remain machine-only. Do not automatically expose account deletion, API-key issuance, or migration execution as ordinary UI actions. Preserve necessary server-to-server consumers with their existing explicit authentication while preventing browser shortcuts around staff authorization.

Restrict current AWS/Salesforce diagnostic endpoints to suitable platform permissions or disable them in production. Any mutation such as cache invalidation must not be triggered by an ordinary read-only GET.

## 12. UX and operational requirements

- Follow `docs/01_DESIGN_SYSTEM.md` and existing component conventions after inspection.
- Include loading, empty, permission-denied, expired-session, integration-failure, and missing-configuration states.
- Keyboard-accessible controls, visible focus, semantic tables, explicit form labels, and readable errors.
- Do not cache authenticated admin data publicly. Prevent one account's UI data from persisting when switching to another account.
- Use bounded queries and avoid integration calls in list rendering. Benchmark account/user lists on seeded multi-account data and document results rather than promising an unmeasured production latency.
- New environment variables belong in `.env.example` with descriptions and placeholder values only. Document key rotation, reader-role provisioning, initial admin setup, recovery, rollback, and log retention. No automatic deletion of historical logs in this feature.

## 13. Required tests and acceptance criteria

Use a disposable test database and mocked external providers. Add a focused test runner/browser harness if the repository lacks one.

- [ ] Customer owner/admin/member and anonymous requests cannot load admin pages, submit admin actions, or call admin APIs directly.
- [ ] Platform viewer can inspect permitted records but cannot run SQL or mutate data.
- [ ] Login without completed MFA cannot access any admin data; replayed/expired challenge and recovery codes fail.
- [ ] Session idle/absolute expiry and role revocation take effect on the next protected request.
- [ ] Concurrent membership changes cannot remove the last active platform administrator.
- [ ] Successful login lands on all accounts, including incomplete/unlinked accounts.
- [ ] Opening two different accounts shows the correct users, stores, billing and logs, without changing admin identity.
- [ ] Tampering with account/child-record IDs cannot return a different account's child inside the selected workspace.
- [ ] Global users include users with no account; existing customer routes still enforce tenant isolation.
- [ ] Failed integrations leave local setup visible and accurately report unavailable data.
- [ ] Local management actions and audit records are atomic; reset delivery failures are visible.
- [ ] Log browsing covers all retained sources and excludes secrets, including legacy nested content.
- [ ] Every application table appears in the inventory with a safe projection or explicit restriction.
- [ ] SQL can join permitted records across customers; global scope is clearly displayed.
- [ ] The real SQL reader role blocks INSERT/UPDATE/DELETE, DDL, stacked statements, write CTEs, unsafe functions, raw secret columns, privilege escalation, and protected catalog/settings access.
- [ ] SQL timeout, excessive rows/bytes, cancellation/failure cleanup, and concurrent-query limits work.
- [ ] Missing SQL configuration never causes privileged-connection fallback.
- [ ] CSRF attempts fail; administrator-supplied reasons and stored log content cannot execute scripts.
- [ ] Existing registration, customer login, reset, onboarding, and checkout flows retain expected behavior.

Run `npm run check`, `npm run build`, and relevant tests. Report baseline failures separately; do not claim passing checks that were not run.

## 14. Implementation sequence and completion report

1. Inspect instructions/schema/routes; document data ownership and safe table projections.
2. Add migrations, staff authorization, bootstrap procedure, MFA and admin sessions.
3. Implement the account-first landing page, global users, and account workspace.
4. Add validated customer management and audit records.
5. Implement global/account log viewers.
6. Provision and test reader permissions; implement table browser and inline SQL.
7. Harden diagnostics and run acceptance/regression tests.
8. Finish setup/runbook documentation and report verification results.

No deadline or delivery estimate has been committed. Complete all P0 requirements before calling this feature done. Optional follow-ups: actual customer impersonation, controlled SQL writes, exports, staff invitation email workflow, billing mutations, and external infrastructure-log integration.

Final implementation report must list changed files, migrations and setup commands, required secrets/roles, tests executed and outcomes, unresolved limitations, and exact steps to log in and validate all four original user requirements.

Reference for authorization principles: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
