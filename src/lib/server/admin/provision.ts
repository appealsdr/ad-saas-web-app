/**
 * Admin "Account provision" (AD-1944, AD-1968): Salesforce Accounts with a blank appealsdoctor_vuid__c and no platform account
 * (service contracts are optional).
 *
 * Contracts of a linked account are read live from Salesforce (dashboard "Outstanding payments", /payments),
 * so linking the Salesforce Account to a platform account is what makes its contracts appear in the platform —
 * no local service_contracts rows are copied. This module:
 *   - lists such Salesforce accounts (read-only, with a "possible existing platform account" hint so staff merge
 *     instead of creating a duplicate), and
 *   - provisions one: local Account (+ optional owner login) + selected Stores, linked to the EXISTING Salesforce
 *     records. Nothing is created in Salesforce; only the vuid is backfilled.
 */
import { sql } from '../db';
import { sfdcQuery } from '../salesforce/client';
import { VUID_FIELD } from '../salesforce/vuid';
import { fetchSalesforceAccount, fetchSalesforceContact, updateSalesforceAccount, updateSalesforceContact } from '../salesforce/records';
import { updateSalesforceStore } from '../salesforce/stores';
import { hashPassword } from '../auth/password';
import { generateTempPassword } from '../auth/temp_password';
import { ensureAccountFolders } from '../storage/s3-paths';
import { ensureOwnerAccountContact } from '../account/contacts';
import { logError, describeError } from '../error_log';
import { recordAudit, type AuditActor } from './audit';
import { ActionError, requireReason } from './actions';
import { isSalesforceId, soqlList, soqlString } from '../salesforce/soql';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const id15 = (id: string) => id.slice(0, 15);

// ─── Types ────────────────────────────────────────────────────────────────

export interface SfContractRow {
	Id: string;
	Name: string | null;
	ContractNumber: string | null;
	StartDate: string | null;
	EndDate: string | null;
	AccountId: string;
	Account?: { Name: string | null; Phone: string | null; Website: string | null; Primary_Email__c: string | null } | null;
}
export interface SfAccountRow { Id: string; Name: string | null; Phone: string | null; Website: string | null; Primary_Email__c: string | null }
export interface SfContactRow { Id: string; FirstName: string | null; LastName: string | null; Email: string | null; AccountId: string }
export interface SfStoreRow { Id: string; Name: string; Account__c: string; Seller_ID__c: string | null; Marketplaces__c: string | null }

export interface PlatformMatch {
	accountId: string;
	name: string;
	sfdcAccountId: string | null;
	reason: 'email' | 'name';
}

export interface ProvisionCandidate {
	sfdcAccountId: string;
	name: string;
	email: string | null;
	phone: string | null;
	website: string | null;
	contracts: { id: string; name: string; number: string | null; startDate: string | null; endDate: string | null }[];
	contacts: { id: string; name: string; email: string | null }[];
	stores: { id: string; name: string; sellerId: string | null; marketplaces: string | null }[];
	/** Platform accounts that look like the same customer: provisioning would likely create a duplicate. */
	matches: PlatformMatch[];
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────────────

/** Group Salesforce contract/contact/store rows by Account and drop accounts already linked to a platform account. */
export function buildCandidates(
	contracts: SfContractRow[],
	contacts: SfContactRow[],
	stores: SfStoreRow[],
	linkedSfIds: Iterable<string>,
	/** Accounts to list even when they have no contract (AD-1968: contracts are optional). */
	accounts: SfAccountRow[] = []
): ProvisionCandidate[] {
	const linked = new Set<string>();
	for (const id of linkedSfIds) if (id) linked.add(id15(id));
	const byAccount = new Map<string, ProvisionCandidate>();
	for (const a of accounts) {
		if (!a.Id || linked.has(id15(a.Id)) || byAccount.has(a.Id)) continue;
		byAccount.set(a.Id, {
			sfdcAccountId: a.Id, name: a.Name ?? '(no name)', email: a.Primary_Email__c ?? null, phone: a.Phone ?? null,
			website: a.Website ?? null, contracts: [], contacts: [], stores: [], matches: []
		});
	}
	for (const c of contracts) {
		if (!c.AccountId || linked.has(id15(c.AccountId))) continue;
		let cand = byAccount.get(c.AccountId);
		if (!cand) {
			cand = {
				sfdcAccountId: c.AccountId,
				name: c.Account?.Name ?? '(no name)',
				email: c.Account?.Primary_Email__c ?? null,
				phone: c.Account?.Phone ?? null,
				website: c.Account?.Website ?? null,
				contracts: [], contacts: [], stores: [], matches: []
			};
			byAccount.set(c.AccountId, cand);
		}
		cand.contracts.push({
			id: c.Id, name: c.Name ?? c.ContractNumber ?? 'Service contract', number: c.ContractNumber,
			startDate: c.StartDate, endDate: c.EndDate
		});
	}
	for (const k of contacts) {
		const cand = byAccount.get(k.AccountId);
		if (cand) cand.contacts.push({ id: k.Id, name: [k.FirstName, k.LastName].filter(Boolean).join(' '), email: k.Email });
	}
	for (const s of stores) {
		const cand = byAccount.get(s.Account__c);
		if (cand) cand.stores.push({ id: s.Id, name: s.Name, sellerId: s.Seller_ID__c, marketplaces: s.Marketplaces__c });
	}
	return [...byAccount.values()];
}

const normName = (s: string) => s.toLowerCase().replace(/\b(llc|inc|ltd|co|corp|company)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Attach platform accounts with the same email (account or any user) or the same normalised company name. */
export function attachMatches(
	cands: ProvisionCandidate[],
	local: { id: string; name: string; sfdc_account_id: string | null; emails: string[] }[]
): void {
	for (const cand of cands) {
		const emails = new Set([cand.email, ...cand.contacts.map((c) => c.email)].filter((e): e is string => !!e).map((e) => e.toLowerCase()));
		const nm = normName(cand.name);
		for (const l of local) {
			if (l.sfdc_account_id && id15(l.sfdc_account_id) === id15(cand.sfdcAccountId)) continue;
			if (l.emails.some((e) => emails.has(e.toLowerCase()))) cand.matches.push({ accountId: l.id, name: l.name, sfdcAccountId: l.sfdc_account_id, reason: 'email' });
			else if (nm.length >= 3 && normName(l.name) === nm) cand.matches.push({ accountId: l.id, name: l.name, sfdcAccountId: l.sfdc_account_id, reason: 'name' });
		}
	}
}

// ─── Listing ──────────────────────────────────────────────────────────────

export interface ProvisionList {
	candidates: ProvisionCandidate[];
	/** Salesforce accounts (blank vuid) that are already linked to a platform account (not shown). */
	alreadyLinked: number;
	truncated: boolean;
}

const MAX_ACCOUNTS = 2000;

/**
 * Read-only. Throws if Salesforce cannot be queried (the page shows the error instead of an empty list).
 * Lists every Salesforce Account whose appealsdoctor_vuid__c is blank (not yet on the platform) and that is not
 * already linked to a platform account — with or without service contracts.
 */
export async function listProvisionCandidates(q = ''): Promise<ProvisionList> {
	const accountsRes = await sfdcQuery<SfAccountRow>(
		`SELECT Id, Name, Phone, Website, Primary_Email__c FROM Account
		 WHERE ${VUID_FIELD} = null ORDER BY CreatedDate DESC LIMIT ${MAX_ACCOUNTS}`,
		{ paginate: true }
	);
	const accounts = accountsRes.records;
	const sfAccountIds = accounts.map((a) => a.Id);
	if (!sfAccountIds.length) return { candidates: [], alreadyLinked: 0, truncated: false };

	const linkedRows = await sql<{ sfdc_account_id: string }[]>`SELECT sfdc_account_id FROM accounts WHERE sfdc_account_id IS NOT NULL`;
	const linked = new Set(linkedRows.map((r) => id15(r.sfdc_account_id)));
	const unlinkedIds = sfAccountIds.filter((id) => !linked.has(id15(id)));
	const alreadyLinked = sfAccountIds.length - unlinkedIds.length;
	const truncated = accounts.length >= MAX_ACCOUNTS;
	if (!unlinkedIds.length) return { candidates: [], alreadyLinked, truncated };

	const contracts: SfContractRow[] = [];
	const contacts: SfContactRow[] = [];
	const stores: SfStoreRow[] = [];
	for (let i = 0; i < unlinkedIds.length; i += 150) {
		const list = soqlList(unlinkedIds.slice(i, i + 150));
		const [k, c, s] = await Promise.all([
			sfdcQuery<SfContractRow>(`SELECT Id, Name, ContractNumber, StartDate, EndDate, AccountId FROM ServiceContract WHERE AccountId IN (${list}) ORDER BY CreatedDate DESC`, { paginate: true }),
			sfdcQuery<SfContactRow>(`SELECT Id, FirstName, LastName, Email, AccountId FROM Contact WHERE AccountId IN (${list}) ORDER BY CreatedDate ASC`, { paginate: true }),
			sfdcQuery<SfStoreRow>(`SELECT Id, Name, Account__c, Seller_ID__c, Marketplaces__c FROM Store__c WHERE Account__c IN (${list})`, { paginate: true })
		]);
		contracts.push(...k.records);
		contacts.push(...c.records);
		stores.push(...s.records);
	}

	let candidates = buildCandidates(contracts, contacts, stores, linked, accounts);
	const needle = q.trim().toLowerCase();
	if (needle) {
		candidates = candidates.filter((c) =>
			[c.name, c.email ?? '', c.sfdcAccountId, ...c.contacts.map((k) => k.email ?? ''), ...c.contracts.map((k) => k.name)].some((v) => v.toLowerCase().includes(needle))
		);
	}

	// Possible existing platform accounts for the remaining candidates (email via account or any user, or same name).
	const local = await sql<{ id: string; name: string; sfdc_account_id: string | null; emails: string[] | null }[]>`
		SELECT a.id, a.name, a.sfdc_account_id,
		       array_remove(array_agg(DISTINCT lower(u.email)) || array[lower(a.email)], NULL) AS emails
		FROM accounts a LEFT JOIN users u ON u.account_id = a.id
		GROUP BY a.id`;
	attachMatches(candidates, local.map((l) => ({ ...l, emails: l.emails ?? [] })));
	candidates.sort((a, b) => a.name.localeCompare(b.name));
	return { candidates, alreadyLinked, truncated };
}

// ─── Provision action ─────────────────────────────────────────────────────

interface Ctx { actor: AuditActor; ip?: string | null }

export interface ProvisionInput {
	sfdcAccountId: string;
	sfdcContactId: string | null;
	storeIds: string[];
	createLogin: boolean;
	reason: string | null;
}
export interface ProvisionResult {
	accountId: string;
	userId: string | null;
	/** Shown to staff exactly once; never stored or audited. */
	temporaryPassword: string | null;
	stores: number;
	warnings: string[];
}

export async function provisionFromSalesforce(ctx: Ctx, input: ProvisionInput): Promise<ProvisionResult> {
	const why = requireReason(input.reason);
	const sfId = input.sfdcAccountId.trim();
	if (!isSalesforceId(sfId)) throw new ActionError('Invalid Salesforce account id.', 422);
	if (input.sfdcContactId && !isSalesforceId(input.sfdcContactId)) throw new ActionError('Invalid Salesforce contact id.', 422);

	// Live truth from Salesforce — never trust ids/fields posted by the browser.
	const accRes = await fetchSalesforceAccount(sfId);
	if (!accRes.ok) throw new ActionError(`Could not read the Salesforce account: ${accRes.error}`, 502);
	const sfAcc = accRes.record;
	const sfStores = await sfdcQuery<SfStoreRow & { Business_Name__c: string | null; Seller_Account_Primary_Email__c: string | null; Store_Email__c: string | null; Country__c: string | null; Description__c: string | null }>(
		`SELECT Id, Name, Account__c, Seller_ID__c, Marketplaces__c, Business_Name__c, Seller_Account_Primary_Email__c, Store_Email__c, Country__c, Description__c FROM Store__c WHERE Account__c = ${soqlString(sfId)}`
	);
	const wanted = new Set(input.storeIds);
	const chosenStores = sfStores.records.filter((s) => wanted.has(s.Id));
	if (chosenStores.length !== wanted.size) throw new ActionError('A selected store does not belong to this Salesforce account.', 422);

	let contact: { id: string; first: string | null; last: string | null; email: string | null; phone: string | null } | null = null;
	if (input.createLogin) {
		if (!input.sfdcContactId) throw new ActionError('Choose the Salesforce contact who will get the login.', 422);
		const c = await fetchSalesforceContact(input.sfdcContactId);
		if (!c.ok || c.record.AccountId !== sfAcc.Id) throw new ActionError('That contact does not belong to this Salesforce account.', 422);
		contact = { id: c.record.Id, first: c.record.FirstName ?? null, last: c.record.LastName ?? null, email: c.record.Email ?? null, phone: c.record.Phone ?? null };
		if (!contact.email || !EMAIL_RE.test(contact.email)) throw new ActionError('The selected contact has no valid email address.', 422);
	}

	const [linked] = await sql<{ id: string }[]>`SELECT id FROM accounts WHERE sfdc_account_id = ${sfAcc.Id} OR sfdc_account_id = ${id15(sfAcc.Id)} LIMIT 1`;
	if (linked) throw new ActionError('This Salesforce account is already linked to a platform account.', 409);
	const email = contact?.email?.toLowerCase() ?? null;
	if (email) {
		const [dup] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
		if (dup) throw new ActionError('A platform user with this email already exists — use Account merge instead of provisioning a duplicate.', 409);
	}

	const tempPassword = input.createLogin ? generateTempPassword() : null;
	const passwordHash = tempPassword ? await hashPassword(tempPassword) : null;
	const accountEmail = email ?? sfAcc.Primary_Email__c ?? null;

	let accountId = '';
	let userId: string | null = null;
	const localStoreIds: { local: string; sf: string }[] = [];
	try {
		await sql.begin(async (tx) => {
			const [account] = await tx<{ id: string }[]>`
				INSERT INTO accounts (name, email, phone, website, sfdc_account_id)
				VALUES (${sfAcc.Name ?? '(no name)'}, ${accountEmail}, ${sfAcc.Phone ?? contact?.phone ?? null}, ${sfAcc.Website ?? null}, ${sfAcc.Id})
				RETURNING id`;
			accountId = account.id;
			if (contact && passwordHash) {
				const [user] = await tx<{ id: string }[]>`
					INSERT INTO users (email, display_name, password_hash, account_id, role, must_reset_password, sfdc_contact_id, sfdc_account_id)
					VALUES (${email}, ${[contact.first, contact.last].filter(Boolean).join(' ')}, ${passwordHash}, ${accountId}, 'owner', true, ${contact.id}, ${sfAcc.Id})
					RETURNING id`;
				userId = user.id;
			}
			for (const s of chosenStores) {
				const [row] = await tx<{ id: string }[]>`
					INSERT INTO stores (account_id, created_by, name, marketplaces, seller_id, seller_primary_email, store_email, business_name, country, description, sfdc_store_id)
					VALUES (${accountId}, ${userId}, ${s.Name}, ${s.Marketplaces__c}, ${s.Seller_ID__c}, ${s.Seller_Account_Primary_Email__c},
					        ${s.Store_Email__c}, ${s.Business_Name__c}, ${s.Country__c}, ${s.Description__c}, ${s.Id})
					RETURNING id`;
				localStoreIds.push({ local: row.id, sf: s.Id });
			}
			await recordAudit({
				actor: ctx.actor, action: 'account.provision_from_salesforce', targetType: 'account', targetId: accountId, targetAccountId: accountId,
				outcome: 'success', reason: why, ip: ctx.ip,
				metadata: { sfdcAccountId: sfAcc.Id, sfdcContactId: contact?.id ?? null, loginCreated: !!userId, stores: localStoreIds.length }
			}, tx);
		});
	} catch (e) {
		if ((e as { code?: string })?.code === '23505') throw new ActionError('A record with one of these Salesforce ids or emails already exists on the platform.', 409);
		const d = describeError(e);
		await logError({ source: 'admin.provision', operation: 'insert_local', errorMessage: d.errorMessage, stack: d.stack, context: { sfdcAccountId: sfAcc.Id } });
		throw new ActionError('Could not provision the account. Nothing was created.', 502);
	}

	// Best-effort follow-ups: the local records are committed, so problems here are reported, not fatal.
	const warnings: string[] = [];
	const backfill = async (label: string, run: Promise<{ ok: boolean; error?: string }>) => {
		const r = await run;
		if (!r.ok) warnings.push(`Salesforce ${label} vuid backfill failed: ${r.error ?? 'unknown error'}`);
	};
	await backfill('Account', updateSalesforceAccount(sfAcc.Id, {}, { accountId }));
	if (contact && userId) await backfill('Contact', updateSalesforceContact(contact.id, {}, { userId, accountId }));
	for (const s of localStoreIds) await backfill('Store', updateSalesforceStore(s.sf, {}, { accountId, userId: userId ?? undefined, localStoreId: s.local }));
	try { await ensureAccountFolders(accountId); } catch (e) { warnings.push(`Document folders were not created: ${describeError(e).errorMessage}`); }
	if (userId) { try { await ensureOwnerAccountContact(accountId, userId); } catch (e) { warnings.push(`Owner contact link failed: ${describeError(e).errorMessage}`); } }
	for (const w of warnings) await logError({ source: 'admin.provision', operation: 'follow_up', severity: 'warn', accountId, errorMessage: w });

	return { accountId, userId, temporaryPassword: tempPassword, stores: localStoreIds.length, warnings };
}
