/**
 * On-demand external lookups for the account workspace. Never used while
 * rendering lists. Each call has its own timeout and reports
 * { source, fetchedAt, ok, data | error } independently, so one provider being
 * down never hides local data or another provider's result.
 */
import { fetchSalesforceAccount } from '../salesforce/records';
import { getStripe } from '../stripe';
import { redactString } from './redact';

export const EXTERNAL_TIMEOUT_MS = 8_000;

export interface ExternalResult<T> {
	source: string;
	fetchedAt: string;
	ok: boolean;
	data?: T;
	error?: string;
}

async function timed<T>(source: string, fn: () => Promise<T>): Promise<ExternalResult<T>> {
	const fetchedAt = new Date().toISOString();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const data = await Promise.race([
			fn(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out after ${EXTERNAL_TIMEOUT_MS / 1000}s`)), EXTERNAL_TIMEOUT_MS);
			})
		]);
		return { source, fetchedAt, ok: true, data };
	} catch (e) {
		return { source, fetchedAt, ok: false, error: redactString(e instanceof Error ? e.message : String(e)).slice(0, 300) };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function fetchSalesforceAccountLive(sfdcAccountId: string, accountId: string) {
	return timed('Salesforce Account (live)', async () => {
		const r = await fetchSalesforceAccount(sfdcAccountId, { accountId });
		if (!r.ok) throw new Error(r.notFound ? 'Salesforce Account not found (broken link?)' : r.error);
		const a = r.record as unknown as Record<string, unknown>;
		return {
			Id: a.Id, Name: a.Name, Phone: a.Phone, Website: a.Website,
			BillingStreet: a.BillingStreet, BillingCity: a.BillingCity, BillingState: a.BillingState,
			BillingPostalCode: a.BillingPostalCode, BillingCountry: a.BillingCountry,
			LastModifiedDate: a.LastModifiedDate
		};
	});
}

export function fetchStripeCustomerLive(customerId: string) {
	return timed('Stripe customer + subscriptions (live)', async () => {
		const stripe = getStripe();
		const [customer, subs] = await Promise.all([
			stripe.customers.retrieve(customerId),
			stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 })
		]);
		if ('deleted' in customer && customer.deleted) return { customerDeleted: true, subscriptions: [] };
		return {
			customerDeleted: false,
			email: (customer as { email?: string | null }).email ?? null,
			subscriptions: subs.data.map((s) => ({
				id: s.id,
				status: s.status,
				cancelAtPeriodEnd: s.cancel_at_period_end,
				created: new Date(s.created * 1000).toISOString()
			}))
		};
	});
}
