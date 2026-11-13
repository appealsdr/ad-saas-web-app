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
