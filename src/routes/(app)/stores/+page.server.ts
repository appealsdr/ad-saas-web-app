/**
 * Stores list + Create flow.
 *
 * Load: returns all stores for the user's account.
 * Action `create_store`:
 *   1. Validate (name required).
 *   2. INSERT local stores row — marketplaces/seller_id are left unset; they're
 *      filled in from Amazon (SP-API marketplaceParticipations) once the
 *      seller connects, not collected from the user here (see
 *      /auth/spapi/callback).
 *   3. Best-effort POST to Salesforce Store__c; on success store sfdc_store_id.
 *   4. Return the new store id — UI navigates to /stores/<id>/connect to kick off SP-API.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import {
	createSalesforceStore,
	listCasesForStores,
	listRequiredFilesForStores
} from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';
import { canManageAccountContacts } from '$lib/server/auth/roles';
import { getDefaultStorePointOfContactId } from '$lib/server/account/contacts';

interface StoreRow {
	id: string;
	name: string;
	marketplaces: string | null;
	seller_id: string | null;
	country: string | null;
	sfdc_store_id: string | null;
	spapi_status: string;
	spapi_connected_at: Date | null;
	spapi_last_error: string | null;
	point_of_contact_id: string | null;
	created_at: Date;
	plan_kind: string | null;
	plan_end_date: Date | null;
	plan_cancelling: boolean;
	plan_name: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const [user] = await sql<{ account_id: string | null }[]>`
		SELECT account_id FROM users WHERE id = ${locals.user.id} LIMIT 1
	`;
	if (!user?.account_id) return { stores: [] };

	const stores = await sql<StoreRow[]>`
		SELECT s.id, s.name, s.marketplaces, s.seller_id, s.country,
		       s.sfdc_store_id, s.spapi_status, s.spapi_connected_at, s.spapi_last_error,
		       s.point_of_contact_id, s.created_at,
		       sc.kind AS plan_kind, sc.end_date AS plan_end_date, (sc.cancel_requested_at IS NOT NULL) AS plan_cancelling,
		       scli.product_name AS plan_name
		FROM stores s
		LEFT JOIN accounts acct ON acct.id = s.account_id
		LEFT JOIN service_contracts asub ON asub.id = acct.active_subscription_contract_id AND asub.status = 'active'
		LEFT JOIN service_contracts sc ON sc.id = COALESCE(asub.id, s.active_service_contract_id)
		LEFT JOIN LATERAL (
			SELECT product_name FROM service_contract_line_items
			WHERE service_contract_id = sc.id
			ORDER BY created_at ASC LIMIT 1
		) scli ON TRUE
		WHERE s.account_id = ${user.account_id}
		ORDER BY s.created_at DESC
	`;

	const sfdcStoreIds = stores.map((s) => s.sfdc_store_id).filter((id): id is string => !!id);
	const [casesResult, filesResult] = await Promise.all([
		listCasesForStores(sfdcStoreIds),
		listRequiredFilesForStores(sfdcStoreIds)
	]);
	const openCasesByStore = new Map<string, number>();
	if (casesResult.ok) {
		for (const c of casesResult.cases) {
			if (!c.sfdcStoreId) continue;
			if (/closed|resolved/i.test(c.Status)) continue;
			openCasesByStore.set(c.sfdcStoreId, (openCasesByStore.get(c.sfdcStoreId) ?? 0) + 1);
		}
	}
	const docsByStore = new Map<string, { uploaded: number; total: number }>();
	if (filesResult.ok) {
		for (const f of filesResult.files) {
			const entry = docsByStore.get(f.parentId) ?? { uploaded: 0, total: 0 };
			entry.total += 1;
			if (f.uploaded) entry.uploaded += 1;
			docsByStore.set(f.parentId, entry);
		}
	}

	return {
		stores: stores.map((s) => {
			const docs = s.sfdc_store_id ? docsByStore.get(s.sfdc_store_id) : undefined;
			return {
				id: s.id,
				name: s.name,
				marketplaces: s.marketplaces,
				sellerId: s.seller_id,
				country: s.country,
				sfdcStoreId: s.sfdc_store_id,
				spapiStatus: s.spapi_status as 'connected' | 'disconnected' | 'error',
				spapiConnectedAt: s.spapi_connected_at?.toISOString() ?? null,
				spapiLastError: s.spapi_last_error,
				createdAt: s.created_at.toISOString(),
				openIssues: s.sfdc_store_id ? (openCasesByStore.get(s.sfdc_store_id) ?? 0) : 0,
				plan: s.plan_kind
					? {
							kind: s.plan_kind as 'service' | 'subscription',
							name: s.plan_name ?? 'Active plan',
							endDate: s.plan_end_date?.toISOString().slice(0, 10) ?? null,
							cancelling: s.plan_cancelling
						}
					: null,
				documents: docs ?? { uploaded: 0, total: 0 },
				setup: {
					storeAdded: true,
					contactSet: !!s.point_of_contact_id,
					amazonConnected: s.spapi_status === 'connected',
					planChosen: !!s.plan_kind
				}
			};
		})
	};
};

export const actions: Actions = {
	create_store: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const data = await request.formData();
		const name               = String(data.get('name') ?? '').trim();
		const sellerPrimaryEmail = String(data.get('sellerPrimaryEmail') ?? '').trim();
		const storeEmail         = String(data.get('storeEmail') ?? '').trim();
		const businessName       = String(data.get('businessName') ?? '').trim();
		const country            = String(data.get('country') ?? '').trim();
		const description        = String(data.get('description') ?? '').trim();

		// marketplaces + Seller ID are NOT collected here anymore — they're
		// filled in automatically from the SP-API marketplaceParticipations
		// call once the seller connects their Amazon account (see
		// /auth/spapi/callback), which is the source of truth Amazon confirms
		// rather than something the user could mistype.
		const echo = {
			name, sellerPrimaryEmail,
			storeEmail, businessName, country, description
		};

		if (!name) return fail(400, { ...echo, error: 'Store name is required.' });

		const [user] = await sql<{ account_id: string | null; sfdc_account_id: string | null }[]>`
			SELECT u.account_id, a.sfdc_account_id
			FROM users u
			LEFT JOIN accounts a ON a.id = u.account_id
			WHERE u.id = ${locals.user.id}
			LIMIT 1
		`;
		if (!user?.account_id) {
			return fail(409, { ...echo, error: 'Your account is not linked yet.' });
		}

		// 1. Insert local row. marketplaces/seller_id are left null here — they're
		// filled in by /auth/spapi/callback once the seller connects Amazon.
		let storeId: string;
		try {
			const [row] = await sql<{ id: string }[]>`
				INSERT INTO stores (
					account_id, created_by, name,
					seller_primary_email, store_email, business_name, country, description
				)
				VALUES (
					${user.account_id}, ${locals.user.id}, ${name},
					${sellerPrimaryEmail || null}, ${storeEmail || null},
					${businessName || null}, ${country || null}, ${description || null}
				)
				RETURNING id
			`;
			storeId = row.id;
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'stores.create_store',
				operation: 'insert_local',
				userId: locals.user.id,
				accountId: user.account_id,
				errorMessage: desc.errorMessage,
				stack: desc.stack
			});
			return fail(500, { ...echo, error: 'Could not create the store right now.' });
		}

		const defaultPocId = await getDefaultStorePointOfContactId(user.account_id);
		if (defaultPocId) {
			await sql`
				UPDATE stores SET point_of_contact_id = ${defaultPocId}
				WHERE id = ${storeId}
			`;
		}

		// 2. Best-effort Salesforce sync
		const sfResult = await createSalesforceStore(
			{
				name,
				sfdcAccountId: user.sfdc_account_id,
				sellerPrimaryEmail: sellerPrimaryEmail || null,
				storeEmail: storeEmail || null,
				businessName: businessName || null,
				country: country || null,
				description: description || null
			},
			{ userId: locals.user.id, accountId: user.account_id, localStoreId: storeId }
		);
		if (sfResult.ok) {
			try {
				await sql`UPDATE stores SET sfdc_store_id = ${sfResult.sfdcStoreId} WHERE id = ${storeId}`;
			} catch (e) {
				// SF created, local link failed; non-fatal.
				const desc = describeError(e);
				await logError({
					source: 'stores.create_store',
					operation: 'persist_sfdc_id',
					userId: locals.user.id,
					accountId: user.account_id,
					errorMessage: desc.errorMessage,
					stack: desc.stack,
					context: { sfdcStoreId: sfResult.sfdcStoreId, storeId }
				});
			}
		}

		// Redirect into the SP-API connect flow — that's the user's next step.
		throw redirect(303, `/stores/${storeId}?step=connect`);
	}
};
