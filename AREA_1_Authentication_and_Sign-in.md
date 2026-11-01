# AREA 1 — Authentication & Sign-in — Detailed QA Guide

Step-by-step execution guide for every Area 1 test case in `QA_TEST_CASES.md`.
Use this document to run the tests manually and record Pass/Fail.

- **Application:** SvelteKit web app (Appeals Doctor / SamDoctor Web)
- **Role covered:** **Client** (account user) — sub-roles `owner`, `admin`, `member`
- **Total Area 1 test cases:** **45** (TC-AUTH-01 … TC-AUTH-65)
- **Legend:** 🔒 role-gated · 🔁 Salesforce-synced · ⛔ negative/edge case
- **Priority:** P1 (critical) · P2 (major) · P3 (minor)

---

## How to use this guide

1. Replace `{BASE_URL}` with the environment under test, e.g. `http://localhost:5173`
   or the public ngrok URL (e.g. `https://<sub>.ngrok-free.dev`).
   > Google OAuth and SP-API redirects require the **ngrok/public URL** (and that exact
   > URL registered in the Google OAuth consent screen + redirect URIs).
2. Work through each test case in order. Each card has **Preconditions → Test Data → Steps → Expected Result**.
3. Record the result in the **Run log** table at the bottom.

### Environment prerequisites

| Requirement | Why |
|---|---|
| App running (`npm run dev`) + Postgres reachable | All flows |
| A **clean database** OR known seed users | Sign-up / duplicate-email tests |
| SMTP/email capture (mailbox or log) | Reset-password email (TC-AUTH-41/43) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` set | Google tests (1.3) |
| Salesforce JWT creds configured | 🔁 sync verifications (TC-AUTH-12/62) |
| Browser DevTools (Application → Cookies; Network) | Cookie/redirect assertions |

### Reusable test accounts

| Label | Email | Password | Notes |
|---|---|---|---|
| NEW | `qa+new@example.com` | `Test1234!` | Use a fresh address per sign-up run |
| EXISTING | `qa+owner@example.com` | `Test1234!` | Pre-registered owner |
| GOOGLE | a real Google account you control | — | For OAuth consent |

---

## 1.1 Navigation to login

### TC-AUTH-01 (P1) — Unauthenticated user reaches login via URL
**Preconditions:** Logged out (clear cookies for `{BASE_URL}`).
**Steps:**
1. Open `{BASE_URL}/` in a fresh/incognito window.
2. Observe the redirect and the rendered page.

**Expected Result:**
- Redirected to `{BASE_URL}/login`.
- Page shows the **Appeals Doctor logo** (`/icons/company_logo.svg`) — renders, no broken-image icon.
- Visible controls: **Email** field, **Password** field, **Sign in** button, **Continue with Google**, **Forgot password?**, and a **Sign up** link.

---

### TC-AUTH-02 (P1) — Protected URL redirects to login, returns after sign-in
**Preconditions:** Logged out. Have EXISTING account credentials.
**Steps:**
1. Navigate directly to `{BASE_URL}/dashboard`.
2. Confirm the URL after redirect.
3. Sign in with the EXISTING account.

**Expected Result:**
- Step 2: redirected to `{BASE_URL}/login?next=/dashboard`.
- Step 3: after successful login, lands back on `{BASE_URL}/dashboard` (the `next` target).

---

### TC-AUTH-03 (P2) ⛔ — Visiting /login while already authenticated
**Preconditions:** Logged in (active session).
**Steps:**
1. With a valid session, navigate to `{BASE_URL}/login`.

**Expected Result:**
- User is taken to `{BASE_URL}/dashboard` (intended behavior) — **or** remains on `/login`.
- Confirm the actual behavior against spec and record which occurs.

---

## 1.2 Manual sign-up (`/register`)

### TC-AUTH-10 (P1) — Sign-up form renders
**Preconditions:** Logged out, on `{BASE_URL}/login`.
**Steps:**
1. Click **Sign up**.

**Expected Result:**
- Navigates to `{BASE_URL}/register`.
- Fields present: **Full name**, **Company**, **Email**, **Phone**, **Website**, **Password**, **Confirm password**.

---

### TC-AUTH-11 (P1) — Successful registration creates owner + session
**Preconditions:** Use a **fresh** email (NEW) not already registered.
**Test Data:** Full name `QA Tester`, Company `QA Co`, Email `qa+new@example.com`, Phone `5551234567`, Website `https://qa.example.com`, Password `Test1234!`, Confirm `Test1234!`.
**Steps:**
1. Go to `{BASE_URL}/register`.
2. Fill all fields with valid data above.
3. Submit.

**Expected Result:**
- Account + **owner** user created; session cookie set.
- Redirected into the app (dashboard).
- New user role = **owner** (verify via DB or Accounts page later).

---

### TC-AUTH-12 (P1) 🔁 — Salesforce Account + Contact created on registration
**Preconditions:** Salesforce configured and reachable. Completed TC-AUTH-11 (or register a new user).
**Steps:**
1. Register a new user (as in TC-AUTH-11).
2. In Salesforce, search for the new **Account** (by company name) and **Contact** (by email).
3. (Optional) Check the local `accounts`/`users` rows for `sfdc_account_id` / `sfdc_contact_id`.

**Expected Result:**
- A Salesforce **Account** and **Contact** are created (best-effort).
- Local records are linked back with `sfdc_account_id` / `sfdc_contact_id`.
- **Resilience:** If SF is down at registration time, the sign-up still succeeds and the sync is queued (no user-facing failure).

---

### TC-AUTH-13 (P1) ⛔ — Duplicate email is blocked
**Preconditions:** EXISTING account already registered with `qa+owner@example.com`.
**Steps:**
1. Go to `{BASE_URL}/register`.
2. Enter the **already-registered** email with otherwise valid data.
3. Submit.

**Expected Result:**
- Blocked with message **"An account with this email already exists."**
- Email field is highlighted; a **"Sign in instead →"** link appears.
- **No** duplicate account/user created (verify count unchanged in DB).

---

### TC-AUTH-13a (P2) — "Sign in instead →" pre-fills email
**Preconditions:** On the duplicate-email error state from TC-AUTH-13.
**Steps:**
1. Click **"Sign in instead →"**.

**Expected Result:**
- Lands on `{BASE_URL}/login` with the **email pre-filled**.
- Any `next` parameter is preserved.
- Only the password is required to continue.

---

### TC-AUTH-13b (P2) ⛔ (race condition) — Concurrent duplicate registrations
**Preconditions:** A fresh email not yet registered. Ability to fire two near-simultaneous submits (two tabs, or a quick double request).
**Steps:**
1. Prepare two registration forms with the **same** fresh email.
2. Submit both as close to simultaneously as possible.

**Expected Result:**
- Exactly **one** registration succeeds.
- The other receives the friendly **"account already exists"** message (not a generic 500).
- Enforced by the `users.email` UNIQUE constraint (Postgres error `23505`).

---

### TC-AUTH-14 (P2) ⛔ — Password too short
**Steps:**
1. On `{BASE_URL}/register`, fill valid fields but set Password = `Test1` (< 8 chars), Confirm same.
2. Submit.

**Expected Result:** Validation error shown; **account not created**.

---

### TC-AUTH-15 (P2) ⛔ — Password ≠ Confirm
**Steps:**
1. On `{BASE_URL}/register`, set Password = `Test1234!`, Confirm = `Test9999!`.
2. Submit.

**Expected Result:** "Passwords do not match" error; account not created.

---

### TC-AUTH-16 (P2) ⛔ — Invalid email format
**Steps:**
1. On `{BASE_URL}/register`, set Email = `not-an-email`.
2. Submit.

**Expected Result:** Email validation error; account not created.

---

### TC-AUTH-17 (P2) ⛔ — Invalid phone / website; values preserved
**Steps:**
1. On `{BASE_URL}/register`, set Phone = `123` (< 7 digits) and/or Website = `htp:/bad`.
2. Submit.

**Expected Result:**
- Field-level validation errors on phone and/or website.
- Previously entered values in **other** fields are **preserved** on the form.

---

### TC-AUTH-18 (P3) ⛔ — All fields empty
**Steps:**
1. On `{BASE_URL}/register`, leave everything blank.
2. Submit.

**Expected Result:** Each required field is flagged; no submission.

---

## 1.3 Google sign-up / sign-in

> **Implementation notes:** `GET /auth/google` requires `GOOGLE_CLIENT_ID`; it generates a CSRF
> `state`, stores `{state, next}` in a short-lived (10 min) **HttpOnly** `g_oauth` cookie, and **302**-redirects
> to `accounts.google.com/o/oauth2/v2/auth` with scope `openid email profile`, `access_type=offline`,
> `prompt=select_account`. `GET /auth/google/callback` verifies `state` (single-use; cookie deleted up-front),
> exchanges `code` for tokens, fetches the profile, then resolves the user:
> (a) existing `oauth_accounts(google, sub)` → sign-in; (b) else existing `users.email` → **link** + sign-in;
> (c) else **create** account + owner user (sign-up). Then creates a DB session and **303**-redirects.

### TC-AUTH-20 (P2) — Initiate Google consent
**Preconditions:** `GOOGLE_CLIENT_ID` set. Logged out.
**Steps:**
1. On `{BASE_URL}/login` (or `/register`), open DevTools → Network.
2. Click **Continue with Google**.
3. Inspect the redirect request and cookies.

**Expected Result:**
- **302** to `accounts.google.com/o/oauth2/v2/auth` with `prompt=select_account`, scope `openid email profile`, and a `state` parameter.
- A short-lived **HttpOnly** `g_oauth` cookie is set carrying `state` (and any `next`).

---

### TC-AUTH-21 (P2) — Complete Google consent → session created
**Preconditions:** GOOGLE account available; from TC-AUTH-20 redirect.
**Steps:**
1. Complete the Google consent (choose account, approve).
2. Observe the return to the app.

**Expected Result:**
- Returned to `{BASE_URL}/auth/google/callback`; code exchanged for tokens; profile fetched.
- Real DB session created (**HttpOnly** session cookie).
- **303** redirect to `/dashboard` (or the preserved `?next`).
- `last_login_at` updates for the user.

---

### TC-AUTH-22 (P2) ⛔ — User cancels Google consent
**Steps:**
1. Begin the Google flow, then **cancel/deny** at Google (so Google returns `?error=access_denied`).

**Expected Result:**
- Callback throws **400** "Google sign-in was cancelled or failed".
- No session created; user is **not** signed in.

---

### TC-AUTH-23 (P3) — Returning Google user resolves to same user
**Preconditions:** A user previously **signed up** with Google (record in `oauth_accounts`).
**Steps:**
1. Sign out.
2. Sign in again with the **same** Google account.

**Expected Result:**
- Resolved via `oauth_accounts(google, sub)` to the **same** user.
- **No** duplicate account/user created.

---

### TC-AUTH-24 (P2) — First-time Google user → sign-up + onboarding
**Preconditions:** Google account whose email is **not** in `users`.
**Steps:**
1. Click **Continue with Google** and complete consent with the new Google account.
2. Observe where you land.

**Expected Result:**
- **Sign-up:** new account + **owner** user created from Google name/email (company blank), `avatar_url` from Google picture.
- Account created with `onboarding_completed=false`.
- The `(app)` guard redirects to **`/onboarding`** (not the dashboard).
- Salesforce sync is **deferred** until onboarding (not run in the callback).

---

### TC-AUTH-25 (P1) — Google email matches existing local user → link & sign-in
**Preconditions:** A user that **registered manually** with email `qa+owner@example.com`; a Google account with the **same** email.
**Steps:**
1. Sign out.
2. Click **Continue with Google** and authenticate with the matching-email Google account.

**Expected Result:**
- **Sign-in by email link:** Google linked to the existing user via `oauth_accounts`.
- **No** duplicate account/user created.

---

### TC-AUTH-26 (P1) ⛔ (CSRF) — Missing/mismatched state
**Preconditions:** Ability to hit the callback URL manually.
**Steps:**
1. Start the Google flow (sets `g_oauth` cookie), then either:
   - manually call `{BASE_URL}/auth/google/callback?code=fake&state=wrong`, or
   - delete/expire the `g_oauth` cookie before the callback, or
   - replay a previously-used callback URL.

**Expected Result:**
- **400** "invalid or expired request".
- No token exchange, no session.
- State is single-use (cookie deleted on first callback) — a **replayed** callback fails.

---

### TC-AUTH-27 (P2) ⛔ — Callback with no code
**Steps:**
1. With a valid `g_oauth` cookie/state, call `{BASE_URL}/auth/google/callback?state=<valid>` **without** a `code` and **without** an `error`.

**Expected Result:** **400** "missing authorization code".

---

### TC-AUTH-28 (P2) ⛔ (config) — Google env vars unset
**Steps:**
1. With `GOOGLE_CLIENT_ID` **unset**, request `{BASE_URL}/auth/google`.
2. (Separately) With `GOOGLE_CLIENT_SECRET` **unset**, reach the callback.

**Expected Result:**
- `/auth/google` → **503** "Google sign-in is not configured".
- Callback → **503** when the secret is unset.
- No redirect to Google; no session.

---

### TC-AUTH-29 (P2) ⛔ — Token/userinfo fetch fails at Google
**Steps:**
1. Reach the callback with a **bad/used code** (or simulate a network failure to Google).

**Expected Result:**
- Callback returns **502**.
- Failure recorded via `logError` (`source: 'auth.google'`).
- No partial session created.

---

## 1.4 Username (email/password) login

### TC-AUTH-30 (P1) — Valid login
**Preconditions:** EXISTING account with known password.
**Steps:**
1. Go to `{BASE_URL}/login`.
2. Enter valid email + password.
3. Submit.

**Expected Result:**
- Signed in; redirected to `/dashboard` (or `?next`).
- `last_login_at` updates.

---

### TC-AUTH-31 (P1) ⛔ — Wrong password
**Steps:**
1. On `{BASE_URL}/login`, enter a **valid email** with the **wrong** password.
2. Submit.

**Expected Result:**
- Generic **"Invalid email or password"**.
- Must **not** reveal whether the email exists.

---

### TC-AUTH-32 (P1) ⛔ — Non-existent email (timing-safe)
**Steps:**
1. On `{BASE_URL}/login`, enter an email that **does not exist** + any password.
2. Submit; note response time.

**Expected Result:**
- Same generic **"Invalid email or password"** error.
- Response time is **similar** to the wrong-password case (timing-attack mitigation).

---

### TC-AUTH-33 (P2) ⛔ — Empty email or password
**Steps:**
1. On `{BASE_URL}/login`, leave email and/or password blank.
2. Submit.

**Expected Result:** Field validation error; no submission.

---

### TC-AUTH-34 (P2) — Session cookie is HttpOnly
**Preconditions:** Logged in.
**Steps:**
1. Open DevTools → **Console**, run `document.cookie`.
2. Open DevTools → **Application → Cookies** and inspect the session cookie.

**Expected Result:**
- The session cookie is **not** present in `document.cookie`.
- It is flagged **HttpOnly** in the cookie inspector.

---

### TC-AUTH-35 (P2) — Google option on login
**Steps:**
1. Open `{BASE_URL}/login`.

**Expected Result:** **Continue with Google** button is present for users who signed up with Google.

---

## 1.5 Reset-password flow

### TC-AUTH-40 (P1) — Reach forgot-password
**Steps:**
1. On `{BASE_URL}/login`, click **Forgot password?**.

**Expected Result:** Navigates to `{BASE_URL}/forgot-password` with an email field.

---

### TC-AUTH-41 (P1) — Request reset for a registered email
**Preconditions:** EXISTING registered email; access to its mailbox (or email log).
**Steps:**
1. On `{BASE_URL}/forgot-password`, enter the registered email.
2. Submit.
3. Check the mailbox/log.

**Expected Result:**
- Success state ("Check your email").
- A reset email is sent containing a link `{BASE_URL}/reset-password?token=...`.

---

### TC-AUTH-42 (P1) ⛔ (security) — Request reset for an unregistered email
**Steps:**
1. On `{BASE_URL}/forgot-password`, enter an email that is **not** registered.
2. Submit.

**Expected Result:**
- **Same** success message as TC-AUTH-41 (no account enumeration).
- No email is actually delivered to an unknown address (verify no leak of existence).

---

### TC-AUTH-43 (P1) — Open valid reset link
**Preconditions:** A valid, unused token from TC-AUTH-41.
**Steps:**
1. Open `{BASE_URL}/reset-password?token=<valid>`.

**Expected Result:** Page shows **new-password** + **confirm** fields.

---

### TC-AUTH-44 (P1) — Set a valid new password
**Steps:**
1. On the reset page, enter a new password (≥ 8 chars), matching confirm.
2. Submit.
3. Go to `{BASE_URL}/login` and sign in with the **new** password.

**Expected Result:**
- Redirected to `{BASE_URL}/login?reset=1` with a success banner.
- Login with the new password succeeds.

---

### TC-AUTH-45 (P1) ⛔ — Expired or already-used token
**Preconditions:** A token that is **expired (> 1h)** or already used.
**Steps:**
1. Open `{BASE_URL}/reset-password?token=<expired-or-used>`.

**Expected Result:**
- "Link expired" state with **"Request a new link"**.
- Cannot reset the password.

---

### TC-AUTH-46 (P2) ⛔ — Invalid new password on reset
**Steps:**
1. On a valid reset page, set a new password **< 8 chars** or with a **mismatched** confirm.
2. Submit.

**Expected Result:** Validation error; password **unchanged**.

---

### TC-AUTH-47 (P2) ⛔ — Reuse the same reset link twice
**Steps:**
1. Successfully reset a password with a valid link (TC-AUTH-44).
2. Open the **same** reset link again and attempt another reset.

**Expected Result:** Second attempt is **rejected** (token marked used).

---

## 1.6 Logout

### TC-AUTH-50 (P1) — Logout clears session
**Preconditions:** Logged in.
**Steps:**
1. Trigger **Logout** from the app.
2. After redirect, press the browser **Back** button.
3. (Optional) Inspect cookies and DB `sessions` row.

**Expected Result:**
- Session row deleted; session cookie cleared.
- Redirected to `{BASE_URL}/login`.
- **Back** button does **not** restore an authenticated session.

---

## 1.7 First-time onboarding (`/onboarding`)

> **Implementation notes:** Accounts carry `onboarding_completed` (migration 016, **default `true`** — so
> manual `/register` sign-ups and existing accounts never see onboarding). Google **sign-ups** insert
> `onboarding_completed=false`. The `(app)` layout guard redirects any authenticated user whose account is
> `onboarding_completed=false` to `/onboarding`. Submitting saves company/website/phone locally, runs the
> **deferred** Salesforce Account+Contact sync (best-effort), sets `onboarding_completed=true`, and
> 303-redirects to `/dashboard`.

### TC-AUTH-60 (P1) — Land on onboarding after first Google sign-up
**Preconditions:** Completed TC-AUTH-24 (new Google user, `onboarding_completed=false`).
**Steps:**
1. Immediately after the first-time Google sign-up, observe the page.

**Expected Result:**
- Lands on `{BASE_URL}/onboarding` (not the dashboard).
- Form shows: **Full name** (pre-filled from Google), **Email** (read-only/disabled), **Company name** (required), **Website**, **Phone**.

---

### TC-AUTH-61 (P1) — Submit onboarding completes it
**Steps:**
1. On `{BASE_URL}/onboarding`, enter a **Company name** (and optional website/phone). Optionally change the name.
2. Submit.
3. After landing on the dashboard, navigate back to `{BASE_URL}/onboarding`.

**Expected Result:**
- Account `name`/`phone`/`website` saved; `display_name` updated if the name changed.
- `onboarding_completed=true`; redirected to `/dashboard`.
- Step 3: visiting `/onboarding` again redirects **straight to** `/dashboard`.

---

### TC-AUTH-62 (P1) 🔁 — Deferred Salesforce sync on onboarding
**Preconditions:** Salesforce configured.
**Steps:**
1. Complete onboarding with a company name (TC-AUTH-61).
2. In Salesforce, find the new **Account** + **Contact** by company/email.
3. Check `sfdc_account_id` / `sfdc_contact_id` on the local `accounts`, `users`, and `account_contacts` rows.

**Expected Result:**
- Salesforce **Account** + **Contact** created with the entered company name and linked back to local records.
- **Resilience:** If SF is down, onboarding still completes and the sync is queued.

---

### TC-AUTH-63 (P2) ⛔ — Empty company name blocked
**Steps:**
1. On `{BASE_URL}/onboarding`, leave **Company name** empty (fill others).
2. Submit.

**Expected Result:**
- **400** "Company name is required."
- Previously entered values preserved; onboarding **not** completed.

---

### TC-AUTH-64 (P1) ⛔ (gate) — App routes redirect to onboarding while incomplete
**Preconditions:** A user with `onboarding_completed=false` (don't submit the form yet).
**Steps:**
1. While onboarding is incomplete, navigate directly to `{BASE_URL}/dashboard`.
2. Try other `(app)` routes, e.g. `{BASE_URL}/stores`.

**Expected Result:**
- Each `(app)` route redirects back to `{BASE_URL}/onboarding`.
- The `/onboarding` route itself remains reachable (it is outside `(app)`).

---

### TC-AUTH-65 (P2) — Manual sign-ups skip onboarding
**Preconditions:** A user created via **manual `/register`** (TC-AUTH-11).
**Steps:**
1. Sign in as the manually-registered user.
2. Observe the landing page; try `{BASE_URL}/onboarding`.

**Expected Result:**
- Goes straight to the dashboard (`onboarding_completed=true` by default).
- Never sees/forced into `/onboarding`.

---

## Run log

| TC ID | Pri | Result (Pass/Fail/Blocked) | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-AUTH-01 | P1 | | | | |
| TC-AUTH-02 | P1 | | | | |
| TC-AUTH-03 | P2 | | | | |
| TC-AUTH-10 | P1 | | | | |
| TC-AUTH-11 | P1 | | | | |
| TC-AUTH-12 | P1 | | | | |
| TC-AUTH-13 | P1 | | | | |
| TC-AUTH-13a | P2 | | | | |
| TC-AUTH-13b | P2 | | | | |
| TC-AUTH-14 | P2 | | | | |
| TC-AUTH-15 | P2 | | | | |
| TC-AUTH-16 | P2 | | | | |
| TC-AUTH-17 | P2 | | | | |
| TC-AUTH-18 | P3 | | | | |
| TC-AUTH-20 | P2 | | | | |
| TC-AUTH-21 | P2 | | | | |
| TC-AUTH-22 | P2 | | | | |
| TC-AUTH-23 | P3 | | | | |
| TC-AUTH-24 | P2 | | | | |
| TC-AUTH-25 | P1 | | | | |
| TC-AUTH-26 | P1 | | | | |
| TC-AUTH-27 | P2 | | | | |
| TC-AUTH-28 | P2 | | | | |
| TC-AUTH-29 | P2 | | | | |
| TC-AUTH-30 | P1 | | | | |
| TC-AUTH-31 | P1 | | | | |
| TC-AUTH-32 | P1 | | | | |
| TC-AUTH-33 | P2 | | | | |
| TC-AUTH-34 | P2 | | | | |
| TC-AUTH-35 | P2 | | | | |
| TC-AUTH-40 | P1 | | | | |
| TC-AUTH-41 | P1 | | | | |
| TC-AUTH-42 | P1 | | | | |
| TC-AUTH-43 | P1 | | | | |
| TC-AUTH-44 | P1 | | | | |
| TC-AUTH-45 | P1 | | | | |
| TC-AUTH-46 | P2 | | | | |
| TC-AUTH-47 | P2 | | | | |
| TC-AUTH-50 | P1 | | | | |
| TC-AUTH-60 | P1 | | | | |
| TC-AUTH-61 | P1 | | | | |
| TC-AUTH-62 | P1 | | | | |
| TC-AUTH-63 | P2 | | | | |
| TC-AUTH-64 | P1 | | | | |
| TC-AUTH-65 | P2 | | | | |

**Area 1 total: 45 test cases** — at 2 min average ≈ **90 minutes** (allow more for Google/SF flows).
