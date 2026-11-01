# AREA 2 — Dashboard (Home tab)

Detailed QA test cases for the **Dashboard** (`/dashboard`) — the landing page after login.
Each case below includes a **purpose**, **preconditions**, a numbered **step-by-step guide**, and the **expected result**.

- **Route:** `/dashboard`
- **Source:** [`+page.server.ts`](src/routes/(app)/dashboard/+page.server.ts) · [`+page.svelte`](src/routes/(app)/dashboard/+page.svelte)
- **Role coverage:** Client (`owner` / `admin` / `member`) — the dashboard is **not** role-gated; all signed-in users of an account see the same vis5wew.
- **ID scheme:** `TC-DASH-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 role/tenancy · 🔁 Salesforce-synced · ⛔ negative/edge case

---

## What the Dashboard does (functional overview)

On load, `+page.server.ts` assembles **one** view from several independent sources:

1. **Local DB** — the signed-in `user`, their `account`, and all `stores` for that account (newest first).
2. **Salesforce Cases** — `listCasesForStores(...)` runs a single SOQL across every store that has an `sfdc_store_id`, returning all cases for the account's stores.
3. **Salesforce comments** — `listRecentMessagesForCases(...)` returns up to **6** most-recent `Case_Message__c` rows across those cases (sanitized server-side before render).
4. **Salesforce pending files** — `listPendingFilesForCases(...)` returns up to **6** pending `Case_File__c` rows plus a **total** pending count.

**Resilience:** each Salesforce source can fail independently. A failure does **not** crash the page — the affected section shows an inline alert and the rest renders with whatever data is available.

**Derived stats** (computed in the loader):

| Stat | How it is computed |
|---|---|
| **Open Cases** | cases whose status is **not** resolved (not `closed`/`resolved`) |
| `in progress` sub-count | status contains `progress` or `working` |
| `waiting` sub-count | status contains `waiting`, `pending`, or `awaiting` |
| **Active Stores** | total store count; `connected` sub-count = stores with `spapi_status === 'connected'` |
| **Pending Files** | **total** pending `Case_File__c` count across all cases (not just the 6 displayed) |
| **Resolved This Month** | resolved cases whose `LastModifiedDate` ≥ start of the current UTC month |

> ⚠️ **Spec vs. build discrepancy (flag to product):** the described Home spec lists **5** first-panel cards (Account status, Active stores, **Inactive stores**, Open Issues, **Closed Issues**) and a third "Last activity" panel. The **built** dashboard shows **4** stat cards (**Open Cases, Active Stores, Pending Files, Resolved This Month**) and two columns (**Recent Cases**, **Latest Comments**). There is no Inactive-stores card, no Closed-issues card, no explicit Account-status card, and no standalone "Last activity" panel (pending files appear as a "Required Actions" banner). The cases below target the **built** UI; raise the missing elements as spec gaps (see Appendix).

> 📝 **Label note:** the first card is labeled **"Open Cases"** in the build (older docs say "Open Issues"). Test against the on-screen label.

---

## 2.1 Stat cards (panel 1)

### TC-DASH-01 (P1) — Four stat cards render
**Purpose:** confirm the top stat row renders all four cards with counts.
**Preconditions:** signed-in client user; account exists.
**Steps:**
1. Sign in and land on `/dashboard` (or navigate to it from the sidebar).
2. Observe the top row of cards.
**Expected:** Exactly four cards render left-to-right: **Open Cases**, **Active Stores**, **Pending Files**, **Resolved This Month**. Each shows an uppercase label, a large numeric value, and a sub-line. No layout breakage or missing card.

### TC-DASH-02 (P1) — Open Cases count + link 🔁
**Purpose:** verify the Open Cases value and its navigation.
**Preconditions:** account has at least one open and (ideally) one resolved case in Salesforce.
**Steps:**
1. On `/dashboard`, read the **Open Cases** value.
2. Cross-check it against the number of non-resolved cases in `/issues` for the account's stores.
3. Click the **Open Cases** card.
**Expected:** The value equals the count of cases whose status is **not** closed/resolved across all the account's stores. The sub-line reads `<n> in progress · <n> waiting`. Clicking the card navigates to `/issues`.

### TC-DASH-03 (P1) — Active Stores count + SP-API sub-count + link
**Purpose:** verify store totals and connected-store breakdown.
**Preconditions:** account has ≥1 store; at least one connected via SP-API (optional but ideal).
**Steps:**
1. On `/dashboard`, read the **Active Stores** value and sub-line.
2. Compare with the store list at `/stores`.
3. Click the **Active Stores** card.
**Expected:** Value = total stores for the account. Sub-line = `<n> connected via SP-API` (counts only stores with `spapi_status === 'connected'`). Clicking navigates to `/stores`.

### TC-DASH-04 (P1) — Pending Files count, warning color + link
**Purpose:** verify the pending-files stat and its conditional styling/link.
**Preconditions:** account has at least one pending required file on a case.
**Steps:**
1. On `/dashboard`, read the **Pending Files** value.
2. Note its color when the value is > 0.
3. Click the **Pending Files** card.
**Expected:** Value = **total** count of pending `Case_File__c` across all the account's cases (the full total, not just the 6 shown in the banner). When > 0 the number renders in the **orange/warning** color and the sub-line reads "Documents awaiting upload"; when 0 it is the default color with "All required files uploaded". Clicking navigates to `/issues?filter=waiting`.

### TC-DASH-05 (P2) — Resolved This Month count + ratio
**Purpose:** verify the resolved-this-month metric.
**Preconditions:** at least one case resolved within the current calendar month (UTC).
**Steps:**
1. On `/dashboard`, read the **Resolved This Month** value and sub-line.
2. Confirm against cases marked closed/resolved with `LastModifiedDate` in the current UTC month.
**Expected:** Value = count of resolved cases modified on/after the **start of the current UTC month**. Sub-line reads `of <n> total cases`. This card is **not** a link (no hover lift, `cursor: default`).

### TC-DASH-06 (P3) ⛔ — Empty account renders zeros gracefully
**Purpose:** ensure a brand-new account does not error or show NaN.
**Preconditions:** freshly created account with **no stores and no cases**.
**Steps:**
1. Sign in as the new account's user.
2. Land on `/dashboard`.
**Expected:** All four values show `0` (no `NaN`/blank). The **Active Stores** sub-line reads "Add your first store →". The **Pending Files** sub-line reads "All required files uploaded". No console errors; page renders fully.

### TC-DASH-07 (P2) — Topbar greeting + account name
**Purpose:** verify the personalized header.
**Preconditions:** signed-in user with a `display_name` (or email) and an account `name`.
**Steps:**
1. Land on `/dashboard`.
2. Read the Topbar title and subtitle.
**Expected:** Title reads **"Welcome, `<displayName>`"** (falls back to email if no display name). Subtitle reads **"`<accountName>` · overview"**. If there is no account, the title is "Dashboard" and the subtitle is "Overview of your account activity".

---

## 2.2 Required Actions / Pending files banner

> Built as the **"Required Actions — Documents Pending"** banner (red header), shown only when there is at least one pending file. Lists up to **6** rows.

### TC-DASH-10 (P1) — Pending-files banner content
**Purpose:** verify the banner appears and shows correct row detail.
**Preconditions:** account has ≥1 pending required file on a case.
**Steps:**
1. On `/dashboard`, locate the red **"Required Actions — Documents Pending"** banner above the two-column section.
2. Inspect the header and the individual rows.
**Expected:**
- Header shows the warning icon, the title, and a red **count badge** equal to the total pending count (`stats.pendingFiles`), plus a **"View all cases →"** link to `/issues`.
- Up to **6** rows render; each shows: **file name**, `Case <caseNumber>` (falls back to the first 8 chars of the case id), optionally `· <storeName>`, optionally `· <short description>` (truncated to ~80 chars), a yellow **"Pending"** badge, and an **"Upload →"** affordance.

### TC-DASH-11 (P1) — Pending-file row navigation
**Purpose:** verify each row deep-links to the case.
**Preconditions:** at least one pending-file row whose case maps to a local store.
**Steps:**
1. In the Required Actions banner, click a pending-file row that has a store name.
2. Then test a row whose case has **no** mapped local store (if available).
**Expected:** A row with a mapped store navigates to `/stores/<localStoreId>/issues/<caseId>`. A row with no mapped local store falls back to `/issues`.

### TC-DASH-12 (P2) — Banner hidden when nothing pending
**Purpose:** verify the banner is suppressed when there are no pending files.
**Preconditions:** account with **no** pending required files.
**Steps:**
1. Ensure all required files are uploaded (or use an account with none pending).
2. Load `/dashboard`.
**Expected:** No Required Actions banner renders. (If instead the pending-files lookup **errored**, a yellow "Could not check pending required files: …" alert is shown in its place — see TC-DASH-32.)

---

## 2.3 Recent Cases + Latest Comments (panel 2)

### TC-DASH-20 (P1) — Recent Cases table
**Purpose:** verify the Recent Cases table content, ordering, and links.
**Preconditions:** account has ≥1 case across its stores.
**Steps:**
1. On `/dashboard`, find the left **"Recent Cases"** card.
2. Inspect the column headers and rows.
3. Click a row whose Store column is populated.
**Expected:**
- Columns: **Case**, **Store**, **Status**, **Updated**.
- Up to **6** rows, sorted newest-first by `LastModifiedDate`.
- Each Case cell shows the **case number** (monospace) over a sub-line of the record-type name (or subject, or `—`).
- Status renders as a colored badge (orange = new/open, blue = working/in progress, yellow = waiting/pending, green = closed/resolved, grey = anything else).
- Updated shows a **relative** time (`just now`, `Nm ago`, `Nh ago`, `Nd ago`, else short date).
- A **"View all →"** link goes to `/issues`. Clicking a row with a mapped store navigates to `/stores/<localStoreId>/issues/<caseId>`; rows without a mapped store are not clickable.

### TC-DASH-21 (P1) — Latest Comments feed
**Purpose:** verify the comments feed content and links.
**Preconditions:** account has ≥1 `Case_Message__c` across its cases.
**Steps:**
1. On `/dashboard`, find the right **"Latest Comments"** card.
2. Inspect the header and each comment row.
3. Click a comment row.
**Expected:**
- Header reads "Latest Comments" with a small "`<n>` recent" count when there are comments.
- Up to **6** rows. Each shows the commenter name (`displayName` → `senderContactName` → `createdByName` → "Sender"), `on Case <caseNumber>`, a 2-line clamped **rich-text excerpt** (rendered HTML), an optional meta line `<storeName> · <senderType>`, and a relative time.
- Clicking a row with a mapped store navigates to `/stores/<localStoreId>/issues/<caseId>`; otherwise to `/issues`.
> Spec asks for **10** latest comments + a "View more" button; the build caps at **6** with no "View more" button. Flag the count and the missing button.

### TC-DASH-22 (P3) ⛔ — Empty Latest Comments
**Purpose:** verify graceful empty state for comments.
**Preconditions:** account with cases but **no** comments yet.
**Steps:**
1. Load `/dashboard`.
2. Inspect the Latest Comments card.
**Expected:** The card shows the empty line **"No comments yet across your cases."** No crash, no broken rows.

### TC-DASH-23 (P3) ⛔ — Empty Recent Cases (context-aware)
**Purpose:** verify the empty state distinguishes "no stores" from "no cases".
**Preconditions:** two scenarios — (a) account with **no stores**, (b) account with stores but **no cases**.
**Steps:**
1. Load `/dashboard` for scenario (a).
2. Load `/dashboard` for scenario (b).
**Expected:**
- (a) No stores → "No stores yet. **Add a store** to start tracking cases." with the link going to `/stores`.
- (b) Stores but no cases → "No cases yet for any of your stores."

### TC-DASH-24 (P2) — Rich-text comment excerpt is sanitized 🔁
**Purpose:** confirm the comment excerpt is XSS-safe (server-sanitized).
**Preconditions:** a `Case_Message__c` whose body contains formatting and/or unsafe markup (e.g. `<script>`, `onerror=`, a `javascript:` link).
**Steps:**
1. Ensure a recent comment body includes both legitimate formatting (bold/list/link) and malicious markup.
2. Load `/dashboard` and inspect the Latest Comments excerpt (and the rendered DOM).
**Expected:** Legitimate formatting renders (bold/lists/links visible, links styled in the dark-orange color); all unsafe markup is stripped/neutralized server-side (`sanitizeMessageHtml`). The rendered output contains no executable script/handlers. Excerpt is clamped to 2 lines.

---

## 2.4 Salesforce resilience (independent failures)

### TC-DASH-30 (P2) ⛔ — Cases load fails
**Purpose:** verify a Cases SOQL failure degrades gracefully.
**Preconditions:** force `listCasesForStores` to fail (SF down / bad token).
**Steps:**
1. Trigger the cases failure, then load `/dashboard`.
**Expected:** A red alert at the top reads "Could not load cases from Salesforce: `<error>`". Stat cards still render (cases-derived stats fall back to 0). The Recent Cases card shows an empty/zero state. No full-page crash.

### TC-DASH-31 (P2) ⛔ — Comments load fails
**Purpose:** verify a comments failure is isolated.
**Preconditions:** force `listRecentMessagesForCases` to fail.
**Steps:**
1. Trigger the comments failure, then load `/dashboard`.
**Expected:** Inside the **Latest Comments** card, a red alert reads "Could not load comments: `<error>`". The rest of the dashboard (stats, Recent Cases, pending files) renders normally.

### TC-DASH-32 (P2) ⛔ — Pending files load fails
**Purpose:** verify a pending-files failure is isolated.
**Preconditions:** force `listPendingFilesForCases` to fail.
**Steps:**
1. Trigger the files failure, then load `/dashboard`.
**Expected:** In place of the Required Actions banner, a yellow alert reads "Could not check pending required files: `<error>`". `Pending Files` stat falls back to `0`. Other sections render normally.

---

## 2.5 Access & tenancy

### TC-DASH-40 (P1) 🔒 — Unauthenticated access redirects
**Purpose:** verify the dashboard is auth-gated.
**Preconditions:** logged out.
**Steps:**
1. Navigate directly to `/dashboard` while logged out.
**Expected:** Redirected to `/login` (the loader throws `redirect(303, '/login')`; the `(app)` layout guard also enforces this with `?next=/dashboard`).

### TC-DASH-41 (P1) 🔒 — Data is account-scoped (tenancy)
**Purpose:** verify the dashboard never shows another account's data.
**Preconditions:** two separate accounts, each with their own stores/cases/comments.
**Steps:**
1. Sign in as account A; note the stores, case numbers, and comments shown.
2. Sign out, sign in as account B; reload `/dashboard`.
**Expected:** Each user sees only their **own** account's stores, cases, pending files, and comments. No cross-account leakage; counts reflect only the signed-in account.

### TC-DASH-42 (P3) — Onboarding gate precedence
**Purpose:** verify an incomplete-onboarding account cannot reach the dashboard.
**Preconditions:** account with `onboarding_completed = false` (e.g. a first-time Google sign-up).
**Steps:**
1. Sign in as that user and attempt to reach `/dashboard`.
**Expected:** The `(app)` layout guard redirects to `/onboarding` before the dashboard renders. After completing onboarding, `/dashboard` loads normally.

---

## Appendix — Spec vs. build gaps to confirm with product

| # | Described spec | Actual build | Action |
|---|---|---|---|
| A | Panel 1 = 5 cards incl. **Account status**, **Inactive stores**, **Closed Issues** | 4 cards: Open Cases, Active Stores, Pending Files, Resolved This Month | Confirm desired cards |
| B | Panel 2 = **Pending Files** + **Latest Comments (10)** with "View more" | Required-Actions banner + Recent Cases + Latest Comments (cap **6**), no "View more" | Confirm layout & counts |
| C | Panel 3 = **Last activity** (store activities) | Not present as a distinct panel | Confirm if needed |
| D | First card labeled **"Open Issues"** | Built label is **"Open Cases"** | Confirm copy |
