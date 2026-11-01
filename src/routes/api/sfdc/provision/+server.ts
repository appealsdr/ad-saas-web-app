/**
 * POST /api/sfdc/provision — called from Salesforce to create a local
 * Account + user (and the matching Salesforce Account/Contact), optionally
 * provision related Stores under that Account, and hand back a one-time
 * login.
 *
 * Auth: Bearer API key with the "provision" scope (see $lib/server/auth/api_key).
 *
 * The returned temporaryPassword is shown exactly once here — it is never
 * retrievable again. The created user has must_reset_password=true, so their
 * first login is routed through the forced password-change flow before a
 * session is issued (see (auth)/login/+page.server.ts).
 *
 * vuid: every entity (Account, Contact/User, each Store) is stamped with our
 * local id in Salesforce's appealsdoctor_vuid__c field (see
 * $lib/server/salesforce/vuid.ts). The response below returns the same ids
 * alongside the Salesforce Ids so the calling Salesforce Flow can, if it
 * needs to, write appealsdoctor_vuid__c itself as a fallback.
 *
 * IMPORTANT — who creates what in Salesforce: this endpoint is called BY a
 * Salesforce Flow, from records that already exist there (that's what
 * triggered the call). If the caller passes an existing sfdcAccountId /
 * sfdcContactId (and, per store, sfdcStoreId), we link to those and only
 * backfill the vuid — we do NOT create new Account/Contact/Store__c records.
 * Only when those ids are omitted do we create new Salesforce records (the
 * app-originated signup path, e.g. registering directly on samdoctor-web).
 * Always creating new SF records regardless of caller-supplied ids caused a
 * duplicate-account loop: Salesforce → provision → app creates ANOTHER
 * Account/Contact/Store__c back in Salesforce → (if that write re-triggers
 * the same Flow) → provision again, etc.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { requireApiKey } from '$lib/server/auth/api_key';
import { hashPassword } from '$lib/server/auth/password';
import { generateTempPassword } from '$lib/server/auth/temp_password';
import {
	createSalesforceAccountAndContact,
	createSalesforceStore,
	updateSalesforceStore,
	updateSalesforceAccount,
	updateSalesforceContact
} from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ProvisionStoreInput {
	name: string;
	sfdcStoreId?: string; // if set, link to this existing Store__c instead of creating a new one
	marketplaces?: string;
	sellerId?: string;
	sellerPrimaryEmail?: string;
	storeEmail?: string;
	businessName?: string;
	country?: string;
	description?: string;
}

interface ProvisionBody {
	companyName: string;
	firstName?: string;
	lastName: string;
	email: string;
	phone: string;
	website?: string;
	sfdcAccountId?: string; // if set (with sfdcContactId), link instead of creating new SF records
	sfdcContactId?: string;
	stores?: ProvisionStoreInput[];
}

interface ProvisionedStoreResult {
	vuid: string; // local stores.id
	name: string;
	sfdcStoreId: string | null;
	error?: string;
}

export const POST: RequestHandler = async ({ request }) => {
	await requireApiKey(request, 'provision');

	let body: Partial<ProvisionBody>;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON.');
	}

	const companyName = String(body.companyName ?? '').trim();
	const firstName = body.firstName ? String(body.firstName).trim() : undefined;
	const lastName = String(body.lastName ?? '').trim();
	const email = String(body.email ?? '').trim().toLowerCase();
	const phone = String(body.phone ?? '').trim();
	const website = String(body.website ?? '').trim();
	const storeInputs = Array.isArray(body.stores) ? body.stores : [];
	const suppliedSfdcAccountId = body.sfdcAccountId ? String(body.sfdcAccountId).trim() : undefined;
	const suppliedSfdcContactId = body.sfdcContactId ? String(body.sfdcContactId).trim() : undefined;

	if (!companyName || !lastName || !email) {
		throw error(400, 'companyName, lastName, and email are required.');
	}
	if (!EMAIL_RE.test(email)) {
		throw error(400, 'email is not a valid email address.');
	}
	if (Boolean(suppliedSfdcAccountId) !== Boolean(suppliedSfdcContactId)) {
		throw error(400, 'sfdcAccountId and sfdcContactId must be provided together, or not at all.');
	}
	for (const s of storeInputs) {
		if (!s || !String(s.name ?? '').trim()) {
			throw error(400, 'Each entry in stores requires a name.');
		}
	}

	const existing = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
	if (existing[0]) {
		throw error(409, 'A user with this email already exists.');
	}

	const tempPassword = generateTempPassword();
	const passwordHash = await hashPassword(tempPassword);

	let accountId: string;
	let userId: string;
	try {
		[accountId, userId] = await sql.begin(async (tx) => {
			const [account] = await tx`
				INSERT INTO accounts (name, email, phone, website)
				VALUES (${companyName}, ${email}, ${phone}, ${website})
				RETURNING id
			`;
			const [user] = await tx`
				INSERT INTO users (email, display_name, password_hash, account_id, role, must_reset_password)
				VALUES (${email}, ${[firstName, lastName].filter(Boolean).join(' ')}, ${passwordHash}, ${account.id}, 'owner', true)
				RETURNING id
			`;
			return [account.id, user.id];
		});
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'sfdc.provision',
			operation: 'insert_local',
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { email }
		});
		throw error(500, 'Could not create the account. Please try again.');
	}

	let sfdcAccountId: string | null = null;
	let sfdcContactId: string | null = null;

	if (suppliedSfdcAccountId && suppliedSfdcContactId) {
		// Salesforce already has these records — link to them and only
		// backfill the vuid, instead of creating new Account/Contact.
		sfdcAccountId = suppliedSfdcAccountId;
		sfdcContactId = suppliedSfdcContactId;
		await sql.begin(async (tx) => {
			await tx`UPDATE accounts SET sfdc_account_id = ${sfdcAccountId} WHERE id = ${accountId}`;
			await tx`
				UPDATE users
				SET sfdc_contact_id = ${sfdcContactId}, sfdc_account_id = ${sfdcAccountId}
				WHERE id = ${userId}
			`;
		});
		const [accountBackfill, contactBackfill] = await Promise.all([
			updateSalesforceAccount(sfdcAccountId, {}, { accountId }),
			updateSalesforceContact(sfdcContactId, {}, { userId })
		]);
		for (const [label, result] of [
			['account', accountBackfill],
			['contact', contactBackfill]
		] as const) {
			if (!result.ok) {
				await logError({
					source: 'sfdc.provision',
					operation: `backfill_vuid_${label}`,
					severity: 'warn',
					userId,
					accountId,
					errorMessage: result.error,
					errorCode: result.errorCode
				});
			}
		}
	} else {
		// No existing SF ids given — this is an app-originated signup, so
		// create fresh Account/Contact records in Salesforce.
		const sfResult = await createSalesforceAccountAndContact(
			{
				companyName,
				firstName,
				lastName,
				email,
				phone,
				website,
				startDate: new Date()
			},
			{ userId, accountId }
		);

		if (sfResult.ok) {
			sfdcAccountId = sfResult.sfdcAccountId;
			sfdcContactId = sfResult.sfdcContactId;
			await sql.begin(async (tx) => {
				await tx`UPDATE accounts SET sfdc_account_id = ${sfdcAccountId} WHERE id = ${accountId}`;
				await tx`
					UPDATE users
					SET sfdc_contact_id = ${sfdcContactId}, sfdc_account_id = ${sfdcAccountId}
					WHERE id = ${userId}
				`;
			});
		} else {
			await logError({
				source: 'sfdc.provision',
				operation: 'create_sfdc_account_contact',
				severity: 'warn',
				userId,
				accountId,
				errorMessage: sfResult.error,
				errorCode: sfResult.errorCode
			});
		}
	}

	// ── Stores (optional) ────────────────────────────────────────────────
	// Each store is created locally first (so it has a vuid to stamp onto
	// the Salesforce Store__c), then synced to Salesforce. A store sync
	// failure doesn't fail the whole request — same best-effort pattern as
	// the Account/Contact sync above.
	const provisionedStores: ProvisionedStoreResult[] = [];
	for (const storeInput of storeInputs) {
		const name = String(storeInput.name).trim();
		const marketplaces = storeInput.marketplaces ? String(storeInput.marketplaces).trim() : null;
		const sellerId = storeInput.sellerId ? String(storeInput.sellerId).trim() : null;
		const sellerPrimaryEmail = storeInput.sellerPrimaryEmail
			? String(storeInput.sellerPrimaryEmail).trim()
			: null;
		const storeEmail = storeInput.storeEmail ? String(storeInput.storeEmail).trim() : null;
		const businessName = storeInput.businessName ? String(storeInput.businessName).trim() : null;
		const country = storeInput.country ? String(storeInput.country).trim() : null;
		const description = storeInput.description ? String(storeInput.description).trim() : null;

		let storeId: string;
		try {
			const [store] = await sql<{ id: string }[]>`
				INSERT INTO stores (
					account_id, created_by, name, marketplaces, seller_id,
					seller_primary_email, store_email, business_name, country, description
				)
				VALUES (
					${accountId}, ${userId}, ${name}, ${marketplaces}, ${sellerId},
					${sellerPrimaryEmail}, ${storeEmail}, ${businessName}, ${country}, ${description}
				)
				RETURNING id
			`;
			storeId = store.id;
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'sfdc.provision',
				operation: 'insert_local_store',
				userId,
				accountId,
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { name }
			});
			provisionedStores.push({ vuid: '', name, sfdcStoreId: null, error: 'Could not create the store locally.' });
			continue;
		}

		const suppliedSfdcStoreId = storeInput.sfdcStoreId ? String(storeInput.sfdcStoreId).trim() : undefined;

		if (suppliedSfdcStoreId) {
			// Salesforce already has this Store__c — link to it and only
			// backfill the vuid, instead of creating a new one.
			await sql`UPDATE stores SET sfdc_store_id = ${suppliedSfdcStoreId} WHERE id = ${storeId}`;
			const backfill = await updateSalesforceStore(suppliedSfdcStoreId, {}, { userId, accountId, localStoreId: storeId });
			if (!backfill.ok) {
				await logError({
					source: 'sfdc.provision',
					operation: 'backfill_vuid_store',
					severity: 'warn',
					userId,
					accountId,
					errorMessage: backfill.error,
					errorCode: backfill.errorCode,
					context: { storeId, sfdcStoreId: suppliedSfdcStoreId }
				});
			}
			provisionedStores.push({ vuid: storeId, name, sfdcStoreId: suppliedSfdcStoreId });
			continue;
		}

		const storeSfResult = await createSalesforceStore(
			{
				name,
				sfdcAccountId,
				marketplaces,
				sellerId,
				sellerPrimaryEmail,
				storeEmail,
				businessName,
				country,
				description
			},
			{ userId, accountId, localStoreId: storeId }
		);

		if (storeSfResult.ok) {
			await sql`UPDATE stores SET sfdc_store_id = ${storeSfResult.sfdcStoreId} WHERE id = ${storeId}`;
			provisionedStores.push({ vuid: storeId, name, sfdcStoreId: storeSfResult.sfdcStoreId });
		} else {
			await logError({
				source: 'sfdc.provision',
				operation: 'create_sfdc_store',
				severity: 'warn',
				userId,
				accountId,
				errorMessage: storeSfResult.error,
				errorCode: storeSfResult.errorCode,
				context: { storeId, name }
			});
			provisionedStores.push({ vuid: storeId, name, sfdcStoreId: null, error: storeSfResult.error });
		}
	}

	return json(
		{
			account: { vuid: accountId, sfdcAccountId },
			contact: { vuid: userId, sfdcContactId },
			stores: provisionedStores,
			username: email,
			temporaryPassword: tempPassword,
			// Kept for backward compatibility with callers built against the
			// pre-stores response shape.
			userId,
			accountId,
			sfdcAccountId,
			sfdcContactId
		},
		{ status: 201 }
	);
};
