/**
 * Load the user's local Account + their linked Salesforce Account & Contact.
 *
 *  - Local row data comes from Postgres (always available).
 *  - SF records are fetched in PARALLEL via REST. Each can fail independently
 *    (e.g. Account exists, Contact doesn't yet) — the UI handles partial state.
 *
 * The `edit_contact` action PATCHes the Salesforce Contact, then updates the
 * local users.display_name to keep the two in sync.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import {
	fetchSalesforceAccount,
	fetchSalesforceContact,
	updateSalesforceContact,
	updateSalesforceAccount,
	createSalesforceAccountAndContact,
	createSalesforceContactForAccount,
	splitFullName
} from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';
import { listSubscriptions } from '$lib/server/salesforce';
import { getAccountSubscription } from '$lib/server/subscription';
import { canManageAccountContacts } from '$lib/server/auth/roles';
import {
	createAccountTeamUser,
	syncTeamUserToSalesforce,
	ensureOwnerAccountContact
} from '$lib/server/account/contacts';

interface LocalAccountRow {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	website: string | null;
	billing_street: string | null;
	billing_city: string | null;
	billing_state: string | null;
	billing_postal_code: string | null;
	billing_country: string | null;
	sfdc_account_id: string | null;
	created_at: Date;
	updated_at: Date;
}

interface LocalUserRow {
	id: string;
	email: string;
	display_name: string | null;
	avatar_url: string | null;
	sfdc_contact_id: string | null;
	sfdc_account_id: string | null;
	account_id: string | null;
	role: string;
	created_at: Date;
	last_login_at: Date | null;
}

interface AccountContactRow {
	id: string;
	account_id: string;
	user_id: string | null;
	first_name: string | null;
	last_name: string;
	email: string;
	phone: string | null;
	title: string | null;
	is_point_of_contact: boolean;
	sfdc_contact_id: string | null;
	invite_sent_at: Date | null;
	invite_accepted_at: Date | null;
	created_at: Date;
	updated_at: Date;
	user_role: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const [user] = await sql<LocalUserRow[]>`
		SELECT id, email, display_name, avatar_url,
		       sfdc_contact_id, sfdc_account_id, account_id,
		       role, created_at, last_login_at
		FROM users WHERE id = ${locals.user.id} LIMIT 1
	`;
	if (!user) throw redirect(303, '/login');

	if (user.account_id) {
		await ensureOwnerAccountContact(user.account_id, user.id);
	}

	const localAccount = user.account_id
		? (
				await sql<LocalAccountRow[]>`
					SELECT id, name, email, phone, website,
					       billing_street, billing_city, billing_state,
					       billing_postal_code, billing_country,
					       sfdc_account_id, created_at, updated_at
					FROM accounts WHERE id = ${user.account_id} LIMIT 1
				`
			)[0] ?? null
		: null;

	const ctx = { userId: user.id, accountId: user.account_id ?? undefined };
	const sfdcAccountId = user.sfdc_account_id ?? localAccount?.sfdc_account_id ?? null;
	const sfdcContactId = user.sfdc_contact_id ?? null;

	const [googleLink] = await sql<{ provider_uid: string }[]>`
		SELECT provider_uid FROM oauth_accounts
		WHERE user_id = ${user.id} AND provider = 'google' LIMIT 1
	`;

	// Fetch in parallel — each side can succeed or fail independently.
	const subscription = user.account_id ? await getAccountSubscription(user.account_id) : null;

	const [accountResult, contactResult, contactRows] = await Promise.all([
		sfdcAccountId ? fetchSalesforceAccount(sfdcAccountId, ctx) : Promise.resolve(null),
		sfdcContactId ? fetchSalesforceContact(sfdcContactId, ctx) : Promise.resolve(null),
		user.account_id
			? sql<AccountContactRow[]>`
				SELECT ac.id, ac.account_id, ac.user_id, ac.first_name, ac.last_name, ac.email,
				       ac.phone, ac.title, ac.is_point_of_contact, ac.sfdc_contact_id,
				       ac.invite_sent_at, ac.invite_accepted_at, ac.created_at, ac.updated_at,
				       u.role AS user_role
				FROM account_contacts ac
				LEFT JOIN users u ON u.id = ac.user_id
				WHERE ac.account_id = ${user.account_id}
				ORDER BY ac.is_point_of_contact DESC, ac.last_name, ac.first_name
			`
			: Promise.resolve([] as AccountContactRow[])
	]);

	const [categories, [storeCount]] = await Promise.all([
		listSubscriptions().catch(() => []),
		user.account_id
			? sql<{ stores: number }[]>`SELECT count(*)::int AS stores FROM stores WHERE account_id = ${user.account_id}`
			: Promise.resolve([{ stores: 0 }])
	]);

	return {
		plans: {
			categories,
			storeCount: storeCount.stores,
			activePlanEntryId: subscription?.pricebookEntryId ?? null,
			activePlanName: subscription?.planName ?? null,
			activePlanEndDate: subscription?.endDate?.toISOString().slice(0, 10) ?? null,
			activePlanCancelling: subscription?.cancelling ?? false,
			activeStripeSubscriptionId: subscription?.stripeSubscriptionId ?? null
		},
		localUser: {
			id: user.id,
			email: user.email,
			displayName: user.display_name,
			avatarUrl: user.avatar_url,
			createdAt: user.created_at.toISOString(),
			lastLoginAt: user.last_login_at?.toISOString() ?? null
		},
		localAccount: localAccount
			? {
					id: localAccount.id,
					name: localAccount.name,
					email: localAccount.email,
					phone: localAccount.phone,
					website: localAccount.website,
					billingStreet: localAccount.billing_street,
					billingCity: localAccount.billing_city,
					billingState: localAccount.billing_state,
					billingPostalCode: localAccount.billing_postal_code,
					billingCountry: localAccount.billing_country,
					createdAt: localAccount.created_at.toISOString(),
					updatedAt: localAccount.updated_at.toISOString()
				}
			: null,
		sfdcIds: {
			accountId: sfdcAccountId,
			contactId: sfdcContactId
		},
		account:
			accountResult && accountResult.ok
				? accountResult.record
				: null,
		accountError:
			accountResult && !accountResult.ok
				? { message: accountResult.error, notFound: accountResult.notFound ?? false }
				: null,
		contact:
			contactResult && contactResult.ok
				? contactResult.record
				: null,
		contactError:
			contactResult && !contactResult.ok
				? { message: contactResult.error, notFound: contactResult.notFound ?? false }
				: null,
		subscription: subscription
			? {
					planName: subscription.planName,
					price: subscription.price,
					renews: subscription.endDate.toISOString(),
					cancelling: subscription.cancelling
				}
			: null,
		userRole: user.role as 'owner' | 'admin' | 'member',
		googleLinked: !!googleLink,
		accountContacts: contactRows.map((r) => ({
			id: r.id,
			accountId: r.account_id,
			userId: r.user_id ?? undefined,
			firstName: r.first_name ?? undefined,
			lastName: r.last_name,
			email: r.email,
			phone: r.phone ?? undefined,
			title: r.title ?? undefined,
			isPointOfContact: r.is_point_of_contact,
			sfdcContactId: r.sfdc_contact_id ?? undefined,
			inviteSentAt: r.invite_sent_at?.toISOString() ?? undefined,
			inviteAcceptedAt: r.invite_accepted_at?.toISOString() ?? undefined,
			userRole: (r.user_role as 'owner' | 'admin' | 'member' | undefined) ?? undefined,
			createdAt: r.created_at.toISOString(),
			updatedAt: r.updated_at.toISOString()
		}))
	};
};

export const actions: Actions = {
	/**
	 * Retry creating the Salesforce Account + Contact for this user/account
	 * when one or both sides never synced (e.g. the earlier sign-up attempt
	 * hit a Salesforce auth error). Re-reads current state — never trust
	 * client input — and only creates whichever side is still missing.
	 */
	sync: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const userId = locals.user.id;

		const [user] = await sql<{
			email: string;
			display_name: string | null;
			sfdc_contact_id: string | null;
			sfdc_account_id: string | null;
			account_id: string | null;
		}[]>`
			SELECT email, display_name, sfdc_contact_id, sfdc_account_id, account_id
			FROM users WHERE id = ${userId} LIMIT 1
		`;
		if (!user?.account_id) {
			return fail(409, { error: 'No account linked to your user.' });
		}

		const [account] = await sql<{
			name: string;
			phone: string | null;
			website: string | null;
			sfdc_account_id: string | null;
			created_at: Date;
		}[]>`
			SELECT name, phone, website, sfdc_account_id, created_at
			FROM accounts WHERE id = ${user.account_id} LIMIT 1
		`;
		if (!account) {
			return fail(409, { error: 'No account linked to your user.' });
		}

		const sfdcAccountId = user.sfdc_account_id ?? account.sfdc_account_id ?? null;
		const sfdcContactId = user.sfdc_contact_id ?? null;

		if (sfdcAccountId && sfdcContactId) {
			return { success: 'Already synced to Salesforce.' };
		}

		const { firstName, lastName } = splitFullName(user.display_name ?? user.email);
		const ctx = { userId, accountId: user.account_id };

		if (!sfdcAccountId) {
			const result = await createSalesforceAccountAndContact(
				{
					companyName: account.name,
					firstName,
					lastName,
					email: user.email,
					phone: account.phone ?? '',
					website: account.website ?? '',
					startDate: account.created_at
				},
				ctx
			);
			if (!result.ok) {
				return fail(502, { error: `Salesforce sync failed: ${result.error}` });
			}
			await sql.begin(async (tx) => {
				await tx`UPDATE accounts SET sfdc_account_id = ${result.sfdcAccountId} WHERE id = ${user.account_id}`;
				await tx`
					UPDATE users
					SET sfdc_contact_id = ${result.sfdcContactId}, sfdc_account_id = ${result.sfdcAccountId}
					WHERE id = ${userId}
				`;
			});
			return { success: 'Account and contact created in Salesforce.' };
		}

		// Account side already linked — only the Contact is missing.
		const result = await createSalesforceContactForAccount(
			{
				sfdcAccountId,
				firstName,
				lastName,
				email: user.email,
				localUserId: userId
			},
			ctx
		);
		if (!result.ok) {
			return fail(502, { error: `Salesforce sync failed: ${result.error}` });
		}
		await sql`
			UPDATE users
			SET sfdc_contact_id = ${result.sfdcContactId}, sfdc_account_id = ${sfdcAccountId}
			WHERE id = ${userId}
		`;
		return { success: 'Contact created in Salesforce.' };
	},

	/**
	 * Remove the linked Google identity. Blocked if it's the user's only way
	 * to sign in (no password set) — they'd otherwise lock themselves out.
	 */
	unlink_google: async ({ locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const [user] = await sql<{ password_hash: string | null }[]>`
			SELECT password_hash FROM users WHERE id = ${locals.user.id} LIMIT 1
		`;
		if (!user?.password_hash) {
			return fail(409, {
				error: 'Set a password first — Google is currently your only way to sign in.'
			});
		}

		await sql`
			DELETE FROM oauth_accounts WHERE user_id = ${locals.user.id} AND provider = 'google'
		`;
		return { success: 'Google account disconnected.' };
	},

	edit_contact: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const data = await request.formData();
		const firstName = String(data.get('firstName') ?? '').trim();
		const lastName = String(data.get('lastName') ?? '').trim();
		const phone = String(data.get('phone') ?? '').trim();

		const echo = { firstName, lastName, phone };

		if (!lastName) {
			return fail(400, { ...echo, error: 'Last name is required by Salesforce.' });
		}

		// Re-read the user's Contact ID — never trust client-submitted IDs.
		const [user] = await sql<{ sfdc_contact_id: string | null; account_id: string | null }[]>`
			SELECT sfdc_contact_id, account_id FROM users WHERE id = ${locals.user.id} LIMIT 1
		`;
		if (!user?.sfdc_contact_id) {
			return fail(409, {
				...echo,
				error: 'Your Salesforce Contact is not linked yet. Try again once sync completes.'
			});
		}

		const patch = {
			FirstName: firstName || null,
			LastName: lastName,
			Phone: phone || null
		};

		const result = await updateSalesforceContact(user.sfdc_contact_id, patch, {
			userId: locals.user.id,
			accountId: user.account_id ?? undefined
		});

		if (!result.ok) {
			return fail(502, {
				...echo,
				error: `Salesforce rejected the update: ${result.error}`
			});
		}

		// Mirror to local users row: display_name = "First Last" (or "Last" alone)
		const displayName = firstName ? `${firstName} ${lastName}` : lastName;
		try {
			await sql`
				UPDATE users SET display_name = ${displayName}
				WHERE id = ${locals.user.id}
			`;
		} catch (e) {
			// Non-fatal: SF write succeeded; local mirror lagging. Log and move on.
			const desc = describeError(e);
			await logError({
				source: 'accounts.edit_contact',
				operation: 'sync_local_display_name',
				severity: 'warn',
				userId: locals.user.id,
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { displayName }
			});
		}

		return { ...echo, success: 'Contact updated in Salesforce.' };
	},

	/**
	 * Edit local billing address AND PATCH it to Salesforce Account.
	 * Strategy: write to local DB first (cheap, always succeeds for well-formed
	 * input), then PATCH SF. If SF fails the local row is still updated — the
	 * sync queue can reconcile later. UI surfaces the SF error so the user
	 * knows the two sides may diverge.
	 */
	edit_billing_address: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const data = await request.formData();
		const billingStreet     = String(data.get('billingStreet')     ?? '').trim();
		const billingCity       = String(data.get('billingCity')       ?? '').trim();
		const billingState      = String(data.get('billingState')      ?? '').trim();
		const billingPostalCode = String(data.get('billingPostalCode') ?? '').trim();
		const billingCountry    = String(data.get('billingCountry')    ?? '').trim();

		const echo = {
			billingStreet, billingCity, billingState, billingPostalCode, billingCountry
		};

		const [user] = await sql<{ account_id: string | null; sfdc_account_id: string | null }[]>`
			SELECT account_id, sfdc_account_id FROM users WHERE id = ${locals.user.id} LIMIT 1
		`;
		if (!user?.account_id) {
			return fail(409, { ...echo, error: 'No account linked to this user.' });
		}

		// 1. Local DB — empty string → NULL so missing fields aren't treated as set.
		try {
			await sql`
				UPDATE accounts
				SET billing_street      = ${billingStreet     || null},
				    billing_city        = ${billingCity       || null},
				    billing_state       = ${billingState      || null},
				    billing_postal_code = ${billingPostalCode || null},
				    billing_country     = ${billingCountry    || null}
				WHERE id = ${user.account_id}
			`;
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'accounts.edit_billing_address',
				operation: 'update_local',
				userId: locals.user.id,
				accountId: user.account_id,
				errorMessage: desc.errorMessage,
				stack: desc.stack
			});
			return fail(500, { ...echo, error: 'Could not save the billing address right now.' });
		}

		// 2. PATCH Salesforce Account — skip if not linked yet.
		const sfdcAccountId =
			user.sfdc_account_id ??
			(
				await sql<{ sfdc_account_id: string | null }[]>`
					SELECT sfdc_account_id FROM accounts WHERE id = ${user.account_id} LIMIT 1
				`
			)[0]?.sfdc_account_id ??
			null;

		if (sfdcAccountId) {
			const result = await updateSalesforceAccount(
				sfdcAccountId,
				{
					BillingStreet:     billingStreet     || null,
					BillingCity:       billingCity       || null,
					BillingState:      billingState      || null,
					BillingPostalCode: billingPostalCode || null,
					BillingCountry:    billingCountry    || null
				},
				{ userId: locals.user.id, accountId: user.account_id }
			);
			if (!result.ok) {
				// Local saved, SF rejected — surface so user knows.
				return fail(502, {
					...echo,
					error: `Saved locally but Salesforce rejected the update: ${result.error}`,
					savedLocally: true
				});
			}
			return { ...echo, success: 'Billing address updated locally and in Salesforce.' };
		}

		return { ...echo, success: 'Billing address saved. Will sync to Salesforce once linked.' };
	},

	/**
	 * Edit the Salesforce Account's general information. Salesforce is the source
	 * of truth for these fields; name/phone/website/email are mirrored locally.
	 */
	edit_account_info: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const data = await request.formData();
		const str = (k: string) => String(data.get(k) ?? '').trim();
		const num = (k: string) => {
			const v = str(k).replace(/[$,]/g, '');
			return v === '' ? null : Number(v);
		};
		const echo = {
			accountName: str('accountName'), accountPhone: str('accountPhone'), accountFax: str('accountFax'),
			accountWebsite: str('accountWebsite'), accountEmail: str('accountEmail'),
			accountIndustry: str('accountIndustry'), accountEmployees: str('accountEmployees'),
			accountRevenue: str('accountRevenue')
		};
		if (!echo.accountName) return fail(400, { ...echo, error: 'Account name is required.' });
		const employees = num('accountEmployees');
		const revenue = num('accountRevenue');
		if ((employees !== null && !Number.isInteger(employees)) || (revenue !== null && Number.isNaN(revenue)) || (employees !== null && Number.isNaN(employees))) {
			return fail(400, { ...echo, error: 'Employees and annual revenue must be numbers.' });
		}

		const [user] = await sql<{ account_id: string | null; sfdc_account_id: string | null; role: string }[]>`
			SELECT account_id, sfdc_account_id, role FROM users WHERE id = ${locals.user.id} LIMIT 1
		`;
		if (!user?.account_id) return fail(409, { ...echo, error: 'No account linked to this user.' });
		if (!canManageAccountContacts(user.role)) {
			return fail(403, { ...echo, error: 'Only account owners and admins can edit account information.' });
		}

		await sql`
			UPDATE accounts
			SET name = ${echo.accountName}, phone = ${echo.accountPhone || null},
			    website = ${echo.accountWebsite || null}, email = ${echo.accountEmail || null}
			WHERE id = ${user.account_id}
		`;

		const sfdcAccountId =
			user.sfdc_account_id ??
			(await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${user.account_id}`)[0]?.sfdc_account_id ??
			null;
		if (!sfdcAccountId) return { ...echo, success: 'Account information saved. Will sync to Salesforce once linked.' };

		const result = await updateSalesforceAccount(
			sfdcAccountId,
			{
				Name: echo.accountName,
				Phone: echo.accountPhone || null,
				Fax: echo.accountFax || null,
				Website: echo.accountWebsite || null,
				Primary_Email__c: echo.accountEmail || null,
				Industry: echo.accountIndustry || null,
				NumberOfEmployees: employees,
				AnnualRevenue: revenue
			},
			{ userId: locals.user.id, accountId: user.account_id }
		);
		if (!result.ok) {
			return fail(502, { ...echo, error: `Saved locally but Salesforce rejected the update: ${result.error}`, savedLocally: true });
		}
		return { ...echo, success: 'Account information updated in Salesforce.' };
	},

	// ─── Account contacts management ──────────────────────────────────────

	add_account_contact: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const [actor] = await sql<{
			account_id: string | null;
			role: string;
			sfdc_account_id: string | null;
		}[]>`
			SELECT u.account_id, u.role, COALESCE(u.sfdc_account_id, a.sfdc_account_id) AS sfdc_account_id
			FROM users u
			LEFT JOIN accounts a ON a.id = u.account_id
			WHERE u.id = ${locals.user.id}
			LIMIT 1
		`;
		if (!actor?.account_id) {
			return fail(409, { contactError: 'No account linked to your user.' });
		}
		if (!canManageAccountContacts(actor.role)) {
			return fail(403, { contactError: 'Only account owners and admins can add team members.' });
		}

		const data = await request.formData();
		const firstName = String(data.get('firstName') ?? '').trim();
		const lastName  = String(data.get('lastName')  ?? '').trim();
		const email     = String(data.get('email')     ?? '').trim().toLowerCase();
		const phone     = String(data.get('phone')     ?? '').trim();
		const title     = String(data.get('title')     ?? '').trim();
		const password  = String(data.get('password')  ?? '');
		const confirm   = String(data.get('confirm')   ?? '');

		if (!lastName || !email || !password) {
			return fail(400, { contactError: 'Last name, email, and password are required.' });
		}
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return fail(400, { contactError: 'Please enter a valid email address.' });
		}
		if (password.length < 8) {
			return fail(400, { contactError: 'Password must be at least 8 characters.' });
		}
		if (password !== confirm) {
			return fail(400, { contactError: 'Passwords do not match.' });
		}

		const created = await createAccountTeamUser({
			accountId: actor.account_id,
			createdByUserId: locals.user.id,
			firstName,
			lastName,
			email,
			phone,
			title,
			password,
			sfdcAccountId: actor.sfdc_account_id
		});
		if (!created.ok) {
			return fail(created.status ?? 500, { contactError: created.error });
		}

		if (actor.sfdc_account_id) {
			await syncTeamUserToSalesforce({
				accountId: actor.account_id,
				userId: created.userId,
				contactId: created.contactId,
				sfdcAccountId: actor.sfdc_account_id,
				firstName,
				lastName,
				email,
				phone,
				title,
				actorUserId: locals.user.id
			});
		}

		return {
			contactSuccess: `${firstName ? firstName + ' ' : ''}${lastName} added as a team member. They can sign in but cannot manage contacts.`
		};
	},

	remove_account_contact: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const [actor] = await sql<{ account_id: string | null; role: string }[]>`
			SELECT account_id, role FROM users WHERE id = ${locals.user.id} LIMIT 1
		`;
		if (!actor?.account_id) return fail(409, { contactError: 'No account linked.' });
		if (!canManageAccountContacts(actor.role)) return fail(403, { contactError: 'Insufficient permissions.' });

		const data = await request.formData();
		const contactId = String(data.get('contactId') ?? '').trim();
		if (!contactId) return fail(400, { contactError: 'Contact ID required.' });

		const [target] = await sql<{ user_id: string | null; user_role: string | null }[]>`
			SELECT ac.user_id, u.role AS user_role
			FROM account_contacts ac
			LEFT JOIN users u ON u.id = ac.user_id
			WHERE ac.id = ${contactId} AND ac.account_id = ${actor.account_id}
			LIMIT 1
		`;
		if (!target) return fail(404, { contactError: 'Contact not found.' });
		if (target.user_role === 'owner') {
			return fail(403, { contactError: 'The account owner cannot be removed.' });
		}

		await sql.begin(async (tx) => {
			if (target.user_id) {
				await tx`DELETE FROM users WHERE id = ${target.user_id} AND role <> 'owner'`;
			}
			await tx`
				DELETE FROM account_contacts
				WHERE id = ${contactId} AND account_id = ${actor.account_id}
			`;
		});

		return { contactSuccess: 'Contact removed.' };
	},

	set_point_of_contact: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const [actor] = await sql<{ account_id: string | null; role: string }[]>`
			SELECT account_id, role FROM users WHERE id = ${locals.user.id} LIMIT 1
		`;
		if (!actor?.account_id) return fail(409, { contactError: 'No account linked.' });
		if (!canManageAccountContacts(actor.role)) return fail(403, { contactError: 'Insufficient permissions.' });

		const data = await request.formData();
		const contactId = String(data.get('contactId') ?? '').trim();
		if (!contactId) return fail(400, { contactError: 'Contact ID required.' });

		// Use a transaction: clear existing POC then set new one atomically.
		await sql.begin(async (tx) => {
			await tx`
				UPDATE account_contacts
				SET is_point_of_contact = false
				WHERE account_id = ${actor.account_id!} AND is_point_of_contact = true
			`;
			await tx`
				UPDATE account_contacts
				SET is_point_of_contact = true
				WHERE id = ${contactId} AND account_id = ${actor.account_id!}
			`;
		});

		return { contactSuccess: 'Point of contact updated.' };
	},

	update_account_contact: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const [actor] = await sql<{ account_id: string | null; role: string }[]>`
			SELECT account_id, role FROM users WHERE id = ${locals.user.id} LIMIT 1
		`;
		if (!actor?.account_id) return fail(409, { contactError: 'No account linked.' });
		if (!canManageAccountContacts(actor.role)) return fail(403, { contactError: 'Insufficient permissions.' });

		const data = await request.formData();
		const contactId = String(data.get('contactId') ?? '').trim();
		const firstName = String(data.get('firstName') ?? '').trim();
		const lastName  = String(data.get('lastName')  ?? '').trim();
		const phone     = String(data.get('phone')     ?? '').trim();
		const title     = String(data.get('title')     ?? '').trim();

		if (!contactId || !lastName) {
			return fail(400, { contactError: 'Contact ID and last name are required.' });
		}

		await sql`
			UPDATE account_contacts
			SET first_name = ${firstName || null},
			    last_name  = ${lastName},
			    phone      = ${phone || null},
			    title      = ${title || null}
			WHERE id = ${contactId} AND account_id = ${actor.account_id}
		`;

		return { contactSuccess: 'Contact updated.' };
	}
};
