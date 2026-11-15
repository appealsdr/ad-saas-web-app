# Account merge — proposal (AD-1944)

Status: **implemented for two accounts at a time** (admin → Accounts → Account merge → Review merge). Requires migration `036_account_merge.sql`.
Staff pick the account that stays, then choose: which value wins per account field and for the Stripe customer; which logins stay (one owner) or are disabled;
which stores, contracts, contacts and activity move; and whether to re-parent the moved records in Salesforce. Everything unchosen stays on the retired account.
Not built: the Apex `Database.merge` route and re-parenting of Salesforce records the platform does not track (cases etc.), N-way merges (chain two-account merges), and undo.

## The situation

1. Salesforce creates Account **S1** (+ stores, cases). It is provisioned → platform account **A** linked to S1.
2. The same client later registers on the platform themselves → platform account **B**, and (after email verification) a *new* Salesforce Account **S2** + Contact.
3. They buy a contract → `service_contracts` row under **B**, a ServiceContract + Payments under **S2**, a Stripe customer on **B**.

Result: two platform accounts and two Salesforce accounts for one customer. The history (stores, cases, documents) is on A/S1; the new money (contract, payments, Stripe) is on B/S2. The client logs in as B and sees none of the history.

## Principles

- **Pick a survivor, retire the duplicate; never delete.** Default survivor = the account with Salesforce history (A/S1); staff can flip it in the preview.
- **Preview first.** A dry run lists everything that will move and every conflict. Execute is only possible after a clean preview.
- **Local first, Salesforce second, both resumable.** Postgres changes happen in one transaction. Salesforce steps are recorded in a job table and are idempotent, so a failure halfway is retried, not left half-merged.
- **platform_admin + fresh MFA + reason + typed confirmation**, everything in `admin_audit_events`.

## Step 0 — detect (built)

The tab flags platform accounts sharing a canonical email (Gmail dots/+tags collapsed), website host or company name. Same signals feed a "possible existing account" warning on *Account provision*, so staff merge instead of provisioning a duplicate.

## Step 1 — preview and conflicts

For survivor **A** and duplicate **B**, show counts and block or warn on:

| Item | Rule |
|---|---|
| `users` (email is unique) | Move B's users to A as `member` (A keeps its owner). Same person on both → keep A's user, drop B's after moving its sessions/history. |
| `accounts.sfdc_account_id` (unique) | A keeps S1. B's S2 id is moved to a merge log, then B is cleared so the unique key is free. |
| `stores` | Move B's stores to A. **Same `seller_id` on both → same store**: merge into A's store (move documents) or block for manual review. |
| `service_contracts` + line items, `balance_payment_applications`, subscriptions | Move to A. **Both have an active subscription (`active_subscription_contract_id`) → block**; staff cancels one first. |
| Stripe customer | A has none → adopt B's. Both have one → keep both ids in the merge log, point new charges at the one with the active subscription/payment method; never delete a Stripe customer. |
| `account_contacts` (unique per account+email) | Move; on collision keep A's row. |
| `api_keys`, `ai_chat_messages`, `activity_log`, `signup_links` | Re-point `account_id`. |
| In-flight payments | Block while a PaymentIntent for B is `processing`/`requires_action` or a checkout session is open. |
| Documents in S3 | Keep objects where they are; rows keep their keys. (Verify the download path never assumes `account_id` in the key before enabling.) |

## Step 2 — execute locally (one transaction)

1. Lock both accounts (`pg_advisory_xact_lock` on both ids) and set them read-only.
2. Re-parent every table above from B to A.
3. Keep B as a **retired row**: new column `accounts.merged_into_account_id`, name suffixed, `sfdc_account_id` cleared. Its users' sessions are revoked and they sign in as the moved user on A.
4. Write an `account_merges` row with a JSON snapshot of every moved id per table (this is the undo data) and the audit event.

## Step 3 — Salesforce (job with retries)

Preferred: an Apex REST endpoint (or the SOAP `merge()` call) that runs `Database.merge(S1, S2)`, which re-parents all related records (Contacts, ServiceContracts, Payments, Stores, Cases, documents) in one supported operation and keeps S1 as master. The REST API has no merge verb, so this needs a small Apex class in the org.

Fallback without Apex: re-parent explicitly, in this order, each step idempotent (query by `AccountId = S2`, update to S1):
`Contact.AccountId` → `ServiceContract.AccountId` (Payments follow their contract) → `Store__c.Account__c` → `Case.AccountId` → other lookups. Then mark S2 as merged (`Merged_Into__c`, status "Merged – do not use") instead of deleting it.

Finally: stamp S1's `appealsdoctor_vuid__c` with A's id, clear S2's, update the surviving Contact's vuid, and push the final name/email/phone to S1.

## Step 4 — verify and finish

Reconcile counts (stores, contracts, payments, users) between Postgres and Salesforce; show the result on the merge record. Notify the client's owner by email. Undo window: the snapshot allows re-parenting back for as long as no new records were created on A since the merge.

## Prevent it recurring

- `Account provision` warns when a platform account with the same email/name exists.
- On registration, if the verified email or company matches an existing Salesforce Account, send the client a signup link (`signup-link`) instead of creating S2.
- Do not create the Salesforce Account/Contact for a self-registration if a match exists; queue it for staff review.

## Suggested build order

1. Migration: `accounts.merged_into_account_id`, `account_merges` (snapshot + status), `account_merge_steps` (job).
2. Preview function + conflict rules + tests against a seeded database.
3. Local transaction.
4. Salesforce step (Apex `merge` if available, else the fallback).
5. UI: pick pair → preview → confirm.
