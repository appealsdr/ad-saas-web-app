# AWS Deployment — Step-by-Step (What We Did)

A record of how Appeals Doctor (SamDoctor Web) was deployed to AWS App Runner.

> ✅ **No passwords, keys, or tokens are stored in this file — safe to commit.**
> Live secret values and the full credential inventory live in `aws setup.md` (gitignored).

- **Stack:** SvelteKit (`@sveltejs/adapter-node`, Node 22) · PostgreSQL · S3 · Stripe · Salesforce
- **Host:** AWS App Runner (managed containers, auto HTTPS, auto-scaling)
- **Region:** `us-east-2` · **Account:** `661526246146`
- **Result:** https://qa5xpqdgfx.us-east-2.awsapprunner.com

---

## Architecture

```
Internet ──HTTPS──► App Runner service "appeals-dr" (container, port 3000)
                       ├─ pulls image ───────────► ECR repo "appeals-dr"
                       ├─ instance role ─────────► S3 + Secrets Manager (keyless)
                       └─ VPC connector ─────────► RDS PostgreSQL (private path)
```

---

## Prerequisites (local machine)

```bash
brew install awscli                 # AWS CLI v2
brew install --cask docker-desktop  # Docker engine (launch it: open -a Docker)
brew install postgresql@16          # provides the psql client
aws configure                       # access key, secret, region us-east-2, output json
aws sts get-caller-identity         # verify identity
```

---

## Step 1 — Containerize the app

Created a multi-stage **`Dockerfile`** (Node 22): build stage runs `npm ci && npm run build` (adapter-node → `build/`), runtime stage runs `node build` on port 3000 as the non-root `node` user. Added **`.dockerignore`**.

## Step 2 — Create the RDS PostgreSQL database

Console → RDS → Create database → PostgreSQL 16, Free tier, `db.t4g.micro`.
- Identifier `amzn-andrei-appeals-dr-test`, master user `postgres`, strong password.
- Encryption on, backups on.

**Gotcha:** the instance came up with no application database, so we created one:
```bash
psql "postgresql://postgres:<PW>@<ENDPOINT>:5432/postgres?sslmode=require" \
  -c "CREATE DATABASE samdoctor;"
```

## Step 3 — Load the schema (16 tables)

Wrote **`scripts/apply-migrations.sh`** to apply `db/migrations/*.sql` in order to any Postgres URL.

To reach the private DB from the laptop, temporarily set RDS **Public access = Yes** and allowed our IP on 5432, then:
```bash
read -rs PGURL                      # paste the full URL (hidden input)
export PGURL
./scripts/apply-migrations.sh       # applies 001…014, lists tables at the end
```
Then reverted public access (see Step 9 hardening).

**Gotcha:** `read -rs PGURL <url>` doesn't set the value — paste at the prompt, or use `export PGURL="…"` directly. URLs must include `?sslmode=require`.

## Step 4 — Store configuration in Secrets Manager

Console → Secrets Manager → Store a new secret → **Other type of secret** (not the RDS/Redshift types — those try to enumerate clusters and error). Stored all app config as JSON under name `amzn-andrei-appeals-dr`.

**Gotcha:** the Salesforce PEM was pasted with raw line breaks → invalid JSON. Re-serialized it so newlines became `\n`, which lets App Runner extract values per-key.

## Step 5 — Create the S3 bucket

Bucket `amzn-andrei-appeals-dr-test-bucket`, **Block all public access ON**, encryption ON. No access keys — the app reaches it via an IAM role (Step 7).

## Step 6 — Build & push the image to ECR

```bash
ACCOUNT=661526246146; REGION=us-east-2
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/appeals-dr"

aws ecr create-repository --repository-name appeals-dr --region $REGION
aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker build --platform linux/amd64 -t "${REPO}:latest" .   # amd64 even on Apple Silicon
docker push "${REPO}:latest"
```

**Gotcha:** in **zsh**, `$REPO:latest` is parsed as the `:l` (lowercase) modifier → image got mis-tagged `appeals-dratest`. Always brace it: **`"${REPO}:latest"`**.

## Step 7 — Create IAM roles (keyless access)

- **Instance role** `appeals-dr-apprunner-instance` — trust `tasks.apprunner.amazonaws.com`; inline policy granting `secretsmanager:GetSecretValue` on the secret and S3 read/write/list on the bucket.
- **ECR access role** `appeals-dr-apprunner-ecr-access` — trust `build.apprunner.amazonaws.com`; managed policy `AWSAppRunnerServicePolicyForECRAccess`.

Because the app runs *as* the instance role, static AWS keys stay blank in prod.

## Step 8 — Create the VPC connector & App Runner service

```bash
# VPC connector — same VPC/subnets/SG as RDS so they can talk privately
aws apprunner create-vpc-connector --region us-east-2 \
  --vpc-connector-name appeals-dr-connector \
  --subnets <subnet-a> <subnet-b> <subnet-c> \
  --security-groups <rds-sg>
```
The default security group already had a self-referencing all-traffic rule, so the connector (in that SG) can reach RDS (in that SG) on 5432.

Then created the service with `aws apprunner create-service` wiring:
- ECR image `appeals-dr:latest`, port `3000`, auto-deployments ON
- ECR access role + instance role
- **Plain env:** `NODE_ENV=production`, `PROTOCOL_HEADER=x-forwarded-proto`, `HOST_HEADER=host`, `AWS_REGION`, `AWS_S3_BUCKET`, `SFDC_LOGIN_URL`, `SFDC_API_VERSION`
- **Secret env (from Secrets Manager):** `DATABASE_URL`, `JWT_SECRET`, `STRIPE_SECRET_KEY`, `PUBLIC_STRIPE_KEY`, `SFDC_CLIENT_ID`, `SFDC_USERNAME`, `SFDC_PRIVATE_KEY`
- Egress via the VPC connector; TCP health check

> `PROTOCOL_HEADER`/`HOST_HEADER` let SvelteKit derive its own origin from App Runner's proxy headers — avoids hardcoding `ORIGIN` before the URL exists.

Service reached `RUNNING` in ~3 minutes and returned the public URL.

**Gotchas:**
- Newer services (App Runner) returned `SubscriptionRequiredException` on the freshly-activated account; it cleared on its own once activation finished.
- After `RUNNING`, the public hostname took a few minutes to resolve (DNS propagation / negative caching). Verified via `dig @8.8.8.8 <url>`; `/login` then returned HTTP 200.

## Step 9 — Salesforce key fix (code change)

`src/lib/server/salesforce/config.ts` originally read the RSA key only from a file (`SFDC_PRIVATE_KEY_PATH`). Updated it to prefer the **`SFDC_PRIVATE_KEY`** env var (injected from Secrets Manager), normalizing `\n`, with the file path as a dev fallback. Rebuilt, pushed, and added the `SFDC_*` env vars to the running service.

---

## Redeploy workflow (day-to-day)

```bash
cd ~/Documents/GitHub/appeal-dr-app
ACCOUNT=661526246146; REGION=us-east-2
REPO="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/appeals-dr"

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker build --platform linux/amd64 -t "${REPO}:latest" .
docker push "${REPO}:latest"        # auto-deployments ON → rolling redeploy starts automatically
```

Watch status:
```bash
aws apprunner describe-service --region us-east-2 \
  --service-arn <SERVICE_ARN> --query 'Service.Status' --output text
```

---

## Post-deploy hardening checklist

- [ ] RDS → **Public access = No**; remove the temporary laptop-IP rule on 5432 (app uses the VPC connector now).
- [ ] Rotate any secrets that were exposed during setup; keep real values only in Secrets Manager.
- [ ] Keep static AWS keys blank in prod (instance role handles access).
- [ ] Confirm Salesforce `SFDC_LOGIN_URL` matches org type (`test.` sandbox vs `login.` production).
- [ ] Switch Stripe/Google/Salesforce to live credentials + prod redirect URIs before real traffic.

## Not yet done

- Custom domain + HTTPS (App Runner → Custom domains)
- Redis / ElastiCache (currently unused in prod)
- Google OAuth (placeholder credentials)
- SES transactional email
