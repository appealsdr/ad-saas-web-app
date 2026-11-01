/**
 * Account-level subscription lookup. One active plan covers every store in the
 * account; accounts.active_subscription_contract_id is the source of truth.
 */
import { sql } from './db';

export interface AccountSubscription {
	contractId: string;
	pricebookEntryId: string | null;
	planName: string | null;
	price: number | null;
	endDate: Date;
	stripeSubscriptionId: string | null;
	/** The customer cancelled: the plan stays active until endDate, then stops. */
	cancelling: boolean;
}

export async function getAccountSubscription(accountId: string): Promise<AccountSubscription | null> {
	const [row] = await sql<
		{
			id: string;
			sfdc_pricebook_entry_id: string | null;
			product_name: string | null;
			unit_price: number | null;
			end_date: Date;
			stripe_subscription_id: string | null;
			cancelling: boolean;
		}[]
	>`
		SELECT sc.id, scli.sfdc_pricebook_entry_id, scli.product_name, scli.unit_price,
		       sc.end_date, sc.stripe_subscription_id, (sc.cancel_requested_at IS NOT NULL) AS cancelling
		FROM accounts a
		JOIN service_contracts sc ON sc.id = a.active_subscription_contract_id
		LEFT JOIN LATERAL (
			SELECT sfdc_pricebook_entry_id, product_name, unit_price
			FROM service_contract_line_items
			WHERE service_contract_id = sc.id ORDER BY created_at ASC LIMIT 1
		) scli ON TRUE
		WHERE a.id = ${accountId} AND sc.kind = 'subscription' AND sc.status = 'active'
	`;
	if (!row) return null;
	return {
		contractId: row.id,
		pricebookEntryId: row.sfdc_pricebook_entry_id,
		planName: row.product_name,
		price: row.unit_price === null ? null : Number(row.unit_price),
		endDate: row.end_date,
		stripeSubscriptionId: row.stripe_subscription_id,
		cancelling: row.cancelling
	};
}
