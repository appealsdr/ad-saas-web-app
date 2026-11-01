# AREA 5 — Services & Checkout

> **Asana child ticket for Area 5.** Sub-areas **5.1** (Service catalog) and **5.2** (Checkout) are its **sub-tickets**.

Detailed QA test cases for the **service catalog** (`/stores/<id>/services`) and the **checkout flow** (`/checkout/summary` → `/checkout/payment` → `/checkout/success`).
Each case below includes a **purpose**, **preconditions**, a numbered **step-by-step guide**, and the **expected result**.

- **Routes:** `/stores/<id>/services` · `/checkout/summary` · `/checkout/payment` · `/checkout/success`
- **Source:**
  - [`services/+page.server.ts`](src/routes/(app)/stores/[id]/services/+page.server.ts) · [`services/+page.svelte`](src/routes/(app)/stores/[id]/services/+page.svelte)
  - [`checkout/summary/+page.server.ts`](src/routes/checkout/summary/+page.server.ts) · [`checkout/summary/+page.svelte`](src/routes/checkout/summary/+page.svelte)
  - [`checkout/payment/+page.server.ts`](src/routes/checkout/payment/+page.server.ts) · [`checkout/payment/+page.svelte`](src/routes/checkout/payment/+page.svelte)
  - [`checkout/success/+page.server.ts`](src/routes/checkout/success/+page.server.ts) · [`checkout/success/+page.svelte`](src/routes/checkout/success/+page.svelte)
  - [`api/checkout/payment_intent/+server.ts`](src/routes/api/checkout/payment_intent/+server.ts)
  - [`salesforce/pricebook.ts`](src/lib/server/salesforce/pricebook.ts) · [`salesforce/contracts.ts`](src/lib/server/salesforce/contracts.ts)
- **Role coverage:** Client (`owner` / `admin` / `member`) — services & checkout are **not** role-gated; any signed-in user of an account can buy services for a store their account owns.
- **ID scheme:** `TC-SVC-<n>` (catalog) · `TC-CHK-<n>` (checkout) · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 role/tenancy · 🔁 Salesforce-synced · ⛔ negative/edge/security case

> All URLs use `{BASE_URL}` as the origin placeholder (e.g. `{BASE_URL}/stores/<id>/services`).

---

## What Services & Checkout does (functional overview)

The flow lets a client pick paid services for a store and pay for them, creating a service contract that is mirrored to Salesforce.

1. **Catalog (`pricebook.ts`).** `listServices()` runs a single SOQL against `PricebookEntry` where `Pricebook2.Name = '<SERVICE pricebook>'` (from `SFDC_SERVICE_PRICEBOOK_NAME`, default `SERVICE`), filtered to `IsActive = true` **and** `Product2.IsActive = true`. Each row exposes `pricebookEntryId`, `productId`, `pricebook2Id`, `name`, `description`, `category` (`Category__c`), `family` (`Product2.Family`), `unitPrice`, and `currency` (defaults to `USD`). Rows are bucketed by category (real categories alphabetical, `Uncategorized` last; products sorted by name). Results are **cached in-process for 5 minutes**; on a Salesforce error the loader returns the last good (stale) value or `[]`.

2. **Selection → summary.** The catalog page flattens categories into rows, supports live search and multi-select, computes a client-side subtotal for display only, and forwards the selection as `{BASE_URL}/checkout/summary?id=<peId>&id=<peId>&store=<localStoreId>` (one `id` per selected `pricebookEntryId`, plus the store the contract attaches to).

3. **Server re-prices; never trusts the client total.** `/checkout/summary`, `/checkout/payment`, and `POST /api/checkout/payment_intent` each **independently re-look-up every `id` from the pricebook server-side** via `getCatalogProduct(id, 'service')`. The total is recomputed from those server prices — the query string carries only opaque ids, never amounts. IDs that no longer resolve are dropped (`missing`); ownership of `store=` is re-verified against the signed-in user's account on every hop.

4. **Payment.** `/checkout/payment` mounts the Stripe **Payment Element** and POSTs to `/api/checkout/payment_intent`, which re-prices, enforces a max of **20** line items and a **≥ 50-cent** minimum, sets `receipt_email` to the signed-in user's email, and stamps metadata (`user_id`, `account_id`, `store_id`, `pricebook_entry_ids`). On confirm, Stripe redirects to `{BASE_URL}/checkout/success?payment_intent=…&redirect_status=succeeded`.

5. **Contract creation (idempotent).** `/checkout/success` retrieves the PaymentIntent; when `status === 'succeeded'` it **UPSERTs by `stripe_payment_intent_id`** — inserts a local `service_contracts` row + `service_contract_line_items` in one transaction, then calls `createServiceContractWithLines()` to create a Salesforce **ServiceContract** (whose `Description` lists `<qty> × <name> — <price>` per line plus a `Total:` footer) and its ContractLineItems. Refreshing the page re-detects the existing contract and does **not** duplicate.

> **Detailed Stripe cases live in Area 10.** PaymentIntent internals, the full test-card matrix, webhook/reconciliation, and sync-failure recovery are covered there. Here the checkout is tested at the **flow level**; cross-references to **Area 10.2** are noted where relevant.

---

## 5.1 Service catalog (/stores/<id>/services)

### TC-SVC-01 (P1) 🔁 — Services table lists pricebook products
**Purpose:** confirm the catalog renders every active SERVICE product with all its fields, sourced from the Salesforce pricebook.
**Preconditions:** signed-in client user who owns store `<id>`; the SERVICE price book has ≥1 active `PricebookEntry` whose `Product2` is also active.
**Steps:**
1. Sign in and navigate to `{BASE_URL}/stores/<id>/services`.
2. Observe the toolbar count and the table.
3. For a known product, cross-check its row against the Salesforce PricebookEntry/Product2 record.
**Expected:**
- Topbar reads **"Services"** with subtitle "For `<storeName>` — pick services to continue to checkout" and a "← Back to store" link.
- The count reads "`<n>` of `<n>` services" (all rows visible with no search).
- Table columns: **[checkbox] · Service · Category · Description · Price**. Each row shows the product **name** (bold), its **family** as a sub-line (when present), the **category** label, the **description** (`—` when null), and the **unit price** formatted as currency (e.g. `$300`, currency from the row, default USD).
- Only products where both the PricebookEntry **and** the Product2 are `IsActive = true` appear; inactive ones are absent. Categories order with real names first (alphabetical) and `Uncategorized` last.

### TC-SVC-02 (P2) — Search filters by name / description / category / family in real time
**Purpose:** verify the search box filters the table live across four fields.
**Preconditions:** catalog has several products spanning multiple names, descriptions, categories, and families.
**Steps:**
1. On `{BASE_URL}/stores/<id>/services`, type a fragment of a product **name** into the search box.
2. Clear it, then type a word that appears only in a **description**.
3. Repeat for a **category** label, then a **family** value.
4. Type a string that matches nothing.
**Expected:**
- Matching happens instantly on each keystroke (case-insensitive `includes`) against **name, description, category label, and family**.
- The count updates to "`<filtered>` of `<total>` services".
- A no-match query shows the row **"No services match "`<query>`". Try a different keyword."** and the count reads "0 of `<total>`".

### TC-SVC-03 (P2) — Row select, "Select all visible", count/total update, and clear
**Purpose:** verify individual + bulk selection, the live subtotal, and clearing.
**Preconditions:** catalog has ≥3 products with known prices.
**Steps:**
1. Click a data row (anywhere in the row) to select it; then click its checkbox to toggle it back off.
2. Select two individual rows; read the selected count and footer subtotal.
3. Click the header **"Select all visible"** checkbox.
4. Enter a search that narrows the list, then toggle "Select all visible" again.
5. Click **Clear**.
**Expected:**
- Clicking a row toggles it (row highlights when selected); the checkbox click is independent (`stopPropagation`) and toggles the same row.
- The toolbar shows "· **`<n>`** selected" and the footer shows "`<n>` selected · subtotal **`<sum of unit prices>`**" (currency formatted). The subtotal equals the sum of the selected rows' unit prices.
- "Select all visible" selects exactly the **currently-filtered** rows; the header checkbox shows an **indeterminate** state when only some visible rows are selected, checked when all visible are selected.
- **Clear** empties the selection: the "selected" count and the **Clear** button disappear, footer reverts to "Select one or more services to continue."

### TC-SVC-04 (P1) — "Continue" disabled at 0, enabled at ≥1, navigates to summary
**Purpose:** verify the continue affordance gating and its target URL.
**Preconditions:** catalog with ≥1 product; store `<id>` owned by the user.
**Steps:**
1. Load `{BASE_URL}/stores/<id>/services` with nothing selected; inspect the footer button.
2. Select one service.
3. Click **"Continue to summary →"**.
4. Inspect the resulting URL.
**Expected:**
- With **0** selected the button ("Continue to summary →") is **disabled** and the footer is muted ("Select one or more services to continue.").
- With **≥1** selected the button enables.
- Clicking navigates to `{BASE_URL}/checkout/summary?id=<peId>[&id=<peId>…]&store=<id>` — one `id` per selected `pricebookEntryId`, plus `store=<localStoreId>`. While navigating the button reads "Loading…" and is disabled (guards against double-submit).

### TC-SVC-05 (P3) 🔁 — Pricebook cached ~5 minutes (data still correct after cache window)
**Purpose:** verify the 5-minute in-process cache serves fresh, correct data and refreshes after TTL.
**Preconditions:** ability to change a Product2/PricebookEntry in Salesforce (or trigger the `invalidatePricebookCache` test hook).
**Steps:**
1. Load `{BASE_URL}/stores/<id>/services` and note a product's price.
2. Change that product's `UnitPrice` (or deactivate it) in Salesforce.
3. Immediately reload the page (within ~5 min).
4. Wait past the 5-minute TTL (or invalidate the cache) and reload again.
**Expected:**
- Within the TTL the reload may still show the **old** cached value (in-process 5-minute cache) — this is expected, not a bug.
- After the TTL expires (or after cache invalidation) the reload shows the **updated** price / removed product. Data is always internally consistent (name, price, category all reflect the same snapshot); no partial/stale mixture.
- If Salesforce errors during a refresh, the page keeps showing the last good (stale) data rather than blanking (stale-if-error). An empty catalog shows the guidance message about active SERVICE PricebookEntry rows.

---

## 5.2 Checkout

### TC-CHK-01 (P1) 🔁 — Summary lists selected services with server-validated prices + total
**Purpose:** verify `/checkout/summary` re-prices the selection server-side and offers "Continue to payment".
**Preconditions:** arriving from TC-SVC-04 with ≥1 valid service and `store=<id>` for a store the user owns.
**Steps:**
1. Land on `{BASE_URL}/checkout/summary?id=…&store=<id>`.
2. Review the line items, category column, per-item prices, and the **Total**.
3. Read the "Service contract will be created for store" note.
4. Click **"Continue to payment →"**.
**Expected:**
- Each selected service renders with **name**, optional **description**, **category** (`—` if none), and **price** — all values re-fetched server-side from the pricebook (not from the URL).
- The **Total** row equals the sum of the server-side unit prices (currency formatted with decimals).
- An orange note names the target store; if that store has no `sfdcStoreId` a hint notes "Store__c will be left blank". "Edit selection" links back to `{BASE_URL}/stores/<id>/services`.
- **Continue to payment** carries the **same query string unchanged** to `{BASE_URL}/checkout/payment?…`. It is **disabled** when no valid store resolved.
- If some selected ids no longer resolve, a red banner reads "`<n>` item(s) … no longer available and have been removed"; if **none** resolve, the page shows "None of the selected services are still available." with a back link. (With `id` empty entirely, the loader redirects to `{BASE_URL}/stores`.)

### TC-CHK-02 (P1) ⛔ (security) — Query-string tampering cannot manipulate the total
**Purpose:** confirm the server ignores/rejects forged or foreign pricebook ids and that the total can never be set client-side.
**Preconditions:** signed-in user; knowledge of a valid `pricebookEntryId` plus a bogus one.
**Steps:**
1. Manually edit the summary URL to inject a **fake** id: `{BASE_URL}/checkout/summary?id=01uFAKE000000000&store=<id>`.
2. Try mixing one valid id with the fake id.
3. Try appending a fabricated amount param (e.g. `&total=1` or `&price=0`).
4. Try a `pricebookEntryId` that exists in a **different** pricebook (e.g. a SUBSCRIPTION entry) rather than SERVICE.
5. Repeat the same tampering on `/checkout/payment` and on the `POST /api/checkout/payment_intent` body (`pricebookEntryIds`).
**Expected:**
- Unknown/foreign ids **do not resolve** via `getCatalogProduct(id, 'service')` and are silently dropped into `missing`; they never appear as a $0 (or arbitrary) line. A SUBSCRIPTION-pricebook id is not accepted on the SERVICE flow.
- Any `total`/`price`/amount query param is **ignored** — the total is always recomputed from resolved server prices. There is no client-supplied amount anywhere in the chain.
- If **every** id is invalid, `/checkout/payment` and `/api/checkout/payment_intent` reject (redirect to `/stores` / `404 "Selected services are no longer available."`). More than **20** ids → `400`.
- The Stripe **PaymentIntent amount** equals the server-computed `totalCents`; it cannot be influenced by the client. (See **Area 10.2** for the PaymentIntent amount-integrity cases.)

### TC-CHK-03 (P1) — Payment page shows Stripe Payment Element, email pre-filled, correct total
**Purpose:** verify the Stripe Payment Element mounts with the right amount and the receipt email defaults to the user.
**Preconditions:** valid selection carried from summary; `PUBLIC_STRIPE_KEY` set; a working `getStripe()` (test mode).
**Steps:**
1. Land on `{BASE_URL}/checkout/payment?id=…&store=<id>`.
2. Observe the header charge line, the mini line-item recap, and the Payment Element.
3. Inspect the receipt/email handling.
**Expected:**
- Header reads "Charging `<total>` for `<n>` service(s)"; the recap lists each service with its price and a **Total** row — all from server-side re-pricing.
- The page POSTs `/api/checkout/payment_intent` and mounts the Stripe **Payment Element** once the `clientSecret` returns; the pay button reads "Pay `<total>`".
- The created PaymentIntent has `receipt_email` = the **signed-in user's email** (so the Stripe receipt goes to them); metadata carries `user_id`, `account_id`, `store_id`, `pricebook_entry_ids`.
- If `PUBLIC_STRIPE_KEY` is missing or Stripe fails to load/init, a clear inline error is shown instead of a broken form. (Full Element/card behavior → **Area 10.**)

### TC-CHK-04 (P1) — Valid test card → redirect to /checkout/success with ?payment_intent=…
**Purpose:** verify a successful payment completes the redirect.
**Preconditions:** on `{BASE_URL}/checkout/payment` with the Payment Element mounted (Stripe test mode).
**Steps:**
1. Enter a valid Stripe test card (see the card matrix in **Area 10.2**, e.g. `4242 4242 4242 4242`, any future expiry/CVC/ZIP).
2. Click **Pay `<total>`**.
3. Observe the redirect and the success page.
**Expected:**
- Stripe confirms the payment with `return_url = {BASE_URL}/checkout/success` and redirects to `{BASE_URL}/checkout/success?payment_intent=pi_…&payment_intent_client_secret=…&redirect_status=succeeded`.
- The success page shows the green **✓ "Payment received"** state with the services, amount, and "Receipt to `<email>`".
- The card matrix / PaymentIntent status details are validated in **Area 10.2**; here only the flow-level redirect + success render are in scope.

### TC-CHK-05 (P2) ⛔ — Declined card → Stripe error shown; no contract created
**Purpose:** verify a decline surfaces an error and creates no contract.
**Preconditions:** on `{BASE_URL}/checkout/payment` with the Element mounted.
**Steps:**
1. Enter a decline test card (see **Area 10.2**, e.g. `4000 0000 0000 0002`).
2. Click **Pay**.
3. Confirm you remain on the payment page and check `/payments`.
**Expected:**
- `stripe.confirmPayment` returns an error; the page stays on `/checkout/payment` and renders the Stripe **error message** inline (`result.error.message`); the button re-enables.
- **No redirect** to `/checkout/success` occurs, so no `service_contracts` row and no Salesforce ServiceContract are created for this attempt. `/payments` shows no new contract.
- (The full decline-code matrix and PaymentIntent states are in **Area 10.2**.)

### TC-CHK-06 (P1) 🔁 — On success, local + Salesforce contract created; "View contract" → /payments/<id>
**Purpose:** verify successful payment creates the local service contract + line items and the Salesforce ServiceContract with a line-item Description.
**Preconditions:** a completed valid payment (TC-CHK-04); the account is linked to Salesforce (`sfdc_account_id`) and the SERVICE pricebook has a `pricebook2Id`.
**Steps:**
1. Complete a successful payment and land on `{BASE_URL}/checkout/success?payment_intent=pi_…`.
2. Read the confirmation card.
3. Click **"View my Services"**.
4. In Salesforce, open the created **ServiceContract** and read its **Description**.
**Expected:**
- A local `service_contracts` row is inserted (keyed on `stripe_payment_intent_id`) with `service_contract_line_items` for each purchased product (one transaction), then a Salesforce **ServiceContract** + ContractLineItems are created; `sync_status` becomes `synced`.
- The success card shows **"✓ Following services created"** and lists the purchased service names.
- The Salesforce ServiceContract **Name** is "`<Store Name> <YYYY-MM-DD>` Services"; its **Description** lists one line per item as `<qty> × <name> — <price>` followed by a `Total: <amount>` footer.
- The action button links to the local contract: **`{BASE_URL}/payments/<localContractId>`** (falls back to `{BASE_URL}/payments` if no id).
- If the account is not SF-linked or the pricebook id is missing, the local contract still saves but `sync_status = failed` and the card shows the amber "Salesforce sync failed … Our team will reconcile" note. (Sync-failure recovery detail → **Area 10.**)

### TC-CHK-07 (P2) — Reloading success URL does not duplicate the contract (UPSERT by payment intent)
**Purpose:** verify idempotency on refresh / repeated visits.
**Preconditions:** a success page already processed once (TC-CHK-06).
**Steps:**
1. On `{BASE_URL}/checkout/success?payment_intent=pi_…`, hard-refresh the page 2–3 times.
2. Open the same success URL in a new tab.
3. Check `/payments`, the `service_contracts` table, and Salesforce for duplicates.
**Expected:**
- Each reload re-detects the existing local row (`hasLocalContract` by `stripe_payment_intent_id`) and short-circuits with `syncStatus = 'already-exists'`; the card shows "Service Contract was already on file (idempotent confirm)."
- **Exactly one** local `service_contracts` row, one set of line items, and **one** Salesforce ServiceContract exist for this `payment_intent`. No duplicates in `/payments` or Salesforce.

### TC-CHK-08 (P2) 🔒 (tenancy) — Checkout with a foreign store is rejected
**Purpose:** verify `store=` is re-verified against the signed-in user's account and cannot attach a contract to a store they don't own.
**Preconditions:** two accounts A and B; user is signed in as **A**; `<foreignStoreId>` belongs to **B**.
**Steps:**
1. As user A, open `{BASE_URL}/checkout/summary?id=<validSvcId>&store=<foreignStoreId>`.
2. Observe the store note on the summary.
3. Continue to `/checkout/payment` and start the PaymentIntent with the foreign `storeId` in the body.
4. (Also try `{BASE_URL}/stores/<foreignStoreId>/services` directly.)
**Expected:**
- The summary loader's ownership query (`stores JOIN users … WHERE account_id = <A>`) returns nothing, so `selectedStore` is **null**: the amber "Couldn't identify which store this purchase is for" warning shows and **Continue to payment is disabled**.
- `POST /api/checkout/payment_intent` re-validates `storeId` the same way; a foreign store id yields `validatedStoreId = null` (metadata `store_id` empty) — the contract never attaches to store B, and no cross-account leakage occurs.
- Visiting another account's `{BASE_URL}/stores/<foreignStoreId>/services` returns **404 "Store not found."** (loader ownership check).

---

## Run log

| TC ID | Pri | Result | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-SVC-01 | P1 | | | | |
| TC-SVC-02 | P2 | | | | |
| TC-SVC-03 | P2 | | | | |
| TC-SVC-04 | P1 | | | | |
| TC-SVC-05 | P3 | | | | |
| TC-CHK-01 | P1 | | | | |
| TC-CHK-02 | P1 | | | | |
| TC-CHK-03 | P1 | | | | |
| TC-CHK-04 | P1 | | | | |
| TC-CHK-05 | P2 | | | | |
| TC-CHK-06 | P1 | | | | |
| TC-CHK-07 | P2 | | | | |
| TC-CHK-08 | P2 | | | | |
