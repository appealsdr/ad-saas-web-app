# AREA 7 — Case detail (timeline, comments, documents)

> This file is the **Asana child ticket for Area 7**. Its sub-areas **7.1–7.3** are the **sub-tickets** under it (Timeline, Comments, Case documents).

Detailed QA test cases for the **Case detail** screen — the per-case view a client opens from a store's issue list. Each case below includes a **purpose**, **preconditions**, a numbered **step-by-step guide**, and the **expected result**.

- **Route:** `/stores/{storeId}/issues/{caseId}` (i.e. `{BASE_URL}/stores/<localStoreId>/issues/<sfdcCaseId>`)
- **Source:** [`+page.server.ts`](src/routes/(app)/stores/[id]/issues/[caseId]/+page.server.ts) · [`+page.svelte`](src/routes/(app)/stores/[id]/issues/[caseId]/+page.svelte) · [`CaseTimeline.svelte`](src/lib/components/cases/CaseTimeline.svelte) · [`RichTextEditor.svelte`](src/lib/components/ui/RichTextEditor.svelte) · [`sanitize.ts`](src/lib/server/sanitize.ts) · [`cases.ts`](src/lib/server/salesforce/cases.ts) · [`api/cases/[caseId]/documents/[docId]/+server.ts`](src/routes/api/cases/[caseId]/documents/[docId]/+server.ts) · [`api/files/example/[s3DocId]/+server.ts`](src/routes/api/files/example/[s3DocId]/+server.ts)
- **Role coverage:** Client (`owner` / `admin` / `member`) — case detail is **not** role-gated; every signed-in user of the owning account sees the same view. Tenancy is enforced by the account-id join on the store (and on the documents API).
- **ID scheme:** `TC-CASE-<n>` · **Priority:** P1 (critical) · P2 (major) · P3 (minor)
- **Legend:** 🔒 role/tenancy · 🔁 Salesforce-synced · ⛔ negative/edge case

---

## What Case detail does (functional overview)

The loader (`+page.server.ts`) first resolves the **local store** by joining `stores` to `users` on `account_id` (tenancy gate — a store not in the signed-in user's account yields **404 "Store not found."**). It then fans out **five** reads in parallel:

1. **SF Case** — `fetchCase(caseId)` pulls `Id, CaseNumber, Subject, Status, Priority, CreatedDate, LastModifiedDate, Description, Origin, Type, AccountId, ContactId, OwnerId, RecordType.Name`. If the case is missing → **404 "Case not found in Salesforce."**; any other failure → **502 "Could not load case: …"**.
2. **SF comments** — `listCaseMessages(caseId)` reads `Case_Message__c` rows (ordered oldest-first, paginated, cap 500). Each body is **sanitized on read** with `sanitizeMessageHtml` before it reaches the browser.
3. **SF required files** — `listRequiredFilesForCase(caseId)` returns the required-file checklist, joined to local `case_documents` rows (by required-file id) for upload metadata.
4. **SF case history** — `listCaseHistory(caseId)` reads `CaseHistory` rows (field changes).
5. **Local uploads** — `case_documents` rows for this case + store.

**Timeline assembly:** `buildCaseTimeline({ caseRecord, messages, requiredFiles, history })` merges four event streams into one list sorted **newest-first**: case-history rows (opened / status / priority / owner / field changes), comment-added events (one per message; detail = truncated plain-text body), document-requested events (one per required-file slot) and document-uploaded events (one per uploaded slot). If no `created` history row exists, a synthetic **"Case opened"** event is added from `CreatedDate`. Message bodies are converted to **plain text** (`htmlToText`) for the timeline, which renders text — not HTML.

**Resilience:** each Salesforce read can fail independently and is surfaced without crashing the page — `messagesError`, `filesError`, and `historyError` are returned separately so comments / documents / timeline each degrade on their own.

**Actions (POST):**
- `post_comment` — sanitize body → empty check (plain text) → length check → require `sfdc_contact_id` → `createCaseMessage` (INSERT `Case_Message__c`).
- `upload_doc` — one required-file slot: PUT to S3 → UPSERT local `case_documents` row → `attachUploadToRequiredFile` (creates `S3_Document__c`, links `Required_File__c`).
- `clear_doc` — reverse: DELETE local row + S3 object + clear the required-file link + tombstone the `S3_Document__c`.

**Layout:** two columns. Left = **Case Details** card + **Messages** card (search, list, rich-text composer). Right = a **financial** card (placeholder "Estimated Revenue at Risk"), the **Case Timeline** card, and the **Case Documents** card (required-file checklist).

> 📝 **Placeholder note (flag to product):** "Potential Value" / "Estimated Revenue at Risk" / "Store Total Saved" and the **Assigned Owner** value (raw `OwnerId`) are placeholders — Potential Value is a deterministic hash of the case number, not a real Salesforce figure. Do not QA these as real financials; flag them as spec gaps.

---

## 7.1 Timeline

### TC-CASE-01 (P1) — Case header & Case Details render 🔁
**Purpose:** confirm the case header/topbar and the Case Details card show the core Salesforce fields, and the case number is copyable.
**Preconditions:** signed-in client user; a case exists in Salesforce for one of the account's stores (with an `sfdc_store_id`).
**Steps:**
1. Open `{BASE_URL}/stores/<localStoreId>/issues/<sfdcCaseId>`.
2. Read the **Topbar** title/subtitle and the **Case Details** card fields.
3. Select the **Case ID** value (monospace) and copy it (double-click / drag-select → Cmd/Ctrl+C).
**Expected:**
- Topbar title = the **CaseNumber**; subtitle = `<recordTypeName || 'Case'> · <storeName>`; a **"← Back to store"** button links to `/stores/<localStoreId>`.
- Case Details card shows a **Status badge** (color per status: orange new/open, blue working/in progress, yellow waiting/pending, green closed/resolved, grey otherwise) plus fields: **Case ID** (mono, = CaseNumber), **Service Type** (recordTypeName or `—`), **Store**, **Marketplace** (store marketplaces `;`→`, ` or `—`), **Assigned Owner** (raw `OwnerId` or `—`), **Opened On** (CreatedDate, short date), **Priority** (or `—`), **Potential Value** (placeholder).
- The Case ID text is selectable and copies as plain text.
- If the case status is a "waiting on client" status, an amber **"Action required: Please upload the requested documents to proceed."** alert shows at the bottom of the card.

### TC-CASE-02 (P1) — Timeline renders merged events with colored dots 🔁
**Purpose:** verify the Case Timeline renders opened / status-changed / comment-added / document-requested / document-uploaded events with correct dot color, date+time, text and actor/detail.
**Preconditions:** a case that has: history (opened + at least one status change), ≥1 comment, ≥1 required-file slot, and ≥1 uploaded document.
**Steps:**
1. Open the case detail page and locate the **Case Timeline** card (right column).
2. Inspect each event row top-to-bottom.
**Expected:**
- Events are sorted **newest-first** by date.
- Each row shows a **colored dot**, a `<short date> · <time>` line, bold **text**, and (where present) a `by <actor>` meta line and/or a **detail** line.
- Dot colors by type: **case_opened** = navy/slate; **status/priority/owner/field changed** = blue; **comment_added** = green; **document_requested / document_uploaded** = amber.
- Text patterns: `Case opened`; status/field changes via history; `Comment added by <author>`; `Document requested — <fileName>`; `Document uploaded — <fileName>`.
- For **comment_added**, the `by <actor>` meta line is intentionally **suppressed** (the component hides `actor` for comment events); the truncated (~120-char) plain-text comment body appears as the **detail** line.
- For **document_uploaded**, the detail line shows the uploaded file's original name.

### TC-CASE-03 (P2) ⛔ — History load fails: warning banner, comments/documents still show
**Purpose:** verify a `CaseHistory` (`listCaseHistory`) failure is isolated and non-fatal.
**Preconditions:** force `listCaseHistory` to fail (e.g. SF `CaseHistory` not accessible / bad token) while the case, comments and files still load.
**Steps:**
1. Trigger the history failure, then open the case detail page.
2. Inspect the Case Timeline card, the Messages card, and the Case Documents card.
**Expected:**
- Inside the Timeline card an amber warning reads **"Could not load full case history from Salesforce. Showing comments and documents only."**
- The timeline still renders the synthetic **"Case opened"** event plus comment-added and document events derived from messages/files.
- Messages and Case Documents render normally. No full-page crash.

### TC-CASE-04 (P3) ⛔ — Brand-new case with no activity
**Purpose:** verify the empty timeline state.
**Preconditions:** a freshly opened case with **no** history beyond creation edge-cases, **no** comments, and **no** required-file slots — i.e. `buildCaseTimeline` returns zero events.
**Steps:**
1. Open the brand-new case's detail page.
2. Inspect the Case Timeline card body.
**Expected:** The timeline shows **"No activity recorded yet."** (Note: with any required-file slot or the synthetic "Case opened" event present, events exist — this state requires a case with genuinely no derivable events.) No crash.

---

## 7.2 Comments (rich text)

> **Implementation context.** The composer is a rich-text editor ([`RichTextEditor.svelte`](src/lib/components/ui/RichTextEditor.svelte)) supporting **bold, italic, underline, bulleted/numbered lists, links, and clear-formatting**; it emits HTML into a hidden `body` field. The body is **sanitized server-side on BOTH write and read** ([`sanitize.ts`](src/lib/server/sanitize.ts) → `sanitize-html`). Allowed tags: `p, br, b, strong, i, em, u, s, ul, ol, li, a, blockquote, h3, h4, span`. `<a>` keeps only `href/target/rel`; allowed schemes `http/https/mailto`; **every** link is forced to `target="_blank" rel="noopener noreferrer"`. Comments are stored in SF `Case_Message__c` (`Case__c`, `Sender_Contact__c`, `Message_Body__c`, `Sender_Type__c = 'external'`) and rendered with `{@html}` — safe because sanitized.

### TC-CASE-10 (P1) — Post a formatted comment 🔁
**Purpose:** verify a formatted comment is sanitized, stored as an external `Case_Message__c`, and rendered back with author, timestamp, External badge and preserved formatting; the composer clears on success.
**Preconditions:** signed-in user whose account owns the store **and** whose `users.sfdc_contact_id` is populated (linked SF Contact).
**Steps:**
1. Open the case detail page and scroll to the **Messages** composer.
2. Type text; make one word **bold**, add a **bulleted list**, and insert a **link** (`https://…`) via the 🔗 button.
3. Click **Send**.
4. After the page updates, inspect the new message row and the timeline.
5. (Verification) Confirm the `Case_Message__c` row in Salesforce.
**Expected:**
- A green **"Comment posted."** alert appears; the composer input **clears**; the message list **scrolls to the bottom** smoothly.
- The new row shows: avatar initials, the author name with **" (You)"**, a blue **External** badge, the date/time (`Mon D, YYYY at h:mm am/pm`), and the **rendered formatting** (bold text, a bulleted list, a clickable link).
- In Salesforce a `Case_Message__c` is created with `Sender_Type__c = 'external'`, `Sender_Contact__c` = the user's `sfdc_contact_id`, and `Message_Body__c` = the **sanitized** HTML.
- A **"Comment added by <you>"** event appears in the timeline (green dot) with the truncated body as detail.

### TC-CASE-11 (P2) ⛔ — Empty comment & length guard
**Purpose:** verify emptiness is checked on **plain text after sanitize**, and overlong bodies are rejected.
**Preconditions:** signed-in linked user on a case detail page.
**Steps:**
1. With the composer empty, click **Send**.
2. Enter markup that has **no visible text** (e.g. `<b></b>` or only whitespace/`&nbsp;`) and click **Send**.
3. Enter a body whose sanitized HTML exceeds **32,000** characters and click **Send**.
**Expected:**
- Steps 1–2 → **400** with error **"Comment cannot be empty."** (the check runs on `htmlToText(sanitized)`, so tag-only markup counts as empty). No `Case_Message__c` created; the composer preserves the raw draft.
- Step 3 → **400** with error **"Comment is too long."** No record created.
- Each error renders in a red alert directly under the composer.

### TC-CASE-12 (P2) ⛔ — Unlinked contact & Salesforce rejection
**Purpose:** verify the missing-contact guard and SF-create failure surfacing.
**Preconditions:** (a) a signed-in user whose `users.sfdc_contact_id` is **null** (not yet synced); (b) separately, a linked user where the SF create can be forced to fail.
**Steps:**
1. As the unlinked user (a), enter a valid comment and click **Send**.
2. As the linked user (b), force `createCaseMessage` to fail (SF down / validation rule), enter a valid comment, and click **Send**.
**Expected:**
- (a) → **409** with error **"Your Salesforce Contact is not linked yet. Try again once sync completes."** No record created.
- (b) → **502** with error **"Salesforce rejected the comment: `<sf error>`"** (the underlying SF error is surfaced). No successful post.
- Both render as a red alert under the composer.

### TC-CASE-13 (P2) ⛔ 🔒 — XSS / markup sanitization (write & read)
**Purpose:** verify the server sanitizer neutralizes hostile markup on **write** and on **read**, so rendered output contains no executable content.
**Preconditions:** a linked user on a case detail page; ability to inspect the rendered DOM and (ideally) the stored `Message_Body__c`.
**Steps:**
1. Post a comment whose body contains hostile markup: `<script>alert(1)</script>`, an `<img src=x onerror=alert(1)>`, an anchor `<a href="javascript:alert(1)">x</a>`, an `<iframe>`, and inline `style="..."`/event handlers.
2. After posting, inspect the rendered message body in the DOM (both the list row and the message modal).
3. Separately, arrange an existing **SF-authored** `Case_Message__c` that contains similar hostile markup, then load the page and inspect its rendered body.
**Expected:**
- **On write:** the stored/rendered body has `<script>`, `<iframe>`, event handlers (`onerror=`, etc.), inline `style`, and `javascript:` links **stripped or neutralized**; only allowlisted tags remain (`p, br, b, strong, i, em, u, s, ul, ol, li, a, blockquote, h3, h4, span`).
- Any surviving `<a>` keeps only `href/target/rel`, uses an `http`/`https`/`mailto` scheme, and is forced to `target="_blank" rel="noopener noreferrer"`.
- **On read:** the SF-authored malicious message is **equally sanitized** (`sanitizeMessageHtml` runs in the loader before `{@html}`), so no executable markup reaches the browser.
- No alert dialog fires; no script/handler executes; the timeline detail (plain text via `htmlToText`) contains no markup.

---

## 7.3 Case documents

> **Implementation context.** Case documents use the **same unified-upload model as store files (Area 4.5)**, scoped to the case: on upload, bytes go to **S3**, a local **`case_documents`** row is upserted, and an **`S3_Document__c`** is created with **`Related_Object_Type__c = 'Case'`** and linked to the `Required_File__c` slot. Upload limit is **25 MB**; allowed MIME types match the Area 4.5 allowlist (`application/pdf`; `image/png|jpeg|gif|webp|heic`; Word `.doc/.docx`; Excel `.xls/.xlsx`; `text/plain`, `text/csv`; `application/zip`). Downloads/previews are proxied through signed S3 URLs by the documents API.

### TC-CASE-20 (P1) — Upload to a required-file slot 🔁
**Purpose:** verify a valid upload creates the S3 object, the local mirror row, the `S3_Document__c`, and links the `Required_File__c` slot to show **Uploaded**.
**Preconditions:** a case with ≥1 **pending** required-file slot; a valid file ≤25 MB of an allowed MIME type.
**Steps:**
1. Open the case detail page; in the **Case Documents** card find a pending slot.
2. Upload the valid file into that slot (via the RequiredFiles upload control).
3. After the update, inspect the slot state and the header count.
4. (Verification) Confirm the S3 object, the `case_documents` row, and the `S3_Document__c` (with `Related_Object_Type__c = 'Case'`) exist and the `Required_File__c` is linked (`File_Uploaded__c = true`).
**Expected:**
- A green **"Uploaded `<filename>`."** alert appears; the slot flips to the **uploaded** style and shows the file with a download/preview affordance.
- Header count updates to `<uploaded> of <total> uploaded`; the "Files Submitted" tile on the financial card updates.
- Backend: S3 object written under the case key path; local `case_documents` row upserted (store_id, sfdc_case_id, sfdc_case_file_id = required-file id); `S3_Document__c` created with `Related_Record_Id__c = <caseId>` / `Related_Object_Type__c = 'Case'`; the required-file slot's `Last_Version__c` + `File_Uploaded__c` set.
- A **"Document uploaded — `<slotName>`"** event (amber dot) appears in the timeline.

### TC-CASE-21 (P2) — Remove a case document 🔁
**Purpose:** verify clearing a slot deletes the local row, the S3 object, clears the `Required_File__c`, and tombstones the `S3_Document__c`.
**Preconditions:** a case with an **uploaded** required-file slot.
**Steps:**
1. Open the case detail page; on an uploaded slot, click the clear/remove control.
2. Inspect the slot state and header count.
3. (Verification) Confirm the local row is gone, the S3 object is deleted, `File_Uploaded__c = false`, and the `S3_Document__c` is tombstoned.
**Expected:**
- A green **"Upload cleared. Slot is pending again."** alert appears; the slot reverts to **pending**.
- Backend: `case_documents` row deleted (scoped by `store_id`); S3 object deleted; `clearRequiredFile` unsets `Last_Version__c` / `File_Uploaded__c` and tombstones the old `S3_Document__c`.
- Header count decrements accordingly.

### TC-CASE-22 (P2) ⛔ — Oversized / wrong-type & partial-success
**Purpose:** verify size/MIME rejection and the S3+local-ok-but-SF-fails partial path.
**Preconditions:** an `>25 MB` file; a disallowed-type file (e.g. `.exe`, `video/*`); ability to force the SF attach step to fail on an otherwise-valid upload.
**Steps:**
1. Attempt to upload the `>25 MB` file into a slot.
2. Attempt to upload the disallowed-type file into a slot.
3. Upload a valid file but force `attachUploadToRequiredFile` (the SF step) to fail.
**Expected:**
- Step 1 → **400** **"File too large (max 25 MB)."** No S3/local/SF writes.
- Step 2 → **400** **"Unsupported file type: `<mime>`"**. No writes.
- Step 3 → **partial success**: S3 write and local row succeed, and the message reads **"Uploaded `<filename>`, but Salesforce sync had an issue: `<sf error>`."** The file **still shows** as uploaded in the slot (local mirror drives the UI).
- (Missing file / missing slot id → 400 "Pick a file to upload." / "Missing required file." respectively.)

### TC-CASE-23 (P2) 🔒 — Preview document & example; cross-account rejected
**Purpose:** verify authenticated inline preview of an uploaded case document and of a slot Example, and that cross-account access to the documents API is rejected.
**Preconditions:** an uploaded case document (local id `<localDocId>`) on a case; a required-file slot with an **Example** (`<s3DocId>`); a **second** account whose user does not own this case's store.
**Steps:**
1. As the owning user, open the uploaded document via the preview modal → `GET {BASE_URL}/api/cases/<caseId>/documents/<localDocId>?disposition=inline`.
2. Open the slot **Example** → `GET {BASE_URL}/api/files/example/<s3DocId>?disposition=inline`.
3. Log out; request `{BASE_URL}/api/cases/<caseId>/documents/<localDocId>` unauthenticated.
4. Sign in as the **other-account** user; request `{BASE_URL}/api/cases/<caseId>/documents/<localDocId>`.
**Expected:**
- Step 1 → **302** redirect to a short-lived presigned S3 URL with **inline** disposition (renders in the FilePreviewModal). Default (no `disposition`) downloads as attachment.
- Step 2 → **302** to a presigned URL for the `S3_Document__c` example (S3 key looked up from Salesforce; no local mirror). Missing example → **404 "Example file not found."**
- Step 3 → **401 "Sign in required."** (both endpoints require a signed-in user).
- Step 4 → **404 "Document not found."** — the documents query joins `case_documents → stores → users` on `account_id`, so another account never resolves the row (no cross-account leakage).

---

## Run log

| TC ID | Pri | Result | Tester | Date | Notes / Defect ref |
|---|---|---|---|---|---|
| TC-CASE-01 | P1 | | | | |
| TC-CASE-02 | P1 | | | | |
| TC-CASE-03 | P2 | | | | |
| TC-CASE-04 | P3 | | | | |
| TC-CASE-10 | P1 | | | | |
| TC-CASE-11 | P2 | | | | |
| TC-CASE-12 | P2 | | | | |
| TC-CASE-13 | P2 | | | | |
| TC-CASE-20 | P1 | | | | |
| TC-CASE-21 | P2 | | | | |
| TC-CASE-22 | P2 | | | | |
| TC-CASE-23 | P2 | | | | |
