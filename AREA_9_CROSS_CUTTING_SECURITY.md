# AREA 9 — Cross-cutting (security, roles, sessions)

Detailed QA test cases for the **cross-cutting security surface** of the Appeals Doctor app — authentication guard, multi-tenant data isolation, role gating, session/cookie handling, and diagnostic-endpoint exposure. These checks span **every** functional area rather than one screen.
Each case below includes a **purpose**, **preconditions**, a numbered **step-by-step guide**, and the **expected result**.

> This is the **Asana child ticket for Area 9**. It is **flat** — no sub-tickets. Every test case lives directly under this ticket.

- **Scope:** auth guard + redirects, multi-tenant (account) data isolation, role matrix (owner/admin/member) enforcement, session lifecycle, cookie hardening, and dev/diagnostic-endpoint exposure.
- **Source files:** [`hooks.server.ts`](src/hooks.server.ts) · [`auth/roles.ts`](src/lib/server/auth/roles.ts) · [`auth/session.ts`](src/lib/server/auth/session.ts) · [`auth/cookie.ts`](src/lib/server/auth/cookie.ts) · [`api/aws/diagnostic/+server.ts`](src/routes/api/aws/diagnostic/+server.ts) · [`api/sfdc/diagnostic/pricebook/+server.ts`](src/routes/api/sfdc/diagnostic/pricebook/+server.ts) · [`api/sfdc/ping/+server.ts`](src/routes/api/sfdc/ping/+server.ts) · [`api/files/example/[s3DocId]/+server.ts`](src/routes/api/files/example/[s3DocId]/+server.ts)
- **Role coverage:** `owner` / `admin` / `member` — this area is where role gating and tenancy are **explicitly** verified (unlike most feature screens, which are not role-gated).
- **ID scheme:** `TC-SEC-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 role/tenancy · 🔁 Salesforce-synced · ⛔ negative/edge case (also used to mark **flagged defects / hardening items**)

> Throughout, `{BASE_URL}` is the app origin under test (e.g. `http://localhost:5173` in dev, or the deployed HTTPS origin in staging/prod).

---

## What this area verifies (overview)

This area is largely **security and tenancy verification** and is grounded in the following code behavior:

1. **Auth guard (middleware).** `src/hooks.server.ts` reads the `session` cookie (a raw token), and:
   - **No cookie** → `event.locals.user = null`, request continues as anonymous.
   - **Cookie present** → `getSessionUser(token)` hashes the token (SHA-256) and joins `sessions` → `users`. A **live** session attaches the user to `event.locals.user`. An **unknown/expired/deactivated** session sets `user = null` **and clears the stale cookie** via `clearSessionCookie`.
   - **DB error** → fails **open to anonymous** (`user = null`) so a brief Postgres outage doesn't take the site down. It does **not** grant access — an unreachable DB just means "logged out".
   - Route-level guards in the `(app)` layout are what actually **redirect** unauthenticated users to `/login` (see TC-DASH-40); the hook only decides whether a user is attached.

2. **Session lifecycle.** `src/lib/server/auth/session.ts`: token = 32 random bytes (base64url); only its **SHA-256 hash** is stored, so a DB leak can't be replayed. TTL = **3 hours** (`SESSION_TTL_MS`). `getSessionUser` returns `null` and **opportunistically deletes** the row when `expires_at <= now` **or** the user's `is_active = false`.

3. **Cookie hardening.** `src/lib/server/auth/cookie.ts`: the `session` cookie is always `httpOnly: true`, `sameSite: 'lax'` (deliberately not `strict`, to survive the SP-API OAuth redirect chain), `path: '/'`, `maxAge = 3h`. `secure` is **conditional** — set only when the request setting the cookie is itself over HTTPS (`event.url.protocol === 'https:'`), because dev runs http localhost and https ngrok simultaneously.

4. **Role gating.** `src/lib/server/auth/roles.ts`: `canManageAccountContacts(role)` → `owner` **or** `admin`; `isAccountOwner(role)` → `owner` only; `parseUserRole` defaults anything unrecognized to `member`. `member` must be blocked from all contact-management / point-of-contact (POC) actions, both in the UI and on the server.

5. **Diagnostic / dev-endpoint exposure (hardening risks).** Several endpoints are explicitly documented in-code as "guard or remove before prod":
   - `GET /api/aws/diagnostic` — sign-in required, **no tenancy/role gating**; returns AWS region, bucket, masked access-key id, and a live HeadBucket ping result.
   - `GET /api/sfdc/diagnostic/pricebook` — sign-in required, **no tenancy/role gating**; returns Salesforce `instanceUrl`, pricebook structure and sample rows, **and clears the catalog cache as a side effect** (`invalidatePricebookCache()`).
   - `GET /api/sfdc/ping` — **NO auth check at all**; any anonymous caller receives the Salesforce `instanceUrl`, token issued/expiry timestamps, and REST resource list. **This is a leak defect.**
   - `GET /api/files/example/<s3DocId>` — sign-in required, but looks up `S3_Document__c` **by id only** with **no account-scoped tenancy check**.

---

## 9 · Cross-cutting test cases

### TC-SEC-01 (P1) 🔒 — Multi-tenant isolation: list endpoints return only the signed-in account's data
**Purpose:** confirm every list/data surface (stores, issues/cases, payments, accounts/contacts) is strictly scoped to the signed-in user's account, and that another account's records cannot be reached by guessing IDs.
**Preconditions:** two fully separate accounts **A** and **B**, each with its own stores, cases/issues, payments, and contacts. Note at least one record id from **B** (e.g. a store id, a case id, a payment id).
**Steps:**
1. Sign in as a user of **account A**.
2. Visit each list surface and record what renders: `{BASE_URL}/stores`, `{BASE_URL}/issues`, the payments surface, and the accounts/contacts surface.
3. Confirm every row belongs to account A only.
4. With account A's session still active, directly request a **known account-B** record by id in the URL (e.g. `{BASE_URL}/stores/<B-store-id>`, `{BASE_URL}/stores/<B-store-id>/issues/<B-case-id>`, and any payment detail route by B's id).
5. Also try any JSON/list API these pages call, substituting B's ids.
6. Repeat mirror-image checks signed in as **account B** trying to reach **A**'s ids.
**Expected:** Each list shows **only** the signed-in account's records. Requesting another account's record by id returns **not found / forbidden** (404 or 403) or redirects — never account B's data. No count, name, case number, payment, or contact from the other account ever appears. If any endpoint returns another account's data by raw id, log it as a **P1 tenancy defect**.

### TC-SEC-02 (P1) 🔒 — Unauthenticated access to `/(app)/*` redirects to `/login?next=…`
**Purpose:** verify the `(app)` route group is auth-gated and preserves the intended destination.
**Preconditions:** fully logged out (no `session` cookie).
**Steps:**
1. Clear cookies / use a fresh private window.
2. Navigate directly to a protected route, e.g. `{BASE_URL}/dashboard`.
3. Repeat for several `(app)` routes: `{BASE_URL}/stores`, `{BASE_URL}/issues`, `{BASE_URL}/services`, and a deep link such as `{BASE_URL}/stores/<some-id>/issues/<some-id>`.
4. Inspect the resulting URL after each redirect.
**Expected:** Each request lands on `{BASE_URL}/login` with a `next` query param set to the originally requested path (e.g. `/login?next=/stores`). After signing in, the user is returned to that `next` destination. The hook (`hooks.server.ts`) sets `locals.user = null`; the `(app)` layout guard performs the redirect.

### TC-SEC-03 (P1) 🔒 ⛔ — Expired / invalid session cookie is treated as logged out and cleared
**Purpose:** verify a stale, unknown, or expired `session` token cannot be used, and that the bad cookie is actively cleared.
**Preconditions:** ability to manipulate the `session` cookie (browser dev tools) and, ideally, DB access to expire or delete a session row.
**Steps:**
1. **Invalid token:** sign in, then in dev tools overwrite the `session` cookie value with garbage (e.g. `not-a-real-token`). Reload a protected page and re-request it.
2. **Expired session:** in the DB, set the active session's `expires_at` to a past time (or wait out the 3-hour TTL). Reload a protected page.
3. **Deactivated user:** set the signed-in user's `is_active = false`, reload a protected page.
4. After each, inspect the `session` cookie in dev tools and observe whether you are redirected to `/login`.
**Expected:** In every case the user is treated as **logged out** — protected pages redirect to `/login?next=…` (TC-SEC-02). Per `getSessionUser`, expired or `is_active = false` sessions return `null` and the row is **deleted** opportunistically. Per `hooks.server.ts`, an unknown/dead token causes `clearSessionCookie` to run, so the stale `session` cookie is removed (`Set-Cookie` with an expiry in the past / deleted value). No protected data renders.

### TC-SEC-04 (P2) 🔒 — Role matrix: member blocked from contact-management & POC actions; owner cannot be removed
**Purpose:** verify role gating (`roles.ts`) is enforced both in the UI (hidden controls) and on the server (rejected mutations), and that the account **owner** cannot be removed/demoted.
**Preconditions:** one account with three users — an `owner`, an `admin`, and a `member`. Access to the contact / point-of-contact (POC) management surface.
**Steps:**
1. **Member (UI):** sign in as the `member`. Open the contacts / account-team surface. Confirm add-contact, edit-role, remove-contact, and set-POC controls are **not shown** (or are disabled).
2. **Member (server):** with the member's session, attempt the underlying mutation directly (POST the form action / call the API) to add, edit, remove a contact, or change the POC — using otherwise-valid payloads. (`canManageAccountContacts('member')` → `false`.)
3. **Admin:** sign in as the `admin`; confirm the same management controls **are** available and that a valid add/edit/POC change succeeds (`canManageAccountContacts('admin')` → `true`).
4. **Owner:** sign in as the `owner`; confirm full access, and specifically attempt to **remove or demote the owner** (via UI and via a direct server call).
**Expected:**
- Member: controls hidden in the UI **and** the direct mutation is rejected server-side (403 / validation error) — no data changes. Server enforcement must not rely on the UI alone.
- Admin & owner: management actions succeed.
- The `owner` cannot be removed or demoted through any path (`isAccountOwner` gate) — the attempt is rejected with a clear error and the owner remains intact.

### TC-SEC-05 (P2) 🔒 ⛔ — Direct form-action POST with missing fields / foreign IDs is rejected
**Purpose:** verify server-side validation and tenancy checks reject crafted requests that bypass the UI.
**Preconditions:** a signed-in user of **account A**; a known id belonging to **account B** (store/case/contact/payment).
**Steps:**
1. Identify a mutating form action or API route (e.g. create/update store, upload/attach a file, add a contact, submit a payment).
2. **Missing fields:** POST the action with required fields omitted or empty.
3. **Malformed values:** POST with wrong types / out-of-range values.
4. **Foreign id:** POST an otherwise-valid payload but reference an **account-B** id (e.g. attach a file to B's case, edit B's store).
5. Observe status codes, error messages, and whether any record was created/modified (check the DB / Salesforce).
**Expected:** Missing/malformed requests fail server-side validation (4xx with a field-level error) and write **nothing**. Requests referencing a foreign id fail the tenancy check (403/404) and never touch account B's data. The server never trusts client-supplied ids without confirming they belong to the signed-in account. Any action that mutates cross-account data on a raw id is a **P1 tenancy defect** — record it here.

### TC-SEC-06 (P3) 🔒 — Session cookie is HttpOnly and (in prod) Secure
**Purpose:** verify cookie hardening attributes match `cookie.ts`.
**Preconditions:** ability to sign in over both HTTP (dev localhost) and HTTPS (ngrok/staging/prod), plus dev-tools access to inspect `Set-Cookie`.
**Steps:**
1. Sign in and inspect the `session` cookie in dev tools → Application → Cookies, and the login response's `Set-Cookie` header.
2. Confirm `HttpOnly` is set; confirm the cookie is **not** readable from JS (`document.cookie` must not contain `session`).
3. Confirm `SameSite=Lax` and `Path=/` and a `Max-Age` of `10800` (3h).
4. Sign in over **HTTPS** (ngrok/staging) and confirm the `Secure` attribute is present.
5. Sign in over **plain HTTP localhost** and confirm `Secure` is **absent** (by design, so localhost dev works).
**Expected:** `session` is always `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=10800`, and invisible to `document.cookie`. `Secure` is present on HTTPS requests and absent on plain-HTTP localhost, matching the conditional `secure: isHttps(event)` logic. In production (HTTPS only), the cookie must always carry `Secure`.

### TC-SEC-07 (P2) 🔒 ⛔ — Diagnostic endpoints leak infrastructure detail (hardening item)
**Purpose:** flag that `GET /api/aws/diagnostic` and `GET /api/sfdc/diagnostic/pricebook` are **sign-in-gated only** — no tenancy, no role check — and return infrastructure detail; the pricebook endpoint also mutates shared state. Verify they are guarded or removed before production.
**Preconditions:** one ordinary signed-in `member` user (lowest privilege). Optionally two accounts to prove there's no tenancy scoping.
**Steps:**
1. As a signed-in `member`, GET `{BASE_URL}/api/aws/diagnostic`. Inspect the JSON.
2. As the same `member`, GET `{BASE_URL}/api/sfdc/diagnostic/pricebook` (optionally `?name=SERVICE`). Inspect the JSON.
3. Log **out** and GET both endpoints again.
4. **Side-effect check:** before hitting the pricebook diagnostic, load `{BASE_URL}/services` and note the catalog. Then GET `/api/sfdc/diagnostic/pricebook`, then reload `/services` and observe that the catalog was re-fetched (cache was cleared).
5. Sign in as a **second, unrelated account** and confirm the same infra data is returned regardless of account.
**Expected:**
- Both endpoints return **401 "Sign in required."** when logged out (correct minimum).
- When signed in as **any** user (even a low-privilege `member` of an unrelated account), both return infrastructure detail: `/api/aws/diagnostic` exposes `AWS_REGION`, `AWS_S3_BUCKET`, a **masked** `AWS_ACCESS_KEY_ID`, secret/session presence, resolved region+bucket, and a live HeadBucket ping result; `/api/sfdc/diagnostic/pricebook` exposes the Salesforce `instanceUrl`, pricebook records, counts, and sample `PricebookEntry`/`Product2` rows.
- The pricebook diagnostic **clears the in-process catalog cache** (`invalidatePricebookCache()`) as a side effect — any signed-in user can force a `/services` cache flush by hitting it.
- **Flag as a hardening defect:** these are dev/admin endpoints with no tenancy or role gating. Before prod they must be role-restricted (admin/owner or internal-only), IP-restricted, or removed. The unauthenticated side-effect + info-exposure combination on the pricebook route is especially notable.

### TC-SEC-08 (P1) 🔒 ⛔ — `GET /api/sfdc/ping` has no auth check (unauthenticated Salesforce leak)
**Purpose:** confirm the Salesforce ping endpoint performs **no** authentication and leaks Salesforce environment detail to anonymous callers. **This is a defect.**
**Preconditions:** fully logged out (no `session` cookie); a plain HTTP client (browser private window or `curl`).
**Steps:**
1. With **no** session cookie, GET `{BASE_URL}/api/sfdc/ping` (e.g. `curl -i {BASE_URL}/api/sfdc/ping`).
2. Inspect the response body and status.
3. Confirm no `Set-Cookie`/auth step was involved and that the data returned is real Salesforce environment detail.
**Expected:** The endpoint responds **200** to an **anonymous** caller and returns `{ ok, instanceUrl, tokenIssuedAt, tokenExpiresAt, resourceCount, sampleResources }` — i.e. the Salesforce **instance URL**, token **issue/expiry timestamps**, and a sample of REST resource names. The handler (`api/sfdc/ping/+server.ts`) has **no `if (!locals.user)` guard**, unlike the other diagnostic routes. **Log as a P1 defect:** must be guarded behind auth (and ideally role/IP restricted) or removed before production. Any information disclosure to unauthenticated callers is unacceptable in prod.

### TC-SEC-09 (P2) 🔒 ⛔ — Example-file endpoint has no account-scoped tenancy check
**Purpose:** verify `GET /api/files/example/<s3DocId>` — which is sign-in-gated but looks up `S3_Document__c` **by id only** — cannot be used to reach another account's uploads, or flag that an ownership check is needed.
**Preconditions:** a signed-in user; the `s3DocId` of a legitimate template example (from a `Document_Template__c.Last_Version__c`); and, if obtainable, an `S3_Document__c` id that belongs to **another account's** uploaded file rather than a shared template.
**Steps:**
1. As a signed-in user, GET `{BASE_URL}/api/files/example/<valid-template-s3DocId>` and confirm it 302-redirects to a presigned S3 URL (append `?disposition=inline` to preview).
2. **Guessability:** attempt to enumerate/guess other `S3_Document__c` ids (Salesforce 15/18-char ids) and request them via the same route.
3. **Foreign upload:** if you can obtain the `S3_Document__c` id of another account's **uploaded** (non-template) file, request `{BASE_URL}/api/files/example/<that-id>` and observe whether it serves the file.
4. Log out and confirm the route returns **401**.
**Expected:** Logged out → **401 "Sign in required."** Signed in with a valid template id → **302** to a presigned URL. The handler performs **no account-scoped ownership check** — it resolves `S3_Key__c` purely by `Id`. Verify one of two acceptable outcomes: (a) template example ids are **not** user-guessable and the route only ever resolves shared template documents (never another account's private upload), **or** (b) if any non-template / account-owned `S3_Document__c` can be served through this route, that is a **tenancy defect** — an ownership/account-scope check must be added before it returns a presigned URL. Record which outcome holds.

---

## Run log

| TC ID | Pri | Result | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-SEC-01 | P1 | | | | Tenancy — list endpoints account-scoped |
| TC-SEC-02 | P1 | | | | `(app)/*` → `/login?next=…` |
| TC-SEC-03 | P1 | | | | Expired/invalid cookie → logged out + cleared |
| TC-SEC-04 | P2 | | | | Role matrix; owner not removable |
| TC-SEC-05 | P2 | | | | Direct form POST validation + tenancy |
| TC-SEC-06 | P3 | | | | Cookie HttpOnly / Secure (prod) |
| TC-SEC-07 | P2 | | | | ⛔ diagnostic exposure (aws + pricebook); pricebook clears cache |
| TC-SEC-08 | P1 | | | | ⛔ `/api/sfdc/ping` unauthenticated leak — DEFECT |
| TC-SEC-09 | P2 | | | | ⛔ example-file no tenancy check |
