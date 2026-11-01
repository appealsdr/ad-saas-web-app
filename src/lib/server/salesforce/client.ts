/**
 * Thin Salesforce REST API client built on top of the JWT auth module.
 *
 * - Auto-attaches Bearer token; refreshes once on 401 (handles SF revoking
 *   sessions or our cached token going stale before the assumed TTL).
 * - Resolves paths against the org's instance_url returned by the auth call —
 *   that's the real per-org endpoint, not the login URL.
 * - Parses JSON when present; returns text for non-JSON bodies.
 *
 * Usage from a SvelteKit endpoint:
 *   import { sfdcQuery, sobjectCreate } from '$lib/server/salesforce';
 *   const { records } = await sfdcQuery<{ Id: string; Name: string }>(
 *     "SELECT Id, Name FROM Account LIMIT 5"
 *   );
 */
import { getAccessToken, invalidateAccessToken } from './auth';
import { getSalesforceConfig } from './config';

export class SalesforceApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly errorCode?: string,
		readonly body?: unknown
	) {
		super(message);
		this.name = 'SalesforceApiError';
	}
}

interface SalesforceErrorBody {
	message?: string;
	errorCode?: string;
}

function buildUrl(instanceUrl: string, path: string): string {
	if (path.startsWith('http://') || path.startsWith('https://')) return path;
	const trimmed = path.startsWith('/') ? path : `/${path}`;
	return `${instanceUrl}${trimmed}`;
}

async function parseBody(res: Response): Promise<unknown> {
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		const text = await res.text();
		return text.length ? text : null;
	}
	const text = await res.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function extractSfError(body: unknown): SalesforceErrorBody | undefined {
	if (Array.isArray(body) && body.length) return body[0] as SalesforceErrorBody;
	if (body && typeof body === 'object') return body as SalesforceErrorBody;
	return undefined;
}

/**
 * Authenticated fetch against the Salesforce REST API.
 *
 * `path` may be:
 *   - an absolute URL (used as-is)
 *   - a path starting with `/services/...` (resolved against instance_url)
 *   - any other path (also resolved against instance_url)
 *
 * On 401 Unauthorized: invalidates the cached token and retries ONCE.
 */
export async function sfdcFetch<T = unknown>(
	path: string,
	init: RequestInit = {}
): Promise<T> {
	const doFetch = async (): Promise<Response> => {
		const token = await getAccessToken();
		const url = buildUrl(token.instanceUrl, path);
		const headers = new Headers(init.headers);
		if (!headers.has('Authorization')) {
			headers.set('Authorization', `${token.tokenType} ${token.accessToken}`);
		}
		if (!headers.has('Accept')) headers.set('Accept', 'application/json');
		if (init.body && !headers.has('Content-Type')) {
			headers.set('Content-Type', 'application/json');
		}
		return fetch(url, { ...init, headers });
	};

	let res = await doFetch();
	if (res.status === 401) {
		invalidateAccessToken();
		res = await doFetch();
	}

	const body = await parseBody(res);

	if (!res.ok) {
		const sfErr = extractSfError(body);
		throw new SalesforceApiError(
			sfErr?.message ?? `Salesforce API ${res.status} ${res.statusText}`,
			res.status,
			sfErr?.errorCode,
			body
		);
	}

	return body as T;
}

// ─── REST API conveniences ───────────────────────────────────────────────

const dataPath = (): string => `/services/data/${getSalesforceConfig().apiVersion}`;

export interface QueryResult<T> {
	totalSize: number;
	done: boolean;
	nextRecordsUrl?: string;
	records: T[];
}

/** Run a SOQL query. Pass a paginate=true to auto-follow `nextRecordsUrl`. */
export async function sfdcQuery<T = Record<string, unknown>>(
	soql: string,
	options: { paginate?: boolean } = {}
): Promise<QueryResult<T>> {
	const first = await sfdcFetch<QueryResult<T>>(
		`${dataPath()}/query?q=${encodeURIComponent(soql)}`
	);
	if (!options.paginate || first.done) return first;

	const all = [...first.records];
	let next = first.nextRecordsUrl;
	while (next) {
		const page = await sfdcFetch<QueryResult<T>>(next);
		all.push(...page.records);
		next = page.done ? undefined : page.nextRecordsUrl;
	}
	return { totalSize: all.length, done: true, records: all };
}

export interface CreateResult {
	id: string;
	success: boolean;
	errors: unknown[];
}

/** Insert a new record. Returns { id, success, errors }. */
export async function sobjectCreate<TBody extends object>(
	objectName: string,
	body: TBody
): Promise<CreateResult> {
	return sfdcFetch<CreateResult>(`${dataPath()}/sobjects/${encodeURIComponent(objectName)}`, {
		method: 'POST',
		body: JSON.stringify(body)
	});
}

/** Patch an existing record. Returns no body on success (204). */
export async function sobjectUpdate<TBody extends object>(
	objectName: string,
	id: string,
	body: TBody
): Promise<void> {
	await sfdcFetch<void>(
		`${dataPath()}/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(id)}`,
		{ method: 'PATCH', body: JSON.stringify(body) }
	);
}

/** Fetch a single record by Id. */
export async function sobjectGet<T = Record<string, unknown>>(
	objectName: string,
	id: string,
	fields?: string[]
): Promise<T> {
	const qs = fields?.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
	return sfdcFetch<T>(
		`${dataPath()}/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(id)}${qs}`
	);
}

/** Delete a record by Id. */
export async function sobjectDelete(objectName: string, id: string): Promise<void> {
	await sfdcFetch<void>(
		`${dataPath()}/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(id)}`,
		{ method: 'DELETE' }
	);
}

/** Upsert by external Id field. Returns 201 (created) or 204 (updated). */
export async function sobjectUpsert<TBody extends object>(
	objectName: string,
	externalIdField: string,
	externalId: string,
	body: TBody
): Promise<CreateResult | null> {
	return sfdcFetch<CreateResult | null>(
		`${dataPath()}/sobjects/${encodeURIComponent(objectName)}/${encodeURIComponent(
			externalIdField
		)}/${encodeURIComponent(externalId)}`,
		{ method: 'PATCH', body: JSON.stringify(body) }
	);
}

/**
 * Call an Apex REST endpoint at /services/apexrest/<path>.
 * Example: apexRest('/appealDoctor/webhook', { method: 'POST', body: ... })
 */
export async function apexRest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
	const p = path.startsWith('/') ? path : `/${path}`;
	return sfdcFetch<T>(`/services/apexrest${p}`, init);
}

/**
 * Hit /services/data/<v>/ to confirm auth + version are good.
 * Returns the list of REST resources Salesforce exposes for that version.
 */
export async function sfdcPing(): Promise<Record<string, string>> {
	return sfdcFetch<Record<string, string>>(`${dataPath()}/`);
}
