/**
 * appealsdoctor_vuid__c — a custom Text field on Account / Contact / Store__c
 * that holds the local Postgres UUID for that record. Gives Salesforce a
 * stable back-reference to our app's primary key, without us needing to
 * use Salesforce's External Id mechanism (which would conflict if the SF
 * record was created elsewhere first).
 *
 * Behavior:
 *   - On CREATE: always set the field to the local UUID.
 *   - On UPDATE: only set it if it's currently blank in Salesforce. This
 *     backfills records that were created before the field existed (or that
 *     were linked manually) without ever overwriting a value already there.
 */
import { sfdcQuery } from './client';

export const VUID_FIELD = 'appealsdoctor_vuid__c';

/**
 * Return true if the given SF record's `appealsdoctor_vuid__c` is empty.
 * Returns false on ANY read failure — being defensive is correct here, since
 * the consequence of returning true incorrectly is overwriting a populated
 * value we can't see.
 */
export async function isVuidBlank(
	objectName: 'Account' | 'Contact' | 'Store__c' | string,
	sfdcId: string
): Promise<boolean> {
	try {
		const escaped = sfdcId.replace(/'/g, "''");
		const soql = `SELECT ${VUID_FIELD} FROM ${objectName} WHERE Id = '${escaped}' LIMIT 1`;
		const result = await sfdcQuery<Record<string, unknown>>(soql);
		const row = result.records[0];
		if (!row) return false;
		const value = row[VUID_FIELD];
		return value == null || value === '';
	} catch {
		// Could be INVALID_FIELD (field not yet added to the org), 404 (record
		// gone), perm denied, etc. Don't touch the value in any of those cases.
		return false;
	}
}

/**
 * Convenience: merge `{ [VUID_FIELD]: localId }` into a PATCH payload IF
 * the SF record's vuid is blank AND a local id was provided. Returns the
 * merged payload either way.
 */
export async function withVuidBackfill<T extends Record<string, unknown>>(
	payload: T,
	args: { objectName: string; sfdcId: string; localId?: string | null }
): Promise<T & Partial<Record<typeof VUID_FIELD, string>>> {
	if (!args.localId) return payload;
	if (await isVuidBlank(args.objectName, args.sfdcId)) {
		return { ...payload, [VUID_FIELD]: args.localId };
	}
	return payload;
}
