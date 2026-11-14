import { describe, expect, it } from 'vitest';
import { stripeFeeCents, stripeFee } from '$lib/server/payments/fees';

describe('Stripe fee pass-through', () => {
	it('grosses up so we net the base price after 2.9% + 30c', () => {
		const base = 10000;
		const fee = stripeFeeCents(base);
		const total = base + fee;
		const stripeTakes = Math.round(total * 0.029 + 30);
		expect(Math.abs(total - stripeTakes - base)).toBeLessThanOrEqual(1);
	});
	it('is zero for a zero base and exposes dollars', () => {
		expect(stripeFeeCents(0)).toBe(0);
		expect(stripeFee(300)).toBe(9.27);
	});
});

import { computeFee } from '$lib/payments/fees';
import { feeForMethod } from '$lib/server/payments/fees';

describe('per-method Stripe fee', () => {
	it('card matches the env-driven pass-through fee', () => {
		expect(feeForMethod(10000, 'card').feeCents).toBe(stripeFeeCents(10000));
	});
	it('ACH is 0.8% grossed up and capped at $5', () => {
		expect(computeFee(10000, 'us_bank_account').feeCents).toBe(81);
		expect(computeFee(100000, 'us_bank_account').feeCents).toBe(500);
	});
	it('unknown methods fall back to card; total = base + fee', () => {
		const f = computeFee(5000, 'something_new');
		expect(f.method).toBe('card');
		expect(f.totalCents).toBe(5000 + f.feeCents);
	});
});
