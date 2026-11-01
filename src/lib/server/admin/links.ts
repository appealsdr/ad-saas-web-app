/**
 * Deep links from admin record pages into Salesforce and Stripe.
 *
 * Salesforce: built from the org's instance_url (returned by the JWT login), so it
 * points at the same org the app talks to (sandbox or production).
 * Stripe: dashboard URLs; test-mode keys get the /test prefix.
 */
import { env } from '$env/dynamic/private';
import { getAccessToken } from '../salesforce/auth';

let cachedBase: string | null = null;

async function sfBase(): Promise<string | null> {
	if (cachedBase) return cachedBase;
	try {
		cachedBase = (await getAccessToken()).instanceUrl.replace(/\/$/, '');
		return cachedBase;
	} catch {
		return null; // Salesforce unreachable: no link now, try again next time
	}
}

/** Link to a Salesforce record, or null when the org URL is unavailable or there is no id. */
export async function salesforceUrl(sfObject: string, id: string | null | undefined): Promise<string | null> {
	if (!id) return null;
	const base = await sfBase();
	if (!base) return null;
	const lightning = base.replace(/\.my\.salesforce\.com$/, '.lightning.force.com');
	return lightning !== base ? `${lightning}/lightning/r/${sfObject}/${id}/view` : `${base}/${id}`;
}

const stripeMode = () => ((env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live') ? '' : '/test');

export type StripeKind = 'payment' | 'subscription' | 'customer';

/** Stripe dashboard link for a payment intent (pi_), subscription (sub_) or customer (cus_) id. */
export function stripeUrl(kind: StripeKind, id: string | null | undefined): string | null {
	if (!id || !/^[a-z]+_[A-Za-z0-9]+$/.test(id)) return null;
	const path = kind === 'payment' ? 'payments' : kind === 'subscription' ? 'subscriptions' : 'customers';
	return `https://dashboard.stripe.com${stripeMode()}/${path}/${id}`;
}
