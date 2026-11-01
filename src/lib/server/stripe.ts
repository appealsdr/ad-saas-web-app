/**
 * Stripe SDK singleton — server-only.
 *
 * Lives under $lib/server/ so the secret key cannot be bundled into the
 * browser. STRIPE_SECRET_KEY must be set (sk_test_… in dev, sk_live_…
 * in prod). The publishable key (pk_*) is safe to expose to the client and
 * goes through $env/dynamic/public if/when we add Stripe.js Elements later.
 */
import Stripe from 'stripe';
import { env } from '$env/dynamic/private';

let cached: Stripe | null = null;

export function getStripe(): Stripe {
	if (cached) return cached;
	const key = env.STRIPE_SECRET_KEY;
	if (!key) {
		throw new Error(
			'STRIPE_SECRET_KEY is not set. Add it to samdoctor-web/.env (see .env.example).'
		);
	}
	cached = new Stripe(key, {
		// Pin the API version so behavior is stable across SDK upgrades.
		apiVersion: '2026-05-27.dahlia',
		typescript: true
	});
	return cached;
}

/** Where Stripe Checkout redirects users after success/cancel. */
export function getReturnBaseUrl(): string {
	return env.STRIPE_RETURN_URL ?? env.ORIGIN ?? 'http://localhost:5173';
}
