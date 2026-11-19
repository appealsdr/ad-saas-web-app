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
	it('only card carries a fee; every other method is free (company absorbs it)', () => {
		for (const m of ['us_bank_account', 'link', 'cashapp', 'affirm', 'klarna', 'afterpay_clearpay', 'something_new']) {
			const f = computeFee(100000, m);
			expect(f.feeCents, m).toBe(0);
			expect(f.totalCents, m).toBe(100000);
		}
		expect(computeFee(10000, 'card').feeCents).toBeGreaterThan(0);
	});
	it('no method selected yet defaults to the card fee; total = base + fee', () => {
		const f = computeFee(5000, null);
		expect(f.method).toBe('card');
		expect(f.totalCents).toBe(5000 + f.feeCents);
		expect(feeForMethod(5000, 'us_bank_account').feeCents).toBe(0);
	});
});
