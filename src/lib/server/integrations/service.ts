/**
 * Admin-side management of API integrations (AD-1966). Every mutation is
 * scoped to ONE integration (re-checked against the account) and commits its
 * audit event (admin_audit_events) in the same transaction. Nothing here ever
 * touches a sibling integration, except pauseAllIntegrations, which is a
 * separate, explicitly confirmed account-level action.
 */
import { sql } from '../db';
import { recordAudit, type AuditActor } from '../admin/audit';
import { ActionError, requireReason } from '../admin/actions';
import { generateCredential, type IntegrationStatus } from './auth';
import { INTEGRATION_PERMISSIONS, diffPermissions, normalizePermissions, type IntegrationPermission } from './permissions';
import { parseCidrList } from './ip';

interface Ctx {
	actor: AuditActor;
	ip?: string | null;
}

export interface IntegrationRow {
	id: string;
	account_id: string;
	name: string;
	default_user_id: string;
	default_user_name: string | null;
	default_user_email: string | null;
	status: IntegrationStatus;
	permissions: string[];
	allowed_ip_ranges: string[] | null;
	rate_limit_per_minute: number;
	credential_ttl_days: number | null;
	rotation_grace_hours: number;
	paused_at: Date | null;
	pause_reason: string | null;
	disabled_at: Date | null;
	disable_reason: string | null;
	created_at: Date;
	updated_at: Date;
	last_used_at: Date | null;
	active_credentials: number;
}

const SELECT = sql`
	SELECT i.id, i.account_id, i.name, i.default_user_id, u.display_name AS default_user_name, u.email AS default_user_email,
	       i.status, i.permissions, i.allowed_ip_ranges::text[] AS allowed_ip_ranges, i.rate_limit_per_minute,
	       i.credential_ttl_days, i.rotation_grace_hours, i.paused_at, i.pause_reason, i.disabled_at, i.disable_reason,
	       i.created_at, i.updated_at,
	       (SELECT max(c.last_used_at) FROM integration_credentials c WHERE c.integration_client_id = i.id) AS last_used_at,
	       (SELECT count(*)::int FROM integration_credentials c
	         WHERE c.integration_client_id = i.id AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())) AS active_credentials
	FROM integration_clients i JOIN users u ON u.id = i.default_user_id`;

export const listIntegrations = (accountId: string) =>
	sql<IntegrationRow[]>`${SELECT} WHERE i.account_id = ${accountId} ORDER BY lower(i.name), i.id`;

export async function getIntegration(accountId: string, id: string): Promise<IntegrationRow | null> {
	const rows = await sql<IntegrationRow[]>`${SELECT} WHERE i.account_id = ${accountId} AND i.id = ${id}`;
	return rows[0] ?? null;
}

export interface CredentialRow {
	id: string;
	label: string | null;
	key_prefix: string;
	expires_at: Date | null;
	revoked_at: Date | null;
	revoke_reason: string | null;
	last_used_at: Date | null;
	last_used_ip: string | null;
	created_at: Date;
}

/** Metadata only — the hash and raw secret are never selected. */
export const listCredentials = (integrationId: string) =>
	sql<CredentialRow[]>`
		SELECT id, label, key_prefix, expires_at, revoked_at, revoke_reason, last_used_at, host(last_used_ip) AS last_used_ip, created_at
		FROM integration_credentials WHERE integration_client_id = ${integrationId}
		ORDER BY created_at DESC`;

// ─── Validation ───────────────────────────────────────────────────────────

export interface IntegrationInput {
	name: string;
	defaultUserId: string;
	permissions?: string[] | null; // null/undefined → all permissions
	copyPermissionsFromId?: string | null;
	allowedIps?: string; // newline/comma separated; '' = no restriction
	rateLimitPerMinute?: number;
	credentialTtlDays?: number | null;
	rotationGraceHours?: number;
}

function validateName(raw: string): string {
	const name = raw.trim();
	if (!name) throw new ActionError('Integration name is required.', 422);
	if (name.length > 100) throw new ActionError('Integration name must be 100 characters or fewer.', 422);
	return name;
}

async function requireAccountUser(accountId: string, userId: string): Promise<void> {
	const [u] = await sql<{ is_active: boolean }[]>`SELECT is_active FROM users WHERE id = ${userId} AND account_id = ${accountId}`;
	if (!u) throw new ActionError('The default user must be a user of this account.', 422);
	if (!u.is_active) throw new ActionError('The default user is suspended.', 422);
}

function parseSettings(input: Pick<IntegrationInput, 'allowedIps' | 'rateLimitPerMinute' | 'credentialTtlDays' | 'rotationGraceHours'>) {
	let ips: string[] = [];
	try {
		ips = parseCidrList(input.allowedIps ?? '');
	} catch (e) {
		throw new ActionError(e instanceof Error ? e.message : 'Invalid IP allowlist.', 422);
	}
	const rate = input.rateLimitPerMinute ?? 60;
	if (!Number.isInteger(rate) || rate < 1 || rate > 10_000) throw new ActionError('Rate limit must be a whole number between 1 and 10,000 per minute.', 422);
	const ttl = input.credentialTtlDays ?? null;
	if (ttl !== null && (!Number.isInteger(ttl) || ttl < 1 || ttl > 3650)) throw new ActionError('Credential lifetime must be between 1 and 3650 days (or empty for no expiry).', 422);
	const grace = input.rotationGraceHours ?? 24;
	if (!Number.isInteger(grace) || grace < 0 || grace > 720) throw new ActionError('Rotation grace period must be between 0 and 720 hours.', 422);
	return { ips, rate, ttl, grace };
}

function mapDbError(e: unknown): never {
	const err = e as { code?: string; message?: string };
	if (err?.code === '23505') throw new ActionError('An integration with this name already exists on this account.', 409);
	if (err?.code === '23514') throw new ActionError(err.message?.includes('default_user') ? 'The default user must be a user of this account.' : 'The submitted values are not allowed.', 422);
	if (err?.code === '22P02' && /cidr/i.test(err.message ?? '')) throw new ActionError('An IP range has host bits set (use the network address, e.g. 10.0.0.0/24).', 422);
	throw e;
}

// ─── Create / update ─────────────────────────────────────────────────────

export async function createIntegration(
	ctx: Ctx,
	accountId: string,
	input: IntegrationInput,
	opts: { issueCredential?: boolean } = {}
): Promise<{ id: string; rawKey: string | null }> {
	const name = validateName(input.name);
	await requireAccountUser(accountId, input.defaultUserId);
	const s = parseSettings(input);

	// New integrations start with ALL permissions unless the admin unchecked some,
	// or explicitly chose to copy another integration's profile.
	let permissions: IntegrationPermission[];
	let copiedFrom: string | null = null;
	try {
		if (input.copyPermissionsFromId) {
			const src = await getIntegration(accountId, input.copyPermissionsFromId);
			if (!src) throw new ActionError('The integration to copy permissions from was not found on this account.', 422);
			permissions = normalizePermissions(src.permissions);
			copiedFrom = src.id;
		} else {
			permissions = normalizePermissions(input.permissions ?? [...INTEGRATION_PERMISSIONS]);
		}
	} catch (e) {
		if (e instanceof ActionError) throw e;
		throw new ActionError(e instanceof Error ? e.message : 'Invalid permissions.', 422);
	}

	try {
		return await sql.begin(async (tx) => {
			const [row] = await tx<{ id: string }[]>`
				INSERT INTO integration_clients (account_id, name, default_user_id, permissions, allowed_ip_ranges, rate_limit_per_minute,
				                                 credential_ttl_days, rotation_grace_hours, created_by, updated_by)
				VALUES (${accountId}, ${name}, ${input.defaultUserId}, ${permissions}, ${s.ips.length ? s.ips : null}::cidr[], ${s.rate},
				        ${s.ttl}, ${s.grace}, ${ctx.actor.userId}, ${ctx.actor.userId})
				RETURNING id`;
			let rawKey: string | null = null;
			if (opts.issueCredential !== false) rawKey = await insertCredential(tx, row.id, 'Initial credential', s.ttl, ctx.actor.userId);
			await recordAudit(
				{ actor: ctx.actor, action: 'integration.create', targetType: 'integration_client', targetId: row.id, targetAccountId: accountId,
				  outcome: 'success', ip: ctx.ip,
				  metadata: { integrationId: row.id, name, defaultUserId: input.defaultUserId, permissions, copiedFromIntegrationId: copiedFrom,
				              credentialIssued: rawKey !== null } },
				tx
			);
			return { id: row.id, rawKey };
		});
	} catch (e) {
		mapDbError(e);
	}
}

export async function updateIntegration(ctx: Ctx, accountId: string, id: string, input: IntegrationInput): Promise<string[]> {
	const cur = await getIntegration(accountId, id);
	if (!cur) throw new ActionError('Integration not found.', 404);
	const name = validateName(input.name);
	if (input.defaultUserId !== cur.default_user_id) await requireAccountUser(accountId, input.defaultUserId);
	const s = parseSettings(input);
	let permissions: IntegrationPermission[];
	try {
		permissions = normalizePermissions(input.permissions ?? cur.permissions);
	} catch (e) {
		throw new ActionError(e instanceof Error ? e.message : 'Invalid permissions.', 422);
	}

	const changed: string[] = [];
	if (name !== cur.name) changed.push('name');
	if (input.defaultUserId !== cur.default_user_id) changed.push('defaultUser');
	const diff = diffPermissions(cur.permissions, permissions);
	if (diff.addedPermissions.length || diff.removedPermissions.length) changed.push('permissions');
	if (JSON.stringify(s.ips) !== JSON.stringify(cur.allowed_ip_ranges?.map(normalizeCidr) ?? [])) changed.push('allowedIpRanges');
	if (s.rate !== cur.rate_limit_per_minute) changed.push('rateLimit');
	if (s.ttl !== cur.credential_ttl_days) changed.push('credentialTtlDays');
	if (s.grace !== cur.rotation_grace_hours) changed.push('rotationGraceHours');
	if (!changed.length) throw new ActionError('No changes to save.', 422);

	try {
		await sql.begin(async (tx) => {
			// Scoped by id AND account: a tampered id can never reach another account's integration.
			await tx`
				UPDATE integration_clients SET name = ${name}, default_user_id = ${input.defaultUserId}, permissions = ${permissions},
				       allowed_ip_ranges = ${s.ips.length ? s.ips : null}::cidr[], rate_limit_per_minute = ${s.rate},
				       credential_ttl_days = ${s.ttl}, rotation_grace_hours = ${s.grace}, updated_by = ${ctx.actor.userId}
				WHERE id = ${id} AND account_id = ${accountId}`;
			await recordAudit(
				{ actor: ctx.actor, action: 'integration.update', targetType: 'integration_client', targetId: id, targetAccountId: accountId,
				  outcome: 'success', ip: ctx.ip,
				  metadata: { integrationId: id, changed, ...(changed.includes('permissions') ? diff : {}),
				              ...(changed.includes('name') ? { name: { from: cur.name, to: name } } : {}),
				              ...(changed.includes('defaultUser') ? { defaultUserId: { from: cur.default_user_id, to: input.defaultUserId } } : {}) } },
				tx
			);
		});
	} catch (e) {
		mapDbError(e);
	}
	return changed;
}

function normalizeCidr(c: string): string {
	return c.includes('/') ? c : `${c}/${c.includes(':') ? 128 : 32}`;
}

// ─── Status ───────────────────────────────────────────────────────────────

export async function setIntegrationStatus(
	ctx: Ctx, accountId: string, id: string, action: 'pause' | 'resume' | 'disable', reason: string | null
): Promise<void> {
	const cur = await getIntegration(accountId, id);
	if (!cur) throw new ActionError('Integration not found.', 404);
	const why = action === 'resume' ? (reason ?? '').trim() || null : requireReason(reason);
	const uid = ctx.actor.userId;
	const next: IntegrationStatus = action === 'pause' ? 'paused' : action === 'disable' ? 'disabled' : 'active';
	if (cur.status === next) throw new ActionError(`Integration is already ${next}.`, 409);
	if (action === 'pause' && cur.status === 'disabled') throw new ActionError('A disabled integration cannot be paused. Resume it first.', 409);

	await sql.begin(async (tx) => {
		if (action === 'pause') {
			await tx`UPDATE integration_clients SET status = 'paused', paused_at = now(), paused_by = ${uid}, pause_reason = ${why}, updated_by = ${uid}
			         WHERE id = ${id} AND account_id = ${accountId}`;
		} else if (action === 'disable') {
			await tx`UPDATE integration_clients SET status = 'disabled', disabled_at = now(), disabled_by = ${uid}, disable_reason = ${why}, updated_by = ${uid}
			         WHERE id = ${id} AND account_id = ${accountId}`;
		} else {
			await tx`UPDATE integration_clients SET status = 'active', paused_at = NULL, paused_by = NULL, pause_reason = NULL,
			         disabled_at = NULL, disabled_by = NULL, disable_reason = NULL, updated_by = ${uid}
			         WHERE id = ${id} AND account_id = ${accountId}`;
		}
		await recordAudit(
			{ actor: ctx.actor, action: `integration.${action}`, targetType: 'integration_client', targetId: id, targetAccountId: accountId,
			  outcome: 'success', reason: why, ip: ctx.ip, metadata: { integrationId: id, from: cur.status, to: next } },
			tx
		);
	});
}

/** Account-wide emergency stop. Separate confirmation; one account-level audit event listing every affected integration. */
export async function pauseAllIntegrations(ctx: Ctx, accountId: string, reason: string | null, confirm: string | null): Promise<string[]> {
	const why = requireReason(reason);
	if ((confirm ?? '').trim() !== 'PAUSE ALL') throw new ActionError('Type PAUSE ALL to confirm pausing every API integration on this account.', 422);
	const uid = ctx.actor.userId;
	return sql.begin(async (tx) => {
		const rows = await tx<{ id: string }[]>`
			UPDATE integration_clients SET status = 'paused', paused_at = now(), paused_by = ${uid}, pause_reason = ${why}, updated_by = ${uid}
			WHERE account_id = ${accountId} AND status = 'active' RETURNING id`;
		const ids = rows.map((r) => r.id);
		await recordAudit(
			{ actor: ctx.actor, action: 'integration.pause_all', targetType: 'account', targetId: accountId, targetAccountId: accountId,
			  outcome: 'success', reason: why, ip: ctx.ip, metadata: { affectedIntegrationIds: ids, count: ids.length } },
			tx
		);
		return ids;
	});
}

// ─── Credentials ─────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof sql.begin>[1]>[0];

async function insertCredential(tx: Tx, integrationId: string, label: string | null, ttlDays: number | null, createdBy: string | null): Promise<string> {
	const c = generateCredential();
	await tx`
		INSERT INTO integration_credentials (integration_client_id, label, key_prefix, key_hash, expires_at, created_by)
		VALUES (${integrationId}, ${label}, ${c.keyPrefix}, ${c.keyHash},
		        ${ttlDays ? sql`now() + ${ttlDays} * interval '1 day'` : null}, ${createdBy})`;
	return c.rawKey;
}

/**
 * Issue a new credential for ONE integration. With rotate=true, that integration's
 * other live credentials are retired: revoked immediately when its grace period is 0,
 * otherwise set to expire after the grace period. Sibling integrations are untouched.
 */
export async function issueCredential(
	ctx: Ctx, accountId: string, id: string, label: string | null, rotate: boolean
): Promise<{ rawKey: string; retired: number }> {
	const cur = await getIntegration(accountId, id);
	if (!cur) throw new ActionError('Integration not found.', 404);
	if (cur.status === 'disabled') throw new ActionError('Resume this integration before issuing credentials.', 409);
	const lab = (label ?? '').trim().slice(0, 100) || null;
	return sql.begin(async (tx) => {
		let retired = 0;
		if (rotate) {
			const rows = cur.rotation_grace_hours === 0
				? await tx<{ id: string }[]>`
					UPDATE integration_credentials SET revoked_at = now(), revoked_by = ${ctx.actor.userId}, revoke_reason = 'Rotated'
					WHERE integration_client_id = ${id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING id`
				: await tx<{ id: string }[]>`
					UPDATE integration_credentials
					SET expires_at = LEAST(COALESCE(expires_at, 'infinity'::timestamptz), now() + ${cur.rotation_grace_hours} * interval '1 hour')
					WHERE integration_client_id = ${id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING id`;
			retired = rows.length;
		}
		const rawKey = await insertCredential(tx, id, lab, cur.credential_ttl_days, ctx.actor.userId);
		await recordAudit(
			{ actor: ctx.actor, action: rotate ? 'integration.credential.rotate' : 'integration.credential.issue', targetType: 'integration_client',
			  targetId: id, targetAccountId: accountId, outcome: 'success', ip: ctx.ip,
			  metadata: { integrationId: id, retiredCredentials: retired, graceHours: rotate ? cur.rotation_grace_hours : undefined } },
			tx
		);
		return { rawKey, retired };
	});
}

/** Revoke exactly one credential (checked against the integration AND account). */
export async function revokeCredential(ctx: Ctx, accountId: string, id: string, credentialId: string, reason: string | null): Promise<void> {
	const why = requireReason(reason);
	if (!(await getIntegration(accountId, id))) throw new ActionError('Integration not found.', 404);
	await sql.begin(async (tx) => {
		const rows = await tx<{ id: string }[]>`
			UPDATE integration_credentials SET revoked_at = now(), revoked_by = ${ctx.actor.userId}, revoke_reason = ${why}
			WHERE id = ${credentialId} AND integration_client_id = ${id} AND revoked_at IS NULL RETURNING id`;
		if (!rows.length) throw new ActionError('Credential not found or already revoked.', 404);
		await recordAudit(
			{ actor: ctx.actor, action: 'integration.credential.revoke', targetType: 'integration_client', targetId: id, targetAccountId: accountId,
			  outcome: 'success', reason: why, ip: ctx.ip, metadata: { integrationId: id, credentialId } },
			tx
		);
	});
}

/** Config-change history for one integration (or the whole account when id is null). */
export function listConfigEvents(accountId: string, integrationId: string | null, limit = 50) {
	return sql<{ id: string; created_at: Date; actor_ref: string; action: string; reason: string | null; target_id: string | null; metadata: Record<string, unknown> | null }[]>`
		SELECT id, occurred_at AS created_at, actor_ref, action, reason, target_id, metadata
		FROM admin_audit_events
		WHERE target_account_id = ${accountId} AND action LIKE 'integration.%'
		  ${integrationId ? sql`AND (target_id = ${integrationId} OR (action = 'integration.pause_all' AND metadata->'affectedIntegrationIds' ? ${integrationId}))` : sql``}
		ORDER BY occurred_at DESC LIMIT ${limit}`;
}
