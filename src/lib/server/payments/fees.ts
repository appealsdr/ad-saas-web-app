/**
 * Stripe processing fee pass-through.
 *
 * Stripe charges us a fee on every card payment; we pass it on to the client so we don't absorb it.
 * The fee is GROSSED UP so that after Stripe takes its cut we still net the base price:
 *   total = (base + fixed) / (1 - percent)      fee = total - base
 *
 * Configure with STRIPE_FEE_PERCENT (default 2.9) and STRIPE_FEE_FIXED_CENTS (default 30);
 * set STRIPE_FEE_PERCENT=0 and STRIPE_FEE_FIXED_CENTS=0 to turn the surcharge off.
 * Pure + env-driven so server load functions and PaymentIntent creation always agree.
 */
import { env } from '$env/dynamic/private';

function num(v: string | undefined, fallback: number): number {
	const n = v === undefined || v === '' ? NaN : Number(v);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Fee in cents to add on top of `baseCents` so we net `baseCents` after Stripe's fee. */
export function stripeFeeCents(baseCents: number): number {
	const pct = num(env.STRIPE_FEE_PERCENT, 2.9) / 100;
	const fixed = num(env.STRIPE_FEE_FIXED_CENTS, 30);
	if (baseCents <= 0 || (pct === 0 && fixed === 0) || pct >= 1) return 0;
	return Math.round((baseCents + fixed) / (1 - pct)) - baseCents;
}

/** Fee in currency units (dollars), rounded to cents. */
export function stripeFee(base: number): number {
	return stripeFeeCents(Math.round(base * 100)) / 100;
}
