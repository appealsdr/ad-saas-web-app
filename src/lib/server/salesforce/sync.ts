/**
 * High-level Salesforce sync flows that compose the lower-level REST helpers
 * in client.ts. Each function is best-effort: it returns a `{ ok, ... }`
 * result rather than throwing, so callers can decide whether to surface the
 * failure to the user or enqueue the work for later via sfdc_sync_queue.
 *
 * Field mapping (registration → Salesforce):
 *
 *   Local field        → Salesforce Account              → Salesforce Contact
 *   ─────────────────────────────────────────────────────────────────────────
 *   companyName        Name                                 (n/a — uses AccountId)
 *   email              Email__c  (custom — see CUSTOM_EMAIL_FIELD)   Email
 *   phone              Phone                                Phone
 *   website            Website                              (n/a)
 *   createdAt (date)   Start_Date__c                        (n/a)
 *   firstName/lastName (n/a — Account is a business)        FirstName / LastName
 *
 * If your org's Account "email" custom field is named something other than
 * Email__c, change ACCOUNT_EMAIL_FIELD below.
 */
import { sobjectCreate, sobjectUpdate, sfdcQuery, SalesforceApiError } from './client';
import { sql } from '../db';
import { logError } from '../error_log';
import { VUID_FIELD } from './vuid';

/**
 * The Salesforce standard Account object has NO `Email` field — it's a
 * business entity, not a person. Almost every org adds a custom one, but the
 * API name varies (`Email__c`, `Account_Email__c`, `Contact_Email__c`, etc.).
 * Change this constant if your org uses a different API name.
 */
const ACCOUNT_EMAIL_FIELD = 'Primary_Email__c';

/**
 * Custom date field on Account that records when the customer first signed
 * up in samdoctor-web. Salesforce date fields accept ISO `YYYY-MM-DD`.
 */
const ACCOUNT_START_DATE_FIELD = 'Start_Date__c';

export interface AccountContactInput {
	companyName: string;          // → Account.Name
	firstName?: string;           // → Contact.FirstName (optional in SF)
	lastName: string;             // → Contact.LastName (required in SF)
	email: string;                // → Account.<ACCOUNT_EMAIL_FIELD> + Contact.Email
	phone: string;                // → Account.Phone + Contact.Phone
	website: string;              // → Account.Website
	startDate: Date;              // → Account.<ACCOUNT_START_DATE_FIELD>
}

export type AccountContactResult =
	| { ok: true; sfdcAccountId: string; sfdcContactId: string }
	| { ok: false; error: string; errorCode?: string };

/** Local record IDs — optional, used purely to correlate error_log rows. */
export interface SyncContext {
	userId?: string;
	accountId?: string;
}

function toSalesforceDate(d: Date): string {
	// YYYY-MM-DD in UTC. Salesforce Date fields are timezone-naive.
	return d.toISOString().slice(0, 10);
}

/** Normalize website to include a protocol — SF Website is fine without one but URLs are tidier. */
function normalizeWebsite(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return trimmed;
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return `https://${trimmed}`;
}

/**
 * Look up an existing Salesforce Contact by email. Used to pre-flight
 * registration so we can reject with a clear message instead of hitting
 * Salesforce's duplicate-rule error mid-creation (which would also leave an
 * orphaned Account behind, since Account creation runs before Contact).
 *
 * Returns null (not an error) if Salesforce is unreachable/misconfigured —
 * callers should treat that as "couldn't verify" and proceed as before
 * rather than blocking registration on an SF outage.
 */
export async function findContactByEmail(
	email: string
): Promise<{ id: string; accountId: string | null } | null> {
	const escaped = email.replace(/'/g, "''");
	try {
		const result = await sfdcQuery<{ Id: string; AccountId: string | null }>(
			`SELECT Id, AccountId FROM Contact WHERE Email = '${escaped}' LIMIT 1`
		);
		const row = result.records[0];
		return row ? { id: row.Id, accountId: row.AccountId ?? null } : null;
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		await logError({
			source: 'salesforce.sync',
			operation: 'find_contact_by_email',
			sfdcObject: 'Contact',
			errorCode: isSfErr ? e.errorCode ?? String(e.status) : undefined,
			errorMessage: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack : undefined,
			context: { email }
		});
		return null;
	}
}

/**
 * Create an Account, then a Contact linked to that Account. Returns both IDs
 * on success or a structured error on failure (auth, validation, network).
 *
 * Note: this is NOT idempotent. If the caller wants idempotency on retry,
 * use sobjectUpsert with an external Id field instead.
 */
export async function createSalesforceAccountAndContact(
	input: AccountContactInput,
	context: SyncContext = {}
): Promise<AccountContactResult> {
	const accountPayload: Record<string, unknown> = {
		Name: input.companyName,
		Phone: input.phone,
		Website: normalizeWebsite(input.website),
		[ACCOUNT_EMAIL_FIELD]: input.email,
		[ACCOUNT_START_DATE_FIELD]: toSalesforceDate(input.startDate)
	};
	// Back-reference: stamp the SF Account with our local accounts.id so
	// downstream SF flows can find the record in Postgres.
	if (context.accountId) accountPayload[VUID_FIELD] = context.accountId;

	// ── Step 1: Account ────────────────────────────────────────────────
	let accountSfId: string;
	try {
		const account = await sobjectCreate('Account', accountPayload);
		if (!account.success) {
			const error = `Salesforce Account create returned success=false: ${JSON.stringify(account.errors)}`;
			await logError({
				source: 'salesforce.sync',
				operation: 'create_account',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: 'Account',
				errorMessage: error,
				context: { payload: accountPayload, sfErrors: account.errors }
			});
			return { ok: false, error };
		}
		accountSfId = account.id;
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.sync',
			operation: 'create_account',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Account',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { payload: accountPayload }
		});
		return { ok: false, error: errorMessage, errorCode };
	}

	// ── Step 2: Contact ────────────────────────────────────────────────
	const contactPayload: Record<string, unknown> = {
		FirstName: input.firstName,
		LastName: input.lastName,
		Email: input.email,
		Phone: input.phone,
		AccountId: accountSfId
	};
	// Back-reference: stamp the SF Contact with our local users.id.
	if (context.userId) contactPayload[VUID_FIELD] = context.userId;
	try {
		const contact = await sobjectCreate('Contact', contactPayload);
		if (!contact.success) {
			const error = `Salesforce Contact create returned success=false: ${JSON.stringify(contact.errors)}`;
			await logError({
				source: 'salesforce.sync',
				operation: 'create_contact',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: 'Contact',
				errorMessage: error,
				context: { payload: contactPayload, sfdcAccountId: accountSfId, sfErrors: contact.errors }
			});
			return { ok: false, error };
		}
		return { ok: true, sfdcAccountId: accountSfId, sfdcContactId: contact.id };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.sync',
			operation: 'create_contact',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Contact',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { payload: contactPayload, sfdcAccountId: accountSfId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/**
 * Enqueue an Account+Contact create for later retry by a worker. Two rows so
 * the worker can process them independently (Contact depends on Account ID
 * being filled in once the queued Account row succeeds).
 */
export async function enqueueAccountContactSync(args: {
	accountRowId: string;
	userRowId: string;
	input: AccountContactInput;
	failureReason: string;
}): Promise<void> {
	const { input } = args;
	await sql.begin(async (sql) => {
		await sql`
			INSERT INTO sfdc_sync_queue (operation, sfdc_object, record_id, payload, last_error)
			VALUES (
				'upsert',
				'Account',
				${args.accountRowId},
				${sql.json({
					localAccountId: args.accountRowId,
					name: input.companyName,
					phone: input.phone,
					website: normalizeWebsite(input.website),
					emailField: ACCOUNT_EMAIL_FIELD,
					email: input.email,
					startDateField: ACCOUNT_START_DATE_FIELD,
					startDate: toSalesforceDate(input.startDate)
				})},
				${args.failureReason}
			)
		`;
		await sql`
			INSERT INTO sfdc_sync_queue (operation, sfdc_object, record_id, payload, last_error)
			VALUES (
				'upsert',
				'Contact',
				${args.userRowId},
				${sql.json({
					localUserId: args.userRowId,
					localAccountId: args.accountRowId,
					firstName: input.firstName,
					lastName: input.lastName,
					email: input.email,
					phone: input.phone
				})},
				${args.failureReason}
			)
		`;
	});
}

export interface AdditionalContactInput {
	sfdcAccountId: string;
	firstName?: string;
	lastName: string;
	email: string;
	phone?: string;
	title?: string;
	localUserId?: string;
}

export type AdditionalContactResult =
	| { ok: true; sfdcContactId: string }
	| { ok: false; error: string; errorCode?: string };

/** Create a Contact under an existing Salesforce Account (team members). */
export async function createSalesforceContactForAccount(
	input: AdditionalContactInput,
	context: SyncContext = {}
): Promise<AdditionalContactResult> {
	const contactPayload: Record<string, unknown> = {
		FirstName: input.firstName ?? null,
		LastName: input.lastName,
		Email: input.email,
		Phone: input.phone ?? null,
		Title: input.title ?? null,
		AccountId: input.sfdcAccountId
	};
	if (input.localUserId) contactPayload[VUID_FIELD] = input.localUserId;

	try {
		const contact = await sobjectCreate('Contact', contactPayload);
		if (!contact.success) {
			const error = `Salesforce Contact create returned success=false: ${JSON.stringify(contact.errors)}`;
			await logError({
				source: 'salesforce.sync',
				operation: 'create_account_contact',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: 'Contact',
				errorMessage: error,
				context: { payload: contactPayload, sfErrors: contact.errors }
			});
			return { ok: false, error };
		}
		return { ok: true, sfdcContactId: contact.id };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.sync',
			operation: 'create_account_contact',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Contact',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { payload: contactPayload }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/** Custom field on Account holding the Stripe Customer id (`cus_…`). */
const ACCOUNT_STRIPE_CUSTOMER_FIELD = 'Stripe_Customer_Id__c';

/** Stamp Account.Stripe_Customer_Id__c once a Stripe Customer is created for this account. */
export async function updateSalesforceAccountStripeCustomerId(
	sfdcAccountId: string,
	stripeCustomerId: string,
	context: SyncContext = {}
): Promise<{ ok: true } | { ok: false; error: string; errorCode?: string }> {
	try {
		await sobjectUpdate('Account', sfdcAccountId, {
			[ACCOUNT_STRIPE_CUSTOMER_FIELD]: stripeCustomerId
		});
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.sync',
			operation: 'update_account_stripe_customer_id',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Account',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcAccountId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/** Split "Jane Mary Doe" → { firstName: "Jane Mary", lastName: "Doe" }. */
export function splitFullName(full: string): { firstName?: string; lastName: string } {
	const trimmed = full.trim().replace(/\s+/g, ' ');
	if (!trimmed) return { lastName: 'Unknown' };
	const parts = trimmed.split(' ');
	if (parts.length === 1) return { lastName: parts[0] };
	const lastName = parts[parts.length - 1];
	const firstName = parts.slice(0, -1).join(' ');
	return { firstName, lastName };
}
