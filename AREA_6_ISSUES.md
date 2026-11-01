# AREA 6 — Issues tab

> **Asana child ticket for Area 6** — flat, no sub-tickets. This file is the single QA guide for the account-wide **Issues / Cases** list.

Detailed QA test cases for the **Issues tab** (`/issues`) — the account-wide list of every Salesforce Case across all of the signed-in user's stores.
Each case below includes a **purpose**, **preconditions**, a numbered **step-by-step guide**, and the **expected result**.

- **Routes:** `/issues` · `/issues?filter=waiting` (deep-linked from the dashboard Pending Files card) · `/cases/<sfdcCaseId>` (Salesforce email deep-link resolver → redirects into `/issues`)
- **Source:** [`+page.server.ts`](src/routes/(app)/issues/+page.server.ts) · [`+page.svelte`](src/routes/(app)/issues/+page.svelte) · deep-link resolver [`cases/[caseId]/+page.server.ts`](src/routes/(app)/cases/[caseId]/+page.server.ts)
- **Role coverage:** Client (`owner` / `admin` / `member`) — the Issues tab is **not** role-gated; all signed-in users of an account see the same account-wide list.
- **ID scheme:** `TC-ISSUE-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 role/tenancy · 🔁 Salesforce-synced · ⛔ negative/edge case

Use `{BASE_URL}` as the app origin placeholder (e.g. `{BASE_URL}/issues`).

---

## What the Issues tab does (functional overview)

On load, `+page.server.ts` builds **one** account-wide case list:

1. **Local DB** — resolves the signed-in `user` → their `account_id`. If the user has **no account**, it returns an empty list (`issues: []`, `storesTotal: 0`).
2. **Stores** — reads every `store` for that account. Only stores that have an `sfdc_store_id` (`linkedStores`) are queried against Salesforce; a `storeBySfdcId` map is built to join each case back to its local store (local id + name).
3. **Salesforce Cases** — a **single** SOQL via `listCasesForStores(sfdcIds, …)` (`WHERE Store__c IN (…)`) returns every case for all linked stores at once.
4. **Join** — each returned case is mapped to an `IssueRow` carrying `localStoreId` and `storeName` (both `null` when the case's `sfdcStoreId` has no matching local store — an "unlinked / orphan" store).

**Resilience:** if the Cases SOQL fails, the loader returns `issues: []` with `storesError` set (and `storesTotal` still populated). The page renders an inline red alert instead of crashing.

**The list UI** (`+page.svelte`):

- **Topbar:** title **"Cases"**, subtitle **"Cases across all your stores"**. (Note: the tab is called "Issues" in the route/nav, but the on-screen heading reads **"Cases"** — test against the on-screen label.)
- **Filter tabs** (client-side): **All · Open · In progress · Waiting · Resolved**. `matchesFilter` keyword taxonomy — Open = status includes `open` or `=== new`; In progress = `progress`/`working`; Waiting = `waiting`/`pending`/`awaiting`; Resolved = `closed`/`resolved`.
- **Count line:** `<filtered> of <total> · <storesTotal> store(s)`.
- **Table columns:** **Case #**, **Subject**, **Store**, **Service** (`recordTypeName`), **Status** (badge), **Priority** (badge), **Opened** (`CreatedDate`), **Last modified** (`LastModifiedDate`). Dates via `toLocaleDateString()`, `—` fallback.
- **Row navigation:** a row is `clickable` only when `localStoreId` is set; clicking navigates to `/stores/<localStoreId>/issues/<caseId>`. Rows for unlinked stores are not clickable and show an italic **"Unlinked store"**.

**Deep-link resolver** (`/cases/<sfdcCaseId>`, used by Salesforce email templates): looks up the case's store via `findCaseStoreLookup`. → `404` if the case isn't found in SF; `502` on lookup error; `303 → /issues` if the case has **no** `Store__c`; `403` if the case's store isn't owned by this account; otherwise `303 → /stores/<localStoreId>/issues/<sfdcCaseId>`. Unauthenticated → `401` (the `(app)` guard preserves `?next=/cases/<id>`).

---

### TC-ISSUE-01 (P1) 🔁 — `/issues` lists all cases across the account's stores
**Purpose:** confirm the account-wide list renders every case for all the account's linked stores, with all columns populated.
**Preconditions:** signed-in client user whose account has ≥1 store with an `sfdc_store_id` and ≥1 Salesforce Case linked to those stores.
**Steps:**
1. Sign in and navigate to `{BASE_URL}/issues` (or click **Issues/Cases** in the sidebar).
2. Read the Topbar and the count line above the table.
3. Inspect the table header and rows.
**Expected:**
- Topbar shows title **"Cases"** and subtitle **"Cases across all your stores"**.
- Count line reads `<n> of <n> · <m> store(s)` where the second `<n>` = total cases across **all** the account's linked stores and `<m>` = total store count.
- Table columns render left-to-right: **Case #** (monospace), **Subject**, **Store**, **Service**, **Status** (colored badge), **Priority** (badge or `—`), **Opened**, **Last modified**.
- Each case appears exactly once (single SOQL across all stores); a case whose store is mapped shows the store **name as an orange link**, otherwise an italic **"Unlinked store"**.
- Status badge color: green = closed/resolved, orange = in progress/working, grey = waiting/pending/awaiting, red = open/new. Priority badge: red = critical/high, orange = medium, grey = otherwise.

### TC-ISSUE-02 (P1) — Clicking a row opens the case under its store
**Purpose:** verify row navigation deep-links to the canonical case detail URL.
**Preconditions:** account has ≥1 case whose store **is** mapped locally (`localStoreId` set → row is clickable).
**Steps:**
1. On `{BASE_URL}/issues`, hover a row whose **Store** column shows an orange store name (cursor becomes a pointer; row highlights on hover).
2. Click anywhere on that row **except** the store-name link.
3. Separately, click the store-name link itself.
**Expected:**
- Clicking the row navigates to `{BASE_URL}/stores/<localStoreId>/issues/<caseId>` (where `<caseId>` is the SF Case `Id`).
- Clicking the store-name link (which stops propagation) navigates to `{BASE_URL}/stores/<localStoreId>` instead of the case detail — the two targets do not conflict.
- A row showing **"Unlinked store"** (no `localStoreId`) is **not** clickable — no navigation, no pointer cursor.

### TC-ISSUE-03 (P2) — Status filter pills narrow the list
**Purpose:** verify the client-side filter tabs correctly subset the cases.
**Preconditions:** account with a mix of case statuses (at least one open/new, one in-progress, one waiting/pending, and one closed/resolved).
**Steps:**
1. On `{BASE_URL}/issues`, note the **All** count in the count line (`<total> of <total>`).
2. Click **Open** → then **In progress** → **Waiting** → **Resolved** → back to **All**.
3. After each click, re-read the count line and the visible rows.
**Expected:**
- The active pill is highlighted (white pill on the grey track).
- Each filter shows only matching rows per the taxonomy: **Open** = status includes `open` or is exactly `new`; **In progress** = `progress`/`working`; **Waiting** = `waiting`/`pending`/`awaiting`; **Resolved** = `closed`/`resolved`.
- The count line updates to `<filtered> of <total> · <m> store(s)` — the second number (total) and store count stay constant; only the first (filtered) number changes.
- If a filter matches zero rows, the table is replaced by a centered card reading **"No cases match the current filter."** (the store/case list is not lost — switching back to **All** restores the full list).

### TC-ISSUE-04 (P2) — `/issues?filter=waiting` deep-link pre-applies the waiting filter
**Purpose:** verify the dashboard **Pending Files** card deep-link lands on the Waiting-filtered view.
**Preconditions:** account with at least one case whose status matches the waiting taxonomy (`waiting`/`pending`/`awaiting`).
**Steps:**
1. From the dashboard, click the **Pending Files** stat card (or navigate directly to `{BASE_URL}/issues?filter=waiting`).
2. Observe which filter pill is active and which rows are shown.
**Expected:**
- The page opens with the **Waiting** filter pre-selected and the list narrowed to waiting/pending/awaiting cases (count line shows `<waiting-count> of <total>`).
- Manually switching to another pill still works and re-widens/re-narrows the list normally.
> ⚠️ **Build note (flag to product):** the current `+page.svelte` initializes `filter = 'all'` locally and does **not** read the `?filter=` query param, so `/issues?filter=waiting` may currently render the **All** view instead of Waiting. Confirm whether the URL param is wired up; if it lands on All, log a defect — the dashboard Pending Files card links to `/issues?filter=waiting` expecting the Waiting view.

### TC-ISSUE-05 (P3) ⛔ — Account with no cases → empty state
**Purpose:** verify graceful empty states, distinguishing "no stores" from "stores but no cases".
**Preconditions:** two scenarios — (a) account with **no stores at all**; (b) account with ≥1 store but **no** Salesforce Cases linked.
**Steps:**
1. Sign in for scenario (a) and load `{BASE_URL}/issues`.
2. Sign in (or set up) scenario (b) and load `{BASE_URL}/issues`.
**Expected:**
- (a) `storesTotal === 0` → a dashed empty card: heading **"No stores yet"**, body "Add an Amazon seller account to start tracking cases.", and an **"Add a store →"** button linking to `{BASE_URL}/stores`.
- (b) stores exist but `issues.length === 0` (and no error) → a dashed empty card: heading **"No cases yet"**, body "No Salesforce Cases linked to any of your `<m>` store(s) yet."
- No `NaN`, no broken table, no console errors in either case.
> 📝 The prompt's phrasing "No cases for your stores." maps to this **"No cases yet"** empty state — verify the exact on-screen copy above and note any wording drift.

### TC-ISSUE-06 (P2) 🔒 — Salesforce email deep-link `/cases/<caseId>` resolves correctly
**Purpose:** verify the `/cases/<sfdcCaseId>` resolver (used by Salesforce email templates) routes to the right destination and enforces tenancy.
**Preconditions:** access to (i) a valid SF Case Id on one of **this** account's stores, (ii) a valid SF Case Id with **no** `Store__c` set, (iii) a valid SF Case Id on a store owned by a **different** account, and (iv) a bogus/non-existent Case Id.
**Steps:**
1. While signed in, open `{BASE_URL}/cases/<caseId-owned>` (case (i)).
2. Open `{BASE_URL}/cases/<caseId-no-store>` (case (ii)).
3. Open `{BASE_URL}/cases/<caseId-other-account>` (case (iii)).
4. Open `{BASE_URL}/cases/<bogus-id>` (case (iv)).
5. Sign out, then open `{BASE_URL}/cases/<caseId-owned>` again.
**Expected:**
- (i) `303` redirect to `{BASE_URL}/stores/<localStoreId>/issues/<caseId>` — the canonical case detail under the owning store.
- (ii) Case exists but has no `Store__c` → `303` redirect to `{BASE_URL}/issues` (account-wide list, so the user still sees the case row).
- (iii) Case exists but its store isn't on this account → **403** "You do not have access to this case." (tenancy enforced).
- (iv) Case not found in Salesforce → **404** "Case not found in Salesforce." (A Salesforce lookup error, as opposed to not-found, yields **502** "Could not look up case: …".)
- Signed out → **401** "Sign in required."; the `(app)` guard preserves `?next=/cases/<id>` so completing sign-in returns here to finish the redirect.

---

## Run log

| TC ID | Pri | Result | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-ISSUE-01 | P1 | | | | |
| TC-ISSUE-02 | P1 | | | | |
| TC-ISSUE-03 | P2 | | | | |
| TC-ISSUE-04 | P2 | | | | |
| TC-ISSUE-05 | P3 | | | | |
| TC-ISSUE-06 | P2 | | | | |
