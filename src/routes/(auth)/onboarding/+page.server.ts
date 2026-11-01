/**
 * First-time onboarding — collects company / website / phone after a Google
 * sign-up, then creates the Salesforce Account + Contact (deferred from the
 * OAuth callback) and marks the account complete. Reached only when the (app)
 * guard sees accounts.onboarding_completed = false.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { logError, describeError } from '$lib/server/error_log';
import {
	createSalesforceAccountAndContact,
	enqueueAccountContactSync,
	findContactByEmail,
	splitFullName
} from '$lib/server/salesforce';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const [acct] = await sql<{ onboarding_completed: boolean }[]>`
		SELECT a.onboarding_completed
		FROM accounts a JOIN users u ON u.account_id = a.id
		WHERE u.id = ${locals.user.id} LIMIT 1
	`;
	// Already done (or no account) → nothing to onboard.
	if (!acct || acct.onboarding_completed) throw redirect(303, '/dashboard');

	return { name: locals.user.displayName ?? '', email: locals.user.email };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const data = await request.formData();
		const company = String(data.get('company') ?? '').trim();
		const website = String(data.get('website') ?? '').trim();
		const phone = String(data.get('phone') ?? '').trim();
		const fullName = String(data.get('name') ?? '').trim();

		if (!company) {
			return fail(400, { error: 'Company name is required.', company, website, phone, name: fullName });
		}

		const [row] = await sql<
			{ user_id: string; account_id: string; created_at: Date; sfdc_account_id: string | null }[]
		>`
			SELECT u.id AS user_id, u.account_id, a.created_at, a.sfdc_account_id
			FROM users u JOIN accounts a ON a.id = u.account_id
			WHERE u.id = ${locals.user.id} LIMIT 1
		`;
		if (!row) return fail(400, { error: 'Account not found.', company, website, phone, name: fullName });

		// Save details locally and mark onboarding complete.
		await sql`
			UPDATE accounts
			SET name = ${company}, phone = ${phone || null}, website = ${website || null},
			    onboarding_completed = true
			WHERE id = ${row.account_id}
		`;
		if (fullName) {
			await sql`UPDATE users SET display_name = ${fullName} WHERE id = ${row.user_id}`;
		}

		// Deferred Salesforce sync — now we have the company name.
		if (!row.sfdc_account_id) {
			const { firstName, lastName } = splitFullName(fullName || locals.user.displayName || company);
			const sfInput = {
				companyName: company,
				firstName,
				lastName,
				email: locals.user.email,
				phone,
				website,
				startDate: row.created_at
			};
			// Same duplicate-Contact pre-flight as registration — avoids creating
			// an orphaned Account when Salesforce would reject the Contact via
			// its duplicate rule. The user is already signed in here, so we
			// can't ask them to "log in instead" — just skip and queue for
			// manual reconciliation (existing best-effort pattern below).
			const existingContact = await findContactByEmail(locals.user.email);
			const sf = existingContact
				? {
						ok: false as const,
						error: `A Salesforce contact already exists for ${locals.user.email} (Contact ${existingContact.id}). Needs manual reconciliation.`
					}
				: await createSalesforceAccountAndContact(sfInput, {
						userId: row.user_id,
						accountId: row.account_id
					});
			if (sf.ok) {
				try {
					await sql.begin(async (sql) => {
						await sql`UPDATE accounts SET sfdc_account_id = ${sf.sfdcAccountId} WHERE id = ${row.account_id}`;
						await sql`UPDATE users SET sfdc_contact_id = ${sf.sfdcContactId}, sfdc_account_id = ${sf.sfdcAccountId} WHERE id = ${row.user_id}`;
						await sql`UPDATE account_contacts SET sfdc_contact_id = ${sf.sfdcContactId} WHERE account_id = ${row.account_id} AND user_id = ${row.user_id}`;
					});
				} catch (e) {
					const desc = describeError(e);
					await logError({
						source: 'onboarding',
						operation: 'persist_sfdc_ids',
						userId: row.user_id,
						accountId: row.account_id,
						errorMessage: desc.errorMessage,
						stack: desc.stack
					});
				}
			} else {
				try {
					await enqueueAccountContactSync({
						accountRowId: row.account_id,
						userRowId: row.user_id,
						input: sfInput,
						failureReason: sf.error
					});
				} catch {
					/* best-effort */
				}
			}
		}

		throw redirect(303, '/dashboard');
	}
};
