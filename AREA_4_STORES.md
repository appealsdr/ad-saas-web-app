# AREA 4 — Stores tab

> **Asana:** this is the **child ticket for Area 4 — Stores**. Its six sub-areas (**4.1–4.6**) are tracked as **sub-tickets** under this card.

Detailed QA test cases for the **Stores** tab — the store list (`/stores`), the create-store flow, and the per-store detail page (`/stores/<id>`).
Each case below includes a **Purpose**, **Preconditions**, a numbered **step-by-step** guide, and the **Expected** result.

- **Routes:** `/stores` (list + create) · `/stores/<id>` (detail: edit, POC, SP-API, Required Files, Issues)
- **Source:**
  - [`stores/+page.server.ts`](src/routes/(app)/stores/+page.server.ts) · [`stores/+page.svelte`](src/routes/(app)/stores/+page.svelte)
  - [`stores/[id]/+page.server.ts`](src/routes/(app)/stores/[id]/+page.server.ts) · [`stores/[id]/+page.svelte`](src/routes/(app)/stores/[id]/+page.svelte)
  - [`salesforce/stores.ts`](src/lib/server/salesforce/stores.ts) · [`salesforce/required-files.ts`](src/lib/server/salesforce/required-files.ts)
  - [`components/files/RequiredFiles.svelte`](src/lib/components/files/RequiredFiles.svelte)
- **Role coverage:** Client (`owner` / `admin` / `member`). Store list/detail are **not** role-gated, but **changing the store point of contact** is owner/admin-only (`canManageAccountContacts`). All data is **account-scoped** (tenancy).
- **ID scheme:** `TC-STORE-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 role/tenancy · 🔁 Salesforce-synced · ⛔ negative/edge case
- Use `{BASE_URL}` as the origin placeholder throughout (e.g. `{BASE_URL}/stores`).

---

## What the Stores tab does (functional overview)

**Store list — `/stores`** (`stores/+page.server.ts`): the loader reads the signed-in user's `account_id`, then loads **all stores for that account** (`ORDER BY created_at DESC`) plus the **Marketplaces picklist options** (`getStoreMarketplaceOptions()`) in parallel. Each card shows name, marketplaces (`;`-split, joined with ` · `), an SP-API status badge, Seller ID, country, and the Salesforce link (or "Not synced").

**Create store** (`?/create_store`): validates **name (required)**, normalizes `marketplaces` (splits on `,`/`;`, re-joins with `;` for the SF multi-picklist), **INSERTs** the local `stores` row, sets a **default point of contact** (`getDefaultStorePointOfContactId`), then **best-effort POSTs** to Salesforce `Store__c` (`createSalesforceStore`); on success it stores `sfdc_store_id`. Finally it **redirects to `/stores/<id>?step=connect`** to kick off SP-API. The Marketplaces field renders as a **multi-select of the SF picklist** when options are available, and **falls back to free-text** when they are not.

**Marketplaces picklist** (`getStoreMarketplaceOptions`, `salesforce/stores.ts`): describes `Store__c` and returns the **active** `Marketplaces__c` picklist values, **cached ~10 minutes** (`MARKETPLACE_OPTIONS_TTL_MS = 10 * 60 * 1000`). Best-effort — on any error it logs and returns `[]`, so the create form falls back to free-text.

**Store detail — `/stores/<id>`** (`stores/[id]/+page.server.ts`): loads the store scoped to the user's account (404 if not found/not owned), the store **point of contact** + account contacts, the store's **Salesforce Cases** (`listCasesForStore`), and the store-level **Required Files** (`listRequiredFilesForStore`) joined with the local `store_documents` mirror. The page renders: header (name + marketplaces), Account Health + Financial Overview, a **Cases** table with **issue-filter pills**, Store Information + **point-of-contact** editor, a compact **SP-API Connection** block, and a **Documents / Required Files** card.

**Store detail actions:** `edit_store` (PATCH local row `+` SF `Store__c` if linked), `set_store_point_of_contact` (owner/admin only), `upload_doc` (S3 `+` local `store_documents` `+` SF `S3_Document__c` / `Required_File__c`), `clear_doc` (reverse). **SP-API connect/reconnect** is a plain link to `/auth/spapi?store=<id>` (OAuth handled in Area 11).

**Resilience:** each Salesforce source degrades independently — a Cases failure shows an inline error but the rest of the page renders; a Required-Files failure shows its own inline error; a store with no `sfdc_store_id` shows "not linked yet" placeholders instead of Cases/Documents.

> 📝 **Label / discrepancy notes to flag with product:** (a) the detail-page **Financial Overview** "Total Revenue Recovered" is a **placeholder** (`resolvedCount * 850`) pending a real SF rollup. (b) The list card badge reads **"SP-API connected / SP-API error / Not connected"**; the detail badge reads **"Active / Error / Not connected"** — same underlying `spapiStatus`, different copy. Test against on-screen labels.

---

## 4.1 Store list

### TC-STORE-01 (P1) — `/stores` lists account stores as cards 🔁
**Purpose:** confirm the list renders each store as a card with all summary fields.
**Preconditions:** signed-in client user; account has ≥1 store (mix of SP-API states and SF-linked/unsynced is ideal).
**Steps:**
1. Sign in and navigate to `{BASE_URL}/stores`.
2. Inspect each store card.
**Expected:** A responsive **3-column grid** of cards, newest-first. Each card shows:
- **Store name** (bold) and, under it, **marketplaces** rendered as `;`-split values joined with ` · ` (or `—` when none).
- An **SP-API status badge** top-right: **green "SP-API connected"** (`spapiStatus === 'connected'`), **orange "SP-API error"** (`'error'`), or **grey "Not connected"** (anything else / disconnected).
- A meta row with **Seller ID** and **Country** (`—` when absent).
- A Salesforce line: `SF: <sfdcStoreId>` (monospace code) when linked, else an orange **"Not synced to Salesforce"**.
- Hovering a card lifts it and highlights the border (whole card is a link).

### TC-STORE-02 (P2) ⛔ — Empty state
**Purpose:** verify the no-stores empty state.
**Preconditions:** account with **zero** stores.
**Steps:**
1. Sign in as that account's user and open `{BASE_URL}/stores`.
**Expected:** No grid; instead a dashed empty panel with a large `＋`, heading **"No stores yet"**, the copy "Add your first Amazon seller account to start tracking violations and appeals.", and an **"Add your first store"** primary button that opens the Create Store modal.

### TC-STORE-03 (P2) — Clicking a store card navigates to detail
**Purpose:** verify card navigation.
**Preconditions:** account has ≥1 store.
**Steps:**
1. On `{BASE_URL}/stores`, click anywhere on a store card.
**Expected:** Navigates to `{BASE_URL}/stores/<id>` for that store (the card is an `<a href="/stores/<id>">`).

---

## 4.2 Create store

### TC-STORE-10 (P1) — "+ Add Store" opens the Step 1-of-2 modal and creates a store 🔁
**Purpose:** verify the create flow end-to-end, including the **Marketplaces multi-select**.
**Preconditions:** signed-in client user whose account is linked (`account_id` present); Salesforce reachable so the picklist loads.
**Steps:**
1. On `{BASE_URL}/stores`, click **"+ Add Store"** in the Topbar.
2. Confirm the modal header reads **"Add Store"** with the sub-line **"Step 1 of 2 — store details. Next, you'll connect your Amazon seller account via SP-API."**
3. Enter a **Store name** (required).
4. Click the **Marketplaces** field — it should be a **multi-select dropdown** of SF picklist values (checkboxes). Select two or more; confirm they appear as **chips** in the trigger.
5. Optionally fill Country, Seller ID, Legal business name, Amazon notification email, Store contact email, Description.
6. Click **"Create & continue to connect →"**.
**Expected:**
- The store is created (local `stores` INSERT). A **default point of contact** is assigned (account owner) when available.
- The selected marketplaces are stored `;`-joined (the modal posts the hidden `marketplaces` field = `selectedMarketplaces.join(';')`, then the server normalizes on `,`/`;`).
- The browser **redirects to `{BASE_URL}/stores/<id>?step=connect`**; the detail page shows the **"Step 2 — connect your Amazon seller account"** banner.

### TC-STORE-11 (P2) ⛔ — Submit without name → validation error, modal stays open with values
**Purpose:** verify required-field validation and value echo.
**Preconditions:** Create Store modal open.
**Steps:**
1. Leave **Store name** blank; fill some other fields (e.g. Country, a couple of marketplaces).
2. Submit the form.
**Expected:** Server returns `fail(400, …)` with **"Store name is required."**. The modal **re-opens** (`$: if (form?.error) showCreate = true`) with the entered values **echoed** back — including the previously selected **marketplaces re-seeded** as chips from the echoed value. No store is created; no redirect.

### TC-STORE-12 (P2) — Marketplaces multi-select persistence + free-text fallback 🔁 ⛔
**Purpose:** verify the picklist-backed multi-select and its SF-unreachable fallback.
**Preconditions:** two scenarios — (a) Salesforce reachable (picklist populated), (b) Salesforce unreachable / `Marketplaces__c` describe fails.
**Steps:**
1. **(a)** Open the Create Store modal with SF up. Confirm Marketplaces renders as a **multi-select** of picklist options. Select several, submit with a valid name.
2. On the created store's detail page, confirm the selected marketplaces show (header subtitle + Store Information / Account Health "Marketplace" field), `;`-split and joined for display.
3. **(b)** Force the picklist to be empty (SF down, or expired token so `getStoreMarketplaceOptions()` returns `[]`). Re-open the modal.
4. Confirm Marketplaces now renders as a **single free-text input** with placeholder `US, UK, DE (comma-separated)`. Enter `US, UK; DE`, submit with a valid name.
**Expected:**
- **(a)** Selected picklist values persist and display consistently (stored as `;`-joined; the ~10-min cache means the option list is stable across quick reloads).
- **(b)** With no options, the field **falls back to free-text**. Whether the user types commas or semicolons, `normalizeMarketplaces` splits on `[,;]`, trims, drops blanks, and re-joins with `;` — so `US, UK; DE` is stored/displayed identically to the multi-select path (`US · UK · DE`). Empty input stores `null`.

### TC-STORE-13 (P3) 🔁 — New store best-effort synced to Salesforce `Store__c`
**Purpose:** verify SF sync on create and its non-fatal failure handling.
**Preconditions:** account has a linked `sfdc_account_id`; Salesforce reachable.
**Steps:**
1. Create a store (TC-STORE-10). After redirect, inspect the detail page's **Store Information** header.
2. Cross-check in Salesforce that a `Store__c` was created with `Name`, `Marketplaces__c`, `Seller_ID__c`, `Account__c` (parent), etc.
3. **(Negative)** Repeat with SF forced to fail the create.
**Expected:**
- On success the card/detail shows the linked **`SF: <sfdcStoreId>`** (the loader/action persists `sfdc_store_id`), and the SF record carries the mapped fields plus the back-reference `appealsdoctor_vuid__c = <local stores.id>`.
- On SF failure the **local store is still created** and the flow still redirects to `?step=connect`; the store shows **"Not in Salesforce" / "Not synced"**, and the error is logged (`logError`), not surfaced as a page crash.

---

## 4.3 Store detail — edit & POC

### TC-STORE-20 (P1) — Detail page sections + inline edit 🔁
**Purpose:** verify the detail layout and the edit-store flow.
**Preconditions:** account has a store (ideally SF-linked with a case or two).
**Steps:**
1. Open `{BASE_URL}/stores/<id>`.
2. Confirm the page shows: **header** (store name + marketplaces subtitle), **Account Health** + **Financial Overview** cards, a **Cases** section, **Store Information** (with point-of-contact), an **SP-API Connection** block, and a **Documents / Required Files** card.
3. Click **"Edit"** in the Topbar; the **"✏️ Edit Store"** modal opens pre-filled with current values.
4. Change the name (and any other field), click **"Save Changes"**.
**Expected:** The local row is updated (`edit_store` → `UPDATE stores …`). If the store is **SF-linked**, `updateSalesforceStore` also patches `Store__c` and the banner reads **"Store updated locally and in Salesforce."**; the modal closes on success. The header and fields reflect the new values.

### TC-STORE-21 (P2) ⛔ — SF rejects edit → partial success, local change persists 🔁
**Purpose:** verify partial-success handling when SF rejects an edit.
**Preconditions:** SF-linked store; force `updateSalesforceStore` to fail (e.g. required SF field / validation rule).
**Steps:**
1. Open the Edit Store modal, make a valid local change, save.
**Expected:** Server returns `fail(502, { savedLocally: true, error: 'Saved locally but Salesforce rejected: <error>' })`. The **local change persists** (reload shows new values), an **error banner** shows the "Saved locally but Salesforce rejected: …" message, and the modal **stays open** (form error keeps `editing = true`). The failure is logged.

### TC-STORE-22 (P2) 🔒 — Change store point of contact (owner/admin only)
**Purpose:** verify the POC editor and its role gate.
**Preconditions:** account with ≥2 account contacts; test once as **owner/admin**, once as **member**.
**Steps:**
1. As **owner/admin**, open `{BASE_URL}/stores/<id>` → **Store Information → Point of contact**. Confirm a **select dropdown** of account contacts + an **"Update"** button.
2. Pick a different contact, click **Update**.
3. Sign in as a **member** and open the same store.
**Expected:**
- Owner/admin: the selection saves (`set_store_point_of_contact` → `UPDATE stores SET point_of_contact_id`), banner **"Store point of contact updated."**; the chosen contact persists on reload.
- Member (`canManageContacts` false): the POC renders as **read-only text** (no dropdown/Update). If a member's request reaches the action directly, it returns `fail(403, …)` **"Only account owners and admins can change the store point of contact."**

### TC-STORE-23 (P1) 🔒 (tenancy) — Cross-account store access is 404/forbidden
**Purpose:** verify a user cannot open another account's store.
**Preconditions:** two accounts A and B; note a store `<id>` belonging to B.
**Steps:**
1. Sign in as **account A**.
2. Navigate directly to `{BASE_URL}/stores/<B-store-id>`.
**Expected:** The loader's `loadStore` joins on `s.account_id = u.account_id`, finds nothing, and throws **`error(404, 'Store not found.')`**. No cross-account data (cases, files, contacts) is exposed. The same guard applies to `edit_store`, `set_store_point_of_contact`, `upload_doc`, and `clear_doc`.

---

## 4.4 Store detail — SP-API connection

### TC-STORE-30 (P1) — `?step=connect` banner → "Connect via SP-API" → Amazon consent
**Purpose:** verify the post-create connect prompt and its link. (OAuth detail in Area 11.)
**Preconditions:** store just created (redirected to `?step=connect`) or manually append `?step=connect`; store **not** connected.
**Steps:**
1. Open `{BASE_URL}/stores/<id>?step=connect`.
2. Locate the warning banner **"Step 2 — connect your Amazon seller account."** and click **"Connect with Amazon →"** (or the Topbar **"Connect SP-API"**).
**Expected:** The banner shows only when `step=connect` **and** the store isn't connected. The button links to **`/auth/spapi?store=<id>`**, which begins the SP-API OAuth handshake and forwards to Amazon Seller Central consent.

### TC-STORE-31 (P1) — Successful Amazon auth → connected banner
**Purpose:** verify the success return state.
**Preconditions:** complete SP-API consent for the store.
**Steps:**
1. From the connect flow, approve consent in Amazon.
2. Land back on the store via `/auth/spapi/callback`.
**Expected:** Callback sets the store's `spapi_status = 'connected'` and returns to **`{BASE_URL}/stores/<id>?spapi=connected`**. A **green "Amazon SP-API connected ✓"** banner shows, plus the persistent **"Connected to Amazon"** strip with the **Selling Partner ID** and "since <date>". The SP-API Connection block and the list-card badge read connected/Active.

### TC-STORE-32 (P2) ⛔ — User denies consent → orange banner, not connected
**Purpose:** verify the denied path.
**Preconditions:** begin SP-API but **decline** consent at Amazon.
**Steps:**
1. Start connect, then cancel/deny at Amazon.
**Expected:** Returns to **`{BASE_URL}/stores/<id>?spapi=denied`**; an **error/orange banner** reads **"Connection cancelled."** followed by any `spapiLastError`. The store remains **not connected** (badge grey / "Not connected").

### TC-STORE-33 (P2) ⛔ — Amazon error / invalid state → red banner with last error
**Purpose:** verify the error path.
**Preconditions:** force an SP-API error (invalid/expired `state`, token exchange failure).
**Steps:**
1. Trigger the failure during the callback.
**Expected:** Returns to **`{BASE_URL}/stores/<id>?spapi=error`**; a **red banner** reads **"Could not finish connection."** plus `spapiLastError`. The store's `spapiStatus` is `'error'` (red "Error" badge; list card "SP-API error"), and the **Last Error** field is populated in the SP-API Connection block.

### TC-STORE-34 (P2) 🔒 — Initiating SP-API for a store the user doesn't own is rejected
**Purpose:** verify tenancy on the connect entry point.
**Preconditions:** account A signed in; `<id>` belongs to account B.
**Steps:**
1. As account A, hit `{BASE_URL}/auth/spapi?store=<B-store-id>` directly.
**Expected:** The SP-API initiation validates store ownership and **rejects** (no OAuth started; 404/forbidden). Account A cannot connect or reconnect account B's store. (Full handling detailed in Area 11.)

### TC-STORE-35 (P3) — "Reconnect" available when already connected
**Purpose:** verify reconnect affordance on a connected store.
**Preconditions:** store with `spapiStatus === 'connected'`.
**Steps:**
1. Open `{BASE_URL}/stores/<id>`.
**Expected:** The Topbar button reads **"Reconnect SP-API"** and the persistent "Connected to Amazon" strip shows a **"Reconnect"** button — both linking to `/auth/spapi?store=<id>`. Reconnecting re-runs consent and refreshes the connection.

---

## 4.5 Store detail — Required Files (store-level)

> **Implementation context.** Slots come from Salesforce **`Required_File__c`** (`listRequiredFilesForStore`), one query per store: `Name`, `Short_Description__c`/`Instructions__c` (rich-text guidelines), `Accepted_Format__c` (`;`-split → format chips), `File_Uploaded__c`, and `Last_Version__r` (the current `S3_Document__c`). A slot is **Uploaded** when `File_Uploaded__c` is true **or** a local `store_documents` row exists; otherwise **Pending**.
> **Upload (`upload_doc`)** does three things: (1) **PUT bytes to S3** (AES-256, key from `storeFileKey`), (2) **UPSERT** the local `store_documents` row (keyed on `sfdc_case_file_id = requiredFileId`), (3) **create `S3_Document__c`** (`Related_Object_Type__c='Store__c'`, `Related_Record_Id__c=<sfdcStoreId>`, bucket/key/region/metadata, `Status__c='Active'`) and set `Required_File__c.Last_Version__c` + `File_Uploaded__c=true`.
> **Allowed MIME:** PDF, PNG, JPEG, GIF, WebP, HEIC, DOC, DOCX, XLS, XLSX, TXT, CSV, ZIP. **Max 25 MB.**
> Required Files only render when the store is **SF-linked**; otherwise the card shows a "not linked to Salesforce yet" note. A `listRequiredFilesForStore` failure shows an inline **"Could not load required files: …"** error.

### TC-STORE-40 (P1) — Required-file slot layout + upload modal
**Purpose:** verify each slot renders its metadata, status, and upload affordances.
**Preconditions:** SF-linked store with ≥1 `Required_File__c` (at least one with a `Document_Template__c` example, one with accepted formats).
**Steps:**
1. Open `{BASE_URL}/stores/<id>` → **Documents** card. Note the header count `<n> of <m> uploaded`.
2. Inspect a **Pending** slot: name, short description, a **"Pending"** badge, and an **"Upload →"** button.
3. Click **Upload →** to open the modal. Confirm the **drag-and-drop / click-to-browse** zone, the **Supported File Types** chips (from `Accepted_Format__c`), and the **Upload Guidelines** (rich-text `Instructions__c`, or the default bullet list incl. "Maximum file size: 25 MB").
4. On a slot whose template has an example, confirm an **"Example"** button appears in the modal actions.
**Expected:** Each slot shows name + description + status badge + accepted formats. The upload zone accepts both drag-drop and click. The `accept` attribute is derived from the slot's accepted formats. The **Example** button appears only when the slot has a template (`f.example`).

### TC-STORE-41 (P1) — Upload a valid file 🔁
**Purpose:** verify a successful upload writes S3 + local + SF.
**Preconditions:** SF-linked store; a valid file (allowed MIME, ≤25 MB).
**Steps:**
1. Open a Pending slot's upload modal, drop/select the file, click **"Upload File"**.
**Expected:**
- Bytes **PUT to S3** (AES-256) under `storeFileKey(...)`; a **local `store_documents`** row is UPSERTed (keyed on `requiredFileId`); an **`S3_Document__c`** is created (`Related_Object_Type__c='Store__c'`, bucket/key/metadata, `Status__c='Active'`), and `Required_File__c.Last_Version__c` + `File_Uploaded__c=true` are set.
- Success banner **"Uploaded `<name>`."**; the modal closes; the slot flips to **Uploaded** (green), showing a clickable **file name · size** and the header count increments.

### TC-STORE-42 (P2) ⛔ — Upload >25 MB is rejected
**Purpose:** verify the size limit.
**Preconditions:** a file **>25 MB**.
**Steps:**
1. Attempt to upload the oversized file into any slot.
**Expected:** `fail(400, { uploadError: 'File too large (max 25 MB).' })`; a red **upload error** banner shows; **no S3/local/SF writes**; the slot remains unchanged (Pending or its prior Uploaded state).

### TC-STORE-43 (P2) ⛔ — Disallowed MIME type is rejected
**Purpose:** verify MIME allow-listing.
**Preconditions:** a disallowed file (e.g. `.exe`, or any type not in `ALLOWED_MIME`).
**Steps:**
1. Attempt to upload it into a slot.
**Expected:** `fail(400, { uploadError: 'Unsupported file type: <type>' })`; a red upload error banner shows; nothing is written; the slot is unchanged. (Note: the `accept` attribute pre-filters the picker, but the server enforces the allow-list regardless.)

### TC-STORE-44 (P1) — Remove an uploaded file 🔁
**Purpose:** verify removal reverses the upload everywhere.
**Preconditions:** a slot in the **Uploaded** state.
**Steps:**
1. On the uploaded slot, click **"✕"** (Remove). Confirm the **"Remove uploaded file?"** prompt.
**Expected:** `clear_doc` runs: the **local `store_documents` row is DELETEd**, the **S3 object is deleted** (best-effort), `Required_File__c.Last_Version__c` is cleared and `File_Uploaded__c=false`, and the **old `S3_Document__c` is tombstoned** (`Status__c='Deleted'`). Banner **"Upload cleared. Slot is pending again."**; the slot returns to **Pending**.

### TC-STORE-45 (P2) — Re-upload replaces the file with no orphan 🔁
**Purpose:** verify re-upload UPSERT + old-object cleanup.
**Preconditions:** a slot already **Uploaded**.
**Steps:**
1. Click **"Re-upload"** on the slot; confirm the modal title reads **"Re-upload Document"**.
2. Select a different valid file and upload.
**Expected:** A **new S3 object** is written; the local row is **UPSERTed** (same `sfdc_case_file_id`, new id/key/metadata via `ON CONFLICT … DO UPDATE`); a new `S3_Document__c` is linked as `Last_Version__c`. After the SF sync completes, the **previous S3 object is deleted** (`oldS3Key !== s3Key`), leaving **no orphan**. The slot shows the new file name/size.

### TC-STORE-46 (P2) ⛔ — SF sync fails after S3+local succeed (partial success); local-DB failure rolls back
**Purpose:** verify partial-success and rollback paths.
**Preconditions:** two scenarios — (a) force `attachUploadToRequiredFile`/`createS3Document` to fail after S3+local succeed; (b) force the local `store_documents` UPSERT to throw.
**Steps:**
1. **(a)** Upload a valid file with SF sync failing.
2. **(b)** Upload a valid file with the local DB write failing.
**Expected:**
- **(a)** S3 + local both persisted; the action returns a **partial-success** message **"Uploaded `<name>`, but Salesforce sync had an issue: `<error>`."** The file is **still visible/previewable** (the local mirror drives the slot's Uploaded state and the preview endpoint).
- **(b)** The just-written **S3 object is deleted** (rollback) and the action returns `fail(500, { uploadError: 'Uploaded the file but could not index it.' })`; the slot stays Pending.

### TC-STORE-47 (P2) — Preview an uploaded file
**Purpose:** verify inline preview via the presigned download endpoint.
**Preconditions:** a slot with an uploaded file that has a local mirror (`localDocId`).
**Steps:**
1. In an Uploaded slot, click the **file-name link**.
2. Test different file types (image / PDF / text / video / audio vs. e.g. a ZIP).
**Expected:** The **FilePreviewModal** opens. Image/PDF/text/video/audio render **inline** using the presigned URL **`GET /api/stores/<id>/documents/<localDocId>?disposition=inline`**; unsupported types (e.g. ZIP) are **download-only** (the modal's download link points at the same endpoint without `disposition=inline`).

### TC-STORE-48 (P2) — Preview a template "Example"
**Purpose:** verify the example/template preview is distinct from user uploads.
**Preconditions:** a slot whose `Document_Template__c` has a `Last_Version__r` example.
**Steps:**
1. Open the slot's upload modal and click **"Example"**.
**Expected:** The FilePreviewModal opens against **`GET /api/files/example/<s3DocumentId>`** (signed-in only). Confirm the previewed content is the **template/example** file (from `Document_Template__r.Last_Version__r`), **not** any file the user uploaded to this slot.

---

## 4.6 Store detail — Issues filter

### TC-STORE-50 (P2) — Issue filter pills filter the store's case table 🔁
**Purpose:** verify the Cases filter pills and row navigation.
**Preconditions:** SF-linked store with cases spanning multiple statuses (open/new, working/in-progress, waiting/pending, closed/resolved).
**Steps:**
1. Open `{BASE_URL}/stores/<id>` → **Cases** section.
2. Confirm the pills **All · Open · In Progress · Waiting · Resolved** and the table columns **Case ID · Service · Status · Priority · Opened · Last Modified**.
3. Click each pill and observe the filtered rows.
4. Click a case row.
**Expected:**
- **All** shows every case; **Open** = status `open`/`new`; **In Progress** = contains `progress`/`working`; **Waiting** = contains `waiting`/`pending`/`awaiting`; **Resolved** = contains `closed`/`resolved` (matching is case-insensitive). The active pill is highlighted. When a filter yields nothing, the table shows **"No cases in this category"**.
- Clicking a row navigates to **`{BASE_URL}/stores/<id>/issues/<caseId>`**.
- If the store isn't SF-linked, the section shows "This store isn't linked to a Salesforce Store\_\_c yet…"; if the Cases query failed, it shows the red **"Could not load cases from Salesforce: …"** error instead of the table.

---

## Run log

| TC ID | Pri | Result | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-STORE-01 | P1 | | | | |
| TC-STORE-02 | P2 | | | | |
| TC-STORE-03 | P2 | | | | |
| TC-STORE-10 | P1 | | | | |
| TC-STORE-11 | P2 | | | | |
| TC-STORE-12 | P2 | | | | |
| TC-STORE-13 | P3 | | | | |
| TC-STORE-20 | P1 | | | | |
| TC-STORE-21 | P2 | | | | |
| TC-STORE-22 | P2 | | | | |
| TC-STORE-23 | P1 | | | | |
| TC-STORE-30 | P1 | | | | |
| TC-STORE-31 | P1 | | | | |
| TC-STORE-32 | P2 | | | | |
| TC-STORE-33 | P2 | | | | |
| TC-STORE-34 | P2 | | | | |
| TC-STORE-35 | P3 | | | | |
| TC-STORE-40 | P1 | | | | |
| TC-STORE-41 | P1 | | | | |
| TC-STORE-42 | P2 | | | | |
| TC-STORE-43 | P2 | | | | |
| TC-STORE-44 | P1 | | | | |
| TC-STORE-45 | P2 | | | | |
| TC-STORE-46 | P2 | | | | |
| TC-STORE-47 | P2 | | | | |
| TC-STORE-48 | P2 | | | | |
| TC-STORE-50 | P2 | | | | |
