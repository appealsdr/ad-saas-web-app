# Testing the public API (`/api/v1`) — guide

Companion to `docs/api-v1.md` (reference) and the admin page **Admin → API** (client-facing overview).
Automated script: `scripts/api_v1_smoke_test.py` (Python 3.8+, standard library only).

## 1. Prepare

1. **Migration 039 applied** on the target database (deploys do not run migrations).
2. In Admin → Accounts → *the account* → Integrations → **Add API integration**. For the full run tick all 11 permissions; copy the key (`adi_…`) — it is shown once.
3. Pick a **test store** that belongs to that account and is linked to Salesforce (`sfdc_store_id` set) — cases, messages and files go through Salesforce. Note its UUID.
4. Optional but recommended: a **second, restricted integration** (e.g. only `stores.list`, `cases.list`) to prove permissions are enforced. Note its key and permissions.
5. Test against **staging** first. With `--write`, records are created in the real Salesforce org behind that environment (all prefixed `[API TEST]`).

## 2. Run the script

```bash
export API_BASE_URL="https://<staging-host>"
export API_KEY="adi_…"
export API_STORE_ID="<store uuid>"

# A. Read-only (safe anywhere): auth, stores, cases, messages, required files, tenancy
python3 scripts/api_v1_smoke_test.py

# B. Full run with writes: create/update store*, create case, post message, upload, idempotency
python3 scripts/api_v1_smoke_test.py --write            # *add --create-store to also create a new store

# C. Permission matrix with a restricted key
python3 scripts/api_v1_smoke_test.py --limited-key adi_… --limited-allows stores.list,cases.list

# D. Limits
python3 scripts/api_v1_smoke_test.py --write --big-test     # 26 MB file must give 413
python3 scripts/api_v1_smoke_test.py --rate-test 100        # N above the integration's per-minute limit must give 429
```

Useful flags: `--case-id` (use an existing case), `--slot-id` (specific required-file slot), `--file ./doc.pdf --mime application/pdf` (upload your own file). Output is `PASS / FAIL / SKIP` per check; exit code 1 if any FAIL.

## 3. What the script verifies

| Area | Checks |
| --- | --- |
| Auth | no key and bad key → 401 `INVALID_CREDENTIAL`; valid key works; `x-request-id` present |
| Stores | list shape/paging; read fields; (write) create, validation 422 (no name, bad email), update, empty update 422 |
| Tenancy | unknown/malformed ids → 404 `NOT_FOUND`; `?integrationId=` in the query is ignored |
| Cases | list + paging total; read; (write) create, **idempotent replay** returns the same case, same key + different body → 422, bad subject/priority → 422 |
| Messages | list; (write) create, replay idempotent, posted `<script>` is stripped, empty body → 422 |
| Required files | list slots (name, accepted formats, uploaded); (write) upload, replay idempotent, slot flips to `uploaded: true` |
| Upload rules | wrong MIME → 415; missing `X-File-Name` → 422; empty body → 422; extension not accepted by the slot → 422; unknown slot → 404; 26 MB → 413 |
| Permissions | for each of the 11 endpoints a restricted key gets 403 `PERMISSION_DENIED` unless it holds that permission |
| Rate limit | 429 `RATE_LIMITED` with `Retry-After` |

## 4. File upload requirements (what the client must do)

* **Raw body, not multipart.** `POST …/required-files/{slotId}/uploads` with the file bytes as the body.
* Headers: `Content-Type: <file MIME>` (required), `X-File-Name: <name.ext>` (required, ≤255, URL-encode odd characters), optional `Idempotency-Key`.
* **Allowed types:** pdf, png, jpeg, gif, webp, heic, doc, docx, xls, xlsx, txt, csv, zip. Anything else → 415.
* **Max 25 MB** per file → 413. Empty file → 422.
* If the slot lists **accepted formats** (shown by the required-files call, e.g. `["pdf"]`), the file extension must match → 422 otherwise.
* One file per call; the newest upload becomes the slot's current file. The slot id must belong to the case, the case to the store, the store to the integration's account — otherwise 404.
* `curl` example:
  ```bash
  curl -X POST "$BASE/api/v1/stores/$STORE/cases/$CASE/required-files/$SLOT/uploads" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/pdf" \
    -H "X-File-Name: id-proof.pdf" -H "Idempotency-Key: up-001" --data-binary @id-proof.pdf
  ```

## 5. Manual scenarios (admin + client), expected results

Run the read-only script after each change.

| Scenario | Do | Expect |
| --- | --- | --- |
| Pause one integration | Integrations → Pause on integration A (reason ≥5 chars) | A: 503 `INTEGRATION_PAUSED`; integration B on the same account still 200 |
| Resume | Resume A | A works again |
| Disable | Disable A | A: 401 `INTEGRATION_DISABLED`; B unaffected |
| Permission change | Untick `stores.list` on A, save | A's next call: 403 `PERMISSION_DENIED` — no new key needed; B unaffected |
| Rotate | Edit A → **Rotate credentials** | New key works; old key works until the grace period ends (0 h = immediately 401); B's keys unchanged |
| Revoke one key | Edit A → Revoke on a single credential | That key 401 `INVALID_CREDENTIAL`; A's other keys and B still work |
| IP allowlist | Set A's allowlist to an IP that is not yours | 403 `IP_NOT_ALLOWED`; clear it → works |
| Rate limit | Set A's limit to 5/min, run `--rate-test 20` | 429 after 5; B has its own counter |
| Different default users | A → John, B → Jane; post a message with each | Message sender differs per integration |
| Emergency stop | Account Integrations → "Pause all" (type `PAUSE ALL`) | Every active integration 503; one account-level audit entry lists them |
| Cross-account | Use A's key with a store UUID from another account | 404 `NOT_FOUND`, never data |

## 6. Where to look when something fails

* **Admin → Accounts → Integrations → API activity**: one row per request with integration, credential, permission, outcome, HTTP status, error code, IP, duration (filter by integration). Config changes (permission diffs, pause, rotate, revoke) show above it.
* The `x-request-id` header / `requestId` in the error body matches the audit row and server logs.
* `502 UPSTREAM_ERROR` = Salesforce or S3 problem; `409 STORE_NOT_SYNCED / ACCOUNT_NOT_SYNCED / USER_NOT_SYNCED` = the store, account or default user is not linked to Salesforce yet.
* Automated suite: `TEST_PG_URL=postgresql://<user>@127.0.0.1:5432/postgres npx vitest run tests/admin/api_integrations.test.ts`.

## 7. Cleanup

Records created with `--write` are marked `[API TEST]` (cases, messages, uploads, and stores when `--create-store`). Close/delete them in Salesforce / the app if the environment is shared. Revoke or disable the test integration when finished.
