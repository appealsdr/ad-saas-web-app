/**
 * Case onboarding information.
 *
 * A Case can carry an onboarding config in Case.Case_Onboarding__c — a JSON array:
 *   [{"fieldapiname":"ASIN__c","fieldlabel":"","required":true}, ...]
 * Each entry names a field on the Case itself. The client fills those fields in and,
 * on save, Case.Onboarding_Info_Provided__c is set to true.
 *
 * Everything here is best-effort: if the org doesn't have the config fields yet, or
 * Salesforce is unreachable, callers get "no onboarding" rather than a broken page.
 */
import { sfdcQuery, sfdcFetch, sobjectUpdate, SalesforceApiError } from './client';
import { getSalesforceConfig } from './config';
import { logError } from '../error_log';

const CONFIG_FIELD = 'Case_Onboarding__c';
const PROVIDED_FIELD = 'Onboarding_Info_Provided__c';
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export type OnboardingFieldType = 'text' | 'textarea' | 'number' | 'checkbox' | 'picklist' | 'date';

export interface OnboardingConfigEntry {
	apiName: string;
	label: string; // configured label; '' when the config leaves it blank
	required: boolean;
}

export interface OnboardingField extends OnboardingConfigEntry {
	type: OnboardingFieldType;
	options: string[]; // picklist values
	value: string | boolean | number | null;
}

export interface CaseOnboarding {
	provided: boolean;
	fields: OnboardingField[];
}

// ── Config parsing ──────────────────────────────────────────────────────

export function parseOnboardingConfig(raw: unknown): OnboardingConfigEntry[] {
	if (typeof raw !== 'string' || !raw.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const seen = new Set<string>();
	const out: OnboardingConfigEntry[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== 'object') continue;
		const o = item as Record<string, unknown>;
		const apiName = typeof o.fieldapiname === 'string' ? o.fieldapiname.trim() : '';
		// The name goes into SOQL, so only plain API-name characters are allowed.
		if (!API_NAME_RE.test(apiName) || seen.has(apiName)) continue;
		seen.add(apiName);
		out.push({
			apiName,
			label: typeof o.fieldlabel === 'string' ? o.fieldlabel.trim() : '',
			required: o.required === true
		});
	}
	return out;
}

// ── Case field describe (cached) ────────────────────────────────────────

interface DescribeField {
	name: string;
	label: string;
	type: string;
	updateable?: boolean;
	picklistValues?: { value: string; active?: boolean }[];
}
let describeCache: { at: number; fields: Map<string, DescribeField> } | null = null;
const DESCRIBE_TTL_MS = 10 * 60 * 1000;

async function describeCaseFields(): Promise<Map<string, DescribeField>> {
	if (describeCache && Date.now() - describeCache.at < DESCRIBE_TTL_MS) return describeCache.fields;
	const cfg = getSalesforceConfig();
	const d = await sfdcFetch<{ fields: DescribeField[] }>(
		`/services/data/${cfg.apiVersion}/sobjects/Case/describe`
	);
	const fields = new Map(d.fields.map((f) => [f.name, f]));
	describeCache = { at: Date.now(), fields };
	return fields;
}

function toFieldType(f: DescribeField | undefined): OnboardingFieldType {
	switch (f?.type) {
		case 'boolean':
			return 'checkbox';
		case 'textarea':
			return 'textarea';
		case 'picklist':
			return 'picklist';
		case 'int':
		case 'double':
		case 'currency':
		case 'percent':
			return 'number';
		case 'date':
			return 'date';
		default:
			return 'text';
	}
}

// ── Read ────────────────────────────────────────────────────────────────

/** The onboarding section for a case, or null when the case has no onboarding config. */
export async function fetchCaseOnboarding(
	caseId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<CaseOnboarding | null> {
	try {
		const escaped = caseId.replace(/'/g, "''");
		const head = (
			await sfdcQuery<Record<string, unknown>>(
				`SELECT ${CONFIG_FIELD}, ${PROVIDED_FIELD} FROM Case WHERE Id = '${escaped}' LIMIT 1`
			)
		).records[0];
		const entries = parseOnboardingConfig(head?.[CONFIG_FIELD]);
		if (entries.length === 0) return null;

		const describe = await describeCaseFields();
		const known = entries.filter((e) => describe.has(e.apiName));
		const values = known.length
			? ((
					await sfdcQuery<Record<string, unknown>>(
						`SELECT ${known.map((e) => e.apiName).join(', ')} FROM Case WHERE Id = '${escaped}' LIMIT 1`
					)
				).records[0] ?? {})
			: {};

		return {
			provided: head?.[PROVIDED_FIELD] === true,
			fields: known.map((e) => {
				const d = describe.get(e.apiName);
				const type = toFieldType(d);
				const raw = values[e.apiName];
				return {
					...e,
					label: e.label || d?.label || e.apiName,
					type,
					options: (d?.picklistValues ?? []).filter((p) => p.active !== false).map((p) => p.value),
					value: type === 'checkbox' ? raw === true : ((raw as string | number | null) ?? null)
				};
			})
		};
	} catch (e) {
		// INVALID_FIELD (config fields not deployed) or a Salesforce blip → no section.
		await logError({
			source: 'salesforce.case_onboarding',
			operation: 'fetch',
			severity: 'warn',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Case',
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage: e instanceof Error ? e.message : String(e),
			context: { caseId }
		});
		return null;
	}
}

// ── Save ────────────────────────────────────────────────────────────────

export type SaveOnboardingResult =
	| { ok: true }
	| { ok: false; error: string; fieldErrors?: Record<string, string> };

/**
 * Save the client's answers. The set of fields comes from the Case's own config (re-read
 * here), never from the request, so a client can only write the fields onboarding names.
 */
export async function saveCaseOnboarding(
	caseId: string,
	submitted: Record<string, FormDataEntryValue | null>,
	context: { userId?: string; accountId?: string } = {}
): Promise<SaveOnboardingResult> {
	const current = await fetchCaseOnboarding(caseId, context);
	if (!current) return { ok: false, error: 'This case has no onboarding information to fill in.' };

	const payload: Record<string, unknown> = {};
	const fieldErrors: Record<string, string> = {};
	const describe = await describeCaseFields();

	for (const f of current.fields) {
		if (describe.get(f.apiName)?.updateable === false) continue; // read-only in Salesforce
		const raw = submitted[f.apiName];
		const str = typeof raw === 'string' ? raw.trim() : '';

		if (f.type === 'checkbox') {
			const checked = raw === 'on' || raw === 'true';
			if (f.required && !checked) fieldErrors[f.apiName] = 'Required.';
			payload[f.apiName] = checked;
			continue;
		}
		if (str === '') {
			if (f.required) fieldErrors[f.apiName] = 'Required.';
			payload[f.apiName] = null;
			continue;
		}
		if (f.type === 'number') {
			const n = Number(str);
			if (!Number.isFinite(n)) {
				fieldErrors[f.apiName] = 'Enter a number.';
				continue;
			}
			payload[f.apiName] = n;
		} else if (f.type === 'picklist') {
			if (f.options.length && !f.options.includes(str)) {
				fieldErrors[f.apiName] = 'Choose one of the listed values.';
				continue;
			}
			payload[f.apiName] = str;
		} else {
			payload[f.apiName] = str;
		}
	}

	if (Object.keys(fieldErrors).length) {
		return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors };
	}

	payload[PROVIDED_FIELD] = true;
	try {
		await sobjectUpdate('Case', caseId, payload);
		return { ok: true };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.case_onboarding',
			operation: 'save',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Case',
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage,
			context: { caseId, fields: Object.keys(payload) }
		});
		return { ok: false, error: `Could not save onboarding information: ${errorMessage}` };
	}
}

// ── Bulk status for case tables ─────────────────────────────────────────

/** Onboarding state for many cases in one query. Cases without a config are omitted. */
export async function listOnboardingStatusForCases(
	caseIds: string[]
): Promise<Map<string, { provided: boolean }>> {
	const out = new Map<string, { provided: boolean }>();
	if (caseIds.length === 0) return out;
	const literals = caseIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
	try {
		const r = await sfdcQuery<Record<string, unknown>>(
			`SELECT Id, ${CONFIG_FIELD}, ${PROVIDED_FIELD} FROM Case WHERE Id IN (${literals})`,
			{ paginate: true }
		);
		for (const row of r.records) {
			if (parseOnboardingConfig(row[CONFIG_FIELD]).length === 0) continue;
			out.set(String(row.Id), { provided: row[PROVIDED_FIELD] === true });
		}
	} catch (e) {
		await logError({
			source: 'salesforce.case_onboarding',
			operation: 'bulk_status',
			severity: 'warn',
			sfdcObject: 'Case',
			errorMessage: e instanceof Error ? e.message : String(e),
			context: { caseCount: caseIds.length }
		});
	}
	return out;
}
