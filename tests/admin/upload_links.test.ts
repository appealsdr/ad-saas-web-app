import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeUser, makeStore } from '../setup/db';

const d = describe.skipIf(!hasDb);

d('MCP one-time upload links (real SQL)', async () => {
	const L = await import('$lib/server/mcp/upload_links');

	async function fixture() {
		const acct = await makeAccount();
		const user = await makeUser({ accountId: acct.id, role: 'owner' });
		const storeId = await makeStore(acct.id);
		const integrationId = randomUUID();
		const base = { accountId: acct.id, storeId, caseId: '500Hn00000AbCdEIAV', requiredFileId: 'a0YHn00000LmNoPQAV', replaceExisting: false, userId: user.id, integrationId };
		return { acct, user, storeId, integrationId, base };
	}

	it('stores only a hash, never the token', async () => {
		const f = await fixture();
		const link = (await L.createUploadLink(f.base))!;
		expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const rows = await sql<{ token_hash: string }[]>`SELECT token_hash FROM upload_links WHERE integration_id = ${f.integrationId}`;
		expect(rows).toHaveLength(1);
		expect(rows[0].token_hash).toBe(L.hashToken(link.token));
		expect(rows[0].token_hash).not.toContain(link.token);
	});

	it('a fresh link resolves to exactly what it was created for', async () => {
		const f = await fixture();
		const { token } = (await L.createUploadLink(f.base))!;
		const found = await L.findUsableLink(token);
		expect(found).toMatchObject({ account_id: f.acct.id, store_id: f.storeId, sfdc_case_id: '500Hn00000AbCdEIAV', required_file_id: 'a0YHn00000LmNoPQAV', created_by_user_id: f.user.id, integration_id: f.integrationId, replace_existing: false });
	});

	it('unknown and malformed tokens never resolve', async () => {
		expect(await L.findUsableLink('x')).toBeNull();
		expect(await L.findUsableLink('A'.repeat(43))).toBeNull();
		expect(await L.findUsableLink("' OR 1=1 --".padEnd(43, 'a'))).toBeNull();
	});

	it('expires after 15 minutes', async () => {
		const f = await fixture();
		const now = Date.now();
		const { token, expiresAt } = (await L.createUploadLink(f.base, now))!;
		expect(expiresAt.getTime() - now).toBe(15 * 60 * 1000);
		expect(await L.findUsableLink(token, now + 14 * 60 * 1000)).not.toBeNull();
		expect(await L.findUsableLink(token, now + 16 * 60 * 1000)).toBeNull();
		expect(await L.claimLink((await L.findUsableLink(token, now))!.id, now + 16 * 60 * 1000)).toBe(false);
	});

	it('is single use: only one of two simultaneous claims wins, and a used link disappears', async () => {
		const f = await fixture();
		const { token } = (await L.createUploadLink(f.base))!;
		const id = (await L.findUsableLink(token))!.id;
		const results = await Promise.all([L.claimLink(id), L.claimLink(id), L.claimLink(id)]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await L.findUsableLink(token)).toBeNull();
	});

	it('a failed upload can hand the link back for a retry, a successful one cannot', async () => {
		const f = await fixture();
		const { token } = (await L.createUploadLink(f.base))!;
		const id = (await L.findUsableLink(token))!.id;
		expect(await L.claimLink(id)).toBe(true);
		await L.releaseLink(id);
		expect(await L.findUsableLink(token)).not.toBeNull();
		expect(await L.claimLink(id)).toBe(true);
		await L.recordLinkUpload(id, 'doc.txt');
		expect(await L.findUsableLink(token)).toBeNull();
		const [r] = await sql<{ uploaded_file_name: string }[]>`SELECT uploaded_file_name FROM upload_links WHERE id = ${id}`;
		expect(r.uploaded_file_name).toBe('doc.txt');
	});

	it('caps open links per integration, and used or expired ones do not count', async () => {
		const f = await fixture();
		const now = Date.now();
		for (let i = 0; i < L.MAX_ACTIVE_LINKS_PER_INTEGRATION; i++) expect(await L.createUploadLink(f.base, now)).not.toBeNull();
		expect(await L.createUploadLink(f.base, now)).toBeNull();
		// another integration is unaffected
		expect(await L.createUploadLink({ ...f.base, integrationId: randomUUID() }, now)).not.toBeNull();
		// once the old ones expire the integration can create again
		expect(await L.createUploadLink(f.base, now + 20 * 60 * 1000)).not.toBeNull();
	});

	it('deleting the account removes its links', async () => {
		const f = await fixture();
		await L.createUploadLink(f.base);
		await sql`DELETE FROM accounts WHERE id = ${f.acct.id}`;
		const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM upload_links WHERE integration_id = ${f.integrationId}`;
		expect(r.n).toBe(0);
	});
});
