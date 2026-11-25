/**
 * Admin: Salesforce → app database. Copy an account's contracts with their line items and payment records
 * (salesforce_contract* tables), and fetch from Stripe any paid transaction those records name that the app
 * never recorded. Writes nothing to Salesforce.
 */
import { sql } from '../db';
import { copySalesforceContract } from '../payments/records';
import { describeError, logError } from '../error_log';
import { recordAudit, type AuditActor } from './audit';
import { ActionError, requireReason } from './actions';
import { fetchSalesforceContracts } from './billing';
import { importTransaction } from './stripe_import';

interface Ctx { actor: AuditActor; ip?: string | null }

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;
/** Keeps one request within reason; the message says when more remain. */
const MAX_IMPORTS = 25;

/** `sfContractId` null = every contract of the account's Salesforce Account. */
export async function copyFromSalesforce(ctx: Ctx, accountId: string, sfContractId: string | null, reason: string | null): Promise<string> {
	const why = requireReason(reason);
	if (sfContractId && !SF_ID.test(sfContractId)) throw new ActionError('Invalid contract.', 400);
	const [account] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${accountId}`;
	if (!account?.sfdc_account_id) throw new ActionError('The account is not linked to Salesforce.', 409);

	let ids: string[];
	try {
		ids = sfContractId ? [sfContractId] : (await fetchSalesforceContracts(account.sfdc_account_id)).contracts.map((c) => c.Id);
	} catch (e) {
		throw new ActionError(`Salesforce could not be read: ${describeError(e).errorMessage}`, 502);
	}
	if (!ids.length) return 'Salesforce has no contracts for this account.';

	let copied = 0;
	const failures: string[] = [];
	const storedIds: string[] = [];
	for (const id of ids) {
		try {
			const stored = await copySalesforceContract(accountId, id);
			if (!stored) {
				failures.push(`${id}: not a contract of this account`);
				continue;
			}
			copied++;
			storedIds.push(stored);
			await sql`
				UPDATE stripe_payments SET salesforce_contract_id = ${stored}, contract_stored_at = now()
				WHERE account_id = ${accountId} AND service_contract_id IS NULL AND left(sfdc_service_contract_id, 15) = ${id.slice(0, 15)}`;
		} catch (e) {
			failures.push(`${id}: ${describeError(e).errorMessage}`);
		}
	}

	const missing = storedIds.length
		? await sql<{ pi: string }[]>`
			SELECT DISTINCT p.stripe_payment_intent_id AS pi FROM salesforce_contract_payments p
			WHERE p.salesforce_contract_id IN ${sql(storedIds)} AND p.status = 'Paid'
			  AND p.stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
			  AND NOT EXISTS (SELECT 1 FROM stripe_payments s WHERE s.stripe_payment_intent_id = p.stripe_payment_intent_id)
			ORDER BY 1`
		: [];
	let imported = 0;
	for (const { pi } of missing.slice(0, MAX_IMPORTS)) {
		try {
			// Evidence for another account still refuses it; the Salesforce contract is this account's own.
			await importTransaction(ctx, accountId, pi, why, false);
			imported++;
		} catch (e) {
			failures.push(`${pi}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	await recordAudit(
		{ actor: ctx.actor, action: 'contract.salesforce_copy', targetType: 'account', targetId: accountId, targetAccountId: accountId, outcome: failures.length && !copied ? 'failure' : 'success', reason: why, ip: ctx.ip, metadata: { sfContractId, copied, imported, failures } },
		undefined,
		{ bestEffort: true }
	);
	if (failures.length) {
		await logError({ source: 'admin.sf_pull', operation: 'copy_contracts', accountId, errorMessage: `${failures.length} item(s) could not be copied.`, context: { failures } });
		if (!copied) throw new ActionError(`Nothing was copied. ${failures[0]}`, 502);
	}
	const rest = missing.length - Math.min(missing.length, MAX_IMPORTS);
	return (
		`Copied ${copied} contract${copied === 1 ? '' : 's'} from Salesforce; fetched ${imported} missing payment${imported === 1 ? '' : 's'} from Stripe.` +
		(rest ? ` ${rest} more payment(s) remain — run it again.` : '') +
		(failures.length ? ` ${failures.length} problem(s): ${failures[0]}` : '')
	);
}
