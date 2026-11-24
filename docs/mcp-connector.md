# AI assistant connector (MCP) — operations (AD-1969)

Endpoint: `POST /mcp` (Streamable HTTP, stateless). Tools: `list_stores`, `get_store`, `list_cases`, `get_case`, `list_messages`,
`list_required_files` (read) and `upload_file`, `post_message` (write — preview unless `confirm=true`).

## How customers connect (no keys)
Claude → Settings → Connectors → add `https://<app-host>/mcp`. Claude discovers OAuth from `/.well-known/oauth-protected-resource/mcp`,
registers itself (`/oauth/register`), and opens `/oauth/authorize`: the customer signs in, ticks what to allow, and approves.
Only account **owners/admins** can connect. They can disconnect any time at **Account → Connected AI assistants** (`/accounts/connections`).
Access tokens last 15 min, refresh tokens 30 days and rotate; replaying an old refresh token or auth code revokes the connection and raises an alert.
Admin-issued integration keys (API → integrations) also work on `/mcp`.

## Turning it on (it is OFF by default)
1. Apply migration `042_mcp_oauth_alerts_killswitch.sql`.
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
