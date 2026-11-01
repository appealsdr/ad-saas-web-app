# AREA 8 — Payments tab

> **Asana child ticket for Area 8** (flat — no sub-tickets). This is the single ticket covering the entire Payments / Invoices area; it has no sub-areas.

Detailed QA test cases for the **Payments tab** (`/payments`, labeled **"Invoices"** in the UI) — the list of service contracts created from the account's purchases, and each contract's detail view.
Each case below includes a **purpose**, **preconditions**, a numbered **step-by-step guide**, and the **expected result**.

- **Routes:** `/payments` (list) · `/payments/<id>` (detail)
- **Source files:** [`+page.server.ts`](src/routes/(app)/payments/+page.server.ts) · [`+page.svelte`](src/routes/(app)/payments/+page.svelte) · [`[id]/+page.server.ts`](src/routes/(app)/payments/[id]/+page.server.ts) · [`[id]/+page.svelte`](src/routes/(app)/payments/[id]/+page.svelte) · [`contracts.ts`](src/lib/server/salesforce/contracts.ts)
- **Role coverage:** Client (`owner` / `admin` / `member`) — the Payments tab is **not** role-gated; all signed-in users of an account see the same contracts (account-scoped).
- **ID scheme:** `TC-PAY-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 role/tenancy · 🔁 Salesforce-synced · ⛔ negative/edge case

Replace `{BASE_URL}` with the environment under test (e.g. `http://localhost:5173`, or the staging host).

---

## What the Payments tab does (functional overview)

The Payments tab is the client-facing record of every **service contract** purchased by the account. A purchase (Stripe payment) creates one local `service_contracts` row plus one `service_contract_line_items` row per catalog item bought; that data is mirrored to a Salesforce **ServiceContract** with child **ContractLineItem** records.

**List page (`/payments`)** — `+page.server.ts`:

1. Resolves the signed-in `user` and their `account_id`. **Unauthenticated → `redirect(303, '/login')`.** No account → empty list with zeroed stats.
2. Runs **one** SQL query over `service_contracts` for that `account_id` only (tenancy-scoped), `LEFT JOIN stores` for the store name, and a correlated sub-select counting `service_contract_line_items` per contract (`line_count`).
3. Rows are ordered **`paid_at DESC`** (newest purchase first).
4. Derives **stats**: `total` = row count · `totalPaidCents` = sum of `amount_cents` · `syncedCount` = rows with `sync_status === 'synced'`.

Each list row surfaces: **Contract** (the `stripe_payment_intent_id` in monospace + "Paid `<date>`"), **Store** name (or `—`), **Services** count (`lineCount`), **Amount** (`amount_cents` / 100 in `currency`), **Term** (`start_date → end_date`), and a **Status** badge from `sync_status` (`synced` → green "In Salesforce", `failed` → orange "SF sync failed", otherwise grey "Pending"). Clicking a row navigates to `/payments/<id>`.

**Detail page (`/payments/<id>`)** — `[id]/+page.server.ts`:

1. Loads the contract with a query that **JOINs the signed-in user and requires `c.account_id = u.account_id`** — the tenancy guard. A contract that does not exist **or belongs to another account** yields no row → **`error(404, 'Contract not found.')`**.
2. Loads all `service_contract_line_items` for the contract, ordered `created_at ASC`.
3. If the contract has an `sfdc_service_contract_id`, calls `listCasesForContract(...)` to fetch the auto-created SF Cases (best-effort; a failure is captured as `casesError` and does not crash the page).

The detail view renders cards for **Contract Summary** (store, term, dates, amount paid, paid-on), **Stripe** (payment intent, charge, payment method type + id, receipt email), **Purchased Services** (line-item table with unit price, qty, line total, a subtotal and a "Total Paid" footer), **Cases**, and **Salesforce** (sync status badge, synced-at, ServiceContract/Account/Contact/Store SF ids). A `failed` sync shows a warning banner with the `sync_error`; a `pending` sync shows an info banner.

**Salesforce ServiceContract Description (recent change)** — `contracts.ts` → `buildContractDescription`: when the ServiceContract is created, its **`Description`** field is populated with **one line per purchased line item** in the form `<quantity> × <name> — <extended price>` (extended price = `unitPrice × quantity`, formatted in the purchase currency), followed by a **`Total: <amount>`** line. The total uses the Stripe charge amount when present, else the summed line totals. Example:

```
2 × Roof Inspection — $300.00
1 × Gutter Cleaning — $120.00
Total: $420.00
```

**Tenancy:** both pages are strictly account-scoped in SQL; there is no way to view another account's contract via URL.

---

### TC-PAY-01 (P1) 🔁 — `/payments` lists the account's service contracts
**Purpose:** confirm the Invoices list renders every service contract for the account with all summary columns and correct ordering.
**Preconditions:** signed-in client user whose account has ≥ 2 service contracts (ideally with different stores, amounts, currencies, paid dates, and sync statuses; at least one with multiple line items).
**Steps:**
1. Sign in and navigate to `{BASE_URL}/payments` (or open **Invoices** from the sidebar).
2. Observe the three stat cards at the top: **Total Contracts**, **Lifetime Spend**, **Synced to Salesforce**.
3. Inspect the contracts table header and each row.
4. Note the order of the rows by their "Paid `<date>`" sub-line.
**Expected:**
- Stat cards show: `Total Contracts` = number of contracts; `Lifetime Spend` = sum of all amounts formatted as USD currency; `Synced to Salesforce` = `<syncedCount>/<total>`.
- Table columns: **Contract**, **Store**, **Services**, **Amount**, **Term**, **Status**.
- Each row shows: the **payment-intent id** (monospace) over "Paid `<paidAt date>`"; the **store name** (or `—`); the **service (line-item) count** as "`<n> service(s)`"; the **amount** = `amount_cents / 100` formatted in the row currency; the **term** as "`<startDate> → <endDate>`"; and a **Status badge** — green "In Salesforce" (`synced`), orange "SF sync failed" (`failed`), or grey "Pending" (anything else).
- Rows are sorted **newest-paid first** (`paid_at DESC`).

### TC-PAY-02 (P2) ⛔ — Empty state when the account has no contracts
**Purpose:** verify a graceful empty state (no table, no errors) when nothing has been purchased.
**Preconditions:** signed-in user whose account has **no** service contracts (fresh account, or an account that has never purchased).
**Steps:**
1. Navigate to `{BASE_URL}/payments`.
2. Observe the stats row and the body area.
3. Click the empty-state call-to-action.
**Expected:**
- Stat cards read `Total Contracts` = **0**, `Lifetime Spend` = **$0.00**, `Synced to Salesforce` = **0/0** (no `NaN`).
- No table renders. Instead the dashed empty card shows heading **"No service contracts yet"** with the copy "Buy a service from one of your stores — each purchase creates a 3-month service contract." and a **"Browse stores →"** button.
- Clicking the button navigates to `/stores`. No console errors.

### TC-PAY-03 (P1) 🔁 — Contract detail view (`/payments/<id>`)
**Purpose:** verify the click-through detail page renders Stripe identifiers, contract summary, Salesforce ids, sync status, and the line-item table with totals.
**Preconditions:** signed-in user whose account owns a **synced** contract with ≥ 2 line items and known Stripe/SF ids.
**Steps:**
1. On `{BASE_URL}/payments`, click a contract row.
2. Confirm the URL is `{BASE_URL}/payments/<id>` and the Topbar reads **"Service Contract"** with subtitle "`<n> service(s) · <amount>`".
3. Inspect the **Contract Summary** card, the **Stripe** card, the **Purchased Services** table, and the **Salesforce** card.
4. Verify the line-item math and the table footer.
**Expected:**
- **Contract Summary:** Store (linked to `/stores/<storeId>` when present, else `—`), **Term** = "`<termMonths>` months", **Start Date**, **End Date**, **Amount Paid** (orange, = `amount_cents / 100` in currency), **Paid On** (date + time).
- **Stripe:** **Payment Intent** id (mono), **Charge** id (mono, `—` if null), **Payment Method** (type), **Payment Method Id** (mono, `—` if null), **Receipt Email** (`—` if null).
- **Purchased Services table:** one row per line item with **Service** name (+ description + `PE:`/`CLI:` SF ids when present), **Category** (`—` if null), **Unit Price**, **Qty**, **Line Total** = `unitPrice × quantity`. The card header shows a **Subtotal** = sum of all line totals; the table **tfoot** shows **"Total Paid"** = `amount_cents / 100`.
- **Salesforce:** **Sync Status** badge (green "Synced" / orange "Failed" / grey "Pending"), **Synced At**, **ServiceContract Id**, **Account Id**, **Contact Id**, **Store Id** (each mono; `—` when null).
- No error banner for a `synced` contract.

### TC-PAY-04 (P1) 🔒 — Tenancy: another account's contract → 404
**Purpose:** verify a user cannot view a service contract belonging to a different account by guessing/pasting its id.
**Preconditions:** two accounts — **A** and **B**. Obtain (from the DB or from account B's session) a valid `service_contracts.id` owned by **account B**. Sign in as a user of **account A**.
**Steps:**
1. Signed in as an account-A user, navigate directly to `{BASE_URL}/payments/<accountB_contract_id>`.
2. Observe the response.
3. (Control) In a separate step, navigate to a **random / non-existent** UUID at `{BASE_URL}/payments/<random-uuid>`.
**Expected:**
- Both requests return **HTTP 404** with the SvelteKit error page message **"Contract not found."** (the loader's `error(404, ...)` because the `c.account_id = u.account_id` join yields no row).
- No contract data, Stripe ids, or line items from account B are exposed. No 500 / stack trace.

### TC-PAY-05 (P3) ⛔ 🔁 — Sync-failed contract shows an error badge and banner
**Purpose:** verify a contract whose Salesforce sync failed is clearly flagged in both the list and the detail view, with the failure reason surfaced.
**Preconditions:** a contract owned by the signed-in account with `sync_status = 'failed'` and a non-null `sync_error` (e.g. seed one, or force a sync failure).
**Steps:**
1. On `{BASE_URL}/payments`, locate the failed contract's row and read its **Status** badge.
2. Click into `{BASE_URL}/payments/<id>` for that contract.
3. Read the banner at the top of the content area and the **Salesforce → Sync Status** field.
**Expected:**
- **List:** the row's Status badge is the **orange "SF sync failed"** badge.
- **Detail:** a warning banner (amber) reads "This contract failed to sync to Salesforce. Reason: `<sync_error>`. The local record is intact; our team will reconcile." — the `sync_error` value is shown in a `<code>` span (or `unknown` if null).
- The **Salesforce** card's **Sync Status** shows the orange **"Failed"** badge; the SF ServiceContract Id may be `—`. Local data (summary, Stripe, line items) still renders fully — the page does not crash.
- *(Contrast, optional):* a `pending` contract instead shows a blue info banner "Salesforce sync is pending." and a grey "Pending" badge.

### TC-PAY-06 (P2) 🔁 — SF ServiceContract `Description` lists each line item + a matching Total
**Purpose:** verify the recently added `buildContractDescription` output — the linked Salesforce **ServiceContract.Description** lists each purchased line item as `<qty> × <name> — <extended price>` followed by a **Total** consistent with the amount charged.
**Preconditions:** a **synced** contract owned by the signed-in account, purchased with ≥ 2 line items (and, ideally, at least one with quantity > 1). You will need Salesforce (org UI / API / SF MCP) access to read the ServiceContract record via its **ServiceContract Id** (shown on `/payments/<id>`).
**Steps:**
1. On `{BASE_URL}/payments/<id>` for the synced contract, note the **Purchased Services** rows (name, qty, line total) and the **Total Paid** amount, plus the **Salesforce → ServiceContract Id**.
2. In Salesforce, open that ServiceContract record (or query `SELECT Id, Description, Stripe_Amount__c FROM ServiceContract WHERE Id = '<sfdcServiceContractId>'`).
3. Read the **Description** field.
4. Compare each Description line against the app's line items, and compare the Description **Total** against the contract's **Amount Paid** / `Stripe_Amount__c`.
**Expected:**
- **Description** contains **one line per purchased line item**, each formatted as `<quantity> × <name> — <extended price>`, where extended price = `unitPrice × quantity` formatted as currency (e.g. `2 × Roof Inspection — $300.00`).
- The line **order and item names** match the Purchased Services table on the detail page.
- The final line reads **`Total: <amount>`**, and that total **equals the amount charged** (the Stripe charge amount / "Total Paid" on the detail view), which normally also equals the sum of the per-line extended prices.
- Currency formatting matches the purchase currency (falls back to a plain two-decimal `<amount> <CURRENCY>` for an unknown ISO code).

---

## Run log

| TC ID | Pri | Result | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-PAY-01 | P1 | | | | |
| TC-PAY-02 | P2 | | | | |
| TC-PAY-03 | P1 | | | | |
| TC-PAY-04 | P1 | | | | |
| TC-PAY-05 | P3 | | | | |
| TC-PAY-06 | P2 | | | | |
