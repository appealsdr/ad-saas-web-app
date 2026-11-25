/**
 * After an account is permanently deleted locally, its Salesforce records must
 * stop pointing at a platform id that no longer exists: set
 * `appealsdoctor_vuid__c` to null on every related Account / Contact /
 * Store__c / ServiceContract. NOTHING is deleted in Salesforce.
 *
 * Targets are the Salesforce ids stored locally (collected BEFORE the local
 * delete cascades) plus records found in Salesforce that carry one of the
 * deleted local ids or hang off the Salesforce Account but were never mirrored
 * locally. Best effort per record: failures are reported, never thrown.
 */
import { sfdcQuery, sobjectUpdate } from '../salesforce/client';
import { VUID_FIELD } from '../salesforce/vuid';
import { describeError, logError } from '../error_log';
import { isSalesforceId, soqlList, soqlString } from '../salesforce/soql';

export type VuidObject = 'Account' | 'Contact' | 'Store__c' | 'ServiceContract';

export interface VuidTargets {
	accountId: string;
	sfdcAccountId: string | null;
	/** Salesforce ids known locally, by object. */
	known: Record<VuidObject, string[]>;
	/** Local ids whose vuid may still be stamped in Salesforce, by object. */
	localIds: Record<VuidObject, string[]>;
}

export interface VuidClearResult {
	attempted: number;
	cleared: number;
	failed: { object: string; id: string; error: string }[];
	skipped: { object: string; message: string }[];
	byObject: Record<string, number>;
}

const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const missingField = (msg: string) => /INVALID_FIELD|No such column|INVALID_TYPE|sObject type/i.test(msg);

const ACCOUNT_LOOKUP: Record<VuidObject, string | null> = {
	Account: null,
	Contact: 'AccountId',
	Store__c: 'Account__c',
	ServiceContract: 'AccountId'
};

async function discover(object: VuidObject, t: VuidTargets, ids: Set<string>, result: VuidClearResult): Promise<boolean> {
	const clauses: string[] = [];
	const local = [...new Set(t.localIds[object])];
	for (const part of chunk(local, 100)) clauses.push(`${VUID_FIELD} IN (${soqlList(part)})`);
	const lookup = ACCOUNT_LOOKUP[object];
	if (lookup && t.sfdcAccountId && isSalesforceId(t.sfdcAccountId)) clauses.push(`(${lookup} = ${soqlString(t.sfdcAccountId)} AND ${VUID_FIELD} != null)`);
	for (const c of clauses) {
		try {
			const r = await sfdcQuery<{ Id: string }>(`SELECT Id FROM ${object} WHERE ${c}`, { paginate: true });
			for (const row of r.records) ids.add(row.Id);
		} catch (e) {
			const msg = describeError(e).errorMessage;
			if (missingField(msg)) {
				result.skipped.push({ object, message: `${object} has no ${VUID_FIELD} field in Salesforce; nothing to clear.` });
				return false;
			}
			result.failed.push({ object, id: '(lookup)', error: `could not search Salesforce: ${msg}` });
		}
	}
	return true;
}

export async function clearSalesforceVuids(t: VuidTargets): Promise<VuidClearResult> {
	const result: VuidClearResult = { attempted: 0, cleared: 0, failed: [], skipped: [], byObject: {} };
	const objects: VuidObject[] = ['Account', 'Contact', 'Store__c', 'ServiceContract'];
	if (!t.sfdcAccountId && objects.every((o) => !t.known[o].length)) return result;

	for (const object of objects) {
		const ids = new Set(t.known[object].filter(isSalesforceId));
		const fieldExists = await discover(object, t, ids, result);
		if (!fieldExists) continue;
		for (const id of ids) {
			result.attempted++;
			try {
				await sobjectUpdate(object, id, { [VUID_FIELD]: null });
				result.cleared++;
				result.byObject[object] = (result.byObject[object] ?? 0) + 1;
			} catch (e) {
				const msg = describeError(e).errorMessage;
				if (missingField(msg)) {
					result.skipped.push({ object, message: `${object} has no ${VUID_FIELD} field in Salesforce; nothing to clear.` });
					break;
				}
				result.failed.push({ object, id, error: msg });
			}
		}
	}
	for (const f of result.failed) {
		await logError({ source: 'admin.account_delete', operation: 'sf_vuid_clear', severity: 'warn', accountId: null, errorMessage: `${f.object} ${f.id}: ${f.error}`, context: { deletedAccountId: t.accountId } });
	}
	return result;
}
