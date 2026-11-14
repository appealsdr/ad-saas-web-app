import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
	rows: [] as unknown[],
	calls: [] as string[],
	begin: vi.fn(),
	rate: vi.fn(),
	turnstile: vi.fn(),
	dns: vi.fn(),
	sfContact: vi.fn(),
	token: vi.fn(),
	sendMail: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/server/db', () => {
	const sql = Object.assign(
		(strings: TemplateStringsArray) => { m.calls.push(strings.join('?').replace(/\s+/g, ' ').trim()); return Promise.resolve(m.rows); },
		{ begin: m.begin }
	);
	return { sql };
});
vi.mock('$lib/server/auth/password', () => ({ hashPassword: async () => 'hash' }));
vi.mock('$lib/server/error_log', () => ({ logError: async () => {}, describeError: () => ({ errorMessage: 'x', stack: '' }) }));
vi.mock('$lib/server/auth/redirects', () => ({ resolvePostAuthPath: () => '/dashboard', safeNextUrl: () => null }));
vi.mock('$lib/server/salesforce', () => ({ findContactByEmail: m.sfContact }));
vi.mock('$lib/server/admin/rate_limit', () => ({ hitRateLimit: m.rate }));
vi.mock('$lib/server/auth/turnstile', () => ({ verifyTurnstile: m.turnstile }));
vi.mock('$lib/server/auth/domain_check', () => ({ domainResolves: m.dns, hostFromWebsite: (w: string) => w.replace(/^https?:\/\//, '') }));
vi.mock('$lib/server/auth/email_verification', () => ({ createVerificationToken: m.token }));
vi.mock('$lib/server/salesforce/email', () => ({ sendVerificationEmail: m.sendMail }));

import { actions } from '../../src/routes/(auth)/register/+page.server';

const GOOD = {
	name: 'Jane Doe', company: 'Acme Goods LLC', email: 'jane@acmegoods.com', phone: '(415) 411-4111',
	website: 'acmegoods.com', password: 'longenough1', confirm: 'longenough1', fax_number: '',
	_t: String(Date.now() - 30_000), 'cf-turnstile-response': 'ok'
};

async function run(over: Record<string, string> = {}) {
	const fd = new FormData();
	for (const [k, v] of Object.entries({ ...GOOD, ...over })) fd.set(k, v);
	const req = new Request('http://x/register', { method: 'POST', body: fd });
	try {
		const res = await (actions.register as (e: unknown) => Promise<unknown>)({
			request: req, getClientAddress: () => '1.2.3.4', url: new URL('http://x/register'), cookies: {}
		});
		return { kind: 'fail' as const, res: res as { status: number; data: { error?: string } } };
	} catch (e) {
		const r = e as { status?: number; location?: string };
		if (r.location) return { kind: 'redirect' as const, location: r.location };
		throw e;
	}
}

const inserted = () => m.calls.some((c) => /INSERT INTO accounts|INSERT INTO users/i.test(c)) || m.begin.mock.calls.length > 0;

beforeEach(() => {
	m.rows = []; m.calls = [];
	m.begin.mockReset().mockResolvedValue(['acc1', 'usr1']);
	m.rate.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 1 });
	m.turnstile.mockReset().mockResolvedValue(true);
	m.dns.mockReset().mockResolvedValue(true);
	m.sfContact.mockReset().mockResolvedValue(null);
	m.token.mockReset().mockResolvedValue('a'.repeat(64));
	m.sendMail.mockReset().mockResolvedValue(undefined);
});

describe('register action — spam is rejected without creating records', () => {
	it.each([
		['single random-string name', { name: 'gIeNoIDfpnZoArBzrtLUmWvm' }, /first and last name/i],
		['dotted gmail', { email: 't.ece.v.ekaf.a.xi5.6@gmail.com' }, /valid email/i],
		['disposable email', { email: 'x@mailinator.com' }, /disposable/i],
		['fake phone', { phone: '5555555555' }, /phone/i],
		['random website', { website: 'zgqjzzjorjqp.com' }, /website/i],
		['random company', { company: 'gIeNoIDfpnZoArBzrtLUmWvm LLC' }, /company/i],
		['password mismatch', { confirm: 'different12' }, /do not match/i]
	])('%s → 400 with a clear message, nothing inserted, no email, no Salesforce', async (_n, over, msg) => {
		const r = await run(over);
		expect(r.kind).toBe('fail');
		if (r.kind === 'fail') { expect(r.res.status).toBe(400); expect(r.res.data.error).toMatch(msg); }
		expect(inserted()).toBe(false);
		expect(m.sendMail).not.toHaveBeenCalled();
		expect(m.sfContact).not.toHaveBeenCalled();
	});

	it('non-resolving website domain → 400', async () => {
		m.dns.mockResolvedValue(false);
		const r = await run();
		expect(r.kind === 'fail' && r.res.status).toBe(400);
		expect(inserted()).toBe(false);
	});

	it('failed Turnstile → 400', async () => {
		m.turnstile.mockResolvedValue(false);
		const r = await run();
		expect(r.kind === 'fail' && r.res.status).toBe(400);
		expect(inserted()).toBe(false);
	});

	it('rate limited IP → 429', async () => {
		m.rate.mockResolvedValue({ allowed: false, count: 99, retryAfterSeconds: 60 });
		const r = await run();
		expect(r.kind === 'fail' && r.res.status).toBe(429);
		expect(inserted()).toBe(false);
	});

	it('honeypot filled / missing timestamp / too fast → silent fake success, nothing created', async () => {
		for (const over of [{ fax_number: 'spam' }, { _t: '' }, { _t: String(Date.now() - 200) }] as Record<string, string>[]) {
			const r = await run(over);
			expect(r.kind).toBe('redirect');
			expect(m.turnstile).not.toHaveBeenCalled();
		}
		expect(inserted()).toBe(false);
		expect(m.sendMail).not.toHaveBeenCalled();
	});

	it('existing user (incl. gmail dot variant) → 409, nothing inserted', async () => {
		m.rows = [{ id: 'u', email: 'jane@acmegoods.com', pending: false }];
		const r = await run();
		expect(r.kind === 'fail' && r.res.status).toBe(409);
		expect(inserted()).toBe(false);
	});
});

describe('register action — legitimate signup', () => {
	it('creates an UNVERIFIED local account, emails a link, does not touch Salesforce or issue a session', async () => {
		const r = await run();
		expect(r).toEqual({ kind: 'redirect', location: '/register/check-email?email=jane%40acmegoods.com' });
		expect(m.begin).toHaveBeenCalledTimes(1);
		expect(m.token).toHaveBeenCalledWith('usr1', 'jane@acmegoods.com');
		expect(m.sendMail).toHaveBeenCalledWith('jane@acmegoods.com', expect.stringContaining('/register/verify?token='), expect.anything());
	});

	it('email send failure → 502 and the unverified rows are removed', async () => {
		m.sendMail.mockRejectedValue(new Error('smtp down'));
		const r = await run();
		expect(r.kind === 'fail' && r.res.status).toBe(502);
		expect(m.calls.some((c) => /DELETE FROM users/i.test(c))).toBe(true);
		expect(m.calls.some((c) => /DELETE FROM accounts/i.test(c))).toBe(true);
	});

	it('unconfirmed existing signup → re-sends the link instead of "already exists"', async () => {
		m.rows = [{ id: 'u9', email: 'jane@acmegoods.com', pending: true }];
		const r = await run();
		expect(r.kind).toBe('redirect');
		expect(m.token).toHaveBeenCalledWith('u9', 'jane@acmegoods.com');
		expect(m.begin).not.toHaveBeenCalled();
	});
});
