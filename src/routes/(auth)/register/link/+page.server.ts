/**
 * Sign-up via a Salesforce-issued link (AD-1934).
 *
 * The Account / Contact (and optionally a ServiceContract) already exist in
 * Salesforce. The link carries their Ids; the client reviews/edits the info,
 * sets a password, and we create the local rows LINKED to those records —
 * no new Salesforce Account/Contact/Contract. Salesforce Stores under the
 * Account are mirrored into the app's stores table.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth/password';
import { createSession } from '$lib/server/auth/session';
import { setSessionCookie } from '$lib/server/auth/cookie';
import { verifySignupToken } from '$lib/server/auth/signup_link';
import { logError, describeError } from '$lib/server/error_log';
import {
	fetchSalesforceAccount,
	fetchSalesforceContact,
	updateSalesforceAccount,
	updateSalesforceContact,
	sfdcQuery
} from '$lib/server/salesforce';
import { ensureAccountFolders } from '$lib/server/storage/s3-paths';
import { ensureOwnerAccountContact } from '$lib/server/account/contacts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 3;

interface SfStore {
	Id: string;
	Name: string;
	Marketplaces__c: string | null;
	Seller_ID__c: string | null;
	Seller_Account_Primary_Email__c: string | null;
	Store_Email__c: string | null;
	Business_Name__c: string | null;
	Country__c: string | null;
	Description__c: string | null;
}

async function listSfStores(sfdcAccountId: string): Promise<SfStore[]> {
	try {
		const r = await sfdcQuery<SfStore>(
			`SELECT Id, Name, Marketplaces__c, Seller_ID__c, Seller_Account_Primary_Email__c, Store_Email__c, Business_Name__c, Country__c, Description__c FROM Store__c WHERE Account__c = '${sfdcAccountId}'`
		);
		return r.records;
	} catch (e) {
		await logError({ source: 'register_link', operation: 'list_stores', severity: 'warn', errorMessage: describeError(e).errorMessage });
		return [];
	}
}

async function checkLink(token: string | null) {
	const v = verifySignupToken(token);
	if (!v.ok) return { error: v.reason === 'expired' ? 'This link has expired. Please ask us for a new one.' : 'This sign-up link is not valid.' } as const;
	const p = v.payload;
	const [used] = await sql<{ nonce: string }[]>`SELECT nonce FROM signup_links WHERE nonce = ${p.nonce}`;
	const [linked] = await sql<{ id: string }[]>`SELECT id FROM accounts WHERE sfdc_account_id = ${p.sfdcAccountId}`;
	if (used || linked) return { error: 'This link has already been used. Please sign in.', signedUp: true } as const;
	return { payload: p } as const;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) throw redirect(303, '/dashboard');
	const token = url.searchParams.get('t');
	const res = await checkLink(token);
	if ('error' in res) return { error: res.error, signedUp: !!res.signedUp };

	const [accRes, conRes, stores] = await Promise.all([
		fetchSalesforceAccount(res.payload.sfdcAccountId),
		fetchSalesforceContact(res.payload.sfdcContactId),
		listSfStores(res.payload.sfdcAccountId)
	]);
	if (!accRes.ok || !conRes.ok || conRes.record.AccountId !== accRes.record.Id) {
		return { error: 'We could not load your details. Please contact support.', signedUp: false };
	}
	const account = accRes.record;
	const contact = conRes.record;
	return {
		error: null,
		signedUp: false,
		hasContract: !!res.payload.sfdcServiceContractId,
		stores: stores.map((s) => s.Name),
		values: {
			name: [contact.FirstName, contact.LastName].filter(Boolean).join(' '),
			company: account.Name ?? '',
			email: contact.Email ?? account.Primary_Email__c ?? '',
			phone: contact.Phone ?? account.Phone ?? '',
			website: account.Website ?? ''
		}
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const data = await request.formData();
		const res = await checkLink(String(data.get('t') ?? url.searchParams.get('t') ?? ''));
		if ('error' in res) return fail(400, { error: res.error });
		const p = res.payload;

		const name = String(data.get('name') ?? '').trim();
		const company = String(data.get('company') ?? '').trim();
		const email = String(data.get('email') ?? '').trim().toLowerCase();
		const phone = String(data.get('phone') ?? '').trim();
		const website = String(data.get('website') ?? '').trim();
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');
		const echo = { name, company, email, phone, website };

		if (!name || !company || !email || !phone || !website || !password) return fail(400, { ...echo, error: 'All fields are required.' });
		if (!EMAIL_RE.test(email)) return fail(400, { ...echo, error: 'Please enter a valid email address.' });
		if (phone.replace(/\D/g, '').length < 7) return fail(400, { ...echo, error: 'Please enter a valid phone number.' });
		if (password !== confirm) return fail(400, { ...echo, error: 'Passwords do not match.' });
		if (password.length < 8) return fail(400, { ...echo, error: 'Password must be at least 8 characters.' });

		const [dup] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
		if (dup) return fail(409, { ...echo, error: 'An account with this email already exists. Please sign in.' });

		// Re-verify against Salesforce so the Ids in the link really belong together.
		const [sfAcc, sfCon, sfStores] = await Promise.all([
			fetchSalesforceAccount(p.sfdcAccountId),
			fetchSalesforceContact(p.sfdcContactId),
			listSfStores(p.sfdcAccountId)
		]);
		if (!sfAcc.ok || !sfCon.ok || sfCon.record.AccountId !== sfAcc.record.Id) {
			return fail(400, { ...echo, error: 'We could not load your details. Please contact support.' });
		}

		const passwordHash = await hashPassword(password);
		let accountId: string;
		let userId: string;
		try {
			[accountId, userId] = await sql.begin(async (tx) => {
				const [account] = await tx<{ id: string }[]>`
					INSERT INTO accounts (name, email, phone, website, sfdc_account_id)
					VALUES (${company}, ${email}, ${phone}, ${website}, ${p.sfdcAccountId})
					RETURNING id`;
				const [user] = await tx<{ id: string }[]>`
					INSERT INTO users (email, display_name, password_hash, account_id, role, last_login_at, sfdc_contact_id, sfdc_account_id)
					VALUES (${email}, ${name}, ${passwordHash}, ${account.id}, 'owner', now(), ${p.sfdcContactId}, ${p.sfdcAccountId})
					RETURNING id`;
				// Link existing Salesforce stores to app stores.
				for (const s of sfStores) {
					await tx`
						INSERT INTO stores (account_id, created_by, name, marketplaces, seller_id, seller_primary_email,
							store_email, business_name, country, sfdc_store_id)
						VALUES (${account.id}, ${user.id}, ${s.Name}, ${s.Marketplaces__c}, ${s.Seller_ID__c},
							${s.Seller_Account_Primary_Email__c}, ${s.Store_Email__c}, ${s.Business_Name__c}, ${s.Country__c}, ${s.Id})
						ON CONFLICT DO NOTHING`;
				}
				await tx`
					INSERT INTO signup_links (nonce, sfdc_account_id, sfdc_contact_id, sfdc_service_contract_id, account_id, user_id)
					VALUES (${p.nonce}, ${p.sfdcAccountId}, ${p.sfdcContactId}, ${p.sfdcServiceContractId}, ${account.id}, ${user.id})`;
				return [account.id, user.id];
			});
		} catch (e) {
			if ((e as { code?: string })?.code === '23505') return fail(409, { ...echo, error: 'This link or email has already been used. Please sign in.' });
			const d = describeError(e);
			await logError({ source: 'register_link', operation: 'create_linked_account', errorMessage: d.errorMessage, stack: d.stack, context: { sfdcAccountId: p.sfdcAccountId } });
			return fail(500, { ...echo, error: 'Could not create your account right now. Please try again.' });
		}

		await ensureAccountFolders(accountId);

		// Push the client's edits back onto the EXISTING Salesforce records (no creates).
		const { splitFullName } = await import('$lib/server/salesforce');
		const { firstName, lastName } = splitFullName(name);
		const ctx = { userId, accountId };
		await updateSalesforceAccount(p.sfdcAccountId, { Name: company, Phone: phone, Website: website, Primary_Email__c: email }, ctx);
		await updateSalesforceContact(p.sfdcContactId, { FirstName: firstName ?? null, LastName: lastName, Phone: phone }, ctx);

		await ensureOwnerAccountContact(accountId, userId);

		const { rawToken } = await createSession(userId, {
			ipAddress: getClientAddress(),
			userAgent: request.headers.get('user-agent') ?? undefined
		});
		setSessionCookie(cookies, { url }, rawToken, SESSION_COOKIE_MAX_AGE);
		throw redirect(303, '/dashboard');
	}
};
