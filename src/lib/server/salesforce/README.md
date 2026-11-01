# Salesforce — JWT Bearer Flow

Server-only client for talking to Salesforce from SvelteKit using the OAuth
2.0 JWT Bearer Token flow (no user interaction, no refresh tokens — perfect
for backend service accounts).

Lives under `src/lib/server/` so the private key and access token cannot be
imported into client code.

## Files

| File | Purpose |
| --- | --- |
| `config.ts` | Reads `SFDC_*` env vars, loads the PEM file from `SFDC_PRIVATE_KEY_PATH`, parses it into a `crypto.KeyObject`. |
| `auth.ts` | Builds the signed JWT (RS256, `node:crypto`), exchanges it for an access token, caches with in-flight dedupe, exposes `invalidateAccessToken()` for 401 recovery. |
| `client.ts` | `sfdcFetch`, `sfdcQuery`, `sobjectCreate/Get/Update/Upsert/Delete`, `apexRest`, `sfdcPing`. Auto-attaches Bearer, retries once on 401. |
| `index.ts` | Barrel — import from `'$lib/server/salesforce'`. |

## Setup (sandbox)

1. **Create a Connected App** in your sandbox org:
   - Setup → App Manager → New Connected App
   - Enable OAuth Settings
   - Callback URL: anything (e.g. `http://localhost`) — unused by JWT flow
   - **Use digital signatures** → upload an X.509 cert
   - Scopes: at minimum `api` and `refresh_token, offline_access`
   - Save → copy the **Consumer Key** (this is `SFDC_CLIENT_ID`)

2. **Pre-authorize the user**:
   - Manage Connected Apps → Edit Policies
   - Permitted Users = "Admin approved users are pre-authorized"
   - Assign the app to a Profile or Permission Set the target user has.

3. **Generate the keypair locally** (if you haven't already), straight into
   the gitignored `keys/` folder:
   ```bash
   # From samdoctor-web/
   openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
     -keyout keys/server.key \
     -out   keys/server.crt \
     -subj "/CN=samdoctor-sandbox"
   chmod 600 keys/server.key
   ```
   Upload `keys/server.crt` to the Connected App.

4. **Fill `.env`** (no PEM pasting — just point at the file):
   ```env
   SFDC_LOGIN_URL=https://test.salesforce.com
   SFDC_CLIENT_ID=<Consumer Key from step 1>
   SFDC_USERNAME=<the pre-authorized SF user>
   SFDC_PRIVATE_KEY_PATH=./keys/server.key
   SFDC_API_VERSION=v60.0
   ```
   Relative paths resolve against the SvelteKit project root
   (`samdoctor-web/`). Absolute paths also work.

## Smoke test

A test endpoint is wired up at `src/routes/api/sfdc/ping/+server.ts`:

```bash
npm run dev
curl http://localhost:5173/api/sfdc/ping | jq
```

Expected response:
```json
{
  "ok": true,
  "instanceUrl": "https://yourorg--sandbox.my.salesforce.com",
  "tokenIssuedAt": "2026-06-03T...",
  "tokenExpiresAt": "2026-06-03T...",
  "resourceCount": 30,
  "sampleResources": ["sobjects", "search", "query", "...", "..."]
}
```

Delete or auth-protect this endpoint before deploying.

## Usage

```ts
// any +server.ts or +page.server.ts
import {
  sfdcQuery,
  sobjectCreate,
  sobjectUpsert,
  apexRest,
  SalesforceApiError
} from '$lib/server/salesforce';

// SOQL
const { records } = await sfdcQuery<{ Id: string; Name: string }>(
  "SELECT Id, Name FROM Account WHERE Industry = 'Technology' LIMIT 50"
);

// Insert
const { id } = await sobjectCreate('Account', { Name: 'Acme Co' });

// Upsert by external Id field
await sobjectUpsert('Account', 'External_Id__c', 'EXT-1234', { Name: 'Acme Co' });

// Call an Apex REST endpoint (matches the Django backend's pattern)
await apexRest('/appealDoctor/webhook', {
  method: 'POST',
  body: JSON.stringify({ event: 'case.updated', id: 'a01...' })
});

// Error handling
try {
  await sobjectGet('Account', 'bad-id');
} catch (e) {
  if (e instanceof SalesforceApiError) {
    console.error(e.status, e.errorCode, e.message);
  }
  throw e;
}
```

## How auth works under the hood

1. `getAccessToken()` checks the module-level cache.
2. Cache miss → `requestAccessToken()`:
   - `buildJwtAssertion()` signs `{iss, sub, aud, exp}` with RS256 using your
     `SFDC_PRIVATE_KEY` (via `node:crypto.createSign`).
   - POST to `${SFDC_LOGIN_URL}/services/oauth2/token` with
     `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`.
   - Returns `{ access_token, instance_url }` — stored with an assumed 2h TTL.
3. Concurrent callers during a refresh share one in-flight promise (no
   thundering herd).
4. Any `sfdcFetch` that gets 401 → `invalidateAccessToken()` + one retry.

The cache is in-process. For multi-replica deployments (ECS, multiple Node
instances) put a Redis lock around `requestAccessToken()` and store the token
in Redis with the same TTL, so all replicas share one access token. The
`REDIS_URL` env var is already reserved in `.env.example` for this.

## Common errors

| Symptom | Likely cause |
| --- | --- |
| `invalid_grant: user hasn't approved this consumer` | User not pre-authorized for the Connected App (step 2 above). |
| `invalid_grant: audience mismatch` | `SFDC_LOGIN_URL` doesn't match the `aud` the cert expects. Sandbox = `https://test.salesforce.com`. |
| `invalid_grant: invalid assertion` | Private key doesn't match the uploaded cert, or `iss`/`sub` typo. |
| `File at "..." does not look like a PEM-encoded private key` | Wrong file pointed at — check `SFDC_PRIVATE_KEY_PATH`. You may have pointed at the certificate or public key by mistake. |
| `Failed to parse Salesforce private key ... DECODER routines::unsupported` | File is encrypted, in DER not PEM, or corrupted. See the error hint — for encrypted keys, run the `openssl pkcs8 -topk8 -nocrypt` command from `keys/README.md`. |
| `Could not read Salesforce private key at ...` | File doesn't exist at that path. Check `SFDC_PRIVATE_KEY_PATH` and that you're running from `samdoctor-web/`. |
| `Salesforce API 401` after working before | Token expired earlier than assumed TTL. Auto-retry handles it; if it loops, your Connected App session policy is shorter than 2h — set `SFDC_TOKEN_TTL_MS` env var (TODO: wire this up). |
