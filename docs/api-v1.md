# Public API v1 — multi-integration (AD-1966)

One account can have many independent integrations (admin: `/admin/accounts/{id}/integrations`).
Each has its own credentials, permission profile, default user, status, IP allowlist, rate limit,
idempotency namespace and audit trail. Separate from the Salesforce provisioning keys (`api_keys`).

Auth: `Authorization: Bearer adi_…` — the credential identifies the integration; ids in the body/query are ignored.
Errors: `{ "error": { "code", "message", "requestId" } }` — `INVALID_CREDENTIAL` 401, `INTEGRATION_DISABLED` 401,
`INTEGRATION_PAUSED` 503, `IP_NOT_ALLOWED` 403, `RATE_LIMITED` 429 (+`Retry-After`), `PERMISSION_DENIED` 403, `NOT_FOUND` 404.

| Endpoint | Permission |
| --- | --- |
| `GET /api/v1/stores` | `stores.list` |
| `GET /api/v1/stores/{storeId}` | `stores.read` |
| `POST /api/v1/stores` | `stores.create` |
| `PATCH /api/v1/stores/{storeId}` | `stores.update` |
| `GET /api/v1/stores/{storeId}/cases` | `cases.list` |
| `GET /api/v1/stores/{storeId}/cases/{caseId}` | `cases.read` |
| `POST /api/v1/stores/{storeId}/cases` | `cases.create` |
| `GET …/cases/{caseId}/messages` | `messages.list` |
| `POST …/cases/{caseId}/messages` | `messages.create` |
| `GET …/cases/{caseId}/required-files` | `files.requirements.read` |
| `POST …/required-files/{requiredFileId}/uploads` | `files.upload` |

Writes accept an optional `Idempotency-Key` header (replayed per integration + operation).

**Uploads** send the file as the raw request body (not multipart): `Content-Type: <file mime>`,
`X-File-Name: <name>`. Limit 25 MB, same MIME allowlist as the app.
