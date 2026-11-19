/**
 * Stripe processing-fee pass-through (isomorphic: used by the server to price the PaymentIntent and by the
 * payment screens to label the breakdown).
 *
 * POLICY (AD-1952): the client pays the Stripe fee ONLY on credit/debit CARD payments. Every other payment
 * method (ACH bank transfer, Link, Cash App, Affirm, Klarna, Afterpay, …) carries no fee — we absorb Stripe's
 * cost on those.
 *
 * For cards the fee is grossed up so that after Stripe takes its cut the base amount is received in full:
 *   total = (base + fixed) / (1 − pct)
 */
export interface FeeRule { label: string; pct: number; fixedCents: number; capCents?: number }

const NO_FEE: FeeRule = { label: 'No processing fee', pct: 0, fixedCents: 0 };

export const FEE_RULES: Record<string, FeeRule> = {
	card: { label: 'Card processing fee (2.9% + $0.30)', pct: 0.029, fixedCents: 30 },
	link: NO_FEE,
	us_bank_account: NO_FEE,
	cashapp: NO_FEE,
	affirm: NO_FEE,
	klarna: NO_FEE,
	afterpay_clearpay: NO_FEE
};
/** Used until the client picks a method (the Payment Element defaults to card for most users). */
export const DEFAULT_METHOD = 'card';
/** Any method that is not a card (including types we have not seen before) is fee-free. */
const OTHER_METHOD = 'other';

export interface FeeBreakdown { method: string; label: string; baseCents: number; feeCents: number; totalCents: number }

export function normalizeMethod(type: string | null | undefined): string {
	if (!type) return DEFAULT_METHOD;
	return FEE_RULES[type] ? type : OTHER_METHOD;
}

/** Override for the card rate, e.g. the env-configured rate from the server. */
export interface CardRate { pct: number; fixedCents: number }

export function computeFee(baseCents: number, type: string | null | undefined, cardRate?: CardRate): FeeBreakdown {
	const method = normalizeMethod(type);
	let r = FEE_RULES[method] ?? NO_FEE;
	if (cardRate && method === 'card') {
		r = { ...r, pct: cardRate.pct, fixedCents: cardRate.fixedCents, label: `${r.label.split(' (')[0]} (charged by Stripe)` };
	}
	if (baseCents <= 0 || (r.pct === 0 && r.fixedCents === 0)) return { method, label: r.label, baseCents, feeCents: 0, totalCents: baseCents };
	let total = Math.ceil((baseCents + r.fixedCents) / (1 - r.pct));
	if (r.capCents !== undefined && total - baseCents > r.capCents) total = baseCents + r.capCents;
	return { method, label: r.label, baseCents, feeCents: total - baseCents, totalCents: total };
}
