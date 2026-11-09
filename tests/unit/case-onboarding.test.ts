import { describe, it, expect } from 'vitest';
import { parseOnboardingConfig } from '../../src/lib/server/salesforce/case-onboarding';

describe('parseOnboardingConfig', () => {
	it('parses the Salesforce config JSON', () => {
		const raw =
			'[{"fieldapiname":"ASIN__c","fieldlabel":"","required":true},{"fieldapiname":"At_risk_of_suspension_due_to_ODR__c","fieldlabel":"At risk?","required":false}]';
		expect(parseOnboardingConfig(raw)).toEqual([
			{ apiName: 'ASIN__c', label: '', required: true },
			{ apiName: 'At_risk_of_suspension_due_to_ODR__c', label: 'At risk?', required: false }
		]);
	});
	it('returns [] for empty, invalid or non-array input', () => {
		for (const v of [null, undefined, '', '   ', 'not json', '{"a":1}', 42]) {
			expect(parseOnboardingConfig(v)).toEqual([]);
		}
	});
	it('drops unsafe or duplicate field names (they end up in SOQL)', () => {
		const raw = JSON.stringify([
			{ fieldapiname: 'ASIN__c', required: true },
			{ fieldapiname: 'ASIN__c', required: false },
			{ fieldapiname: 'Id FROM User--', required: true },
			{ fieldapiname: '', required: true }
		]);
		expect(parseOnboardingConfig(raw)).toEqual([{ apiName: 'ASIN__c', label: '', required: true }]);
	});
});
