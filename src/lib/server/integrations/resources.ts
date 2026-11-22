/**
 * Resource-level tenant verification — runs AFTER requireIntegrationPermission.
 * Everything is scoped by principal.accountId; a resource from another account
 * is indistinguishable from one that does not exist (404).
 */
import { sql } from '../db';
import { ApiError } from './errors';
import { findCaseStoreLookup, listRequiredFilesForCase, type RequiredFile } from '../salesforce';

export interface ApiStore {
	id: string;
	account_id: string;
	name: string;
	marketplaces: string | null;
	seller_id: string | null;
	seller_primary_email: string | null;
	store_email: string | null;
	business_name: string | null;
	country: string | null;
	description: string | null;
	sfdc_store_id: string | null;
	spapi_status: string;
	created_at: Date;
	updated_at: Date;
}

export const STORE_COLUMNS = sql`
	id, account_id, name, marketplaces, seller_id, seller_primary_email, store_email, business_name,
	country, description, sfdc_store_id, spapi_status, created_at, updated_at`;

export async function requireIntegrationStore(accountId: string, storeId: string): Promise<ApiStore> {
	const [store] = await sql<ApiStore[]>`
		SELECT ${STORE_COLUMNS} FROM stores WHERE id = ${storeId} AND account_id = ${accountId} LIMIT 1
	`;
	if (!store) throw new ApiError(404, 'NOT_FOUND', 'Store not found.');
	return store;
}

/** The Salesforce Case must belong to THIS store (which already belongs to the account). */
export async function requireIntegrationCase(store: ApiStore, caseId: string, accountId: string): Promise<void> {
	if (!store.sfdc_store_id) throw new ApiError(404, 'NOT_FOUND', 'Case not found.');
	const lookup = await findCaseStoreLookup(caseId, { accountId });
	if (!lookup.ok) {
		if (lookup.notFound) throw new ApiError(404, 'NOT_FOUND', 'Case not found.');
		throw new ApiError(502, 'UPSTREAM_ERROR', 'Could not verify the case right now.');
	}
	if (lookup.sfdcStoreId !== store.sfdc_store_id) throw new ApiError(404, 'NOT_FOUND', 'Case not found.');
}

/** The required-file slot must belong to the (already verified) case. */
export async function requireIntegrationRequiredFile(caseId: string, requiredFileId: string): Promise<RequiredFile> {
	const res = await listRequiredFilesForCase(caseId);
	if (!res.ok) throw new ApiError(502, 'UPSTREAM_ERROR', 'Could not load required files right now.');
	const f = res.files.find((x) => x.id === requiredFileId);
	if (!f) throw new ApiError(404, 'NOT_FOUND', 'Required file not found.');
	return f;
}

export async function getUserSfdcContactId(userId: string): Promise<string | null> {
	const [row] = await sql<{ sfdc_contact_id: string | null }[]>`SELECT sfdc_contact_id FROM users WHERE id = ${userId} LIMIT 1`;
	return row?.sfdc_contact_id ?? null;
}
