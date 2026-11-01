/**
 * DELETE /api/admin/delete-account?email=...  OR  ?sfdc_account_id=...
 *
 * Ops-only, irreversible: deletes an Account and everything under it from
 * OUR database (not Salesforce) — matched Contact/user(s), stores, and
 * anything that cascades from those (service_contracts, subscriptions,
 * case/store documents, spapi_oauth_states, ai_chat_messages, etc. — see
 * db/migrations for the full ON DELETE CASCADE graph).
 *
 * Lookup:
 *   ?email=...           — finds the user with this email, deletes their account
 *   ?sfdc_account_id=... — finds the account with this Salesforce Account Id
 * Exactly one must be given.
 *
 * Guarded by the same shared secret as issue-api-key / lookup-user
 * (ADMIN_OPS_SECRET). Does not touch Salesforce — delete the Account/Contact
 * there separately if needed.
 */
import { json, error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db';

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export const DELETE: RequestHandler = async ({ request, url }) => {
	const configuredSecret = env.ADMIN_OPS_SECRET;
	if (!configuredSecret) throw error(503, 'ADMIN_OPS_SECRET is not configured.');

	const providedSecret = request.headers.get('x-admin-secret') ?? '';
	if (!providedSecret || !safeEqual(providedSecret, configuredSecret)) {
		throw error(401, 'Invalid or missing x-admin-secret header.');
	}

	const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
	const sfdcAccountId = (url.searchParams.get('sfdc_account_id') ?? '').trim();

	if (!email && !sfdcAccountId) {
		throw error(400, 'Provide either ?email=... or ?sfdc_account_id=...');
	}
	if (email && sfdcAccountId) {
		throw error(400, 'Provide only one of ?email=... or ?sfdc_account_id=..., not both.');
	}

	let accountId: string;
	let accountSfdcId: string | null;
	if (email) {
		const rows = await sql<{ account_id: string; sfdc_account_id: string | null }[]>`
			SELECT u.account_id, a.sfdc_account_id
			FROM users u
			JOIN accounts a ON a.id = u.account_id
			WHERE u.email = ${email}
			LIMIT 1
		`;
		if (!rows[0]) throw error(404, `No user found with email ${email}.`);
		accountId = rows[0].account_id;
		accountSfdcId = rows[0].sfdc_account_id;
	} else {
		const rows = await sql<{ id: string; sfdc_account_id: string | null }[]>`
			SELECT id, sfdc_account_id FROM accounts WHERE sfdc_account_id = ${sfdcAccountId} LIMIT 1
		`;
		if (!rows[0]) throw error(404, `No account found with sfdc_account_id ${sfdcAccountId}.`);
		accountId = rows[0].id;
		accountSfdcId = rows[0].sfdc_account_id;
	}

	const [deletedAccount, deletedUsers, deletedStores] = await sql.begin(async (tx) => {
		// Fetch what's about to go, for the response — accounts/stores cascade
		// on delete, so read before deleting.
		const usersToDelete = await tx<{ id: string; email: string; sfdc_contact_id: string | null }[]>`
			SELECT id, email, sfdc_contact_id FROM users WHERE account_id = ${accountId}
		`;
		const storesToDelete = await tx<{ id: string; name: string; sfdc_store_id: string | null }[]>`
			SELECT id, name, sfdc_store_id FROM stores WHERE account_id = ${accountId}
		`;

		// Platform staff are never deleted as a side effect of removing a customer
		// account (platform_staff.user_id is ON DELETE RESTRICT). Revoke staff first.
		const staff = await tx<{ email: string }[]>`
			SELECT u.email FROM users u JOIN platform_staff ps ON ps.user_id = u.id
			WHERE u.account_id = ${accountId}
		`;
		if (staff.length) {
			throw error(409, `Account contains platform staff (${staff.map((s) => s.email).join(', ')}); remove their staff membership first.`);
		}

		// users.account_id is ON DELETE SET NULL (not cascade) — delete them
		// explicitly so no orphaned users are left behind.
		await tx`DELETE FROM users WHERE account_id = ${accountId}`;

		const [account] = await tx<{ id: string; name: string; sfdc_account_id: string | null }[]>`
			DELETE FROM accounts WHERE id = ${accountId}
			RETURNING id, name, sfdc_account_id
		`;

		return [account, usersToDelete, storesToDelete];
	});

	return json({
		deleted: {
			account: deletedAccount ?? { id: accountId, sfdc_account_id: accountSfdcId },
			users: deletedUsers,
			stores: deletedStores
		},
		note: 'Deleted from the app database only — Salesforce records (if any) are untouched.'
	});
};
