# AREA 3 — Accounts tab

Detailed QA test cases for the **Accounts tab** (`/accounts`) — the account, contact, billing, and team-management surface.
This document is the **Asana child ticket for Area 3**; the sub-areas **3.1–3.4** below are its **sub-tickets**.
Each case includes a **purpose**, **preconditions**, a numbered **step-by-step guide**, and the **expected result**.

- **Route(s):** `/accounts`
- **Source files:** [`+page.server.ts`](src/routes/(app)/accounts/+page.server.ts) · [`+page.svelte`](src/routes/(app)/accounts/+page.svelte) · [`contacts.ts`](src/lib/server/account/contacts.ts) · [`roles.ts`](src/lib/server/auth/roles.ts)
- **Role coverage:** Client (`owner` / `admin` / `member`). The page **renders** for all signed-in users; **team-management actions** (add / update / remove / set-POC) are gated to `owner` / `admin` only (`canManageAccountContacts`).
- **ID scheme:** `TC-ACCT-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 role/tenancy · 🔁 Salesforce-synced · ⛔ negative/edge case

---

## What the Accounts tab does (functional overview)

On load, `+page.server.ts` assembles **one** account view from several independent sources, then keeps Salesforce and the local DB loosely in sync:

1. **Local DB (always available)** — the signed-in `user` (id, email, display name, role, timestamps), their `account` row (name, email/phone/website, billing address, `sfdc_account_id`), and the `account_contacts` list for that account (joined to `users` for each contact's role). Before loading, `ensureOwnerAccountContact(...)` guarantees the owner has a contact row and is the default Point of Contact.
2. **Salesforce Account** — `fetchSalesforceAccount(sfdcAccountId, ctx)` (read-only fields: Account Number, Type, Industry, Rating, Ownership, Annual Revenue, Employees, Start Date, Shipping Address, Description, system info).
3. **Salesforce Contact** — `fetchSalesforceContact(sfdcContactId, ctx)` (Salutation/First/Last, Title, Department, Email, Phones, Mailing Address, system info).
4. **SF ID pills** — the resolved `sfdcIds.accountId` and `sfdcIds.contactId` render as copyable pills at the top.

**Resilience:** the SF Account and SF Contact are fetched **in parallel** and each can succeed or fail **independently** (Promise.all of two fetches + the local contacts query). A failure does **not** crash the page — the affected record shows a status badge (`Synced` / `Not found in SF` / `SF read error` / `Not linked`) and, for a read error, an inline alert; all local data still renders.

**Write paths (best-effort SF sync):**
- **`edit_contact`** — PATCHes the SF Contact (`FirstName`/`LastName`/`Phone`), then mirrors `display_name = "First Last"` to the local `users` row (local mirror failure is non-fatal, logged as `warn`).
- **`edit_billing_address`** — writes the local `accounts` row **first** (empty inputs → `NULL`), then PATCHes the SF Account's `Billing*` fields. If SF rejects, the local write still stands and the message flags the divergence.
- **`add_account_contact`** — creates a `member`-role app user + `account_contacts` row (`createAccountTeamUser`), then **best-effort** creates a linked SF Contact **only when the account has an `sfdc_account_id`** (`syncTeamUserToSalesforce`).
- **`update_account_contact`** / **`remove_account_contact`** / **`set_point_of_contact`** — local-only DB writes, all gated to owner/admin.

**Role gating:** `canManageAccountContacts(role)` returns `true` only for `owner`/`admin`. The `+ Add Team Member` button and per-row action controls are hidden from `member` users, and every management action re-checks the role **server-side** and returns `fail(403)` if a `member` forces the POST. The **owner** cannot be removed (`fail(403)` when `target.user_role === 'owner'`), and the DELETE additionally guards `role <> 'owner'`.

---

## 3.1 View account & contact (read-only)

### TC-ACCT-01 (P1) — Account, Contact, Local User, and Team all render; SF ID pills copyable
**Purpose:** confirm the four record sections and the copyable SF-ID pills all render on `/accounts`.
**Preconditions:** signed-in client user whose account is linked to a Salesforce Account and Contact (both reachable).
**Steps:**
1. Sign in and navigate to `{BASE_URL}/accounts`.
2. Observe the **Salesforce IDs strip** at the top (two pills).
3. Click the **Salesforce Account ID** pill value, then the **Salesforce Contact ID** pill value.
4. Scroll through the page and identify the four record sections.
**Expected:**
- Topbar shows title **"Account"**, subtitle **"Synced from Salesforce"**.
- Two ID pills render: **Salesforce Account ID** and **Salesforce Contact ID**. Each linked ID shows as a monospace clickable `<button>` with tooltip **"Click to copy"**; clicking copies the ID to the clipboard (`navigator.clipboard.writeText`). Unlinked IDs render as muted **"Not linked"** (not clickable).
- Four `ACCOUNT` / `CONTACT` / `LOCAL APP USER` / `ACCOUNT TEAM` record cards render, in that order, each with a status badge where applicable.
- The **ACCOUNT** and **CONTACT** headers show a green **"Synced"** badge when their SF record loaded.

### TC-ACCT-02 (P2) — Read-only fields render with correct number/currency formatting
**Purpose:** verify the read-only Salesforce fields display and that numeric/currency/date values are formatted.
**Preconditions:** SF Account has Account Number, Industry, Annual Revenue, NumberOfEmployees, Shipping Address, Start Date, and system info populated.
**Steps:**
1. On `{BASE_URL}/accounts`, read the **Account Information** section.
2. Read the **Shipping Address** section and its read-only tag.
3. Read the **System Information** section (Owner ID, Created, Last Modified, Salesforce ID).
4. Cross-check Annual Revenue and Employees against the Salesforce record.
**Expected:**
- Account Information shows Account Name, Account Number, Type, Industry, Phone, Fax, Website (as a link when present), Primary Email, Rating, Ownership, **Annual Revenue** (formatted as USD currency, no decimals, e.g. `$1,250,000`), **Employees** (thousands-separated, e.g. `1,200`), and Start Date (locale date). Missing values render as `—`.
- Shipping Address section shows the joined address and a **"read-only · from Salesforce"** tag; empty parts are omitted, fully empty → `—`.
- System Information shows Owner ID and Salesforce ID in monospace, and Created / Last Modified as locale date-times.
- No `NaN`, no `undefined` on screen.

### TC-ACCT-03 (P3) ⛔ — Salesforce unreachable: page still loads local data
**Purpose:** verify a Salesforce read failure degrades gracefully without a hard crash.
**Preconditions:** force the SF Account and/or Contact fetch to fail (SF down / bad token / revoked access) while the local account + user rows exist.
**Steps:**
1. Trigger the SF read failure, then load `{BASE_URL}/accounts`.
2. Inspect the ACCOUNT and CONTACT card headers, badges, and any inline alerts.
3. Confirm the LOCAL APP USER and ACCOUNT TEAM sections still render.
**Expected:**
- The page renders fully — no 500, no blank screen.
- For a read error (not a 404), the affected card shows a **"SF read error"** badge and an inline red alert: **"Could not load account from Salesforce: `<error>`"** (or the equivalent contact message). A genuine 404 shows a grey **"Not found in SF"** badge instead.
- The ACCOUNT card falls back to `data.localAccount.name`; the CONTACT card falls back to the local user's display name/email.
- Local App User info and the Account Team list render normally from the DB.

---

## 3.2 Edit Contact

### TC-ACCT-10 (P1) 🔁 — Edit Contact → SF Contact PATCHed, display name mirrored, success message
**Purpose:** verify the contact edit form writes to Salesforce and mirrors the display name locally.
**Preconditions:** signed-in user whose `users.sfdc_contact_id` is linked; SF Contact reachable.
**Steps:**
1. On `{BASE_URL}/accounts`, in the **CONTACT** card, click **Edit**.
2. Confirm the form shows **First name**, **Last name** (required), and **Phone** fields, pre-filled from the SF Contact.
3. Change First name and Phone, then click **Save to Salesforce**.
4. After the form closes, reload the page and re-open Edit to confirm persistence.
**Expected:**
- The SF Contact is PATCHed with `{ FirstName, LastName, Phone }` (empty First/Phone sent as `null`).
- On success, a blue info alert reads **"Contact updated in Salesforce."** and the edit form closes.
- The local `users.display_name` is updated to `"First Last"` (or just `Last` when First is empty) — visible in the LOCAL APP USER card's **Display Name** and the Topbar greeting on other pages.
- Re-opening Edit shows the new values.

### TC-ACCT-11 (P2) ⛔ — Missing required Last name → validation error, not saved
**Purpose:** verify server-side validation blocks an empty last name (SF requires it).
**Preconditions:** contact linked; edit form open.
**Steps:**
1. Open the CONTACT **Edit** form.
2. Clear the **Last name** field (also try clearing then bypassing the client `required` attribute via a crafted POST).
3. Submit.
**Expected:**
- The action returns `fail(400)` with error **"Last name is required by Salesforce."**, shown as a red alert.
- No PATCH is sent to Salesforce; no local display-name change.
- The First/Last/Phone values are echoed back so the user does not lose their input.

### TC-ACCT-12 (P2) — Cancel discards changes
**Purpose:** verify Cancel abandons edits without persisting.
**Preconditions:** contact linked; edit form open.
**Steps:**
1. Open the CONTACT **Edit** form.
2. Change First name / Last name / Phone but do **not** save.
3. Click **Cancel**.
4. Re-open Edit.
**Expected:**
- The form closes with no request sent. The displayed Contact fields are unchanged. Re-opening Edit shows the original SF values (no local or SF mutation occurred).

---

## 3.3 Edit Billing Address

### TC-ACCT-20 (P1) 🔁 — Edit billing address → saved locally + PATCHed to SF Account
**Purpose:** verify the billing-address edit writes local DB first, then syncs to the SF Account.
**Preconditions:** signed-in user with a linked local `account` **and** an `sfdc_account_id`; SF Account reachable.
**Steps:**
1. On `{BASE_URL}/accounts`, in the ACCOUNT card's **Billing Address** section, click **Edit**.
2. Confirm the grid fields: **Street** (full width), **City**, **State / Province**, **Postal code**, **Country**, pre-filled from local DB (falling back to SF Account values).
3. Edit all five fields and click **Save**.
4. Reload the page to confirm persistence in the read-only view.
**Expected:**
- The local `accounts.billing_*` columns are updated, then the SF Account is PATCHed with `BillingStreet/City/State/PostalCode/Country`.
- On success, a blue info alert reads **"Billing address updated locally and in Salesforce."** and the form closes.
- If the account has **no** `sfdc_account_id` yet, the message instead reads **"Billing address saved. Will sync to Salesforce once linked."**
- The read-only Billing Address view shows the new values after reload.

### TC-ACCT-21 (P2) ⛔ — SF rejects the update → partial-success message, local values persist
**Purpose:** verify local-first semantics when Salesforce rejects the PATCH.
**Preconditions:** account has a linked `sfdc_account_id`; force the SF Account PATCH to fail (e.g. invalid state/country picklist, permissions).
**Steps:**
1. Open the **Billing Address** edit form and enter valid-looking values.
2. Force the SF PATCH to fail, then click **Save**.
3. Reload the page and re-open Edit.
**Expected:**
- The action returns `fail(502)` with `savedLocally: true` and error **"Saved locally but Salesforce rejected the update: `<error>`"**, shown as a red alert.
- The local DB values **were persisted** — after reload, the read-only view and the pre-filled form show the new values (local and SF may now diverge until the sync queue reconciles).

### TC-ACCT-22 (P3) — Empty fields stored as NULL (not empty strings)
**Purpose:** verify blank inputs are normalized to `NULL` in the DB, not `''`.
**Preconditions:** account with existing billing values; user can inspect the DB row.
**Steps:**
1. Open the **Billing Address** edit form.
2. Clear one or more fields (e.g. State and Postal code) and Save.
3. Inspect `accounts.billing_state` / `billing_postal_code` in the DB.
4. Also confirm the SF PATCH sent `null` for the cleared fields.
**Expected:**
- Cleared fields are stored as SQL `NULL` (the action uses `value || null`), never as empty strings.
- The corresponding SF `Billing*` fields are PATCHed with `null`.
- The read-only view shows `—` for the now-empty fields.

---

## 3.4 Account Team management 🔒

### TC-ACCT-30 (P1) 🔒 — "+ Add Team Member" visible for owner/admin, hidden for member, and rejected server-side if forced
**Purpose:** verify the add control and its server-side gate honor the role.
**Preconditions:** three users on the same account: an `owner`, an `admin`, and a `member`.
**Steps:**
1. Sign in as **owner** → open `/accounts` → confirm the **+ Add Team Member** button is present in the ACCOUNT TEAM header; per-row **★ Set as POC / Edit / Remove** controls are present.
2. Repeat as **admin** → confirm the same controls appear.
3. Sign in as **member** → confirm the add button and all per-row action controls are **hidden**.
4. As the **member**, craft a direct `POST /accounts?/add_account_contact` (bypassing the UI) with a valid body.
**Expected:**
- Owner and admin see the add button and per-row actions; member sees neither (`{#if data.userRole === 'owner' || 'admin'}` gates).
- The forced member POST is rejected server-side with `fail(403)` and error **"Only account owners and admins can add team members."** No user/contact is created.

### TC-ACCT-31 (P1) — Add a team member → member user created, can sign in, listed as `member`
**Purpose:** verify the happy-path add creates a working member login and a contact row.
**Preconditions:** signed-in owner/admin; account exists.
**Steps:**
1. As owner/admin, click **+ Add Team Member**.
2. Fill First Name, **Last Name** (required), **Email** (required), Phone, **Title / Role**, **Password ≥ 8** (required), **Confirm password** (required, matching).
3. Click **Add Team Member**.
4. Sign out and sign in as the new member using the email + password.
5. Return to `/accounts` (as owner/admin) and inspect the team list.
**Expected:**
- A `member`-role app user + an `account_contacts` row are created in one transaction; `display_name = "First Last"` (or `Last` alone).
- Success alert reads **"`<name>` added as a team member. They can sign in but cannot manage contacts."** and the add form closes.
- The new member can sign in and reach the app; on `/accounts` they cannot manage contacts.
- The team list shows the new contact with email/title/phone and a **`member`** role tag; status line reads **"App user · can access stores"**.

### TC-ACCT-32 (P2) ⛔ — Weak/mismatched password or missing last name/email → validation error
**Purpose:** verify add-member validation rules.
**Preconditions:** signed-in owner/admin; add form open.
**Steps:**
1. Submit with **Last name** or **Email** blank.
2. Submit with an invalid email (e.g. `foo@bar`).
3. Submit with a **password < 8** characters.
4. Submit with **Password** and **Confirm** not matching.
5. Submit a duplicate email that already exists as a user/contact.
**Expected:** each is rejected with a red alert and **no** user/contact created:
- Missing last name/email/password → **"Last name, email, and password are required."** (`fail(400)`).
- Invalid email → **"Please enter a valid email address."** (`fail(400)`).
- Password < 8 → **"Password must be at least 8 characters."** (`fail(400)`).
- Mismatch → **"Passwords do not match."** (`fail(400)`).
- Duplicate email → **"A user with that email already exists."** / **"A contact with that email already exists on this account."** (`fail(409)`).

### TC-ACCT-33 (P2) 🔁 — New team member best-effort synced to Salesforce
**Purpose:** verify the new member is linked to an SF Contact when the account is SF-linked.
**Preconditions:** signed-in owner/admin whose account has an `sfdc_account_id`.
**Steps:**
1. Add a team member (as in TC-ACCT-31).
2. After creation, inspect the new `users.sfdc_contact_id` and `account_contacts.sfdc_contact_id`, and check Salesforce for the new Contact under the account.
**Expected:**
- `syncTeamUserToSalesforce(...)` runs only because `sfdc_account_id` is present; a new SF Contact is created under the account and its id is persisted to both the `users` and `account_contacts` rows.
- If the account has **no** `sfdc_account_id`, no SF Contact is attempted; the member is still created locally (add still succeeds).
- SF-sync is **best-effort**: an SF failure does **not** fail the add — the member is still created and usable locally (failure is logged).

### TC-ACCT-34 (P1) — Edit a team member → saved; list updates
**Purpose:** verify editing a team member's local fields persists.
**Preconditions:** signed-in owner/admin; account has at least one non-owner contact.
**Steps:**
1. On `/accounts`, click **Edit** on a team-member row.
2. Change First Name, Last Name (required), Phone, and Title / Role.
3. Click **Save**.
**Expected:**
- The `account_contacts` row is updated (`first_name`/`phone`/`title` empty → `NULL`; `last_name` required).
- Success alert reads **"Contact updated."**; the edit form closes and the row reflects the new values.
- Submitting with an empty last name returns `fail(400)` **"Contact ID and last name are required."** with no change.

### TC-ACCT-35 (P1) — Remove a team member → user + contact rows deleted; disappears from list
**Purpose:** verify removal deletes both the app user and the contact row.
**Preconditions:** signed-in owner/admin; a **non-owner** team member exists.
**Steps:**
1. On `/accounts`, click **Remove** on a non-owner member row.
2. Confirm the browser `confirm("Remove <name>?")` dialog.
3. After the list refreshes, attempt to sign in as that removed member.
**Expected:**
- In one transaction, the linked `users` row (guarded `role <> 'owner'`) and the `account_contacts` row are deleted.
- Success alert reads **"Contact removed."**; the row disappears from the team list.
- The removed member can no longer sign in.

### TC-ACCT-36 (P1) ⛔ — Attempt to remove the owner → blocked
**Purpose:** verify the account owner cannot be removed.
**Preconditions:** signed-in owner/admin viewing the team list that includes the owner's contact row.
**Steps:**
1. Confirm the owner row shows **no Remove control** in the UI (Remove is hidden when `userRole === 'owner'`).
2. Craft a direct `POST /accounts?/remove_account_contact` with the owner's `contactId`.
**Expected:**
- No Remove button is rendered for the owner row.
- The forced POST returns `fail(403)` **"The account owner cannot be removed."**; the owner's `users` and `account_contacts` rows remain intact. (Even if reached, the DELETE guards `role <> 'owner'`.)

### TC-ACCT-37 (P2) — Set a contact as Point of Contact (★) → prior POC unset; only one at a time
**Purpose:** verify POC is exclusive and atomically reassigned.
**Preconditions:** signed-in owner/admin; account has ≥2 contacts, one currently the POC.
**Steps:**
1. On `/accounts`, note the current **"Point of Contact"** badge on one row.
2. On a different non-owner row, click **★ Set as POC**.
3. Inspect both rows after the refresh.
**Expected:**
- In one transaction, the previous POC's flag is cleared and the selected contact's `is_point_of_contact` is set — exactly **one** POC at a time.
- The new POC row shows the orange **"Point of Contact"** badge and highlighted styling; the previous POC's badge is removed.
- Success alert reads **"Point of contact updated."** (Note: the **★ Set as POC** control is not shown on the current POC row or on the owner row.)

### TC-ACCT-38 (P1) 🔒 (security) — Member forcing management actions is rejected with authorization error
**Purpose:** verify all four management actions enforce the owner/admin gate server-side, independent of the UI.
**Preconditions:** signed-in **member** on an account with existing contacts.
**Steps:**
1. As the member, craft direct POSTs (e.g. via devtools/curl with the session cookie) to each action with otherwise-valid bodies:
   - `?/add_account_contact`
   - `?/update_account_contact`
   - `?/remove_account_contact`
   - `?/set_point_of_contact`
2. Observe each response and confirm no DB mutation occurred.
**Expected:**
- Each action re-checks `canManageAccountContacts(role)` after resolving the actor's role from the DB (never trusting client input) and returns **`fail(403)`**:
  - add → **"Only account owners and admins can add team members."**
  - update / remove / set-POC → **"Insufficient permissions."**
- No user, contact, or POC change is persisted for any of the four attempts.

---

## Run log

| TC ID | Pri | Result (Pass/Fail/Blocked) | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-ACCT-01 | P1 | | | | |
| TC-ACCT-02 | P2 | | | | |
| TC-ACCT-03 | P3 | | | | |
| TC-ACCT-10 | P1 | | | | |
| TC-ACCT-11 | P2 | | | | |
| TC-ACCT-12 | P2 | | | | |
| TC-ACCT-20 | P1 | | | | |
| TC-ACCT-21 | P2 | | | | |
| TC-ACCT-22 | P3 | | | | |
| TC-ACCT-30 | P1 | | | | |
| TC-ACCT-31 | P1 | | | | |
| TC-ACCT-32 | P2 | | | | |
| TC-ACCT-33 | P2 | | | | |
| TC-ACCT-34 | P1 | | | | |
| TC-ACCT-35 | P1 | | | | |
| TC-ACCT-36 | P1 | | | | |
| TC-ACCT-37 | P2 | | | | |
| TC-ACCT-38 | P1 | | | | |
