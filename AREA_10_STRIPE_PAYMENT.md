# AREA 10 — Stripe payment (detailed)

Detailed QA test cases for the **Stripe payment flow** — server-priced PaymentIntent → embedded Payment Element → success/reconciliation.
This document is the **Asana child ticket for Area 10**; the sub-areas **10.1–10.3** below are its **sub-tickets**.
Each case includes a **Purpose**, **Preconditions**, a numbered **step-by-step guide**, and the **Expected** result.

- **Routes:** `POST /api/checkout/payment_intent` · `POST /api/checkout` (legacy, 410) · `/checkout/payment` · `/checkout/success`
- **Source files:**
  [`payment_intent/+server.ts`](src/routes/api/checkout/payment_intent/+server.ts) ·
  [`checkout/+server.ts`](src/routes/api/checkout/+server.ts) ·
  [`checkout/payment/+page.svelte`](src/routes/checkout/payment/+page.svelte) ·
  [`checkout/success/+page.server.ts`](src/routes/checkout/success/+page.server.ts) ·
  [`checkout/success/+page.svelte`](src/routes/checkout/success/+page.svelte) ·
  [`stripe.ts`](src/lib/server/stripe.ts) ·
  [`salesforce/contracts.ts`](src/lib/server/salesforce/contracts.ts)
- **Role coverage:** Client (`owner` / `admin` / `member`) — checkout is auth-gated but **not** role-gated; any signed-in user of an account can pay.
- **ID scheme:** `TC-STRIPE-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 auth/tenancy · 🔁 Salesforce-synced · ⛔ negative/edge case
- **⚠️ Environment:** run every case with **Stripe TEST mode** keys only (`sk_test_…` / `pk_test_…`). Never exercise these against live keys.

---

## What the Stripe flow does (functional overview)

The checkout is a **server-priced** embedded flow. The browser never dictates the amount:

1. **Client → PaymentIntent API.** `/checkout/payment` (`+page.svelte`) POSTs the user's selected `pricebookEntryIds` (and an optional `storeId`) to `POST /api/checkout/payment_intent`.
2. **Server re-prices everything.** The endpoint requires a signed-in user, de-duplicates the ids, then looks up **every** product server-side via `getCatalogProduct(id, 'service')` against Salesforce. It **NEVER trusts a client-submitted total** — the charge is `Σ round(unitPrice × 100)` computed on the server. Products that vanished from the catalog are dropped; if all are gone it 404s; if the sum is `< $0.50` it 400s.
3. **Stripe PaymentIntent created.** `getStripe().paymentIntents.create(...)` with `automatic_payment_methods.enabled = true`, `receipt_email`, a human-readable `description`, and **metadata** carrying `user_id`, `account_id`, `store_id`, `pricebook_entry_ids`, `product_ids`. The endpoint returns `{ clientSecret, amount, currency, itemCount, missing }`.
4. **Payment Element confirms.** The page mounts the embedded Stripe **Payment Element** with that `clientSecret` and calls `stripe.confirmPayment({ elements, confirmParams: { return_url: '{BASE_URL}/checkout/success' } })`. On success Stripe redirects the browser to `/checkout/success`; on error the flow stays on the page and surfaces `result.error.message`.
5. **Reconciliation on the success page.** `/checkout/success` retrieves the PaymentIntent by id, and **only if `pi.status === 'succeeded'`** idempotently UPSERTs a local `service_contracts` row (keyed on `stripe_payment_intent_id`) + line items, then pushes a Salesforce **ServiceContract** + **ContractLineItems** (+ best-effort Cases). Term is **3 months**.

> ⚠️ **Known reconciliation risk — no webhook.** There is **no** `/api/stripe/webhook` handler yet. A successful payment is reconciled into local/SF records **only** when the browser actually lands on `/checkout/success`. If the customer closes the tab (or loses network) after Stripe captures but before the redirect resolves, Stripe has the money but **no local or SF contract may exist**. This is exercised explicitly in **TC-STRIPE-42** and must be tracked as a defect / covered by a reconciliation plan.

---

## 10.1 PaymentIntent API (`/api/checkout/payment_intent`)

### TC-STRIPE-01 (P1) — Valid POST returns clientSecret with server-summed amount
**Purpose:** confirm a valid authenticated request returns a usable `clientSecret` and a server-computed total.
**Preconditions:** signed-in client user; ≥2 active service products in the Salesforce catalog with known `pricebookEntryId`s and unit prices.
**Steps:**
1. Sign in as a client user.
2. `POST /api/checkout/payment_intent` with `{ "pricebookEntryIds": ["01u…A", "01u…B"] }` (or reach it by loading `/checkout/payment` with those selections).
3. Read the JSON response.
4. Note the two products' unit prices and their `currency` in Salesforce.
**Expected:** `200` with `{ clientSecret, amount, currency, itemCount, missing }`. `amount` = `Σ round(unitPrice × 100)` of the priced items (in cents), computed server-side. `currency` = the first product's `currency` (lower-cased). `itemCount` = number of priced items. `missing` = `[]`.

### TC-STRIPE-02 (P1) 🔒 — Logged-out POST is rejected
**Purpose:** verify checkout is auth-gated.
**Preconditions:** logged out (no session cookie).
**Steps:**
1. `POST /api/checkout/payment_intent` with a valid `pricebookEntryIds` body while unauthenticated.
**Expected:** `401` with message **"You must be signed in to check out."** No PaymentIntent is created in Stripe.

### TC-STRIPE-03 (P1) ⛔ (security) — Tampered client price is ignored
**Purpose:** prove the server ignores any client-supplied amount/price and charges only the server-computed total.
**Preconditions:** signed-in user; a product whose real price is known (e.g. $300).
**Steps:**
1. Craft a `POST` body that adds bogus price fields, e.g. `{ "pricebookEntryIds": ["01u…"], "amount": 1, "total": 0.5, "unitPrice": 0.01 }`.
2. Submit it.
3. Inspect the returned `amount` and the resulting PaymentIntent in the Stripe dashboard.
**Expected:** The extra fields are ignored. `amount` equals the **server-computed** cents for that pricebook entry only (e.g. `30000`), never the injected value. Stripe PaymentIntent amount matches the server figure.

### TC-STRIPE-04 (P2) ⛔ — Empty pricebookEntryIds
**Purpose:** verify the required-field guard.
**Preconditions:** signed-in user.
**Steps:**
1. `POST` with `{ "pricebookEntryIds": [] }` (or omit the field entirely).
**Expected:** `400` with message **"pricebookEntryIds is required."** No PaymentIntent created.

### TC-STRIPE-05 (P2) ⛔ — More than 20 items
**Purpose:** verify the max-line-item cap (`MAX_LINE_ITEMS = 20`).
**Preconditions:** signed-in user.
**Steps:**
1. `POST` with an array of **21+** distinct `pricebookEntryIds`.
**Expected:** `400` with message **"Max 20 items per checkout."** No PaymentIntent created.

### TC-STRIPE-06 (P2) ⛔ — All selected services deactivated/missing (+ partial)
**Purpose:** verify behavior when catalog lookups return nothing, and partial-drop behavior.
**Preconditions:** signed-in user; at least one `pricebookEntryId` that is deactivated / no longer resolvable, plus (for the partial case) one that is still active.
**Steps:**
1. `POST` with only **deactivated/missing** ids.
2. Then `POST` with a **mix**: one missing id + one active id.
**Expected:**
- All-missing → `404` with message **"Selected services are no longer available."** No PaymentIntent.
- Mixed → `200`; the missing id is dropped and returned in `missing`; the amount reflects **only** the surviving priced item(s).

### TC-STRIPE-07 (P2) ⛔ — Order total below the minimum charge amount
**Purpose:** verify the Stripe `$0.50` minimum guard.
**Preconditions:** signed-in user; a product priced so the summed total is `< $0.50` (i.e. `totalCents < 50`).
**Steps:**
1. `POST` with an id whose priced total is under the minimum.
**Expected:** `400` with message **"Order total is below the minimum charge amount."** No PaymentIntent created.

### TC-STRIPE-08 (P2) ⛔ — Non-JSON / malformed body
**Purpose:** verify malformed request bodies are rejected before pricing.
**Preconditions:** signed-in user.
**Steps:**
1. `POST` with a non-JSON payload (e.g. `Content-Type: application/json` but body `not-json{`, or raw text).
**Expected:** `400` with message **"Body must be JSON."** No PaymentIntent created.

### TC-STRIPE-09 (P2) 🔒 — storeId for a store the user does not own
**Purpose:** verify a foreign/unauthorized `storeId` is ignored, not attached, and never leaks.
**Preconditions:** signed-in user in account A; a valid `storeId` belonging to a **different** account B.
**Steps:**
1. `POST` a valid `pricebookEntryIds` body plus `{ "storeId": "<store owned by account B>" }`.
2. Inspect the response and the PaymentIntent metadata.
**Expected:** Request still succeeds (`200`). The ownership check (`s.account_id = u.account_id`) fails, so the store is **not** attached — PaymentIntent metadata `store_id` is empty. No error is raised and no data about account B's store is returned.

### TC-STRIPE-10 (P3) — PaymentIntent metadata carries identifiers
**Purpose:** verify reconciliation metadata is present for the (future) webhook and the success page.
**Preconditions:** signed-in user; access to the Stripe TEST dashboard.
**Steps:**
1. Complete a valid `POST` to create a PaymentIntent.
2. Open the PaymentIntent in the Stripe dashboard → Metadata.
**Expected:** Metadata includes `user_id` (local user id), `account_id` (SFDC Account id, or empty if unlinked), `pricebook_entry_ids` (comma-joined), `product_ids` (comma-joined), and `store_id` (validated store or empty). The `description` shows the "Customer: … | SFDC Account: … | Local user id: …" note plus the service lines.

### TC-STRIPE-11 (P3) — Duplicate ids de-duplicated before pricing
**Purpose:** verify duplicates in the request are collapsed so the customer isn't charged twice.
**Preconditions:** signed-in user; one active product priced at a known amount.
**Steps:**
1. `POST` with `{ "pricebookEntryIds": ["01u…X", "01u…X", " 01u…X "] }` (repeats + whitespace).
2. Inspect `itemCount` and `amount`.
**Expected:** The ids are trimmed and de-duplicated (`new Set(...)`), so `itemCount` = `1` and `amount` = a single unit price. Whitespace-only/empty entries are stripped.

### TC-STRIPE-12 (P3) ⛔ (deprecated) — Legacy /api/checkout returns 410 Gone
**Purpose:** verify the old Checkout-Session endpoint is retired.
**Preconditions:** none (auth not required to observe the 410).
**Steps:**
1. `POST /api/checkout` with any body.
**Expected:** `410 Gone` with message **"This endpoint has been replaced by /api/checkout/payment_intent."** No Stripe Checkout Session is created.

---

## 10.2 Stripe test-card matrix (Payment Element)

> Use **Stripe test mode** keys. For every test card: use **any future expiry** date, **any 3-digit CVC** (**4 digits for Amex**), and **any ZIP/postal code**. Drive these through the embedded Payment Element at `/checkout/payment`; on success Stripe redirects to `{BASE_URL}/checkout/success`.

| ID | Card number | Scenario | Expected |
|---|---|---|---|
| TC-STRIPE-20 (P1) | `4242 4242 4242 4242` | Visa — success | Redirect to `/checkout/success`; local contract + line items + SF ServiceContract created |
| TC-STRIPE-21 (P1) | `4000 0025 0000 3155` | 3DS / SCA authentication required | Auth modal appears; complete → success + redirect; fail/cancel → error, **no charge** |
| TC-STRIPE-22 (P1) ⛔ | `4000 0000 0000 0002` | Generic decline | Inline error, **no redirect**, **no contract** created |
| TC-STRIPE-23 (P2) ⛔ | `4000 0000 0000 9995` | Insufficient funds decline | Inline "insufficient funds" error; no redirect; no contract |
| TC-STRIPE-24 (P2) ⛔ | `4000 0000 0000 0069` | Expired card | Inline "card has expired" error; no redirect; no contract |
| TC-STRIPE-25 (P2) ⛔ | `4000 0000 0000 0127` | Incorrect CVC | Inline "security code is incorrect" error; no redirect; no contract |
| TC-STRIPE-26 (P2) ⛔ | `4000 0000 0000 0119` | Processing error | Inline processing-error message; safe to retry; no contract |
| TC-STRIPE-27 (P2) ⛔ | `4100 0000 0000 0019` | Fraudulent / blocked | Payment blocked; inline error; no redirect; no contract |
| TC-STRIPE-28 (P3) | `5555 5555 5555 4444` | Mastercard — success | Redirect to `/checkout/success`; contract + SF ServiceContract created |
| TC-STRIPE-29 (P3) | `3782 822463 10005` | Amex (4-digit CVC) — success | Redirect to `/checkout/success`; contract created; 4-digit CVC accepted |

### TC-STRIPE-20 (P1) — Visa success end-to-end
**Purpose:** verify the happy path from Payment Element to persisted records.
**Preconditions:** signed-in user; a valid selection reached `/checkout/payment`; TEST keys configured.
**Steps:**
1. On `/checkout/payment`, enter `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
2. Click **Pay `<amount>`**.
3. Wait for the redirect.
**Expected:** Browser redirects to `{BASE_URL}/checkout/success?payment_intent=pi_…`. A local `service_contracts` row is created (UPSERT by `stripe_payment_intent_id`) with line items, and a Salesforce **ServiceContract** + **ContractLineItems** are created (`sync_status = 'synced'`).

### TC-STRIPE-21 (P1) — 3DS / SCA authentication
**Purpose:** verify the SCA challenge flow and that failed/cancelled auth does not charge.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Enter `4000 0025 0000 3155`, any future expiry, any CVC, any ZIP; click **Pay**.
2. When the Stripe 3DS modal appears, **Complete** the authentication.
3. Repeat with a fresh PaymentIntent and instead **Fail**/cancel the modal.
**Expected:** Completing the challenge → redirect to `/checkout/success` and records created. Failing/cancelling → the modal closes, the flow returns to `/checkout/payment` with an error, **no charge** and **no contract**.

### TC-STRIPE-22 (P1) ⛔ — Generic decline
**Purpose:** verify a declined card produces an inline error and no side effects.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Enter `4000 0000 0000 0002`, any future expiry, any CVC, any ZIP; click **Pay**.
**Expected:** `stripe.confirmPayment` returns `result.error`; a red alert shows the decline message; **no redirect**; no local/SF contract created.

### TC-STRIPE-23 (P2) ⛔ — Insufficient funds
**Purpose:** verify the insufficient-funds decline.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Enter `4000 0000 0000 9995`; click **Pay**.
**Expected:** Inline "insufficient funds" error; no redirect; no contract.

### TC-STRIPE-24 (P2) ⛔ — Expired card
**Purpose:** verify the expired-card decline.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Enter `4000 0000 0000 0069`; click **Pay**.
**Expected:** Inline "card has expired" error; no redirect; no contract.

### TC-STRIPE-25 (P2) ⛔ — Incorrect CVC
**Purpose:** verify the incorrect-CVC decline.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Enter `4000 0000 0000 0127`; click **Pay**.
**Expected:** Inline "security code is incorrect" error; no redirect; no contract.

### TC-STRIPE-26 (P2) ⛔ — Processing error (safe retry)
**Purpose:** verify a processing error surfaces and can be safely retried.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Enter `4000 0000 0000 0119`; click **Pay**.
2. Then retry with a success card.
**Expected:** Inline processing-error message; no redirect; no contract. The retry with a good card succeeds normally (no duplicate charge from the failed attempt).

### TC-STRIPE-27 (P2) ⛔ — Fraudulent / blocked
**Purpose:** verify a fraud-blocked card is refused.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Enter `4100 0000 0000 0019`; click **Pay**.
**Expected:** Payment is blocked; inline error; no redirect; no contract.

### TC-STRIPE-28 (P3) — Mastercard success
**Purpose:** verify a non-Visa network succeeds end-to-end.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Enter `5555 5555 5555 4444`, any future expiry, any CVC, any ZIP; click **Pay**.
**Expected:** Redirect to `/checkout/success`; local + SF contract created.

### TC-STRIPE-29 (P3) — Amex success (4-digit CVC)
**Purpose:** verify Amex with a 4-digit CVC succeeds.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Enter `3782 822463 10005`, any future expiry, a **4-digit** CVC, any ZIP; click **Pay**.
**Expected:** The Payment Element accepts the 4-digit CVC; payment succeeds; redirect to `/checkout/success`; contract created.

### TC-STRIPE-30 (P2) ⛔ — Incomplete Payment Element blocks submit
**Purpose:** verify Stripe's inline validation prevents submitting an incomplete form.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Leave the card number (or expiry/CVC) blank or partial.
2. Click **Pay**.
**Expected:** Stripe shows inline field-level validation on the Payment Element; the submit is blocked; no PaymentIntent confirmation attempt succeeds and no redirect occurs.

### TC-STRIPE-31 (P2) — Pay button disabled while processing (no double-submit)
**Purpose:** verify the Pay button guards against duplicate submissions.
**Preconditions:** signed-in user on `/checkout/payment` with a valid card entered.
**Steps:**
1. Click **Pay** once and immediately attempt to click it again / press Enter repeatedly during processing.
**Expected:** While `submitting` is true the button is `disabled` and its label reads **"Processing…"**. `handleSubmit` early-returns if already submitting, so no duplicate `confirmPayment` / no duplicate PaymentIntent confirmation is triggered.

### TC-STRIPE-32 (P2) — Decline message surfaced; user can retry
**Purpose:** verify `result.error.message` is shown and the user can correct and re-pay.
**Preconditions:** signed-in user on `/checkout/payment`.
**Steps:**
1. Pay with a decline card (e.g. `4000 0000 0000 0002`).
2. Observe the error, then correct the card to a success card and click **Pay** again.
**Expected:** The decline message from `result.error.message` renders in a **red alert** below the Payment Element. The button re-enables (`submitting` reset to false). The corrected retry proceeds to success and redirects to `/checkout/success`.

---

## 10.3 Success / reconciliation

### TC-STRIPE-40 (P1) — Success page shows confirmation and links to the contract
**Purpose:** verify the confirmation UI after a successful redirect.
**Preconditions:** a completed successful payment (from TC-STRIPE-20) whose redirect landed on `/checkout/success?payment_intent=pi_…`.
**Steps:**
1. Land on `/checkout/success?payment_intent=pi_…`.
2. Read the confirmation card.
3. Click **View my Services**.
**Expected:** Card shows the green **✓ "Payment received"** header, the **Services** (product name + "`+ N more`" when multiple), the formatted **Amount**, and the **Receipt to** email. When SF sync succeeded, the **"✓ Following services created"** note lists the purchased services. **View my Services** navigates to `/payments/<localContractId>` (or `/payments` if no local id).

### TC-STRIPE-41 (P1) ⛔ (idempotency) — Reloading success does not duplicate
**Purpose:** verify the UPSERT-by-`stripe_payment_intent_id` guard prevents duplicates.
**Preconditions:** a successful payment already reconciled once (TC-STRIPE-40).
**Steps:**
1. On `/checkout/success?payment_intent=pi_…`, refresh the page 2–3 times.
2. Check `service_contracts` for that `stripe_payment_intent_id` and the SF ServiceContract.
**Expected:** Exactly **one** local `service_contracts` row and **one** SF ServiceContract exist. On the reloads `hasLocalContract` returns true, so the page shows **"Service Contract was already on file (idempotent confirm)."** No duplicate line items or SF records are created.

### TC-STRIPE-42 (P1) ⛔ (known risk — no webhook) — Tab closed before redirect lands
**Purpose:** verify/expose the no-webhook reconciliation gap.
**Preconditions:** signed-in user on `/checkout/payment`; ability to kill the browser tab mid-redirect (throttle network or close immediately after Stripe captures).
**Steps:**
1. Pay with a success card so Stripe captures the payment.
2. **Close the tab BEFORE** the `/checkout/success` redirect finishes loading (do not let the success loader run).
3. In the Stripe dashboard, confirm the PaymentIntent shows **succeeded**.
4. Query the local DB (`service_contracts` by `stripe_payment_intent_id`) and Salesforce for a matching contract.
**Expected (documented gap):** Stripe holds a **succeeded** payment, but **no** local `service_contracts` row and **no** SF ServiceContract may exist, because reconciliation runs only on the success page and there is no webhook. **Log this as a defect / confirm the reconciliation plan** (e.g. build `/api/stripe/webhook`).

### TC-STRIPE-43 (P2) 🔁 — SF sync failure leaves local contract with sync-error badge
**Purpose:** verify a Salesforce failure on the success page does not lose the local record.
**Preconditions:** a successful payment; force `createServiceContractWithLines` (or the SF/pricebook linkage) to fail (e.g. account not linked to Salesforce, missing `pricebook2Id`, or an SF API error).
**Steps:**
1. Complete a successful payment while SF sync is forced to fail.
2. Observe the success page.
3. Open `/payments` and the contract detail.
**Expected:** The local `service_contracts` row still exists with `sync_status = 'failed'` and a populated `sync_error`. The success page shows the warning note **"Payment captured, but Salesforce sync failed: `<error>`. Our team will reconcile."** The contract is visible in `/payments` with a **sync-error badge**.

### TC-STRIPE-44 (P2) ⛔ — Unknown / foreign payment_intent
**Purpose:** verify hitting the success page with an invalid or another account's PaymentIntent is safe.
**Preconditions:** signed-in user; a `payment_intent` id that is unknown/invalid, and separately one belonging to another account.
**Steps:**
1. Load `/checkout/success?payment_intent=pi_does_not_exist`.
2. Load `/checkout/success?payment_intent=<a foreign but valid pi>` (if reproducible).
**Expected:** Unknown id → the Stripe retrieve throws and the loader returns a graceful **`502` "Could not load checkout confirmation."** (logged), with no contract created. A non-`succeeded` / foreign intent does **not** create a contract (persistence runs only when `pi.status === 'succeeded'`), and no other account's data is displayed. No cross-account leakage.

---

## Run log

| TC ID | Pri | Result | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-STRIPE-01 | P1 | | | | |
| TC-STRIPE-02 | P1 | | | | |
| TC-STRIPE-03 | P1 | | | | |
| TC-STRIPE-04 | P2 | | | | |
| TC-STRIPE-05 | P2 | | | | |
| TC-STRIPE-06 | P2 | | | | |
| TC-STRIPE-07 | P2 | | | | |
| TC-STRIPE-08 | P2 | | | | |
| TC-STRIPE-09 | P2 | | | | |
| TC-STRIPE-10 | P3 | | | | |
| TC-STRIPE-11 | P3 | | | | |
| TC-STRIPE-12 | P3 | | | | |
| TC-STRIPE-20 | P1 | | | | |
| TC-STRIPE-21 | P1 | | | | |
| TC-STRIPE-22 | P1 | | | | |
| TC-STRIPE-23 | P2 | | | | |
| TC-STRIPE-24 | P2 | | | | |
| TC-STRIPE-25 | P2 | | | | |
| TC-STRIPE-26 | P2 | | | | |
| TC-STRIPE-27 | P2 | | | | |
| TC-STRIPE-28 | P3 | | | | |
| TC-STRIPE-29 | P3 | | | | |
| TC-STRIPE-30 | P2 | | | | |
| TC-STRIPE-31 | P2 | | | | |
| TC-STRIPE-32 | P2 | | | | |
| TC-STRIPE-40 | P1 | | | | |
| TC-STRIPE-41 | P1 | | | | |
| TC-STRIPE-42 | P1 | | | | |
| TC-STRIPE-43 | P2 | | | | |
| TC-STRIPE-44 | P2 | | | | |
