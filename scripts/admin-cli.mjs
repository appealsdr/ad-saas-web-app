#!/usr/bin/env node
/**
 * Operator CLI for platform admin accounts (bootstrap and recovery).
 *
 *   node --env-file=.env scripts/admin-cli.mjs <command> [options]
 *
 * Admin accounts are STANDALONE: their own email, password and MFA. They are not customer users, may
 * use the same email as a customer, and can only be created here — never from the web app.
 *
 * Commands (all write an admin_audit_events row):
 *   create        --email a@b.com --role platform_admin|platform_viewer [--name "Full Name"] [--require-reset]
 *                 Creates a new admin. The password is read from ADMIN_BOOTSTRAP_PASSWORD or a hidden
 *                 prompt (never from argv). Never commit or log it. They enrol MFA at first sign-in.
 *   list          Show admins, roles, state and MFA enrolment.
 *   set-role      --email a@b.com --role platform_admin|platform_viewer   (existing admin; signs them out)
 *   set-password  --email a@b.com [--require-reset]   New password (hidden prompt / ADMIN_BOOTSTRAP_PASSWORD); signs them out.
 *   deactivate    --email a@b.com    Deactivate + revoke admin sessions.
 *   reactivate    --email a@b.com    Re-activate a deactivated admin.
 *   reset-mfa     --email a@b.com    MFA recovery: delete credential + recovery codes, revoke sessions.
 *   rotate-mfa-key                   Re-encrypt all TOTP secrets under the current
 *                                    ADMIN_MFA_ENCRYPTION_KEY (old key in *_PREVIOUS).
 *
 * Uses DATABASE_URL (the app/owner connection). Run it from a host that can reach the database; do NOT
 * run it against production from a laptop unless you intend to. Membership changes are serialised with an
 * advisory lock and a DB trigger prevents removing the last active platform_admin.
 */
import postgres from 'postgres';
import { userInfo } from 'node:os';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';

const ROLES = ['platform_admin', 'platform_viewer'];
const [, , cmd, ...rest] = process.argv;

function arg(name) {
	const i = rest.indexOf(`--${name}`);
	return i >= 0 ? rest[i + 1] : undefined;
}
const flag = (name) => rest.includes(`--${name}`);

const url = process.env.DATABASE_URL;
if (!url) die('DATABASE_URL is not set (use: node --env-file=.env scripts/admin-cli.mjs ...)');
const sql = postgres(url, { max: 2, onnotice: () => {} });
const actorRef = `cli:${userInfo().username}`;

function die(msg, code = 1) {
	console.error(`error: ${msg}`);
	process.exit(code);
}

async function audit(tx, action, { targetId, outcome = 'success', reason, metadata } = {}) {
	await tx`
		INSERT INTO admin_audit_events (actor_ref, actor_role, action, target_type, target_id, outcome, reason, metadata)
		VALUES (${actorRef}, 'operator-cli', ${action}, 'user', ${targetId ?? null}, ${outcome}, ${reason ?? null},
		        ${metadata ? tx.json(metadata) : null})
	`;
}

function hashPassword(password) {
	const salt = randomBytes(16);
	const dk = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
	return `scrypt$16384$8$1$${salt.toString('hex')}$${dk.toString('hex')}`;
}

function promptHidden(question) {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
		rl.question(question, (a) => { rl.output.write('\n'); rl.close(); resolve(a); });
	});
}

function parseKey(raw) {
	if (!raw) return null;
	const t = raw.trim();
	if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
	const b = Buffer.from(t, 'base64');
	return b.length === 32 ? b : null;
}
const kid = (k) => createHash('sha256').update(k).digest('hex').slice(0, 8);

async function main() {
	switch (cmd) {
		case 'list': {
			const rows = await sql`
				SELECT ps.email, ps.display_name, ps.role, ps.is_active, (m.confirmed_at IS NOT NULL) AS mfa, ps.created_at
				FROM platform_staff ps LEFT JOIN admin_mfa_credentials m ON m.user_id = ps.user_id ORDER BY ps.email`;
			console.table(rows.map((r) => ({ email: r.email, name: r.display_name, role: r.role, active: r.is_active, mfa: r.mfa, since: r.created_at.toISOString() })));
			break;
		}
		case 'create': {
			const email = (arg('email') ?? '').trim().toLowerCase();
			const role = arg('role');
			if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die('--email must be a valid email address');
			if (!ROLES.includes(role)) die(`--role must be one of ${ROLES.join(', ')}`);
			const pw = process.env.ADMIN_BOOTSTRAP_PASSWORD || (await promptHidden('Initial password (min 12 chars): '));
			if (!pw || pw.length < 12) die('Password must be at least 12 characters.');
			await sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(hashtext('platform_staff_membership'))`;
				const [dup] = await tx`SELECT 1 FROM platform_staff WHERE lower(email) = ${email}`;
				if (dup) throw new Error('An admin with that email already exists.');
				const [row] = await tx`
					INSERT INTO platform_staff (role, email, display_name, password_hash, must_reset_password, is_active, granted_by_ref)
					VALUES (${role}, ${email}, ${arg('name') ?? null}, ${hashPassword(pw)}, ${flag('require-reset')}, true, ${actorRef})
					RETURNING user_id`;
				await audit(tx, 'staff.created', { targetId: row.user_id, metadata: { email, role } });
				console.log(`Created ${role} ${email}. They enrol MFA at first sign-in at /admin/login.`);
			});
			break;
		}
		case 'set-role':
		case 'set-password':
		case 'reactivate': {
			const email = (arg('email') ?? '').trim().toLowerCase();
			if (!email) die('--email is required');
			const role = arg('role');
			if (cmd === 'set-role' && !ROLES.includes(role)) die(`--role must be one of ${ROLES.join(', ')}`);
			const pw = cmd === 'set-password' ? process.env.ADMIN_BOOTSTRAP_PASSWORD || (await promptHidden('New password (min 12 chars): ')) : null;
			if (cmd === 'set-password' && (!pw || pw.length < 12)) die('Password must be at least 12 characters.');
			await sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(hashtext('platform_staff_membership'))`;
				const [row] = await tx`SELECT user_id, role, is_active FROM platform_staff WHERE lower(email) = ${email}`;
				if (!row) throw new Error('No admin with that email. Create one with: create --email … --role …');
				if (cmd === 'set-role') {
					await tx`UPDATE platform_staff SET role = ${role}, is_active = true, deactivated_at = NULL, granted_by_ref = ${actorRef} WHERE user_id = ${row.user_id}`;
				} else if (cmd === 'reactivate') {
					await tx`UPDATE platform_staff SET is_active = true, deactivated_at = NULL WHERE user_id = ${row.user_id}`;
				} else {
					await tx`UPDATE platform_staff SET password_hash = ${hashPassword(pw)}, must_reset_password = ${flag('require-reset')} WHERE user_id = ${row.user_id}`;
				}
				if (cmd !== 'reactivate') {
					await tx`UPDATE admin_sessions SET revoked_at = now(), revoked_reason = ${cmd === 'set-role' ? 'role_changed' : 'password_changed'} WHERE user_id = ${row.user_id} AND revoked_at IS NULL`;
				}
				await audit(tx, cmd === 'set-role' ? 'staff.grant' : cmd === 'set-password' ? 'staff.password_set' : 'staff.reactivate', { targetId: row.user_id, reason: 'operator cli', metadata: { email, ...(cmd === 'set-role' ? { role, previousRole: row.role } : {}) } });
				console.log(`${cmd} done for ${email}.`);
			});
			break;
		}
		case 'deactivate':
		case 'reset-mfa': {
			const email = (arg('email') ?? '').trim().toLowerCase();
			if (!email) die('--email is required');
			await sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(hashtext('platform_staff_membership'))`;
				const [row] = await tx`SELECT user_id AS id FROM platform_staff WHERE lower(email) = ${email}`;
				if (!row) throw new Error('That email is not a platform admin.');
				if (cmd === 'deactivate') {
					await tx`UPDATE platform_staff SET is_active = false, deactivated_at = now() WHERE user_id = ${row.id} AND is_active`;
				} else {
					await tx`DELETE FROM admin_mfa_credentials WHERE user_id = ${row.id}`;
					await tx`DELETE FROM admin_recovery_codes WHERE user_id = ${row.id}`;
					await tx`UPDATE admin_login_challenges SET consumed_at = now() WHERE user_id = ${row.id} AND consumed_at IS NULL`;
				}
				await tx`UPDATE admin_sessions SET revoked_at = now(), revoked_reason = ${cmd === 'deactivate' ? 'staff_deactivated' : 'mfa_reset'} WHERE user_id = ${row.id} AND revoked_at IS NULL`;
				await audit(tx, cmd === 'deactivate' ? 'staff.deactivate' : 'staff.mfa_reset', { targetId: row.id, reason: 'operator cli', metadata: { email } });
				console.log(`${cmd} done for ${email}.`);
			});
			break;
		}
		case 'rotate-mfa-key': {
			const cur = parseKey(process.env.ADMIN_MFA_ENCRYPTION_KEY);
			const prev = parseKey(process.env.ADMIN_MFA_ENCRYPTION_KEY_PREVIOUS);
			if (!cur) die('ADMIN_MFA_ENCRYPTION_KEY must be set to the NEW key');
			const keys = new Map([[kid(cur), cur]]);
			if (prev) keys.set(kid(prev), prev);
			let n = 0;
			await sql.begin(async (tx) => {
				for (const r of await tx`SELECT user_id, secret_encrypted FROM admin_mfa_credentials`) {
					const [v, id, iv, tag, ct] = r.secret_encrypted.split('.');
					if (v !== 'v1') throw new Error('unrecognised ciphertext');
					if (id === kid(cur)) continue;
					const key = keys.get(id);
					if (!key) throw new Error(`no key available for key id ${id}; set ADMIN_MFA_ENCRYPTION_KEY_PREVIOUS`);
					const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
					d.setAuthTag(Buffer.from(tag, 'base64url'));
					const plain = Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
					const iv2 = randomBytes(12);
					const c = createCipheriv('aes-256-gcm', cur, iv2);
					const ct2 = Buffer.concat([c.update(plain), c.final()]);
					const enc = ['v1', kid(cur), iv2.toString('base64url'), c.getAuthTag().toString('base64url'), ct2.toString('base64url')].join('.');
					await tx`UPDATE admin_mfa_credentials SET secret_encrypted = ${enc} WHERE user_id = ${r.user_id}`;
					n++;
				}
				await audit(tx, 'staff.mfa_key_rotated', { metadata: { reencrypted: n } });
			});
			console.log(`Re-encrypted ${n} secret(s).`);
			break;
		}
		default:
			die('Usage: admin-cli.mjs <create|list|set-role|set-password|deactivate|reactivate|reset-mfa|rotate-mfa-key> [options]  (see file header)', 2);
	}
}

main()
	.catch((e) => {
		console.error('error:', e.code === '23514' ? 'Cannot remove the last active platform administrator.' : e.message);
		process.exitCode = 1;
	})
	.finally(() => sql.end({ timeout: 2 }));
