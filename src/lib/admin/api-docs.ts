/** Content for the admin "API integrations" overview — the single source of truth shown to staff and shareable with clients. */

export interface Field { name: string; type: string; required?: boolean; note: string }
export interface EndpointDoc {
	permission: string;
	group: 'Stores' | 'Cases' | 'Messages' | 'Files';
	method: 'GET' | 'POST' | 'PATCH';
	path: string;
	title: string;
	means: string; // one-line plain-English definition
	youGet: string; // what the caller receives / how it is delivered
	headers?: Field[];
	query?: Field[];
	body?: Field[];
	requestExample?: string;
	status: string;
	responseExample: string;
	notes?: string[];
	errors: [string, string][]; // [status code, meaning]
}

const STORE = `{
  "id": "6f1c1d0e-8f3a-4b0e-9a57-2d2f0c6a9b11",
  "name": "Acme Outdoor",
  "marketplaces": ["Amazon.com"],
  "sellerId": "A1B2C3D4E5F6G7",
  "sellerPrimaryEmail": "seller@acme.com",
  "storeEmail": "support@acme.com",
  "businessName": "Acme Outdoor LLC",
  "country": "US",
  "description": "Camping gear",
  "amazonConnection": "connected",
  "createdAt": "2026-11-01T14:03:22.000Z",
  "updatedAt": "2026-11-18T09:12:05.000Z"
}`;

export const COMMON_ERRORS: [string, string, string][] = [
	['401', 'INVALID_CREDENTIAL', 'Missing, unknown, revoked or expired credential.'],
	['401', 'INTEGRATION_DISABLED', 'The integration was disabled by an administrator.'],
	['503', 'INTEGRATION_PAUSED', 'The integration is paused. Retry later; credentials still work once resumed.'],
	['403', 'IP_NOT_ALLOWED', 'Your source IP is not in the integration’s allowlist.'],
	['429', 'RATE_LIMITED', 'Per-minute limit reached. Wait for the number of seconds in the Retry-After header.'],
	['403', 'PERMISSION_DENIED', 'The integration does not have the permission this endpoint needs.'],
	['404', 'NOT_FOUND', 'The resource does not exist or belongs to a different account (the two look identical on purpose).'],
	['422', 'VALIDATION_ERROR', 'A field is missing, too long or invalid. The message names the field.'],
	['409', 'IDEMPOTENCY_IN_PROGRESS', 'Another request with the same Idempotency-Key is still running.'],
	['422', 'IDEMPOTENCY_KEY_REUSED', 'That Idempotency-Key was already used with a different request body.'],
	['502', 'UPSTREAM_ERROR', 'Salesforce or storage did not respond. Safe to retry with the same Idempotency-Key.'],
	['500', 'INTERNAL_ERROR', 'Unexpected failure. Quote the requestId when contacting support.']
];

const IDEM: Field = { name: 'Idempotency-Key', type: 'string', note: 'Optional, 1–128 chars (A–Z a–z 0–9 . _ : -). Re-sending the same key with the same request returns the original response instead of doing it twice.' };

export const ENDPOINTS: EndpointDoc[] = [
	{
		permission: 'stores.list', group: 'Stores', method: 'GET', path: '/api/v1/stores', title: 'List account stores',
		means: 'Returns every store that belongs to your account, newest first.',
		youGet: 'A JSON array of store objects (id, name, marketplaces, contact emails, Amazon connection status) plus paging info. Only your own account’s stores are ever returned.',
		query: [
			{ name: 'limit', type: 'integer', note: 'Page size, 1–100. Default 50.' },
			{ name: 'offset', type: 'integer', note: 'Number of stores to skip. Default 0.' }
		],
		status: '200 OK',
		responseExample: `{\n  "data": [\n${STORE.replace(/^/gm, '    ')}\n  ],\n  "paging": { "limit": 50, "offset": 0 }\n}`,
		errors: [['200', 'Success (an empty array when the account has no stores)']]
	},
	{
		permission: 'stores.read', group: 'Stores', method: 'GET', path: '/api/v1/stores/{storeId}', title: 'Read one store',
		means: 'Returns the details of a single store.',
		youGet: 'One store object. Use it to look up a store whose id you already have (for example from a list call).',
		status: '200 OK', responseExample: `{ "data": ${STORE.replace(/\n/g, '\n  ')} }`,
		notes: ['storeId is the UUID returned by the list/create calls.'],
		errors: [['404', 'Store not found, or it belongs to another account']]
	},
	{
		permission: 'stores.create', group: 'Stores', method: 'POST', path: '/api/v1/stores', title: 'Create a store',
		means: 'Adds a new store to your account.',
		youGet: 'The created store (HTTP 201). The store is also pushed to Salesforce; salesforceSynced tells you whether that push succeeded immediately. The seller connects Amazon afterwards in the app, which fills in marketplaces and seller id.',
		headers: [IDEM, { name: 'Content-Type', type: 'string', required: true, note: 'application/json' }],
		body: [
			{ name: 'name', type: 'string ≤200', required: true, note: 'Store name.' },
			{ name: 'sellerPrimaryEmail', type: 'email', note: 'Amazon seller account primary email.' },
			{ name: 'storeEmail', type: 'email', note: 'Public/store contact email.' },
			{ name: 'businessName', type: 'string ≤200', note: 'Legal business name.' },
			{ name: 'country', type: 'string ≤100', note: 'Country.' },
			{ name: 'description', type: 'string ≤2000', note: 'Free text.' }
		],
		requestExample: `{\n  "name": "Acme Outdoor",\n  "sellerPrimaryEmail": "seller@acme.com",\n  "businessName": "Acme Outdoor LLC",\n  "country": "US"\n}`,
		status: '201 Created', responseExample: `{\n  "data": ${STORE.replace(/\n/g, '\n  ')},\n  "salesforceSynced": true\n}`,
		errors: [['422', 'name missing/too long, or an email is invalid']]
	},
	{
		permission: 'stores.update', group: 'Stores', method: 'PATCH', path: '/api/v1/stores/{storeId}', title: 'Update a store',
		means: 'Changes some details of an existing store.',
		youGet: 'The updated store. Send only the fields you want to change; omitted fields stay as they are, and null clears an optional field. Changes are mirrored to Salesforce (salesforceSynced is null if the store is not linked yet).',
		headers: [{ name: 'Content-Type', type: 'string', required: true, note: 'application/json' }],
		body: [
			{ name: 'name', type: 'string ≤200', note: 'Cannot be empty.' },
			{ name: 'sellerPrimaryEmail', type: 'email | null', note: '' },
			{ name: 'storeEmail', type: 'email | null', note: '' },
			{ name: 'businessName', type: 'string ≤200 | null', note: '' },
			{ name: 'country', type: 'string ≤100 | null', note: '' },
			{ name: 'description', type: 'string ≤2000 | null', note: '' }
		],
		requestExample: `{ "storeEmail": "help@acme.com", "description": "Camping and hiking gear" }`,
		status: '200 OK', responseExample: `{\n  "data": ${STORE.replace(/\n/g, '\n  ')},\n  "salesforceSynced": true\n}`,
		errors: [['422', 'No updatable field sent, or a value is invalid'], ['404', 'Store not found']]
	},
	{
		permission: 'cases.list', group: 'Cases', method: 'GET', path: '/api/v1/stores/{storeId}/cases', title: 'List cases related to a store',
		means: 'Returns the cases (support issues / services) that belong to one store.',
		youGet: 'A JSON array of case summaries — case number, subject, status, priority, type and dates — newest first, with a total count.',
		query: [{ name: 'limit', type: 'integer', note: '1–100, default 50.' }, { name: 'offset', type: 'integer', note: 'Default 0.' }],
		status: '200 OK',
		responseExample: `{\n  "data": [\n    {\n      "id": "500Hn00000AbCdEIAV",\n      "caseNumber": "00012345",\n      "subject": "Account suspension appeal",\n      "status": "In Progress",\n      "priority": "High",\n      "type": "Custom",\n      "createdAt": "2026-11-10T16:20:00.000+0000",\n      "updatedAt": "2026-11-19T10:02:11.000+0000"\n    }\n  ],\n  "paging": { "limit": 50, "offset": 0, "total": 1 }\n}`,
		notes: ['Case ids are Salesforce ids (15 or 18 alphanumeric characters).'],
		errors: [['404', 'Store not found']]
	},
	{
		permission: 'cases.read', group: 'Cases', method: 'GET', path: '/api/v1/stores/{storeId}/cases/{caseId}', title: 'Read one case',
		means: 'Returns the full details of a single case.',
		youGet: 'The case summary plus its description, origin, case type and related ASIN (if any).',
		status: '200 OK',
		responseExample: `{\n  "data": {\n    "id": "500Hn00000AbCdEIAV",\n    "caseNumber": "00012345",\n    "subject": "Account suspension appeal",\n    "status": "In Progress",\n    "priority": "High",\n    "type": "Custom",\n    "createdAt": "2026-11-10T16:20:00.000+0000",\n    "updatedAt": "2026-11-19T10:02:11.000+0000",\n    "description": "Seller account suspended on Nov 9…",\n    "origin": "API",\n    "caseType": null,\n    "asin": "B0ABCDEF12"\n  }\n}`,
		errors: [['404', 'Case not found, or it does not belong to this store/account']]
	},
	{
		permission: 'cases.create', group: 'Cases', method: 'POST', path: '/api/v1/stores/{storeId}/cases', title: 'Create a case',
		means: 'Opens a new case for a store so our team can start working on it.',
		youGet: 'The new case id (HTTP 201). The case is created in Salesforce with status New, linked to your account and store, and an “Onboarding Documents” upload slot is added automatically.',
		headers: [IDEM, { name: 'Content-Type', type: 'string', required: true, note: 'application/json' }],
		body: [
			{ name: 'subject', type: 'string ≤255', required: true, note: 'Short title of the problem.' },
			{ name: 'description', type: 'string ≤32000', note: 'Details. Plain text; any HTML is stripped.' },
			{ name: 'priority', type: '"Low" | "Medium" | "High"', note: 'Default "Medium".' }
		],
		requestExample: `{\n  "subject": "Listing removed for IP complaint",\n  "description": "ASIN B0ABCDEF12 was removed on Nov 12…",\n  "priority": "High"\n}`,
		status: '201 Created', responseExample: `{\n  "data": {\n    "id": "500Hn00000AbCdEIAV",\n    "storeId": "6f1c1d0e-8f3a-4b0e-9a57-2d2f0c6a9b11",\n    "subject": "Listing removed for IP complaint",\n    "priority": "High",\n    "status": "New"\n  }\n}`,
		errors: [['409', 'STORE_NOT_SYNCED / ACCOUNT_NOT_SYNCED — the store or account is not linked to Salesforce yet'], ['422', 'subject missing or priority invalid']]
	},
	{
		permission: 'messages.list', group: 'Messages', method: 'GET', path: '/api/v1/stores/{storeId}/cases/{caseId}/messages', title: 'Read case messages / comments',
		means: 'Returns the conversation on a case, oldest first.',
		youGet: 'Every message with its text (safe, sanitised HTML), who wrote it (our team or your side), when, and which message it replies to.',
		status: '200 OK',
		responseExample: `{\n  "data": [\n    {\n      "id": "a0XHn00000QrStUMAV",\n      "body": "<p>We have filed the appeal.</p>",\n      "senderType": "internal",\n      "sender": "Appeals Doctor Team",\n      "replyToMessageId": null,\n      "createdAt": "2026-11-12T13:45:00.000+0000"\n    }\n  ]\n}`,
		errors: [['404', 'Store or case not found']]
	},
	{
		permission: 'messages.create', group: 'Messages', method: 'POST', path: '/api/v1/stores/{storeId}/cases/{caseId}/messages', title: 'Create a case message / comment',
		means: 'Posts a new comment on a case, as if the integration’s default user wrote it.',
		youGet: 'The new message id (HTTP 201). Our team sees it on the case immediately. It is attributed to the integration’s default user.',
		headers: [IDEM, { name: 'Content-Type', type: 'string', required: true, note: 'application/json' }],
		body: [
			{ name: 'body', type: 'string ≤32000', required: true, note: 'Message text. Basic formatting HTML is allowed; scripts and unsafe markup are removed.' },
			{ name: 'replyToMessageId', type: 'string', note: 'Id of a message to reply to.' }
		],
		requestExample: `{ "body": "Here is the invoice you asked for — uploading it now." }`,
		status: '201 Created', responseExample: `{ "data": { "id": "a0XHn00000QrStUMAV", "caseId": "500Hn00000AbCdEIAV" } }`,
		errors: [['409', 'USER_NOT_SYNCED — the default user has no Salesforce contact yet'], ['422', 'body empty or too long']]
	},
	{
		permission: 'files.requirements.read', group: 'Files', method: 'GET', path: '/api/v1/stores/{storeId}/cases/{caseId}/required-files', title: 'Read required-file instructions and status',
		means: 'Lists the documents we need from you for this case and whether each one has been provided.',
		youGet: 'One entry per upload slot: name, instructions, accepted file formats, whether a file is already uploaded (with its name/type/date), and an example file if we have one. Use the slot id to upload.',
		status: '200 OK',
		responseExample: `{\n  "data": [\n    {\n      "id": "a0YHn00000LmNoPQAV",\n      "name": "Onboarding Documents",\n      "shortDescription": null,\n      "instructions": "<p>Upload proof of identity…</p>",\n      "acceptedFormats": ["pdf"],\n      "uploaded": false,\n      "upload": null,\n      "example": null,\n      "createdAt": "2026-11-10T16:20:05.000+0000"\n    }\n  ]\n}`,
		errors: [['404', 'Store or case not found']]
	},
	{
		permission: 'files.upload', group: 'Files', method: 'POST', path: '/api/v1/stores/{storeId}/cases/{caseId}/required-files/{requiredFileId}/uploads', title: 'Upload a file into a required-file slot',
		means: 'Sends one document into one of the case’s required-file slots.',
		youGet: 'A confirmation with the stored file’s id, name, type and size (HTTP 201). The file becomes the slot’s current upload and is visible to our team.',
		headers: [
			{ name: 'Content-Type', type: 'string', required: true, note: 'The file’s MIME type: pdf, png, jpeg, gif, webp, heic, doc/docx, xls/xlsx, txt, csv, zip.' },
			{ name: 'X-File-Name', type: 'string ≤255', required: true, note: 'Original file name incl. extension (URL-encode special characters).' },
			IDEM
		],
		requestExample: `curl -X POST "$BASE/api/v1/stores/$STORE/cases/$CASE/required-files/$SLOT/uploads" \\\n  -H "Authorization: Bearer $KEY" \\\n  -H "Content-Type: application/pdf" \\\n  -H "X-File-Name: id-proof.pdf" \\\n  --data-binary @id-proof.pdf`,
		status: '201 Created',
		responseExample: `{\n  "data": {\n    "id": "0b6d7f0a-1c1e-4b8e-8c52-5a4f0c2e9d10",\n    "requiredFileId": "a0YHn00000LmNoPQAV",\n    "fileName": "id-proof.pdf",\n    "contentType": "application/pdf",\n    "sizeBytes": 183422\n  },\n  "salesforceSynced": true\n}`,
		notes: ['The file is the raw request body — not multipart/form-data.', 'Maximum 25 MB per file. If the slot lists accepted formats, the extension must match one.'],
		errors: [['413', 'File larger than 25 MB'], ['415', 'File type not allowed'], ['422', 'Missing X-File-Name, empty file, or extension not accepted by this slot']]
	}
];

export const QUICKSTART = `# 1. Set your values (the key is shown once by your account manager)
BASE="https://<your-app-host>"
KEY="adi_xxxxxxxxxxxxxxxxxxxxxxxx"

# 2. Check the connection — list your stores
curl "$BASE/api/v1/stores" -H "Authorization: Bearer $KEY"

# 3. Open a case for a store
curl -X POST "$BASE/api/v1/stores/$STORE_ID/cases" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: case-2026-11-21-001" \\
  -d '{"subject":"Account suspension appeal","priority":"High"}'

# 4. See which documents we need, then upload one
curl "$BASE/api/v1/stores/$STORE_ID/cases/$CASE_ID/required-files" -H "Authorization: Bearer $KEY"`;

export const ERROR_EXAMPLE = `HTTP/1.1 403 Forbidden
x-request-id: 5b0c6a4e-…

{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "This integration lacks the \\"cases.create\\" permission.",
    "requestId": "5b0c6a4e-…"
  }
}`;
