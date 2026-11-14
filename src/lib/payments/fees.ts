/**
 * Stripe processing-fee pass-through (isomorphic: used by the server to price the PaymentIntent and by the
 * payment screens to label the breakdown).
 *
 * The client pays the Stripe fee on top of the base amount, grossed up so that after Stripe takes its cut the
 * base amount is received in full:  total = (base + fixed) / (1 − pct),  or  base + cap  when the cap applies.
 * Rates are Stripe's standard US pricing; adjust here if the Stripe contract changes.
 */
export interface FeeRule { label: string; pct: number; fixedCents: number; capCents?: number }

export const FEE_RULES: Record<string, FeeRule> = {
	card: { label: 'Card processing fee (2.9% + $0.30)', pct: 0.029, fixedCents: 30 },
	link: { label: 'Link processing fee (2.9% + $0.30)', pct: 0.029, fixedCents: 30 },
	us_bank_account: { label: 'Bank transfer (ACH) fee (0.8%, max $5.00)', pct: 0.008, fixedCents: 0, capCents: 500 },
	cashapp: { label: 'Cash App Pay fee (2.6% + $0.10)', pct: 0.026, fixedCents: 10 },
	affirm: { label: 'Affirm fee (6% + $0.30)', pct: 0.06, fixedCents: 30 },
	klarna: { label: 'Klarna fee (2.9% + $0.30)', pct: 0.029, fixedCents: 30 },
	afterpay_clearpay: { label: 'Afterpay fee (6% + $0.30)', pct: 0.06, fixedCents: 30 }
};
/** Used until the client picks a method (the Payment Element defaults to card for most users). */
export const DEFAULT_METHOD = 'card';

export interface FeeBreakdown { method: string; label: string; baseCents: number; feeCents: number; totalCents: number }

export function normalizeMethod(type: string | null | undefined): string {
	return type && FEE_RULES[type] ? type : DEFAULT_METHOD;
}

/** Override for the card-like methods (card, Link), e.g. the env-configured rate from the server. */
export interface CardRate { pct: number; fixedCents: number }

export function computeFee(baseCents: number, type: string | null | undefined, cardRate?: CardRate): FeeBreakdown {
	const method = normalizeMethod(type);
	let r = FEE_RULES[method];
	if (cardRate && (method === 'card' || method === 'link')) {
		r = { ...r, pct: cardRate.pct, fixedCents: cardRate.fixedCents, label: `${r.label.split(' (')[0]} (charged by Stripe)` };
	}
	if (baseCents <= 0 || (r.pct === 0 && r.fixedCents === 0)) return { method, label: r.label, baseCents, feeCents: 0, totalCents: baseCents };
	let total = Math.ceil((baseCents + r.fixedCents) / (1 - r.pct));
	if (r.capCents !== undefined && total - baseCents > r.capCents) total = baseCents + r.capCents;
	return { method, label: r.label, baseCents, feeCents: total - baseCents, totalCents: total };
}
