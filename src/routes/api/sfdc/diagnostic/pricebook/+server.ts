/**
 * GET /api/sfdc/diagnostic/pricebook?name=SERVICE
 *
 * Walks through progressively narrower filters to pinpoint why /services is
 * empty. Returns counts at each step + sample rows.
 *
 * Platform staff only (`data.query`). GET is read-only; clearing the in-process
 * catalog cache is a separate POST so a read never mutates state.
 */
import { json, error } from '@sveltejs/kit';
import { requireStaff } from '$lib/server/admin/guard';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { sfdcQuery, getAccessToken, SalesforceApiError } from '$lib/server/salesforce';
import { invalidatePricebookCache } from '$lib/server/salesforce/pricebook';

interface CountRow { ct: number }
interface Pricebook2Row { Id: string; Name: string; IsActive: boolean; IsStandard: boolean }
interface SampleRow {
	Id: string;
	UnitPrice: number;
	IsActive: boolean;
	Product2: {
		Id: string;
		Name: string;
		IsActive: boolean;
		Category__c: string | null;
	} | null;
}

export const POST: RequestHandler = async (event) => {
	requireStaff(event, 'data.query');
	invalidatePricebookCache();
	return json({ ok: true, cleared: 'pricebook catalog cache' });
};

export const GET: RequestHandler = async (event) => {
	const { url } = event;
	requireStaff(event, 'data.query');

	const name = (url.searchParams.get('name') ?? env.SFDC_PRICE_SERVICE ?? 'SERVICE').trim();
	const escaped = name.replace(/'/g, "''");

	try {
		const token = await getAccessToken();

		// 1. Does the pricebook exist?
		const pricebooks = await sfdcQuery<Pricebook2Row>(
			`SELECT Id, Name, IsActive, IsStandard FROM Pricebook2 WHERE Name = '${escaped}'`
		);

		if (pricebooks.records.length === 0) {
			// Maybe a name mismatch — list candidates
			const candidates = await sfdcQuery<Pricebook2Row>(
				`SELECT Id, Name, IsActive, IsStandard FROM Pricebook2 ORDER BY Name LIMIT 20`
			);
			return json({
				ok: false,
				step: 'pricebook_not_found',
				lookingFor: name,
				instanceUrl: token.instanceUrl,
				envVar: env.SFDC_PRICE_SERVICE ?? '(unset — defaulted to SERVICE)',
				hint: `No Pricebook2 found with Name = '${name}'. Candidates below — pick the right one and set SFDC_PRICE_SERVICE in .env.`,
				availablePricebooks: candidates.records
			});
		}

		const pb = pricebooks.records[0];

		// 2. Step counts on PricebookEntry
		const [allEntries] = (await sfdcQuery<CountRow>(
			`SELECT count(Id) ct FROM PricebookEntry WHERE Pricebook2Id = '${pb.Id}'`
		)).records;

		const [activeEntries] = (await sfdcQuery<CountRow>(
			`SELECT count(Id) ct FROM PricebookEntry WHERE Pricebook2Id = '${pb.Id}' AND IsActive = true`
		)).records;

		const [activeWithActiveProduct] = (await sfdcQuery<CountRow>(
			`SELECT count(Id) ct FROM PricebookEntry
			 WHERE Pricebook2Id = '${pb.Id}' AND IsActive = true AND Product2.IsActive = true`
		)).records;

		// 3. Pull a few sample rows so we can see what's actually there
		const samples = await sfdcQuery<SampleRow>(
			`SELECT Id, UnitPrice, IsActive,
			        Product2.Id, Product2.Name, Product2.IsActive, Product2.Category__c
			 FROM PricebookEntry
			 WHERE Pricebook2Id = '${pb.Id}'
			 LIMIT 5`
		);

		let hint = '';
		if (allEntries.ct === 0) {
			hint = `Pricebook "${name}" exists but has zero PricebookEntry rows. Add products + entries in Setup → Products → Price Books → ${name}.`;
		} else if (activeEntries.ct === 0) {
			hint = `Pricebook has ${allEntries.ct} entries but none are IsActive = true. Activate them, or relax the IsActive filter.`;
		} else if (activeWithActiveProduct.ct === 0) {
			hint = `${activeEntries.ct} active entries exist, but their Product2 rows are IsActive = false. Activate the Products themselves.`;
		} else {
			hint = `${activeWithActiveProduct.ct} qualifying rows — /services should display them now (cache was just cleared).`;
		}

		return json({
			ok: true,
			instanceUrl: token.instanceUrl,
			lookingFor: name,
			envVar: env.SFDC_PRICE_SERVICE ?? '(unset — defaulted to SERVICE)',
			pricebook: pb,
			counts: {
				total: allEntries.ct,
				active: activeEntries.ct,
				activeWithActiveProduct: activeWithActiveProduct.ct
			},
			sampleEntries: samples.records,
			hint,
			cacheCleared: true
		});
	} catch (e) {
		if (e instanceof SalesforceApiError) {
			throw error(502, `Salesforce error: [${e.errorCode ?? e.status}] ${e.message}`);
		}
		throw error(500, e instanceof Error ? e.message : String(e));
	}
};
