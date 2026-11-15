/**
 * Admin "Account merge" (AD-1944): fold a duplicate platform account (the SOURCE) into the account that stays (the SURVIVOR).
 *
 * Staff choose, per merge:
 *   - which value wins for each account field and for the Stripe customer,
 *   - which logins stay (and their role — exactly one owner) and which are disabled,
 *   - which stores (with their documents/cases/chat), contracts, contacts and activity history move.
 * Everything not chosen stays on the retired source account — nothing is deleted, so a merge can be reviewed or reversed
 * from account_merges (choices + every moved id). The local changes commit in ONE transaction together with the audit
 * event; the optional Salesforce re-parenting runs afterwards and reports per record (best effort, never rolled back).
 * See docs/account-merge-proposal.md.
 */
import type { Sql, TransactionSql } from 'postgres';
import { sql } from '../db';
import { sobjectUpdate } from '../salesforce/client';
import { updateSalesforceAccount } from '../salesforce/records';
import { logError, describeError } from '../error_log';
import { recordAudit, type AuditActor } from './audit';
import { ActionError, requireReason, EDITABLE_ACCOUNT_FIELDS, SF_FIELD, type EditableAccountField } from './actions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = Sql<any> | TransactionSql<any>;

export type Role = 'owner' | 'admin' | 'member';
export const ROLES: Role[] = ['owner', 'admin', 'member'];

export interface MergeAccount {
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
	stripe_customer_id: string | null;
	active_subscription_contract_id: string | null;
	merged_into_account_id: string | null;
	created_at: Date | string;
}
export interface MergeUser { id: string; email: string; display_name: string | null; role: string; is_active: boolean; sfdc_contact_id: string | null }
export interface MergeStore { id: string; name: string; seller_id: string | null; sfdc_store_id: string | null }
export interface MergeContract {
	id: string; kind: string; status: string; store_id: string | null;
	sfdc_service_contract_id: string | null; amount_cents: string | number; currency: string; paid_at: Date | string;
}
export interface MergeSide {
	account: MergeAccount;
	users: MergeUser[];
	stores: MergeStore[];
	contracts: MergeContract[];
	contactCount: number;
	activityCount: number;
}

export type UserDecision = Role | 'disable';
export interface MergeChoices {
	/** Which account's value each editable field takes. Missing field = survivor's. */
	fields: Partial<Record<EditableAccountField, 'survivor' | 'source'>>;
	stripe: 'survivor' | 'source';
	/** Decision for EVERY user of both accounts. */
	users: Record<string, UserDecision>;
	storeIds: string[];
	contractIds: string[];
	contacts: boolean;
	activity: boolean;
	salesforce: boolean;
	reason: string | null;
	/** Typed confirmation: the surviving account's name. */
	confirm: string | null;
}

const id15 = (id: string) => id.slice(0, 15);
const sameSf = (a: string | null, b: string | null) => !!a && !!b && id15(a) === id15(b);

export async function loadMergeSide(id: string, db: Db = sql): Promise<MergeSide | null> {
	const run = db as Sql;
	const [account] = await run<MergeAccount[]>`
		SELECT id, name, email, phone, website, billing_street, billing_city, billing_state, billing_postal_code, billing_country,
		       sfdc_account_id, stripe_customer_id, active_subscription_contract_id, merged_into_account_id, created_at
		FROM accounts WHERE id = ${id}`;
	if (!account) return null;
	const users = await run<MergeUser[]>`
		SELECT id, email, display_name, role, is_active, sfdc_contact_id FROM users WHERE account_id = ${id} ORDER BY created_at, id`;
	const stores = await run<MergeStore[]>`
		SELECT id, name, seller_id, sfdc_store_id FROM stores WHERE account_id = ${id} ORDER BY created_at, id`;
	const contracts = await run<MergeContract[]>`
		SELECT id, kind, status, store_id, sfdc_service_contract_id, amount_cents, currency, paid_at
		FROM service_contracts WHERE account_id = ${id} ORDER BY paid_at DESC, id`;
	const [counts] = await run<{ contacts: number; activity: number }[]>`
		SELECT (SELECT count(*) FROM account_contacts WHERE account_id = ${id})::int AS contacts,
		       (SELECT count(*) FROM activity_log WHERE account_id = ${id})::int AS activity`;
	return { account, users, stores, contracts, contactCount: counts?.contacts ?? 0, activityCount: counts?.activity ?? 0 };
}

/** Sensible starting choices for the review form. */
export function defaultChoices(survivor: MergeSide, source: MergeSide): MergeChoices {
	const fields: MergeChoices['fields'] = {};
	for (const f of EDITABLE_ACCOUNT_FIELDS) fields[f] = !survivor.account[f] && source.account[f] ? 'source' : 'survivor';
	const users: Record<string, UserDecision> = {};
	const survivorHasOwner = survivor.users.some((u) => u.role === 'owner' && u.is_active);
	for (const u of survivor.users) users[u.id] = (u.role as Role) in { owner: 1, admin: 1, member: 1 } ? (u.role as Role) : 'member';
	for (const u of source.users) {
		users[u.id] = !u.is_active ? 'disable' : u.role === 'owner' && survivorHasOwner ? 'admin' : (u.role as Role);
	}
	return {
		fields,
		stripe: !survivor.account.stripe_customer_id && source.account.stripe_customer_id ? 'source' : 'survivor',
		users,
		storeIds: source.stores.map((s) => s.id),
		contractIds: source.contracts.map((c) => c.id),
		contacts: true,
		activity: true,
		salesforce: !!survivor.account.sfdc_account_id && !!source.account.sfdc_account_id && !sameSf(survivor.account.sfdc_account_id, source.account.sfdc_account_id),
		reason: null,
		confirm: null
	};
}

export interface Validation { errors: string[]; warnings: string[] }

/** Pure rules: every blocking problem is listed so staff can fix them all at once. */
export function validateMerge(survivor: MergeSide, source: MergeSide, c: MergeChoices): Validation {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (survivor.account.id === source.account.id) errors.push('Choose two different accounts.');
	if (survivor.account.merged_into_account_id) errors.push(`${survivor.account.name} has already been merged into another account.`);
	if (source.account.merged_into_account_id) errors.push(`${source.account.name} has already been merged into another account.`);

	// Logins
	const all = [...survivor.users, ...source.users];
	let owners = 0;
	let kept = 0;
	for (const u of all) {
		const d = c.users[u.id];
		if (d === undefined) { errors.push(`Choose what happens to the login ${u.email}.`); continue; }
		if (d !== 'disable' && !ROLES.includes(d)) { errors.push(`Invalid role for ${u.email}.`); continue; }
		if (d !== 'disable') { kept++; if (d === 'owner') owners++; }
	}
	if (kept === 0) errors.push('At least one login must stay active on the final account.');
	else if (owners !== 1) errors.push(`The final account needs exactly one owner (you chose ${owners}).`);

	// Stores
	const srcStoreIds = new Set(source.stores.map((s) => s.id));
	const moveStores = new Set(c.storeIds);
	for (const id of moveStores) if (!srcStoreIds.has(id)) errors.push('A selected store does not belong to the account being merged.');
	const survivorSellers = new Map(survivor.stores.filter((s) => s.seller_id).map((s) => [s.seller_id!.toLowerCase(), s.name]));
	for (const s of source.stores) {
		if (moveStores.has(s.id) && s.seller_id && survivorSellers.has(s.seller_id.toLowerCase())) {
			errors.push(`Store "${s.name}" has the same seller ID as "${survivorSellers.get(s.seller_id.toLowerCase())}" in the final account — it is the same store. Leave it unselected.`);
		}
	}

	// Contracts
	const srcContracts = new Map(source.contracts.map((k) => [k.id, k]));
	const moveContracts = new Set(c.contractIds);
	for (const id of moveContracts) {
		const k = srcContracts.get(id);
		if (!k) { errors.push('A selected contract does not belong to the account being merged.'); continue; }
		if (k.store_id && srcStoreIds.has(k.store_id) && !moveStores.has(k.store_id)) {
			const st = source.stores.find((s) => s.id === k.store_id);
			errors.push(`A selected contract belongs to the store "${st?.name ?? k.store_id}". Move that store too, or leave the contract unselected.`);
		}
	}
	const srcSub = source.account.active_subscription_contract_id;
	if (srcSub && moveContracts.has(srcSub) && survivor.account.active_subscription_contract_id) {
		errors.push('Both accounts have an active subscription. Cancel one first, or leave the subscription contract unselected.');
	}

	// Fields / Stripe
	for (const [f, v] of Object.entries(c.fields)) {
		if (!(EDITABLE_ACCOUNT_FIELDS as string[]).includes(f) || (v !== 'survivor' && v !== 'source')) errors.push(`Invalid choice for ${f}.`);
	}
	if (c.stripe !== 'survivor' && c.stripe !== 'source') errors.push('Invalid Stripe customer choice.');
	if (c.stripe === 'source' && !source.account.stripe_customer_id) errors.push('The account being merged has no Stripe customer to keep.');

	// Confirmation
	if ((c.confirm ?? '').trim().toLowerCase() !== survivor.account.name.trim().toLowerCase()) {
		errors.push(`Type the final account's name ("${survivor.account.name}") to confirm.`);
	}

	// Warnings (not blocking)
	const sfBoth = !!survivor.account.sfdc_account_id && !!source.account.sfdc_account_id;
	if (c.salesforce && !sfBoth) warnings.push('Salesforce re-parenting needs both accounts linked to Salesforce; it will be skipped.');
	if (c.salesforce && sfBoth && sameSf(survivor.account.sfdc_account_id, source.account.sfdc_account_id)) warnings.push('Both accounts already share one Salesforce account; nothing to re-parent.');
	if (!c.salesforce && (moveContracts.size > 0 || moveStores.size > 0)) {
		warnings.push('Salesforce is not being updated: moved contracts, stores and their payments stay under the old Salesforce account, so outstanding payments will not show on the final account\'s dashboard until they are re-parented in Salesforce.');
	}
	if (c.stripe === 'source' && survivor.account.stripe_customer_id) warnings.push('The final account\'s own Stripe customer is dropped from the account (kept in the merge log; nothing is deleted in Stripe).');
	if (source.stores.length > moveStores.size || source.contracts.length > moveContracts.size) warnings.push('Unselected stores/contracts stay on the retired account and will not be visible to the customer.');
	return { errors, warnings };
}

export interface MergeResult {
	mergeId: string;
	moved: { users: number; disabled: number; stores: number; contracts: number; contacts: number; activity: number };
	salesforce: { attempted: boolean; ok: number; failed: { object: string; id: string; error: string }[]; note?: string };
}

interface Ctx { actor: AuditActor; ip?: string | null }

export async function mergeAccounts(ctx: Ctx, survivorId: string, sourceId: string, c: MergeChoices): Promise<MergeResult> {
	const why = requireReason(c.reason);
	if (survivorId === sourceId) throw new ActionError('Choose two different accounts.', 422);

	const [s0, t0] = await Promise.all([loadMergeSide(survivorId), loadMergeSide(sourceId)]);
	if (!s0 || !t0) throw new ActionError('Account not found.', 404);
	const pre = validateMerge(s0, t0, c);
	if (pre.errors.length) throw new ActionError(pre.errors.join(' '), 422);

	const movedStoreIds: string[] = [];
	const movedContractIds: string[] = [];
	const movedContacts: { id: string; sfdc_contact_id: string | null }[] = [];
	const keptSourceUsers: { id: string; sfdc_contact_id: string | null }[] = [];
	let activityMoved = 0;
	let disabled = 0;
	let mergeId = '';
	let survivor = s0;
	let source = t0;

	try {
		await sql.begin(async (tx) => {
			// Serialise concurrent merges touching either account, then re-validate against the locked, current state.
			await tx`SELECT id FROM accounts WHERE id IN (${survivorId}, ${sourceId}) ORDER BY id FOR UPDATE`;
			const [s, t] = await Promise.all([loadMergeSide(survivorId, tx), loadMergeSide(sourceId, tx)]);
			if (!s || !t) throw new ActionError('Account not found.', 404);
			const v = validateMerge(s, t, c);
			if (v.errors.length) throw new ActionError(v.errors.join(' '), 422);
			survivor = s;
			source = t;

			// 1. Account fields
			const patch: Record<string, string | null> = {};
			for (const f of EDITABLE_ACCOUNT_FIELDS) if (c.fields[f] === 'source') patch[f] = source.account[f] ?? null;
			const cols = Object.keys(patch);
			if (cols.length) await tx`UPDATE accounts SET ${tx(patch, ...cols)} WHERE id = ${survivorId}`;

			// 2. Stripe customer (unique per account: free it on the source before the survivor adopts it)
			if (c.stripe === 'source' && source.account.stripe_customer_id) {
				await tx`UPDATE accounts SET stripe_customer_id = NULL WHERE id = ${sourceId}`;
				await tx`UPDATE accounts SET stripe_customer_id = ${source.account.stripe_customer_id} WHERE id = ${survivorId}`;
			}

			// 3. Logins: disabled ones cannot sign in; kept ones get their role, source ones move to the survivor.
			for (const u of [...survivor.users, ...source.users]) {
				const d = c.users[u.id];
				const fromSource = source.users.some((x) => x.id === u.id);
				if (d === 'disable') {
					await tx`UPDATE users SET is_active = false WHERE id = ${u.id}`;
					await tx`DELETE FROM sessions WHERE user_id = ${u.id}`;
					disabled++;
				} else if (fromSource) {
					await tx`UPDATE users SET account_id = ${survivorId}, role = ${d} WHERE id = ${u.id}`;
					keptSourceUsers.push({ id: u.id, sfdc_contact_id: u.sfdc_contact_id });
				} else if (u.role !== d) {
					await tx`UPDATE users SET role = ${d} WHERE id = ${u.id}`;
				}
			}

			// 4. Stores (documents, cases and chat history follow by store_id)
			if (c.storeIds.length) {
				const rows = await tx<{ id: string }[]>`UPDATE stores SET account_id = ${survivorId} WHERE id = ANY(${c.storeIds}) AND account_id = ${sourceId} RETURNING id`;
				movedStoreIds.push(...rows.map((r) => r.id));
				if (movedStoreIds.length) await tx`UPDATE ai_chat_messages SET account_id = ${survivorId} WHERE store_id = ANY(${movedStoreIds}) AND account_id = ${sourceId}`;
			}

			// 5. Contracts (line items and payment applications follow by contract id)
			if (c.contractIds.length) {
				const rows = await tx<{ id: string }[]>`UPDATE service_contracts SET account_id = ${survivorId} WHERE id = ANY(${c.contractIds}) AND account_id = ${sourceId} RETURNING id`;
				movedContractIds.push(...rows.map((r) => r.id));
				const sub = source.account.active_subscription_contract_id;
				if (sub && movedContractIds.includes(sub)) {
					await tx`UPDATE accounts SET active_subscription_contract_id = NULL WHERE id = ${sourceId}`;
					await tx`UPDATE accounts SET active_subscription_contract_id = ${sub} WHERE id = ${survivorId} AND active_subscription_contract_id IS NULL`;
				}
			}

			// 6. Contacts: skip emails the survivor already has; a moved contact is never the point of contact (one per account).
			if (c.contacts) {
				const rows = await tx<{ id: string; sfdc_contact_id: string | null }[]>`
					UPDATE account_contacts SET account_id = ${survivorId}, is_point_of_contact = false
					WHERE account_id = ${sourceId}
					  AND lower(email) NOT IN (SELECT lower(email) FROM account_contacts WHERE account_id = ${survivorId})
					RETURNING id, sfdc_contact_id`;
				movedContacts.push(...rows);
			}

			// 7. Activity history
			if (c.activity) {
				const rows = await tx<{ id: string }[]>`UPDATE activity_log SET account_id = ${survivorId} WHERE account_id = ${sourceId} RETURNING id`;
				activityMoved = rows.length;
			}

			// 8. Retire the source and record the merge
			await tx`UPDATE accounts SET merged_into_account_id = ${survivorId}, merged_at = now() WHERE id = ${sourceId}`;
			const moved = {
				users: keptSourceUsers.map((u) => u.id),
				stores: movedStoreIds,
				contracts: movedContractIds,
				contacts: movedContacts.map((m) => m.id),
				activity: activityMoved
			};
			const choices = { fields: c.fields, stripe: c.stripe, users: c.users, storeIds: c.storeIds, contractIds: c.contractIds, contacts: c.contacts, activity: c.activity, salesforce: c.salesforce };
			const [row] = await tx<{ id: string }[]>`
				INSERT INTO account_merges (survivor_account_id, source_account_id, actor_ref, reason, choices, moved)
				VALUES (${survivorId}, ${sourceId}, ${ctx.actor.ref}, ${why}, ${tx.json(choices as never)}, ${tx.json(moved as never)})
				RETURNING id`;
			mergeId = row.id;
			await recordAudit({
				actor: ctx.actor, action: 'account.merge', targetType: 'account', targetId: survivorId, targetAccountId: survivorId,
				outcome: 'success', reason: why, ip: ctx.ip,
				metadata: { sourceAccountId: sourceId, mergeId, users: moved.users.length, disabled, stores: movedStoreIds.length, contracts: movedContractIds.length, contacts: movedContacts.length, activity: activityMoved }
			}, tx);
		});
	} catch (e) {
		if (e instanceof ActionError) throw e;
		const d = describeError(e);
		await logError({ source: 'admin.merge', operation: 'local_merge', errorMessage: d.errorMessage, stack: d.stack, context: { survivorId, sourceId } });
		throw new ActionError('The merge could not be completed. Nothing was changed.', 502);
	}

	const sfResult = await reparentInSalesforce(c, survivor, source, movedStoreIds, movedContractIds, movedContacts, keptSourceUsers);
	if (sfResult.attempted) {
		await sql`UPDATE account_merges SET sf_result = ${sql.json(sfResult as never)} WHERE id = ${mergeId}`.catch(() => undefined);
		for (const f of sfResult.failed) await logError({ source: 'admin.merge', operation: 'sf_reparent', severity: 'warn', accountId: survivorId, errorMessage: `${f.object} ${f.id}: ${f.error}` });
	}
	return {
		mergeId,
		moved: { users: keptSourceUsers.length, disabled, stores: movedStoreIds.length, contracts: movedContractIds.length, contacts: movedContacts.length, activity: activityMoved },
		salesforce: sfResult
	};
}

/** After the local commit: point the moved records' Salesforce counterparts at the survivor's Salesforce account. */
async function reparentInSalesforce(
	c: MergeChoices, survivor: MergeSide, source: MergeSide,
	storeIds: string[], contractIds: string[], contacts: { id: string; sfdc_contact_id: string | null }[], users: { id: string; sfdc_contact_id: string | null }[]
): Promise<MergeResult['salesforce']> {
	const sfS = survivor.account.sfdc_account_id;
	const sfT = source.account.sfdc_account_id;
	if (!c.salesforce) return { attempted: false, ok: 0, failed: [], note: 'Not requested.' };
	if (!sfS || !sfT) return { attempted: false, ok: 0, failed: [], note: 'One of the accounts is not linked to Salesforce.' };
	if (sameSf(sfS, sfT)) return { attempted: false, ok: 0, failed: [], note: 'Both accounts already share one Salesforce account.' };

	const failed: { object: string; id: string; error: string }[] = [];
	let ok = 0;
	const run = async (object: string, id: string, body: Record<string, unknown>) => {
		try { await sobjectUpdate(object, id, body); ok++; return true; }
		catch (e) { failed.push({ object, id, error: describeError(e).errorMessage }); return false; }
	};

	const storeSf = source.stores.filter((s) => storeIds.includes(s.id) && s.sfdc_store_id);
	for (const s of storeSf) await run('Store__c', s.sfdc_store_id!, { Account__c: sfS });

	const contractSf = source.contracts.filter((k) => contractIds.includes(k.id) && k.sfdc_service_contract_id);
	for (const k of contractSf) {
		if (await run('ServiceContract', k.sfdc_service_contract_id!, { AccountId: sfS })) {
			await sql`UPDATE service_contracts SET sfdc_account_id = ${sfS} WHERE id = ${k.id}`.catch(() => undefined);
		}
	}

	const contactIds = new Map<string, string | null>(); // sf contact id -> local user id (if a login)
	for (const u of users) if (u.sfdc_contact_id) contactIds.set(u.sfdc_contact_id, u.id);
	for (const m of contacts) if (m.sfdc_contact_id && !contactIds.has(m.sfdc_contact_id)) contactIds.set(m.sfdc_contact_id, null);
	for (const [sfContact, userId] of contactIds) {
		if (await run('Contact', sfContact, { AccountId: sfS }) && userId) {
			await sql`UPDATE users SET sfdc_account_id = ${sfS} WHERE id = ${userId}`.catch(() => undefined);
		}
	}

	// Account field values chosen from the source go onto the surviving Salesforce account too.
	const sfPatch: Record<string, string | null> = {};
	for (const f of EDITABLE_ACCOUNT_FIELDS) if (c.fields[f] === 'source' && SF_FIELD[f]) sfPatch[SF_FIELD[f]!] = source.account[f] ?? null;
	if (Object.keys(sfPatch).length) {
		const r = await updateSalesforceAccount(sfS, sfPatch, { accountId: survivor.account.id });
		if (r.ok) ok++; else failed.push({ object: 'Account', id: sfS, error: r.error });
	}
	return {
		attempted: true, ok, failed,
		note: 'Cases and other Salesforce records that are not tracked locally are not moved here — use Salesforce\'s Merge Accounts for those.'
	};
}
