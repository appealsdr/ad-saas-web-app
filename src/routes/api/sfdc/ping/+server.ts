/**
 * Salesforce JWT-flow smoke test.
 *
 *   GET /api/sfdc/ping
 *
 * Calls sfdcPing() which exchanges the JWT for an access token (cached after
 * the first hit) and lists REST resources for the configured API version.
 * Confirms: env vars are set, key signs correctly, Connected App accepts the
 * assertion, and the chosen apiVersion exists.
 *
 * Sandbox-only convenience endpoint — remove or guard behind auth before
 * shipping to production.
 */
import { json, error } from '@sveltejs/kit';
import { sfdcPing, getAccessToken, SalesforceApiError } from '$lib/server/salesforce';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		const [resources, token] = await Promise.all([sfdcPing(), getAccessToken()]);
		return json({
			ok: true,
			instanceUrl: token.instanceUrl,
			tokenIssuedAt: new Date(token.issuedAt).toISOString(),
			tokenExpiresAt: new Date(token.expiresAt).toISOString(),
			resourceCount: Object.keys(resources).length,
			sampleResources: Object.keys(resources).slice(0, 5)
		});
	} catch (e) {
		if (e instanceof SalesforceApiError) {
			throw error(502, `Salesforce API error (${e.status}): ${e.message}`);
		}
		const msg = e instanceof Error ? e.message : String(e);
		throw error(500, `Salesforce JWT flow failed: ${msg}`);
	}
};
