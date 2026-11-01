# QA Test Plan — Appeals Doctor (Client Role) — **[PARENT TICKET]**

> **Asana usage:** This document is the **parent ticket**. Each **Area** below is a **child ticket** (its own `AREA_*.md` guide). Where an Area has **sub-areas**, create those as **sub-tickets** under the Area's child ticket. Testers pick up an Area child ticket, run its step-by-step guide, and record Pass/Fail in that guide's Run log.

- **Application:** SvelteKit web app (Appeals Doctor / SamDoctor Web)
- **Primary role covered:** **Client** (account user). Sub-roles in code: `owner`, `admin`, `member` — noted where behavior differs.
- **ID scheme:** `TC-<AREA>-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 = role/tenancy-gated · 🔁 = Salesforce-synced · ⛔ = negative/edge case

> **Roles quick reference** (`src/lib/server/auth/roles.ts`):
> - **owner** — full access; the registering user; can manage team contacts; cannot be removed.
> - **admin** — can manage team contacts; cannot remove the owner.
> - **member** — can use the app and work on stores; **cannot** add/remove/edit contacts or set point-of-contact.

---

## 1. Testing overview & ideas (read first)

**What we are testing.** The full Client-facing web app: authentication (email/password + Google OAuth + onboarding), the dashboard, account/team management, stores (incl. Amazon SP-API connection), the service catalog + Stripe checkout, cases/issues (timeline, rich-text comments, document uploads), payments/contracts, and cross-cutting security/tenancy.

**How to test.** Manual, black-box, from the browser, against a running instance (`npm run dev` + reachable Postgres). Each Area child ticket has cards in **Purpose → Preconditions → Steps → Expected** form. Use browser DevTools (Network + Application → Cookies) for redirect/cookie/CSRF assertions, and check Salesforce / Stripe dashboards / the local DB where a card calls for it.

**Testing ideas / focus areas.**
- **Tenancy isolation (🔒):** every list and detail endpoint must return **only the signed-in account's** data. Guessing another account's store/case/contract/payment id must 404, not leak.
- **Role gating (🔒):** `member` must be blocked from all contact-management + point-of-contact actions, both in the UI (hidden) and server-side (forced POST rejected).
- **Salesforce resilience (🔁):** every SF-backed flow must degrade gracefully when SF is down — the app keeps working, shows a partial-success/inline warning, and queues/defers the sync. Never a hard 500 to the user.
- **Security negatives (⛔):** CSRF state on OAuth (Google + SP-API), account-enumeration resistance (login + password reset), server-side price re-computation (never trust a client total), HTML sanitization of rich-text comments (XSS), HttpOnly session cookies.
- **Known gaps to confirm, not "bugs to file blindly":** see the **Appendix** (spec-vs-build differences) and the **no-Stripe-webhook** reconciliation risk (Area 10).

**Priority guidance.** Run **all P1** first (critical paths + security). P2 next (major but non-blocking). P3 last (minor/cosmetic/edge). Rough size: **~180 cases across 11 areas**; a full P1+P2 pass is roughly a day of focused testing.

**Recording results.** Each Area guide ends with a **Run log** table (`TC ID | Pri | Result | Tester | Date | Notes/Defect ref`). Mirror the Area's pass/fail rollup into its Asana child ticket; file defects as separate tickets and link them in the Notes column.

---

## 2. Credentials table (fill in per environment)

> ⚠️ **Do not commit real secrets to git.** Store live secrets in `.env` (see `.env.example`) or a shared vault. The table below is the parent-ticket's **single place** to record *which* credentials a tester needs and where to get them. Put non-secret values (URLs, test-account emails) here; for secrets, record only a pointer ("in .env" / "in 1Password: <item>").

### 2.1 Environments & infrastructure

| Item | Value / where | Notes |
|---|---|---|
| App base URL (local) | `http://localhost:5173` | `npm run dev` |
| App base URL (public/ngrok) | `https://__________.ngrok-free.dev` | **Required** for Google OAuth & SP-API redirects; must match registered redirect URIs exactly |
| Postgres `DATABASE_URL` | in `.env` | Local Postgres or AWS RDS |
| AWS S3 bucket / region | `__________` / `__________` | File uploads (Area 4.5 / 7.3); AES-256 |
| SMTP / email capture | `__________` | Reset-password email (Area 1.5) — mailbox or server log |

### 2.2 Test user accounts (local app)

| Label | Role | Email | Password | Notes |
|---|---|---|---|---|
| OWNER | owner | `qa+owner@example.com` | `Test1234!` | Pre-registered owner of a seeded account |
| ADMIN | admin | `qa+admin@example.com` | `Test1234!` | For role-matrix tests |
| MEMBER | member | `qa+member@example.com` | `Test1234!` | Must be blocked from contact/POC actions |
| NEW | (new signup) | `qa+new+<date>@example.com` | `Test1234!` | Use a **fresh** address per sign-up run |
| OTHER-ACCT | owner | `qa+other@example.com` | `Test1234!` | Second account — for tenancy/isolation tests |

### 2.3 Third-party / integration credentials

| System | What's needed | Value / where | Used by |
|---|---|---|---|
| Google OAuth | A real Google account you control | `__________` | Area 1.3 (Google sign-in/up) |
| Google OAuth app | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | in `.env` | Area 1.3 |
| Stripe (test mode) | Publishable + secret **test** keys | in `.env` | Area 5.2, Area 10 — use test cards (Area 10.2), never a real card |
| Salesforce (JWT) | Client id, username, login URL, JWT key | in `.env` | All 🔁 flows (Areas 1,3,4,5,7,8,10,11) |
| Amazon SP-API | Seller Central (sandbox) login + `SPAPI_*` env | `__________` / in `.env` | Area 11 — `SPAPI_REDIRECT_URI` must match the registered URI exactly |

---

## 3. Area index → Asana ticket map

Each row is a **child ticket**. The **Sub-areas** column lists the **sub-tickets** to create under it. "Guide" is the step-by-step child-ticket document.

| Area (child ticket) | Guide file | Sub-areas (sub-tickets) | Test IDs | Notable recent changes |
|---|---|---|---|---|
| **1 — Authentication & Sign-in** | [AREA_1_Authentication_and_Sign-in.md](AREA_1_Authentication_and_Sign-in.md) | 1.1 Nav · 1.2 Sign-up · 1.3 Google OAuth · 1.4 Login · 1.5 Reset · 1.6 Logout · 1.7 Onboarding | `TC-AUTH-01…65` | Google OAuth; first-time onboarding; company logo on register |
| **2 — Dashboard** | [AREA_2_DASHBOARD.md](AREA_2_DASHBOARD.md) | 2.1 Stat cards · 2.2 Required Actions/Pending files · 2.3 Recent Cases + Latest Comments | `TC-DASH-01…22` | Unified Required Files (stores **+** cases) rollup |
| **3 — Accounts** | [AREA_3_ACCOUNTS.md](AREA_3_ACCOUNTS.md) | 3.1 View · 3.2 Edit Contact · 3.3 Edit Billing · 3.4 Team management 🔒 | `TC-ACCT-01…38` | — |
| **4 — Stores** | [AREA_4_STORES.md](AREA_4_STORES.md) | 4.1 List · 4.2 Create · 4.3 Edit & POC · 4.4 SP-API connect · 4.5 Required Files · 4.6 Issues filter | `TC-STORE-01…50` | **Marketplaces = multi-select picklist** from SF (free-text fallback) |
| **5 — Services & Checkout** | [AREA_5_SERVICES_AND_CHECKOUT.md](AREA_5_SERVICES_AND_CHECKOUT.md) | 5.1 Service catalog · 5.2 Checkout | `TC-SVC-01…05`, `TC-CHK-01…08` | — |
| **6 — Issues** | [AREA_6_ISSUES.md](AREA_6_ISSUES.md) | *(flat — no sub-areas)* | `TC-ISSUE-01…06` | — |
| **7 — Case detail** | [AREA_7_CASE_DETAIL.md](AREA_7_CASE_DETAIL.md) | 7.1 Timeline · 7.2 Comments (rich text) · 7.3 Documents | `TC-CASE-01…23` | Rich-text comments (`Case_Message__c`), unified uploads |
| **8 — Payments** | [AREA_8_PAYMENTS.md](AREA_8_PAYMENTS.md) | *(flat — no sub-areas)* | `TC-PAY-01…05` | **ServiceContract Description** now lists line items + total |
| **9 — Cross-cutting security** | [AREA_9_CROSS_CUTTING_SECURITY.md](AREA_9_CROSS_CUTTING_SECURITY.md) | *(flat — no sub-areas)* | `TC-SEC-01…09` | Diagnostic-endpoint exposure flags |
| **10 — Stripe payment** | [AREA_10_STRIPE_PAYMENT.md](AREA_10_STRIPE_PAYMENT.md) | 10.1 PaymentIntent API · 10.2 Test-card matrix · 10.3 Success/reconcile | `TC-STRIPE-01…44` | Payment Element; legacy `/api/checkout` → 410 |
| **11 — SP-API (Amazon)** | [AREA_11_SP_API.md](AREA_11_SP_API.md) | 11.1 Init · 11.2 Callback success · 11.3 Negative · 11.4 Connected/reconnect | `TC-SPAPI-01…33` | **Root-callback forward** — site root forwards `spapi_oauth_code`/`state`/`selling_partner_id` to `/auth/spapi/callback` |

---

## 4. Changelog — latest changes folded into this plan

> Newest first. Each row names the change and the test cases that cover it.

| Change | Source | Covered by |
|---|---|---|
| Register screen uses the **company logo** image | `login`/`register` svelte, `4df76e7` | `TC-AUTH-01`, `TC-AUTH-10` |
| **Marketplaces multi-select** sourced from SF `Store__c.Marketplaces__c` picklist (describe + ~10m cache), free-text fallback when SF unreachable | `stores/+page.*`, `salesforce/stores.ts`, `20d730a` | `TC-STORE-10…12` |
| **SP-API root-callback forward** — Amazon returns to the site root; the root route forwards `spapi_oauth_code`/`state`/`selling_partner_id` (and denial/error) to `/auth/spapi/callback` so tokens persist | `src/routes/+page.server.ts`, `20d730a` | `TC-SPAPI-10…13`, `TC-SPAPI-20…25` |
| **Dashboard unified Required Files** — replaced legacy `Case_File__c` banner with a Required Files rollup spanning **stores AND cases** (`Required_File__c`), two batched SOQL rollups; Pending Files stat reflects the new count | `dashboard/+page.*`, `salesforce/required-files.ts`, `20d730a` | `TC-DASH-04`, `TC-DASH-10…12` |
| **ServiceContract Description** now renders one line per purchased item (`qty × name — extended price`) plus a **Total** | `salesforce/contracts.ts` (working diff) | `TC-STRIPE-40`, `TC-PAY-01/03`, `TC-CHK-06` |
| First-time **onboarding** for Google sign-ups (`onboarding_completed` gate; deferred SF sync) | `onboarding/+page.*`, `c3996b4` | `TC-AUTH-24`, `TC-AUTH-60…65` |
| **Google OAuth** sign-in/sign-up (CSRF state, code→token, link/create, DB session) | `auth/google/*`, `f5cf6d8` | `TC-AUTH-20…29` |
| **Required_File__c** model + **S3_Document__c** registry + unified uploads + rich-text `Case_Message__c` | `55f900c` | `TC-STORE-40…48`, `TC-CASE-10…23` |
| Hardened **duplicate-email** signup + actionable error | `c8d6cce` | `TC-AUTH-13/13a/13b` |
| Case **timeline**, account **contacts**, **roles**, store **point-of-contact** | `0ee6a8e` | `TC-CASE-02…04`, `TC-ACCT-30…38`, `TC-STORE-22` |

---

## 5. Maintenance Quick Reference (code → test cases)

> **How to use:** before/after changing a file or component, find its row here to see which Area and test-case IDs to re-run and update. If you add a new action/route, add a row here too.

### Pages & routes

| Source file(s) | Area / feature | Test cases to update |
|---|---|---|
| `src/routes/(auth)/login/+page.{svelte,server.ts}` | 1.4 Login | `TC-AUTH-30…35` |
| `src/routes/(auth)/register/+page.{svelte,server.ts}` | 1.2 Sign-up | `TC-AUTH-10…18`, `TC-AUTH-12` (SF sync) |
| `src/routes/(auth)/forgot-password/+page.{svelte,server.ts}` | 1.5 Reset request | `TC-AUTH-40…42` |
| `src/routes/(auth)/reset-password/+page.{svelte,server.ts}` | 1.5 Reset confirm | `TC-AUTH-43…47` |
| `src/routes/auth/google/+server.ts` + `callback/+server.ts` | 1.3 Google OAuth | `TC-AUTH-20…29` |
| `src/routes/(auth)/onboarding/+page.{svelte,server.ts}` | 1.7 First-time onboarding | `TC-AUTH-60…65` |
| `src/routes/auth/logout/+page.server.ts` | 1.6 Logout | `TC-AUTH-50` |
| `src/routes/(app)/dashboard/+page.{svelte,server.ts}` | 2 Dashboard | `TC-DASH-01…22` + Appendix A–C |
| `src/routes/(app)/accounts/+page.{svelte,server.ts}` | 3 Accounts | `TC-ACCT-01…38` |
| `src/routes/(app)/stores/+page.{svelte,server.ts}` | 4.1–4.2 Store list/create | `TC-STORE-01…13` |
| `src/routes/(app)/stores/[id]/+page.{svelte,server.ts}` | 4.3–4.6 Store detail | `TC-STORE-20…50` |
| `src/routes/(app)/stores/[id]/services/+page.{svelte,server.ts}` | 5.1 Services catalog | `TC-SVC-01…05` |
| `src/routes/checkout/summary/+page.*` | 5.2 Checkout review | `TC-CHK-01…02` |
| `src/routes/checkout/payment/+page.svelte` | 5.2 / 10.2 Payment Element | `TC-CHK-03…05`, `TC-STRIPE-20…32` |
| `src/routes/api/checkout/payment_intent/+server.ts` | 10.1 PaymentIntent API | `TC-STRIPE-01…11` |
| `src/routes/api/checkout/+server.ts` | 10.1 Legacy checkout (deprecated) | `TC-STRIPE-12` |
| `src/routes/checkout/success/+page.{svelte,server.ts}` | 10.3 Success/reconcile | `TC-STRIPE-40…44`, `TC-CHK-06…07` |
| `src/routes/(app)/issues/+page.{svelte,server.ts}` | 6 Issues list | `TC-ISSUE-01…05` |
| `src/routes/(app)/cases/[caseId]/+page.server.ts` | 6 Deep-link resolver | `TC-ISSUE-06` |
| `src/routes/(app)/stores/[id]/issues/[caseId]/+page.*` | 7 Case detail | `TC-CASE-01…22` |
| `src/routes/(app)/payments/+page.*` + `payments/[id]/+page.*` | 8 Payments | `TC-PAY-01…05` |
| `src/routes/+page.server.ts` | 11 SP-API root-callback forward | `TC-SPAPI-10…13`, `TC-SPAPI-20…25` |
| `src/routes/auth/spapi/+server.ts` | 11.1 SP-API init | `TC-SPAPI-01…06` |
| `src/routes/auth/spapi/callback/+server.ts` | 11.2–11.3 SP-API callback | `TC-SPAPI-10…25` |
| `src/routes/auth/spapi/connected/[storeId]/+page.*` | 11.4 SP-API connected | `TC-SPAPI-30…33` |
| `src/routes/api/{cases,stores}/.../documents/[docId]/+server.ts` | 4.5 / 7.3 File download/preview | `TC-STORE-40…48`, `TC-CASE-20…23` |
| `src/routes/api/files/example/[s3DocId]/+server.ts` | 4.5 / 7.3 Example-file preview | `TC-STORE-47`, `TC-CASE-23` |
| `src/routes/api/{aws/diagnostic,sfdc/diagnostic/pricebook,sfdc/ping}/+server.ts` | 9 Diagnostic endpoints | `TC-SEC-07…09` |

### Server modules & shared components

| Source file(s) | What it backs | Test cases to update |
|---|---|---|
| `src/hooks.server.ts` | Session lookup, auth guard, redirects | `TC-AUTH-01…02`, `TC-SEC-02…03`, `TC-SEC-06` |
| `src/routes/(app)/+layout.server.ts` | Onboarding gate | `TC-AUTH-64` |
| `src/lib/server/auth/roles.ts` | Role gating (owner/admin/member) | `TC-ACCT-30/38`, `TC-STORE-22`, `TC-SEC-04` |
| `src/lib/server/auth/{session,cookie,password,redirects}.ts` | Sessions, cookies, hashing | `TC-AUTH-30…35/44`, `TC-SEC-01…06` |
| `src/lib/server/account/contacts.ts` | Team-member create/sync | `TC-ACCT-30…38` |
| `src/lib/server/stripe.ts` | Stripe client / PaymentIntent | all `TC-STRIPE-*` |
| `src/lib/server/salesforce/pricebook.ts` | Service catalog | `TC-SVC-*`, `TC-STRIPE-06` |
| `src/lib/server/salesforce/contracts.ts` | ServiceContract creation + Description line items | `TC-STRIPE-40…43`, `TC-PAY-*` |
| `src/lib/server/salesforce/cases.ts` + `service-cases.ts` | Cases, comments (Case_Message__c), files | `TC-CASE-*`, `TC-ISSUE-*`, `TC-DASH-10/20/21` |
| `src/lib/server/salesforce/{required-files,s3-documents}.ts` | Required_File__c slots + S3_Document__c registry | `TC-STORE-40…48`, `TC-CASE-20…23`, `TC-DASH-04/10` |
| `src/lib/server/sanitize.ts` | Server-side HTML sanitize for rich-text comments | `TC-CASE-10…13` |
| `src/lib/server/salesforce/{records,stores,sync,email,config,vuid}.ts` | SF account/contact/store sync, marketplace picklist, reset email, JWT key | `TC-ACCT-10…22`, `TC-STORE-10…13/21`, `TC-AUTH-41` |
| `src/lib/server/spapi.ts` | OAuth state, token exchange | `TC-SPAPI-*` |
| `src/lib/server/storage/{s3,s3-paths}.ts` | S3 upload/presigned-URL paths/keys | `TC-STORE-40…48`, `TC-CASE-20…23` |
| `src/lib/components/files/RequiredFiles.svelte` | Required-file slots: upload/re-upload/remove/preview | `TC-STORE-40…48`, `TC-CASE-20…23` |
| `src/lib/components/files/FilePreviewModal.svelte` | In-app preview (image/PDF/text/video/audio) | `TC-STORE-47…48`, `TC-CASE-23` |
| `src/lib/components/ui/RichTextEditor.svelte` | Rich-text comment composer | `TC-CASE-10…13` |
| `src/lib/components/cases/CaseTimeline.svelte` | Case timeline UI | `TC-CASE-02…04` |
| `src/lib/components/layout/{Sidebar,Topbar}.svelte` | Nav + tabs, greeting | `TC-DASH-07`, navigation in all areas |
| `src/lib/components/ui/{Badge,Button,Card,StatCard,Toast}.svelte` | Shared UI primitives | cross-cutting — re-check status badges, stat cards, toasts in affected areas |

---

## 6. Appendix — Spec vs. build gaps to confirm with product

| # | Described spec | Actual build | Action |
|---|---|---|---|
| A | Home panel 1 = 5 cards incl. **Account status**, **Inactive stores**, **Closed Issues** | 4 cards: Open Cases, Active Stores, Pending Files, Resolved This Month | Confirm desired cards |
| B | Home panel 2 = **Pending Files** + **Latest Comments (10)** with "View more" | Required-Actions banner + Recent Cases + Latest Comments (~6), no "View more" | Confirm layout & counts |
| C | Home panel 3 = **Last activity** (store activities) | Not present as a distinct panel | Confirm if needed |
| D | Google sign-in fully functional | ✅ **Implemented** — CSRF `state`, code→token exchange, profile fetch, user resolve/link/create, real DB session (`TC-AUTH-20…29`). Requires `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` env | Confirm prod env vars + Google OAuth consent screen config |
| E | Payments reconciled server-side | ⚠️ **No Stripe webhook yet** — a payment is only reconciled when the browser lands on `/checkout/success` (`TC-STRIPE-42`). Closing the tab before redirect may lose the record | Confirm reconciliation plan / add webhook |
| F | Diagnostic endpoints hardened | ⚠️ `GET /api/sfdc/ping` has **no auth** (`TC-SEC-08`); `/api/aws/diagnostic` & `/api/sfdc/diagnostic/pricebook` are authenticated but ungated (`TC-SEC-07`); `/api/files/example/<id>` not tenancy-scoped (`TC-SEC-09`) | Guard/remove before prod |
