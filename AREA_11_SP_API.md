# AREA 11 — SP-API (Amazon) connection flow

> **Asana child ticket for Area 11.** Sub-areas **11.1–11.4** below are the **sub-tickets**. Detailed QA test cases for the Amazon Selling Partner API (SP-API / Login-with-Amazon) OAuth connection flow — from a store owner clicking **Connect via SP-API** through Amazon consent, callback token exchange, and the connected confirmation page.
> Each case includes a **purpose**, **preconditions**, a numbered **step-by-step guide**, and the **expected result**.

- **Routes:** `/auth/spapi` · `/auth/spapi/callback` · `/auth/spapi/connected/<storeId>` · `/` (root-callback forward) · `/stores/<id>`
- **Source files:**
  - [`/auth/spapi/+server.ts`](src/routes/auth/spapi/+server.ts) — initiation
  - [`/auth/spapi/callback/+server.ts`](src/routes/auth/spapi/callback/+server.ts) — consent callback + token exchange
  - [`/auth/spapi/connected/[storeId]/+page.server.ts`](src/routes/auth/spapi/connected/[storeId]/+page.server.ts) · [`+page.svelte`](src/routes/auth/spapi/connected/[storeId]/+page.svelte) — confirmation page
  - [`/+page.server.ts`](src/routes/+page.server.ts) — **root-callback forward** (NEW)
  - [`spapi.ts`](src/lib/server/spapi.ts) — LWA helpers, CSRF state, token exchange/refresh
- **Role coverage:** **Client owner** of the store (the account that owns the `stores` row). Tenancy is enforced on every route by joining `stores.account_id` to the signed-in `users.account_id` — a user can only initiate, complete, or view a connection for a store their account owns.
- **ID scheme:** `TC-SPAPI-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 role/tenancy · 🔁 token/session re-issue · ⛔ negative/edge case

---

## What the SP-API flow does (functional overview)

The flow links a local `stores` row to an Amazon Seller Central account via LWA (Login with Amazon) OAuth, then persists refresh/access tokens so the app can call SP-API on the seller's behalf.

**Happy path (end to end):**

1. **Entry** — On a store page (`/stores/<id>?step=connect`) the owner clicks **Connect via SP-API**, hitting `GET /auth/spapi?store=<localStoreId>`.
2. **Initiation** (`/auth/spapi/+server.ts`):
   - Requires an authenticated user (else `303 → /login`).
   - Requires `?store=` (else `400 Missing store parameter`).
   - **Ownership check** — a single SQL join verifies the store belongs to the caller's account (else `404 Store not found`).
   - **Config check** — `getSpapiConfig()` reads the `SPAPI_*` env vars (`SPAPI_APP_ID`, `SPAPI_LWA_CLIENT_ID`, `SPAPI_LWA_CLIENT_SECRET`, `SPAPI_REDIRECT_URI`); if any are missing it throws `503` with an actionable hint pointing at `.env.example`. **`SPAPI_REDIRECT_URI` must EXACTLY match the URI registered in Seller Central**, because LWA validates it at token exchange.
   - Prunes expired state rows, creates a **fresh CSRF state row** (`spapi_oauth_states`: `state`, `store_id`, `user_id`, `expires_at`; TTL **10 min**, 24 random bytes base64url).
   - `303 →` `https://sellercentral.amazon.com/apps/authorize/consent?application_id=<appId>&state=<state>` (plus `version` if `SPAPI_APP_VERSION` is set). Note the `redirect_uri` is **not** in the consent URL — SP-API uses the one registered in the app settings.
3. **Amazon consent** — the seller approves (or denies) in Seller Central.
4. **Amazon returns to the app.** Amazon redirects the OAuth result to the app's **registered redirect URI**, which — depending on how the app is configured in Seller Central and when tunnelling through ngrok — is often **the bare site root** (`https://<host>/?spapi_oauth_code=...&state=...&selling_partner_id=...`) rather than `/auth/spapi/callback`.
   - **Root-callback forward** (`/+page.server.ts`, NEW): the root route detects the Amazon params (`spapi_oauth_code`, or `selling_partner_id`, or an `error`/`error_description` paired with `state`) and **`303`-forwards to `/auth/spapi/callback` preserving the full query string**, so the real handler runs and the connection completes regardless of which URI Amazon hit. With no Amazon params, root just bounces to `/dashboard`.
5. **Callback** (`/auth/spapi/callback/+server.ts`):
   - Requires `state` (else `400 Missing state parameter`).
   - **`consumeOauthState(state)`** — an **atomic** `DELETE ... RETURNING` consumes the state row (single-use / replay-safe) and returns `{ storeId, userId }`; a missing, already-consumed, or expired (`expires_at < now`) state yields `400 Invalid or expired OAuth state`.
   - Captures the raw callback params **minus the one-time `spapi_oauth_code`** (redacted) into `spapi_callback_params` for audit.
   - **Denial / no code** — if Amazon returned `error`/`error_description`, or there is no `spapi_oauth_code`, the store is set `spapi_status='error'` (with `spapi_last_error`) and it `303 → /stores/<id>?spapi=denied`.
   - **Token exchange** — `exchangeCodeForTokens(code)` POSTs to the LWA token endpoint (`grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`). On success the store is updated: `spapi_status='connected'`, `spapi_refresh_token`, `spapi_access_token`, `spapi_access_token_expires_at` (= now + `expires_in`), `spapi_connected_seller_id`, `spapi_connected_at=now()`, `spapi_last_error=NULL`, and `seller_id` is back-filled if empty. On exchange failure the store is set `spapi_status='error'` and it `303 → /stores/<id>?spapi=error`.
   - **Session re-issue** (🔁): the CSRF state proved which user (`stateRow.userId`) initiated the flow, so the callback **creates a fresh session and sets the cookie**. This guarantees the confirmation page is reachable even if the browser dropped the original session cookie during the cross-site Amazon redirect chain (strict-cookie sessions, third-party-cookie blockers). This step is non-fatal — a failure is logged and the flow continues.
   - `303 → /auth/spapi/connected/<storeId>`.
6. **Confirmation** (`/auth/spapi/connected/[storeId]`): re-checks tenancy (`404` if not the account's store), redirects away if the store isn't actually `connected` (`?spapi=error|denied`), otherwise renders the success card (store name, marketplaces, country, Selling Partner ID, connected timestamp, access-token TTL, optional Salesforce store id, and a collapsible raw-callback-params panel).

**Token lifecycle:** `getStoreAccessToken(storeId)` lazily refreshes a stale/missing access token via the stored refresh token (`refreshAccessToken`, with a 60s expiry skew), updating `spapi_access_token` / `_expires_at` and re-marking `spapi_status='connected'`.

---

## 11.1 Initiation (`/auth/spapi`)

### TC-SPAPI-01 (P1) — Connect via SP-API redirects to Amazon consent
**Purpose:** verify the owner-initiated handoff builds the correct Amazon consent URL.
**Preconditions:** signed-in owner of store `<id>`; `SPAPI_*` env vars configured.
**Steps:**
1. Open `{BASE_URL}/stores/<id>?step=connect`.
2. Click **Connect via SP-API** (issues `GET {BASE_URL}/auth/spapi?store=<id>`).
3. Follow the response (inspect the `Location` header / network tab).
**Expected:** `303` redirect to `https://sellercentral.amazon.com/apps/authorize/consent?application_id=<SPAPI_APP_ID>&state=<state>` (plus `version=<SPAPI_APP_VERSION>` if configured). The `state` value is a fresh random token and a matching `spapi_oauth_states` row now exists for `<id>` and the signed-in user. No `redirect_uri` appears in the consent URL (Amazon uses the registered one).

### TC-SPAPI-02 (P1) 🔒 — Unauthenticated initiation redirects to /login
**Purpose:** verify initiation is auth-gated.
**Preconditions:** logged out.
**Steps:**
1. While logged out, navigate to `{BASE_URL}/auth/spapi?store=<id>`.
**Expected:** `303 → /login`. No consent URL is issued and no `spapi_oauth_states` row is created.

### TC-SPAPI-03 (P2) ⛔ — Missing `?store=` returns 400
**Purpose:** verify the required `store` parameter is enforced.
**Preconditions:** signed-in user.
**Steps:**
1. Navigate to `{BASE_URL}/auth/spapi` (no `store` query param).
**Expected:** `400` error with message **"Missing store parameter."** No state row created, no redirect to Amazon.

### TC-SPAPI-04 (P1) 🔒 (tenancy) — Store not owned / nonexistent returns 404
**Purpose:** verify a user cannot initiate a connection for another account's (or a nonexistent) store.
**Preconditions:** signed-in user A; a store `<foreignId>` owned by a **different** account (and/or a random nonexistent id).
**Steps:**
1. As user A, navigate to `{BASE_URL}/auth/spapi?store=<foreignId>`.
2. Repeat with a nonexistent id.
**Expected:** `404` error **"Store not found."** in both cases (the SQL join to the caller's `account_id` returns no row). **No consent URL is issued** and no state row is created — no cross-account handoff.

### TC-SPAPI-05 (P2) ⛔ — Missing SPAPI_* config returns 503 with hint
**Purpose:** verify a clear, actionable failure when the integration isn't configured.
**Preconditions:** signed-in owner of an owned store; one or more of `SPAPI_APP_ID` / `SPAPI_LWA_CLIENT_ID` / `SPAPI_LWA_CLIENT_SECRET` / `SPAPI_REDIRECT_URI` **unset** (restart dev server after clearing).
**Steps:**
1. Navigate to `{BASE_URL}/auth/spapi?store=<id>`.
**Expected:** `503` error whose message names the missing var(s) and hints "Once the `SPAPI_*` vars are filled in (see `.env.example`) and the dev server restarted, try Connect again." **No consent redirect.** An error-log entry (`source: spapi.connect`, `operation: config`) is recorded.

### TC-SPAPI-06 (P2) — Fresh state per attempt; expired states pruned/unreusable
**Purpose:** verify each initiation mints a new single-use state and stale states cannot be reused.
**Preconditions:** signed-in owner of store `<id>`.
**Steps:**
1. Initiate the flow twice for the same store (two separate clicks); capture the `state` value each time.
2. Inspect `spapi_oauth_states` — confirm each attempt inserted a distinct row.
3. Force a state row older than the 10-min TTL (or wait past TTL), then trigger any new initiation (which runs `pruneExpiredOauthStates`).
**Expected:** Every attempt produces a **different** `state`. Expired rows are deleted by the prune step and can no longer be consumed at callback (see TC-SPAPI-23 / TC-SPAPI-25). Reusing an old/consumed state fails.

---

## 11.2 Consent & callback success (`/auth/spapi/callback`)

### TC-SPAPI-10 (P1) — Approve consent exchanges code and persists tokens
**Purpose:** verify a successful callback exchanges the code and fully updates the store row.
**Preconditions:** valid pending state row from TC-SPAPI-01; seller approves consent in Seller Central; `SPAPI_REDIRECT_URI` exactly matches the registered URI.
**Steps:**
1. Complete Amazon consent by **approving**.
2. Let the callback run (`spapi_oauth_code`, `selling_partner_id`, `state` present).
3. Inspect the `stores` row for `<id>`.
**Expected:** `exchangeCodeForTokens` succeeds against LWA and the store is updated: `spapi_status='connected'`, `spapi_refresh_token` stored, `spapi_access_token` stored, `spapi_access_token_expires_at` = now + `expires_in`, `spapi_connected_seller_id` = the `selling_partner_id`, `spapi_connected_at` = now, `spapi_last_error` cleared, and `seller_id` back-filled if it was empty.

### TC-SPAPI-11 (P1) — Success redirects to the connected confirmation page
**Purpose:** verify the post-success redirect and the confirmation content.
**Preconditions:** TC-SPAPI-10 just completed successfully.
**Steps:**
1. Observe the redirect after token exchange.
2. Read the confirmation page.
**Expected:** `303 → /auth/spapi/connected/<storeId>`. The page shows a green check, "You're connected to Amazon", the **store name**, **Selling Partner ID**, **Connected at** timestamp, and **Access token valid for** (relative TTL, "auto-refreshed"); marketplaces/country/Salesforce store id appear when present.

### TC-SPAPI-12 (P1) — Store shows connected badge; success banner on store page
**Purpose:** verify the connected state surfaces on the store card/detail and via the query param.
**Preconditions:** store `<id>` connected via TC-SPAPI-10.
**Steps:**
1. Open `{BASE_URL}/stores` and `{BASE_URL}/stores/<id>`; observe the SP-API badge.
2. Open `{BASE_URL}/stores/<id>?spapi=connected`.
**Expected:** The store card/detail shows a **green "connected" SP-API badge**. `?spapi=connected` renders a **success banner**.

### TC-SPAPI-13 (P1) 🔁 — Root-callback forward + session resilience
**Purpose:** verify that when Amazon returns the OAuth result to the **site root**, the connection still completes and tokens persist — and that a dropped session cookie does not bounce the user to /login.
**Preconditions:** valid pending state row; seller approved; simulate Amazon redirecting to root (`{BASE_URL}/?spapi_oauth_code=...&state=...&selling_partner_id=...`). Optionally clear/expire the browser session cookie mid-chain to simulate a dropped cookie.
**Steps:**
1. Land on the **root** with the Amazon params (do **not** go directly to `/auth/spapi/callback`).
2. Optionally delete the session cookie before this request to simulate the cross-site cookie drop.
3. Follow the redirects.
**Expected:** The root route (`/+page.server.ts`) detects the Amazon params and `303`-forwards to `/auth/spapi/callback` **preserving the full query string**; the callback consumes the state, exchanges the code, and **persists the tokens** exactly as in TC-SPAPI-10. Because the consumed state proves `stateRow.userId`, the callback **re-issues a session cookie** and the user lands on `/auth/spapi/connected/<storeId>` — **not** bounced to `/login`, even with the original cookie dropped. (With no Amazon params, root instead `303 → /dashboard`.)

### TC-SPAPI-14 (P3) — Raw callback params captured for audit; code never persisted
**Purpose:** verify the audit trail stores Amazon's params but never the one-time code.
**Preconditions:** a store connected via a real/simulated callback.
**Steps:**
1. After a successful callback, inspect `stores.spapi_callback_params` (JSON) for `<id>`.
2. Open the confirmation page and expand **"Raw Amazon callback parameters."**
**Expected:** The persisted params include what Amazon sent (e.g. `selling_partner_id`, `state`, `mws_auth_token` if present) **but never `spapi_oauth_code`** (redacted before persistence). The confirmation page's raw-params panel notes the one-time code is intentionally not persisted. `spapi_oauth_code` appears nowhere at rest.

---

## 11.3 Negative / edge cases

### TC-SPAPI-20 (P1) ⛔ — Seller denies consent
**Purpose:** verify Amazon-side denial is handled and surfaced.
**Preconditions:** valid pending state row; seller **denies** consent (Amazon returns `error`/`error_description`).
**Steps:**
1. On the Amazon consent screen, deny access.
2. Let the callback run.
3. Inspect the store row and the resulting page.
**Expected:** The store is set `spapi_status='error'` with `spapi_last_error` = Amazon's error (and `spapi_callback_params` captured); `303 → /stores/<id>?spapi=denied`; the store page shows the **orange "denied" banner**. No tokens stored.

### TC-SPAPI-21 (P1) ⛔ — LWA token exchange fails
**Purpose:** verify a token-exchange failure (network / invalid code / redirect-uri mismatch) is handled.
**Preconditions:** valid state row; force `exchangeCodeForTokens` to fail (e.g. invalid code, network error, or `SPAPI_REDIRECT_URI` not matching the registered URI).
**Steps:**
1. Trigger the callback with a code that fails exchange at LWA.
2. Inspect the store row and the resulting page.
**Expected:** The store is set `spapi_status='error'` with `spapi_last_error` = the exchange error; `303 → /stores/<id>?spapi=error`; the store page shows the **red "error" banner** with the last error. An error-log entry (`source: spapi.callback`, `operation: exchange_code`) is recorded. No tokens stored.

### TC-SPAPI-22 (P1) ⛔ (CSRF) — Missing state returns 400
**Purpose:** verify the callback rejects requests with no CSRF state.
**Preconditions:** none.
**Steps:**
1. Hit `{BASE_URL}/auth/spapi/callback?spapi_oauth_code=abc&selling_partner_id=A1` (no `state`).
**Expected:** `400` error **"Missing state parameter."** No store update, no token exchange.

### TC-SPAPI-23 (P1) ⛔ (CSRF / replay) — Invalid or already-consumed state returns 400
**Purpose:** verify single-use / atomic state consumption blocks replay.
**Preconditions:** a `state` value that is fabricated, already consumed, or never existed.
**Steps:**
1. Complete a real callback once (consuming its state).
2. Replay the **same** callback URL (same `state`).
3. Separately, hit the callback with a made-up `state`.
**Expected:** Both the replay and the fabricated state return `400` **"Invalid or expired OAuth state. Please retry."** No tokens are stored. Because `consumeOauthState` is an atomic `DELETE ... RETURNING`, a consumed state cannot be reused.

### TC-SPAPI-24 (P2) ⛔ — Tampered/foreign state does not enable cross-account connection
**Purpose:** verify a state row only ever completes the connection for the store/user it was minted for.
**Preconditions:** a valid state row minted by user A for store `<A-id>`.
**Steps:**
1. As user B (or unauthenticated), complete the callback using user A's `state`.
2. Inspect which store row (if any) changed.
**Expected:** The callback binds the result to `stateRow.storeId`/`stateRow.userId` from the consumed row — it can **only** update store `<A-id>`, and the re-issued session is for user A (the proven initiator). A tampered/foreign state that doesn't match a stored row is rejected as invalid (`400`). No cross-account connection is created and no other account's store is modified.

### TC-SPAPI-25 (P3) ⛔ — Expired state (past TTL) rejected as invalid
**Purpose:** verify states older than the 10-min TTL cannot complete a connection.
**Preconditions:** a state row whose `expires_at` is in the past (age it in the DB or wait past TTL).
**Steps:**
1. Trigger the callback using the expired `state`.
**Expected:** `consumeOauthState` returns null (expired) → `400` **"Invalid or expired OAuth state. Please retry."** No tokens stored.

---

## 11.4 Connected page & reconnect

### TC-SPAPI-30 (P1) 🔒 (tenancy) — Confirmation page for another account's store returns 404
**Purpose:** verify the connected page is account-scoped.
**Preconditions:** store `<foreignId>` belongs to a **different** account; sign in as user A.
**Steps:**
1. As user A, navigate to `{BASE_URL}/auth/spapi/connected/<foreignId>`.
**Expected:** `404` **"Store not found."** No store data (name, seller id, tokens, callback params) is leaked.

### TC-SPAPI-31 (P2) ⛔ — Connected page for a non-connected store redirects
**Purpose:** verify the confirmation page only celebrates a genuine connection.
**Preconditions:** an owned store whose `spapi_status` is **not** `connected` (e.g. `error` or `denied` from a failed/denied flow, or a never-connected store).
**Steps:**
1. Navigate directly to `{BASE_URL}/auth/spapi/connected/<id>` for that store.
**Expected:** `303 → /stores/<id>?spapi=error` when status is `error`, otherwise `?spapi=denied`. The success card is never shown for a store that isn't `connected`.

### TC-SPAPI-32 (P2) — Reconnect re-runs the full flow
**Purpose:** verify an already-connected store can reconnect and refresh its tokens.
**Preconditions:** store `<id>` currently `spapi_status='connected'`.
**Steps:**
1. From the store page (or the confirmation page's "reconnect" affordance), start the SP-API flow again for `<id>`.
2. Approve consent and complete the callback.
3. Inspect the store row before/after.
**Expected:** A **reconnect** link/affordance is available on an already-connected store; re-running the flow mints a new state, exchanges a new code, and updates the store back to `spapi_status='connected'` with **refreshed** `spapi_access_token` / `_refresh_token` / `_expires_at` / `spapi_connected_at`. No duplicate store rows are created.

### TC-SPAPI-33 (P3) — Access-token expiry refresh (or reconnect prompt)
**Purpose:** confirm intended behavior once the stored access token is past expiry.
**Preconditions:** store `<id>` connected, with `spapi_access_token_expires_at` set in the **past** (age it in the DB) and a valid `spapi_refresh_token` present.
**Steps:**
1. Trigger an app action that needs an SP-API access token for `<id>` (exercises `getStoreAccessToken`).
2. Observe whether a fresh access token is minted, and inspect the store row.
**Expected:** The app **lazy-refreshes** via the stored refresh token (`refreshAccessToken`), updating `spapi_access_token` and `spapi_access_token_expires_at` and keeping `spapi_status='connected'` (with the 60s skew ensuring near-expiry tokens are refreshed proactively). If no usable refresh token exists, the app should surface a **reconnect prompt** rather than a hard failure — confirm the intended UX with product.

---

## Run log

| TC ID | Pri | Result | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-SPAPI-01 | P1 | | | | |
| TC-SPAPI-02 | P1 | | | | |
| TC-SPAPI-03 | P2 | | | | |
| TC-SPAPI-04 | P1 | | | | |
| TC-SPAPI-05 | P2 | | | | |
| TC-SPAPI-06 | P2 | | | | |
| TC-SPAPI-10 | P1 | | | | |
| TC-SPAPI-11 | P1 | | | | |
| TC-SPAPI-12 | P1 | | | | |
| TC-SPAPI-13 | P1 | | | | |
| TC-SPAPI-14 | P3 | | | | |
| TC-SPAPI-20 | P1 | | | | |
| TC-SPAPI-21 | P1 | | | | |
| TC-SPAPI-22 | P1 | | | | |
| TC-SPAPI-23 | P1 | | | | |
| TC-SPAPI-24 | P2 | | | | |
| TC-SPAPI-25 | P3 | | | | |
| TC-SPAPI-30 | P1 | | | | |
| TC-SPAPI-31 | P2 | | | | |
| TC-SPAPI-32 | P2 | | | | |
| TC-SPAPI-33 | P3 | | | | |
