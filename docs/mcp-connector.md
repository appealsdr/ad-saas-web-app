# AI assistant connector (MCP) — operations (AD-1969)

Endpoint: `POST /mcp` (Streamable HTTP, stateless). Tools: `get_action_items`, `list_stores`, `get_store`, `list_cases`, `get_case`, `list_messages`,
`list_required_files` (read), `upload_file`, `post_message` (write — preview unless `confirm=true`) and `create_upload_link` (creates a one-time link, uploads nothing itself).
Prompts: `whats_needed` ("What needs my attention?") and `upload_document`.

## "What needs my attention" + guided uploads (migration 043)
- `get_action_items` returns ONE prioritised list across the account's stores: cases waiting for the customer's reply, missing required files (case and store level),
  draft cases, and store setup gaps (Amazon not connected, missing details). Each item has plain-language `say`/`why` text and `howToComplete`; `howToPresent` tells
  the assistant to summarise, then go one item at a time. Sections the connection may not read are skipped and listed in `notChecked`. Bounded: 25 stores, 15 open cases, 10 message checks per call.
- Real files: `create_upload_link` returns `https://<app-host>/upload/<token>` for ONE slot. The customer opens it, picks the file (up to 25 MB) and presses Upload — no base64 through chat.
  The link is single-use, expires in 15 minutes, only its SHA-256 is stored (`upload_links`), max 20 open links per connection, and the kill switches apply. The upload goes through the same
  checks as the API (accepted formats, content sniffing, ClamAV, Salesforce sync) and is audited as `upload_link.upload`. A failed attempt hands the link back so the customer can retry.
- Short text can still be pasted via `upload_file`. `/upload/*` paths are excluded from the activity log because the path carries the token.
- Requires `ORIGIN` to be the public **https** origin (links are refused otherwise).


## Links and readable output
- Every store, case and required-file record returned by the tools has a `url` that opens the exact page in the web app (`/stores/<id>`, `/stores/<id>/issues/<caseId>`, `/stores/<id>#store-documents`). `get_action_items` also returns a ready-made markdown `checklist`.
  Links carry ids only and need the normal sign-in. They are built from `ORIGIN`; without an https `ORIGIN` the `url` fields are simply omitted.
- `list_messages` returns plain `text` (line breaks kept, HTML removed), `fromOurTeam` (true = our staff) and the case `url`, instead of raw HTML.
- Server instructions tell the assistant to link records, keep replies short, and not show raw JSON or ids. Formatting is the assistant's own: the connector supplies links and clean text, not UI.

## How customers connect (no keys)
Claude → Settings → Connectors → add `https://<app-host>/mcp`. Claude discovers OAuth from `/.well-known/oauth-protected-resource/mcp`,
registers itself (`/oauth/register`), and opens `/oauth/authorize`: the customer signs in, ticks what to allow, and approves.
Only account **owners/admins** can connect. They can disconnect any time at **Account → Connected AI assistants** (`/accounts/connections`).
Access tokens last 15 min, refresh tokens 30 days and rotate; replaying an old refresh token or auth code revokes the connection and raises an alert.
Admin-issued integration keys (API → integrations) also work on `/mcp`.

## Turning it on (it is OFF by default)
1. Apply migrations `042_mcp_oauth_alerts_killswitch.sql` and `043_mcp_upload_links.sql`.
2. Admin → Accounts → *account* → **Enable AI assistant connector** (per-account switch).
3. Admin → **Security** shows the global kill switch, alerts and active connections.

## Kill switches (all fail closed)
- **Account**: unchecking the box above blocks `/mcp` + sign-in for that account and revokes its connections.
- **Global**: Admin → Security → *Stop connector* (platform admin + fresh MFA). `/mcp` and token issuance return 503 immediately.
- **Revoke all connections**: per account (account page) or platform-wide (Security page).

## Virus scanning (API + MCP uploads)
Run ClamAV (`docker compose --profile scan up -d clamav`) and set:
| env | meaning |
|---|---|
| `CLAMAV_HOST`, `CLAMAV_PORT` (3310) | clamd address. Unset = scanning not configured |
| `VIRUS_SCAN_REQUIRED=true` | refuse uploads (503) if scanning is not configured or the scanner is down — **set in production** |
| `CLAMAV_TIMEOUT_MS` (20000) | per-scan timeout |
Infected files are rejected (422 `MALWARE_DETECTED`) before anything is stored and raise a high alert.

## Alerts
Stored in `security_alerts`, listed in Admin → Security (acknowledge there), written to the error log, and pushed to
`SECURITY_ALERT_WEBHOOK_URL` (https, Slack-compatible `{"text": ...}`) when set. Raised for: refresh-token/auth-code reuse, malware upload,
>20 denied/not-found tool calls in 10 min, >600 tool calls/hour, kill-switch changes and mass revocations.

## Other env
- `ORIGIN` — public origin used in OAuth metadata (already required behind a proxy).
- `MCP_ALLOWED_ORIGINS` — comma-separated browser Origins allowed to call `/mcp` (leave empty unless a browser client needs it).

## CSRF note
SvelteKit's built-in form-origin check is replaced by `src/lib/server/csrf.ts` (same rule) so `/oauth/token|revoke|register` can be called
server-to-server without an Origin header. `/oauth/authorize` (the consent form) stays protected.
