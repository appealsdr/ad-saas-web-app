/**
 * Admin "Salesforce stores" (AD-1947): Store__c records that exist in Salesforce under an account's linked
 * Salesforce Account but have no platform store yet (e.g. created in Salesforce after provisioning).
 *
 * Importing creates the local `stores` row linked to the EXISTING Store__c (nothing is created in Salesforce;
 * only appealsdoctor_vuid__c is backfilled when blank).
 */
import { sql } from '../db';
import { sfdcQuery } from '../salesforce/client';
import { updateSalesforceStore } from '../salesforce/stores';
import { logError, describeError } from '../error_log';
import { recordAudit, type AuditActor } from './audit';
import { ActionError, requireReason } from './actions';

const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const FIELDS = 'Id, Name, Account__c, Seller_ID__c, Marketplaces__c, Business_Name__c, Seller_Account_Primary_Email__c, Store_Email__c, Country__c, Description__c, CreatedDate';

export interface SfStore {
	Id: string; Name: string; Account__c: string; Seller_ID__c: string | null; Marketplaces__c: string | null;
	Business_Name__c: string | null; Seller_Account_Primary_Email__c: string | null; Store_Email__c: string | null;
	Country__c: string | null; Description__c: string | null; CreatedDate: string;
}

export interface SfStoreListing {
	/** false when the account has no Salesforce Account id (nothing to list). */
	linked: boolean;
	/** Stores in Salesforce with no platform store linked, or null when Salesforce could not be queried. */
	stores: (SfStore & { sellerIdTaken: boolean })[] | null;
	/** Count of the account's Salesforce stores already on the platform. */
	alreadyLinked: number;
}

async function fetchSfStores(sfdcAccountId: string): Promise<SfStore[]> {
	const res = await sfdcQuery<SfStore>(`SELECT ${FIELDS} FROM Store__c WHERE Account__c = '${sfdcAccountId}' ORDER BY CreatedDate DESC`, { paginate: true });
	return res.records;
}

export async function listSalesforceStores(accountId: string, sfdcAccountId: string | null): Promise<SfStoreListing> {
	if (!sfdcAccountId || !SF_ID_RE.test(sfdcAccountId)) return { linked: false, stores: [], alreadyLinked: 0 };
	let all: SfStore[];
	try {
		all = await fetchSfStores(sfdcAccountId);
	} catch (e) {
		await logError({ source: 'admin.sf_stores', operation: 'list', accountId, sfdcObject: 'Store__c', errorMessage: e instanceof Error ? e.message : String(e) });
		return { linked: true, stores: null, alreadyLinked: 0 };
	}
	// A Store__c may be linked to any platform store (this or another account), so check globally.
	const ids = all.flatMap((s) => [s.Id, s.Id.slice(0, 15)]);
	const linkedRows = ids.length ? await sql<{ sfdc_store_id: string }[]>`SELECT sfdc_store_id FROM stores WHERE sfdc_store_id = ANY(${ids})` : [];
	const linked = new Set(linkedRows.map((r) => r.sfdc_store_id.slice(0, 15)));
	const sellers = all.map((s) => s.Seller_ID__c).filter((x): x is string => !!x);
	const takenRows = sellers.length ? await sql<{ seller_id: string }[]>`SELECT seller_id FROM stores WHERE account_id = ${accountId} AND seller_id = ANY(${sellers})` : [];
	const taken = new Set(takenRows.map((r) => r.seller_id));
	const unlinked = all.filter((s) => !linked.has(s.Id.slice(0, 15)));
	return {
		linked: true,
		stores: unlinked.map((s) => ({ ...s, sellerIdTaken: !!s.Seller_ID__c && taken.has(s.Seller_ID__c) })),
		alreadyLinked: all.length - unlinked.length
	};
}

export async function importSalesforceStore(
	ctx: { actor: AuditActor; ip?: string | null },
	accountId: string,
	sfdcStoreId: string,
	reason: string
): Promise<string> {
	const why = requireReason(reason);
	if (!SF_ID_RE.test(sfdcStoreId)) throw new ActionError('Invalid Salesforce store id.', 400);
	const [acc] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${accountId}`;
	if (!acc) throw new ActionError('Account not found.', 404);
	if (!acc.sfdc_account_id) throw new ActionError('This account is not linked to a Salesforce account.', 409);

	// Re-read live from Salesforce and require it to belong to THIS account's Salesforce Account.
	let sf: SfStore | undefined;
	try {
		const res = await sfdcQuery<SfStore>(`SELECT ${FIELDS} FROM Store__c WHERE Id = '${sfdcStoreId}' LIMIT 1`);
		sf = res.records[0];
	} catch (e) {
		await logError({ source: 'admin.sf_stores', operation: 'import_fetch', accountId, sfdcObject: 'Store__c', errorMessage: e instanceof Error ? e.message : String(e) });
		throw new ActionError('Salesforce could not be reached. Try again.', 502);
	}
	if (!sf) throw new ActionError('That store no longer exists in Salesforce.', 404);
	if (sf.Account__c.slice(0, 15) !== acc.sfdc_account_id.slice(0, 15)) throw new ActionError('That Salesforce store belongs to a different Salesforce account.', 403);

	let localId: string;
	try {
		localId = await sql.begin(async (tx) => {
			const [dupe] = await tx<{ id: string }[]>`SELECT id FROM stores WHERE sfdc_store_id = ${sf!.Id} OR sfdc_store_id = ${sf!.Id.slice(0, 15)} LIMIT 1`;
			if (dupe) throw new ActionError('This Salesforce store is already on the platform.', 409);
			const [row] = await tx<{ id: string }[]>`
				INSERT INTO stores (account_id, created_by, name, marketplaces, seller_id, seller_primary_email, store_email, business_name, country, description, sfdc_store_id)
				VALUES (${accountId}, ${null}, ${sf!.Name}, ${sf!.Marketplaces__c}, ${sf!.Seller_ID__c}, ${sf!.Seller_Account_Primary_Email__c},
				        ${sf!.Store_Email__c}, ${sf!.Business_Name__c}, ${sf!.Country__c}, ${sf!.Description__c}, ${sf!.Id})
				RETURNING id`;
			await recordAudit({
				actor: ctx.actor, action: 'store.import_from_salesforce', targetType: 'store', targetId: row.id, targetAccountId: accountId,
				outcome: 'success', reason: why, ip: ctx.ip, metadata: { sfdcStoreId: sf!.Id, name: sf!.Name }
			}, tx);
			return row.id;
		});
	} catch (e) {
		if (e instanceof ActionError) throw e;
		if ((e as { code?: string })?.code === '23505') throw new ActionError('A store with this Salesforce id or seller id already exists on this account.', 409);
		const d = describeError(e);
		await logError({ source: 'admin.sf_stores', operation: 'import_insert', accountId, errorMessage: d.errorMessage, stack: d.stack, context: { sfdcStoreId } });
		throw new ActionError('Could not add the store. Nothing was changed.', 502);
	}

	// Best-effort: stamp the Salesforce record with our id (only if blank).
	const bf = await updateSalesforceStore(sf.Id, {}, { accountId, localStoreId: localId });
	return `“${sf.Name}” was added to the platform.${bf.ok ? '' : ' (Salesforce vuid backfill failed; it can be retried with “Sync to Salesforce”.)'}`;
}
