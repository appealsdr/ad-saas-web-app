/**
 * Everything that used to run immediately at signup and now runs only AFTER the email is verified (AD-1946):
 * reserve S3 folders, create the Salesforce Account + Contact (or queue the retry), link the owner contact.
 * Idempotent enough for a repeated call: it skips if the account already has a Salesforce id.
 */
import { sql } from '../db';
import { logError, describeError } from '../error_log';
import { createSalesforceAccountAndContact, enqueueAccountContactSync, splitFullName } from '../salesforce';
import { ensureAccountFolders } from '../storage/s3-paths';
import { ensureOwnerAccountContact } from '../account/contacts';

export async function finalizeSignup(userId: string): Promise<void> {
	const [row] = await sql<{
		user_id: string; account_id: string; display_name: string; email: string;
		company: string; phone: string | null; website: string | null; created_at: Date; sfdc_account_id: string | null;
	}[]>`
		SELECT u.id AS user_id, u.account_id, u.display_name, u.email,
		       a.name AS company, a.phone, a.website, a.created_at, a.sfdc_account_id
		FROM users u JOIN accounts a ON a.id = u.account_id
		WHERE u.id = ${userId} LIMIT 1`;
	if (!row || row.sfdc_account_id) return;

	await ensureAccountFolders(row.account_id);

	const { firstName, lastName } = splitFullName(row.display_name);
	const sfInput = {
		companyName: row.company, firstName, lastName, email: row.email,
		phone: row.phone ?? '', website: row.website ?? '', startDate: row.created_at
	};
	const accountId = row.account_id;
	const sfResult = await createSalesforceAccountAndContact(sfInput, { userId, accountId });

	if (sfResult.ok) {
		try {
			await sql.begin(async (tx) => {
				await tx`UPDATE accounts SET sfdc_account_id = ${sfResult.sfdcAccountId} WHERE id = ${accountId}`;
				await tx`UPDATE users SET sfdc_contact_id = ${sfResult.sfdcContactId}, sfdc_account_id = ${sfResult.sfdcAccountId} WHERE id = ${userId}`;
			});
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'register', operation: 'persist_sfdc_ids', userId, accountId,
				errorMessage: desc.errorMessage, stack: desc.stack,
				context: { sfdcAccountId: sfResult.sfdcAccountId, sfdcContactId: sfResult.sfdcContactId }
			});
		}
	} else {
		try {
			await enqueueAccountContactSync({ accountRowId: accountId, userRowId: userId, input: sfInput, failureReason: sfResult.error });
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'register', operation: 'enqueue_sfdc_sync', severity: 'warn', userId, accountId,
				errorMessage: desc.errorMessage, stack: desc.stack,
				context: { originalSfError: sfResult.error, originalSfErrorCode: sfResult.errorCode }
			});
		}
	}

	await ensureOwnerAccountContact(accountId, userId);
}
