/**
 * Salesforce Store__c sync helpers.
 *
 * Field mapping (local stores row → Salesforce Store__c):
 *
 *   Local                       → Salesforce
 *   ──────────────────────────────────────────────────────────
 *   accounts.sfdc_account_id    → Account__c        (lookup to Account)
 *   name                        → Name
 *   marketplaces                → Marketplaces__c   (multi-picklist; ';'-joined)
 *   seller_id                   → Seller_ID__c
 *   seller_primary_email        → Seller_Account_Primary_Email__c
 *   store_email                 → Store_Email__c
 *   business_name               → Business_Name__c
 *   country                     → Country__c
 *   description                 → Description__c
 *
 * If your org renames any of these, update the keys in storePayload() below.
 */
import { sobjectCreate, sobjectUpdate, sobjectGet, sfdcFetch, sfdcQuery, SalesforceApiError } from './client';
import { getSalesforceConfig } from './config';
import { logError } from '../error_log';
import { isVuidBlank, VUID_FIELD } from './vuid';

export interface StoreFields {
	name: string;
	sfdcAccountId?: string | null;           // → Account__c lookup (accounts.sfdc_account_id)
	marketplaces?: string | null;            // ';'-joined for multi-picklist
	sellerId?: string | null;
	sellerPrimaryEmail?: string | null;
	storeEmail?: string | null;
	businessName?: string | null;
	country?: string | null;
	description?: string | null;
}

export type SfStoreResult =
	| { ok: true; sfdcStoreId: string }
	| { ok: false; error: string; errorCode?: string };

function storePayload(fields: StoreFields): Record<string, unknown> {
	const out: Record<string, unknown> = { Name: fields.name };
	// Link to the parent Salesforce Account. Only set when we actually have an
	// Id — sending null would clear the lookup on an update of an existing store.
	if (fields.sfdcAccountId)                     out.Account__c = fields.sfdcAccountId;
	if (fields.marketplaces !== undefined)        out.Marketplaces__c = fields.marketplaces;
	if (fields.sellerId !== undefined)            out.Seller_ID__c = fields.sellerId;
	if (fields.sellerPrimaryEmail !== undefined)  out.Seller_Account_Primary_Email__c = fields.sellerPrimaryEmail;
	if (fields.storeEmail !== undefined)          out.Store_Email__c = fields.storeEmail;
	if (fields.businessName !== undefined)        out.Business_Name__c = fields.businessName;
	if (fields.country !== undefined)             out.Country__c = fields.country;
	if (fields.description !== undefined)         out.Description__c = fields.description;
	return out;
}

// ─── Marketplaces picklist (for the Create Store UI) ────────────────────

interface DescribeField {
	name: string;
	picklistValues?: { value: string; label: string; active?: boolean }[];
}
interface DescribeResult {
	fields: DescribeField[];
}

let cachedMarketplaceOptions: { at: number; values: string[] } | null = null;
const MARKETPLACE_OPTIONS_TTL_MS = 10 * 60 * 1000;

/**
 * Active picklist values for Store__c.Marketplaces__c, pulled from the SF
 * field describe and cached ~10 min. Best-effort: returns [] (caller falls
 * back to free-text) if Salesforce is unreachable or the field is missing.
 */
export async function getStoreMarketplaceOptions(): Promise<string[]> {
	if (cachedMarketplaceOptions && Date.now() - cachedMarketplaceOptions.at < MARKETPLACE_OPTIONS_TTL_MS) {
		return cachedMarketplaceOptions.values;
	}
	try {
		const cfg = getSalesforceConfig();
		const describe = await sfdcFetch<DescribeResult>(
			`/services/data/${cfg.apiVersion}/sobjects/Store__c/describe`
		);
		const field = describe.fields.find((f) => f.name === 'Marketplaces__c');
		const values = (field?.picklistValues ?? [])
			.filter((p) => p.active !== false)
			.map((p) => p.value);
		cachedMarketplaceOptions = { at: Date.now(), values };
		return values;
	} catch (e) {
		await logError({
			source: 'salesforce.stores',
			operation: 'marketplace_options',
			sfdcObject: 'Store__c',
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage: e instanceof Error ? e.message : String(e)
		});
		return [];
	}
}

// ─── Store__c RecordType lookup (by DeveloperName, cached) ──────────────

const STORE_RECORD_TYPE_DEVELOPER_NAMES = {
	onDemand: 'On_Demand',
	whiteGlove: 'White_Glove'
} as const;

const cachedStoreRecordTypeIds = new Map<string, string | null>();

/**
 * Id of the Store__c RecordType with the given DeveloperName, cached
 * per-name for the life of the process. Best-effort: returns null (caller
 * skips setting RecordTypeId) if the record type doesn't exist in this org
 * or Salesforce is unreachable — never blocks store creation/updates.
 */
async function getStoreRecordTypeId(developerName: string): Promise<string | null> {
	if (cachedStoreRecordTypeIds.has(developerName)) {
		return cachedStoreRecordTypeIds.get(developerName)!;
	}
	try {
		const escaped = developerName.replace(/'/g, "''");
		const r = await sfdcQuery<{ Id: string }>(
			`SELECT Id FROM RecordType WHERE SObjectType = 'Store__c' AND DeveloperName = '${escaped}' LIMIT 1`
		);
		const id = r.records[0]?.Id ?? null;
		cachedStoreRecordTypeIds.set(developerName, id);
		return id;
	} catch (e) {
		await logError({
			source: 'salesforce.stores',
			operation: 'get_store_record_type_id',
			severity: 'warn',
			sfdcObject: 'Store__c',
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage: e instanceof Error ? e.message : String(e),
			context: { developerName }
		});
		cachedStoreRecordTypeIds.set(developerName, null);
		return null;
	}
}

/** Id of the "On_Demand" Store__c RecordType — set on every newly-created store. */
export function getOnDemandStoreRecordTypeId(): Promise<string | null> {
	return getStoreRecordTypeId(STORE_RECORD_TYPE_DEVELOPER_NAMES.onDemand);
}

/** Id of the "White_Glove" Store__c RecordType — set once a store buys a subscription. */
export function getWhiteGloveStoreRecordTypeId(): Promise<string | null> {
	return getStoreRecordTypeId(STORE_RECORD_TYPE_DEVELOPER_NAMES.whiteGlove);
}

/** PATCH a Store__c's RecordTypeId — used to move a store to White_Glove on subscription purchase. */
export async function updateStoreRecordType(
	sfdcStoreId: string,
	recordTypeId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string; errorCode?: string }> {
	try {
		await sobjectUpdate('Store__c', sfdcStoreId, { RecordTypeId: recordTypeId });
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.stores',
			operation: 'update_store_record_type',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Store__c',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcStoreId, recordTypeId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

export async function createSalesforceStore(
	fields: StoreFields,
	context: { userId?: string; accountId?: string; localStoreId?: string } = {}
): Promise<SfStoreResult> {
	const payload = storePayload(fields);
	// New stores start as "On_Demand" — best-effort, skipped if the record
	// type doesn't exist in this org rather than failing store creation.
	const onDemandRecordTypeId = await getOnDemandStoreRecordTypeId();
	if (onDemandRecordTypeId) payload.RecordTypeId = onDemandRecordTypeId;
	// Back-reference: stamp the SF Store__c with our local stores.id.
	if (context.localStoreId) payload[VUID_FIELD] = context.localStoreId;
	try {
		const created = await sobjectCreate('Store__c', payload);
		if (!created.success) {
			const error = `Salesforce Store__c create returned success=false: ${JSON.stringify(created.errors)}`;
			await logError({
				source: 'salesforce.stores',
				operation: 'create_store',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: 'Store__c',
				errorMessage: error,
				context: { payload, localStoreId: context.localStoreId }
			});
			return { ok: false, error };
		}
		return { ok: true, sfdcStoreId: created.id };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.stores',
			operation: 'create_store',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Store__c',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { payload, localStoreId: context.localStoreId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/** Rollup metrics shown on the store overview page — all computed in Salesforce. */
export interface StoreMetrics {
	totalRevenueRecovered: number | null;   // Total_Revenue_Recovered__c
	totalClosedCases: number | null;        // Total_Closed_Cases__c
	totalOpenCases: number | null;          // Total_Open_Cases__c
	totalCases: number | null;              // Total_Cases__c
	storeHealth: string | null;             // Store_Health__c (text/picklist label)
}

const STORE_METRICS_FIELDS = [
	'Total_Revenue_Recovered__c',
	'Total_Closed_Cases__c',
	'Total_Open_Cases__c',
	'Total_Cases__c',
	'Store_Health__c'
] as const;

interface StoreMetricsRow {
	Total_Revenue_Recovered__c: number | null;
	Total_Closed_Cases__c: number | null;
	Total_Open_Cases__c: number | null;
	Total_Cases__c: number | null;
	Store_Health__c: string | null;
}

/** Best-effort — returns all-null on any Salesforce error so the page still renders. */
export async function fetchStoreMetrics(
	sfdcStoreId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<StoreMetrics> {
	try {
		const row = await sobjectGet<StoreMetricsRow>('Store__c', sfdcStoreId, [...STORE_METRICS_FIELDS]);
		return {
			totalRevenueRecovered: row.Total_Revenue_Recovered__c,
			totalClosedCases: row.Total_Closed_Cases__c,
			totalOpenCases: row.Total_Open_Cases__c,
			totalCases: row.Total_Cases__c,
			storeHealth: row.Store_Health__c
		};
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		await logError({
			source: 'salesforce.stores',
			operation: 'fetch_store_metrics',
			severity: 'warn',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Store__c',
			errorCode: isSfErr ? (e.errorCode ?? String(e.status)) : undefined,
			errorMessage: e instanceof Error ? e.message : String(e),
			context: { sfdcStoreId }
		});
		return {
			totalRevenueRecovered: null,
			totalClosedCases: null,
			totalOpenCases: null,
			totalCases: null,
			storeHealth: null
		};
	}
}

export async function updateSalesforceStore(
	sfdcStoreId: string,
	fields: Partial<StoreFields>,
	context: { userId?: string; accountId?: string; localStoreId?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string; errorCode?: string }> {
	const payload = storePayload(fields as StoreFields);
	// Backfill the SF Store__c's appealsdoctor_vuid__c if currently blank —
	// links existing pre-vuid records to our stores.id without ever
	// overwriting a value already populated in Salesforce.
	if (context.localStoreId && (await isVuidBlank('Store__c', sfdcStoreId))) {
		payload[VUID_FIELD] = context.localStoreId;
	}
	try {
		await sobjectUpdate('Store__c', sfdcStoreId, payload);
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.stores',
			operation: 'update_store',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Store__c',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcStoreId, payload, localStoreId: context.localStoreId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}
