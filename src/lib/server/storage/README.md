# S3 Setup — step-by-step

This guide walks you through every piece of AWS configuration needed for
file uploads to work in `samdoctor-web`. Reading time: ~5 min.

At the end you'll have:
- A private S3 bucket with default encryption
- An IAM user (or role) that can read + write to it
- Five env vars filled in
- A green light from `/api/aws/diagnostic`

---

## TL;DR — the 5 env vars

```env
AWS_REGION=us-east-1                  # bucket's region
AWS_S3_BUCKET=samdoctor-documents     # bucket name
AWS_ACCESS_KEY_ID=AKIA…               # IAM user access key
AWS_SECRET_ACCESS_KEY=…               # IAM user secret access key
AWS_SESSION_TOKEN=                    # leave blank unless using SSO/STS
```

`AWS_REGION` + `AWS_S3_BUCKET` are required. The access key pair is required
**in dev**. In prod (ECS Fargate task role) leave the access keys blank; the
SDK picks up the role automatically.

Step-by-step details below.

---

## Step 1 — Pick (or create) the S3 bucket

You need an existing private bucket. If you already have one, skip to Step 2.

### Create a new bucket

AWS Console → **S3** → **Create bucket**

| Setting | Value |
| --- | --- |
| Bucket name | Globally unique — e.g. `samdoctor-documents-prod` |
| AWS Region | Whatever's closest to your users / SF / Stripe — usually `us-east-1` |
| Object Ownership | **ACLs disabled** (recommended) |
| Block Public Access | **Block all public access** ✓ (uploads use presigned URLs, never public) |
| Bucket Versioning | Optional — Enabled is safer (recovers accidental overwrites/deletes) |
| Default encryption | **SSE-S3** (AES-256) ✓ — the SDK also requests it per-PUT but the bucket default is belt-and-suspenders |

Click **Create bucket**.

### Where to find these values

| What you need | Where it shows up | Goes into |
| --- | --- | --- |
| **Bucket name** | The name you just typed in step above; visible in the S3 bucket list | `AWS_S3_BUCKET` |
| **Region** | S3 bucket list → next to the name (e.g. "US East (N. Virginia) us-east-1") | `AWS_REGION` |

---

## Step 2 — Pick an authentication method

Two options. **Use IAM user in dev**, IAM role in prod.

| Method | When | Pros | Cons |
| --- | --- | --- | --- |
| **A. IAM user with access keys** | Dev, CI, anything outside AWS | Simple, works anywhere | Keys are long-lived secrets — rotate, scope tight |
| **B. IAM role assumed by the runtime** | Prod on EC2/ECS/Fargate/Lambda | No keys to manage, auto-rotates | Only works inside AWS |

The rest of this guide does **A**. For **B**, attach a role with the policy
from Step 4 to your task and leave `AWS_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`
blank — the SDK reads the role from the instance metadata automatically.

---

## Step 3 — Create the IAM user

AWS Console → **IAM** → **Users** → **Create user**

1. **User name**: `samdoctor-web-s3` (or similar — descriptive)
2. **Provide user access to the AWS Management Console**: ✗ leave unchecked
   (this user is for the API only — no human will log in as them)
3. **Permissions**: choose **"Attach policies directly"** for now — we'll
   attach a custom one in Step 4. Skip past the existing policies and click
   **Next**.
4. Review → **Create user**.

---

## Step 4 — Attach a least-privilege policy

The user should have **only** the four S3 actions the app uses, scoped to
**only** your bucket.

In the new user's page → **Add permissions** → **Create inline policy** →
JSON editor. Paste this, replacing `samdoctor-documents` with your bucket
name in BOTH places:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AppBucketAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::samdoctor-documents",
        "arn:aws:s3:::samdoctor-documents/*"
      ]
    }
  ]
}
```

| Permission | What it lets the app do |
| --- | --- |
| `s3:PutObject` | Write uploaded files |
| `s3:GetObject` | Generate presigned download URLs |
| `s3:DeleteObject` | Remove files when the user clicks ✕ |
| `s3:ListBucket` | HeadBucket sanity check + diagnostic |

Name the policy `samdoctor-web-s3-access` → **Create policy**.

---

## Step 5 — Get the access key pair

Still on the user's page:

1. Click **Security credentials** tab
2. Scroll to **Access keys** → **Create access key**
3. Use case: **Application running outside AWS** → Next
4. (Optional) tag for tracking → **Create access key**
5. You're shown the **Access key** + **Secret access key** ONCE — copy
   both immediately. The secret cannot be retrieved later (only rotated).

### Where to find these values

| What you need | Where | Goes into |
| --- | --- | --- |
| **Access key** | Shown on the "Retrieve access keys" screen — starts with `AKIA…` | `AWS_ACCESS_KEY_ID` |
| **Secret access key** | Same screen — 40-character base64 string | `AWS_SECRET_ACCESS_KEY` |

If you lose the secret: IAM → Users → your user → Security credentials →
**Make inactive** the old key, then create a fresh one.

---

## Step 6 — Fill in your `.env`

Open `samdoctor-web/.env` and set:

```env
AWS_REGION=us-east-1
AWS_S3_BUCKET=samdoctor-documents
AWS_ACCESS_KEY_ID=AKIAXXXXXXXXXXXXXXXX
AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AWS_SESSION_TOKEN=
```

Restart `npm run dev` — the SvelteKit dev server reads env at boot.

---

## Step 7 — Verify

Open in a logged-in browser tab:

```
http://localhost:5173/api/aws/diagnostic
```

You should see:

```json
{
  "envSummary": {
    "AWS_REGION": "us-east-1",
    "AWS_S3_BUCKET": "samdoctor-documents",
    "AWS_ACCESS_KEY_ID": "AKIA…XXXX",
    "AWS_SECRET_ACCESS_KEY": "set",
    "AWS_SESSION_TOKEN": "(unset)"
  },
  "resolved": { "region": "us-east-1", "bucket": "samdoctor-documents" },
  "syncCheck": { "ok": true, "problems": [] },
  "ping": { "ok": true },
  "hint": "✓ Credentials work and the bucket is reachable."
}
```

Then in the app, open a case → upload a required file. It should land in
S3 under `cases/<caseId>/case_files/<caseFileId>/<docId>-<filename>` and the
SF `Case_File__c.Client_File_Info__c` should get `s3://<bucket>/<key>`.

---

## Common failures + how to diagnose

| What `/api/aws/diagnostic` says | What's wrong | Fix |
| --- | --- | --- |
| `"AWS_S3_BUCKET": "(unset)"` | Env var missing | Add to `.env`, restart |
| `"AWS_ACCESS_KEY_ID": "(unset)"` AND `"AWS_SECRET_ACCESS_KEY": "(unset)"` AND you're in dev | No creds at all | Generate access key (Step 5), add to `.env`, restart |
| `ping.error: "Resolved credential object is not valid"` | One of the env vars is empty/wrong | Re-copy from IAM, watch for trailing newlines |
| `ping.error: "Access Denied"` | Policy not attached, or wrong bucket ARN in policy | Re-check Step 4 — `Resource` must list both `arn:aws:s3:::<bucket>` AND `arn:aws:s3:::<bucket>/*` |
| `ping.error: "PermanentRedirect"` | Region mismatch (e.g. bucket is in `eu-west-1` but `AWS_REGION=us-east-1`) | Check the bucket's region in the S3 console, update `AWS_REGION` |
| `ping.error: "NoSuchBucket"` | Bucket name typo | Compare exactly against the S3 console name |
| `ping.error: "The AWS Access Key Id you provided does not exist"` | Key was deleted/inactive | IAM → Users → Security credentials → status |
| Upload itself fails with `403 SignatureDoesNotMatch` | `AWS_SECRET_ACCESS_KEY` has whitespace or a partial copy | Re-copy from IAM; secret is exactly 40 chars |

---

## Where files end up in S3

```
<AWS_S3_APP_ROOT>/                                         ← top-level "app folder"
  <accountId>/                                             ← per local Account
    .placeholder                                           ← created at account registration
    invoices/                                              ← reserved for receipts/contracts
      .placeholder                                         ← created at account registration
    <accountId>/                                           ← (future) account-level uploads
      <docId>-<filename>
    <storeId>/                                             ← per local Store
      <caseFileId>/                                        ← per STORE-level Case_File__c
        <docId>-<filename>
      <sfdcCaseId>/                                        ← per SF Case
        <caseFileId>/                                      ← per CASE-level Case_File__c
          <docId>-<filename>
```

Concrete example:

```
samdoctor/
  9b2f…-account-uuid/
    .placeholder
    invoices/.placeholder
    7d1a…-store-uuid/
      a07ab00000…-store-level-case-file/
        c1d2…-Government_ID.pdf
      500AB000123XyZ/                                      ← SF Case Id
        a07cd00000…-case-level-case-file/
          e3f4…-Supplier_Invoice.pdf
```

| Origin | S3 key |
| --- | --- |
| Account folder reserved at registration | `<root>/<accountId>/.placeholder` |
| Invoices folder reserved at registration | `<root>/<accountId>/invoices/.placeholder` |
| Store-level upload (`Case_File__c` with `Case__c = null`) | `<root>/<accountId>/<storeId>/<caseFileId>/<docId>-<filename>` |
| Case-level upload (`Case_File__c` with `Case__c = <sfdcCaseId>`) | `<root>/<accountId>/<storeId>/<sfdcCaseId>/<caseFileId>/<docId>-<filename>` |
| Account-level upload (path builder ready, route not yet implemented) | `<root>/<accountId>/<accountId>/<docId>-<filename>` |

`<AWS_S3_APP_ROOT>` defaults to `samdoctor` — override via env to share one
bucket between dev/staging/prod without crossing wires.

Every upload uses **SSE-AES256** server-side encryption and Content-Type is
preserved. Downloads are served via 5-min **presigned URLs** — the SvelteKit
server never proxies bytes.

---

## Things worth doing later

- **Lifecycle policy** to auto-transition objects older than 90 days to S3
  Standard-IA (cheaper) and archive/delete after a year. S3 Console → bucket
  → **Management** → Lifecycle rules.
- **CloudTrail data events** for the bucket if you need an audit log of
  every read/write at the object level.
- **MFA Delete** if the bucket holds anything you can't afford to lose to a
  compromised IAM key.
- Migrate to **IAM Identity Center / STS roles** (no long-lived keys) once
  you're past dev — `AWS_SESSION_TOKEN` is the env var that picks those up.
