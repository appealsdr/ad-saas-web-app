# SP-API — Violation / Performance Notifications & Account Health (Design + Verification)

> **Status:** Planning only — **not built yet.**
> **Created:** 2026-07-01 · **Revisit:** ~2026-07-08 (1 week)
> **Goal:** Receive Amazon **violation & performance notifications** and **account-health "at risk"** signals per connected store, store them, sync to Salesforce, and surface them in the app.

This file records (1) what Amazon SP-API actually exposes for this (verified against current docs, "Step 0"), and (2) the concrete architecture to build. Pick up from the **Decisions pending** and **Next steps** sections.

---

## 1. Step 0 — Verified against current SP-API docs

**Key finding: it's a _hybrid_ — 2 push notifications + 1 pulled report.** Pure notifications do **not** give the full performance-metric detail; the numeric account-health data comes from a report.

### ✅ Account health "at risk" → `ACCOUNT_STATUS_CHANGED` (Notifications API)
- Fires whenever a seller's account status changes between **`NORMAL` / `AT_RISK` / `DEACTIVATED`** — exactly the "account health if at risk" need, event-driven.
- Requires **seller authorization** (not grantless). Delivered via **SQS**.
- Required role: **Selling Partner Insights**.

### ✅ Violations / listing compliance → `LISTINGS_ITEM_ISSUES_CHANGE` (Notifications API)
- Fires when a listing issue is **created / fixed / updated**; payload includes listing info, **issue severity**, and **enforcement actions** taken. Call the **Listings Items API** for full detail.
- Requires **seller authorization**. Delivered via **EventBridge** (confirm whether SQS is also offered).
- Required role: **Product Listing**.

### ✅ Performance metrics + violation breakdown → `GET_V2_SELLER_PERFORMANCE_REPORT` (Reports API — a PULL, not a push)
- Mirrors the Seller Central **Account Health** dashboard. Contains:
  - **Account Health Rating (AHR)**, Order Defect Rate, Late Shipment Rate, Invoice Defect Rate
  - **Listing policy violations**, **restricted product policy violations**, **product safety complaints**
- Retrieved on a **schedule** (e.g. daily) via the Reports API — no push equivalent for the detailed numbers.
- Required role: **Selling Partner Insights**.

### Mechanism summary
| Need | Mechanism | Type | Delivery |
|---|---|---|---|
| Account at-risk alert (real-time) | Notifications API | `ACCOUNT_STATUS_CHANGED` | push → **SQS** |
| Listing/policy violations (real-time) | Notifications API | `LISTINGS_ITEM_ISSUES_CHANGE` | push → **EventBridge** |
| Performance metrics + violation detail | Reports API | `GET_V2_SELLER_PERFORMANCE_REPORT` | **scheduled pull** (e.g. daily) |

### Notifications mechanics
- `createDestination` is a **grantless** operation (one-time per region) — creates the SQS queue / EventBridge target Amazon delivers to.
- `createSubscription` **requires the seller's grant** → hooks into the existing per-store SP-API OAuth connection.
- Some types use **SQS**, some **EventBridge** → the destination layer may need **both**.
- Amazon can **redeliver** → the consumer must be **idempotent** / de-duplicate.

### ⚠️ Open items to confirm (couldn't fully pin — official docs pages were redirect-looping)
1. **Roles approved on the app:** **Selling Partner Insights** + **Product Listing**. These are *restricted* roles needing justification; the app is still in **draft/beta**, so production access needs **Amazon approval** — this is the real gating item.
2. **Delivery per type:** confirm whether `LISTINGS_ITEM_ISSUES_CHANGE` can also target **SQS**, or if a separate **EventBridge** destination is required alongside SQS.
3. Confirm the exact **role-mappings** table entry for each type at registration time.

### Sources
- Notification Type Values — https://developer-docs.amazon.com/sp-api/docs/notification-type-values
- Ensuring Healthy Seller Account Status (SP-API blog) — https://developer-docs.amazon.com/sp-api-blog/docs/ensuring-healthy-seller-account-status
- Notifications API v1 Use Case Guide — https://developer-docs.amazon.com/sp-api/docs/notifications-api
- Roles in the Selling Partner API — https://developer-docs.amazon.com/sp-api/docs/roles-in-the-selling-partner-api

---

## 2. Architecture to build (event-driven, fits current AWS setup)

```
Amazon SP-API Notifications
      │  (push)                         Reports API (scheduled pull)
      ▼                                        │
  AWS SQS  (+ EventBridge if needed)           │
      │                                        │
      ▼                                        ▼
  Worker (AWS Lambda on SQS trigger, or Node consumer)  ◄── scheduled report fetch
        │  parse • dedupe • map seller_id → store/account
        ├──► Postgres  (raw + parsed + current health)
        └──► Salesforce (records + Flow automation)
                 │
   App UI (health badge + violations feed) ◄── reads Postgres/SF
   Email alert on "at risk" (SES)
```

Amazon pushes events to an SQS queue we own; a worker consumes them, normalizes, stores, and fans out to Salesforce + the app. A separate scheduled job pulls `GET_V2_SELLER_PERFORMANCE_REPORT` for the detailed metrics. No polling for the real-time signals.

### Components to build
1. **SQS destination + `createDestination`** (one-time/region) — queue Amazon delivers to + IAM policy allowing Amazon's account to `SendMessage`. Add an **EventBridge** destination if `LISTINGS_ITEM_ISSUES_CHANGE` requires it.
2. **Subscription manager (per store)** — on store connect (extend the existing SP-API callback), call `createSubscription` for each type using that seller's grant; persist subscription IDs to manage/rebuild them. Handle grantless vs seller-scoped tokens.
3. **Notification worker** — SQS consumer that verifies, **de-duplicates** (Amazon redelivers), parses payloads, resolves `selling_partner_id → stores/account`, and writes to Postgres + Salesforce.
4. **Scheduled report job** — daily `GET_V2_SELLER_PERFORMANCE_REPORT` pull per store → parse AHR + metrics + violation counts → store + sync.
5. **Salesforce automation** — Flow that, on an "at risk" / new-violation record, raises a **Case** (ties into existing case/issues UI) and/or notifies the account team.
6. **App surfacing** — per-store **account-health badge** (Healthy / At Risk) + a violations/performance feed, folded into the existing Dashboard "Required Actions" / Issues areas.
7. **Alerting** — email on "at risk" via **SES** (currently in the deploy doc's "not yet done" list).
8. **Ops hardening** — SQS **dead-letter queue**, retries, idempotency keys, subscription-health monitoring (detect a store that silently lost its subscription).

### Data model sketch
- **Postgres:**
  - `spapi_subscriptions` — per store + notification type + subscriptionId + status.
  - `spapi_notifications` — raw payload + type + parsed fields + processed_at (idempotency key on Amazon's notification id).
  - `store_account_health` — current status (NORMAL/AT_RISK/DEACTIVATED), AHR, key metrics, at_risk flag, last_changed.
- **Salesforce:**
  - `Amazon_Notification__c` — type, severity, seller, payload, date.
  - Fields on `Store__c` — `Account_Health_Status__c`, `Account_Health_Rating__c`, `Account_Health_At_Risk__c`.

### Where it plugs into the existing app
- SP-API tokens + auto-refresh already exist: `src/lib/server/spapi.ts` (`getStoreAccessToken()`), and the connect flow in `src/routes/auth/spapi/*`.
- Salesforce sync pattern already exists (`src/lib/server/salesforce/*`) — Postgres-first, then best-effort sync.

---

## 3. Prerequisites & risks
- **App roles/approval (gating):** get **Selling Partner Insights** + **Product Listing** approved; app is in **draft/beta** → production notification access needs Amazon approval.
- **What's truly exposed:** account-health *numbers* only via the report (pull), not push — confirmed.
- **Delivery split:** may need both SQS and EventBridge destinations.
- **Idempotency:** Amazon redelivers notifications — dedupe required.
- **Rate limits:** Reports API + Listings Items API have per-operation limits; schedule/backoff accordingly.

---

## 4. Decisions pending (answer these when picking back up)
1. **Delivery target:** SQS (recommended, already on AWS) — and add EventBridge only if `LISTINGS_ITEM_ISSUES_CHANGE` forces it.
2. **Worker location:** AWS **Lambda** (recommended — cheap, native SQS trigger) vs. a process inside the SvelteKit app.
3. **System of record:** **Postgres-first → sync to Salesforce** (matches current pattern) vs. Salesforce-first.
4. **Report cadence:** daily vs. more frequent for `GET_V2_SELLER_PERFORMANCE_REPORT`.

**Working recommendation:** SQS + Lambda worker + Postgres-first (sync to SF) + daily performance report; subscribe to `ACCOUNT_STATUS_CHANGED` and `LISTINGS_ITEM_ISSUES_CHANGE`.

---

## 5. Next steps (when resuming)
1. Confirm the two open items: **roles** approved on the app + **SQS vs EventBridge** per type (pull the role-mappings doc / check app registration).
2. Confirm the **Decisions pending** above.
3. Then build: destinations → per-store subscriptions (wire into SP-API callback) → worker → Postgres tables → scheduled report job → Salesforce objects/Flow → app UI badge → SES alert.
