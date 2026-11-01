/**
 * Account team contacts — owner bootstrap, store POC defaults, team user creation.
 */
import { sql } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth/password';
import { createSalesforceContactForAccount, splitFullName } from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';

interface OwnerRow {
	id: string;
	email: string;
	display_name: string | null;
	sfdc_contact_id: string | null;
	sfdc_account_id: string | null;
}

/** Ensure the account owner has an account_contacts row (account POC by default). */
export async function ensureOwnerAccountContact(
	accountId: string,
	ownerUserId?: string
): Promise<string | null> {
	const [owner] = ownerUserId
		? await sql<OwnerRow[]>`
			SELECT id, email, display_name, sfdc_contact_id, sfdc_account_id
			FROM users WHERE id = ${ownerUserId} AND account_id = ${accountId} LIMIT 1
		`
		: await sql<OwnerRow[]>`
			SELECT id, email, display_name, sfdc_contact_id, sfdc_account_id
			FROM users
			WHERE account_id = ${accountId} AND role = 'owner'
			ORDER BY created_at ASC
			LIMIT 1
		`;
	if (!owner) return null;

	const [existingPoc] = await sql<{ id: string }[]>`
		SELECT id FROM account_contacts
		WHERE account_id = ${accountId} AND is_point_of_contact = true
		LIMIT 1
	`;

	const [existing] = await sql<{ id: string }[]>`
		SELECT id FROM account_contacts
		WHERE account_id = ${accountId} AND user_id = ${owner.id}
		LIMIT 1
	`;
	if (existing) {
		if (!existingPoc) {
			await sql`
				UPDATE account_contacts SET is_point_of_contact = true WHERE id = ${existing.id}
			`;
		}
		return existing.id;
	}

	const { firstName, lastName } = splitFullName(owner.display_name ?? owner.email);
	const [row] = await sql<{ id: string }[]>`
		INSERT INTO account_contacts (
			account_id, user_id, first_name, last_name, email, phone,
			is_point_of_contact, sfdc_contact_id, invite_accepted_at, created_by
		)
		VALUES (
			${accountId}, ${owner.id}, ${firstName || null}, ${lastName}, ${owner.email}, NULL,
			${!existingPoc}, ${owner.sfdc_contact_id}, now(), ${owner.id}
		)
		ON CONFLICT (account_id, email) DO UPDATE SET
			user_id = EXCLUDED.user_id,
			sfdc_contact_id = COALESCE(account_contacts.sfdc_contact_id, EXCLUDED.sfdc_contact_id),
			invite_accepted_at = COALESCE(account_contacts.invite_accepted_at, now())
		RETURNING id
	`;
	return row?.id ?? null;
}

/** Account POC contact id, falling back to the owner's contact row. */
export async function getDefaultStorePointOfContactId(accountId: string): Promise<string | null> {
	const [poc] = await sql<{ id: string }[]>`
		SELECT id FROM account_contacts
		WHERE account_id = ${accountId} AND is_point_of_contact = true
		LIMIT 1
	`;
	if (poc) return poc.id;
	return ensureOwnerAccountContact(accountId);
}

export interface CreateTeamUserInput {
	accountId: string;
	createdByUserId: string;
	firstName: string;
	lastName: string;
	email: string;
	phone: string;
	title: string;
	password: string;
	sfdcAccountId: string | null;
}

export type CreateTeamUserResult =
	| { ok: true; contactId: string; userId: string }
	| { ok: false; error: string; status?: number };

/** Create a member-role app user + account_contacts row (+ SF Contact when linked). */
export async function createAccountTeamUser(
	input: CreateTeamUserInput
): Promise<CreateTeamUserResult> {
	const email = input.email.trim().toLowerCase();
	const passwordHash = await hashPassword(input.password);
	const displayName = input.firstName
		? `${input.firstName} ${input.lastName}`.trim()
		: input.lastName;

	try {
		return await sql.begin(async (tx) => {
			const dupUser = await tx<{ id: string }[]>`
				SELECT id FROM users WHERE email = ${email} LIMIT 1
			`;
			if (dupUser[0]) {
				return { ok: false as const, error: 'A user with that email already exists.', status: 409 };
			}

			const [user] = await tx<{ id: string }[]>`
				INSERT INTO users (
					email, display_name, password_hash, account_id, role,
					sfdc_account_id, is_active
				)
				VALUES (
					${email}, ${displayName}, ${passwordHash}, ${input.accountId}, 'member',
					${input.sfdcAccountId}, true
				)
				RETURNING id
			`;

			const [contact] = await tx<{ id: string }[]>`
				INSERT INTO account_contacts (
					account_id, user_id, first_name, last_name, email, phone, title,
					is_point_of_contact, created_by, invite_accepted_at
				)
				VALUES (
					${input.accountId}, ${user.id}, ${input.firstName || null}, ${input.lastName},
					${email}, ${input.phone || null}, ${input.title || null},
					false, ${input.createdByUserId}, now()
				)
				RETURNING id
			`;

			return { ok: true as const, contactId: contact.id, userId: user.id };
		});
	} catch (e: unknown) {
		const err = e as { code?: string };
		if (err?.code === '23505') {
			return { ok: false, error: 'A contact with that email already exists on this account.', status: 409 };
		}
		const desc = describeError(e);
		await logError({
			source: 'account.create_team_user',
			operation: 'insert',
			userId: input.createdByUserId,
			accountId: input.accountId,
			errorMessage: desc.errorMessage,
			stack: desc.stack
		});
		return { ok: false, error: 'Could not create team member. Please try again.', status: 500 };
	}
}

/** Best-effort SF Contact create + link ids on user and account_contacts rows. */
export async function syncTeamUserToSalesforce(args: {
	accountId: string;
	userId: string;
	contactId: string;
	sfdcAccountId: string;
	firstName: string;
	lastName: string;
	email: string;
	phone: string;
	title: string;
	actorUserId: string;
}): Promise<void> {
	const sf = await createSalesforceContactForAccount(
		{
			sfdcAccountId: args.sfdcAccountId,
			firstName: args.firstName || undefined,
			lastName: args.lastName,
			email: args.email,
			phone: args.phone || undefined,
			title: args.title || undefined,
			localUserId: args.userId
		},
		{ userId: args.actorUserId, accountId: args.accountId }
	);
	if (!sf.ok) return;

	try {
		await sql.begin(async (tx) => {
			await tx`
				UPDATE users SET sfdc_contact_id = ${sf.sfdcContactId}
				WHERE id = ${args.userId}
			`;
			await tx`
				UPDATE account_contacts SET sfdc_contact_id = ${sf.sfdcContactId}
				WHERE id = ${args.contactId}
			`;
		});
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'account.sync_team_user_sf',
			operation: 'persist_sfdc_contact_id',
			severity: 'warn',
			userId: args.actorUserId,
			accountId: args.accountId,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { userId: args.userId, contactId: args.contactId, sfdcContactId: sf.sfdcContactId }
		});
	}
}
