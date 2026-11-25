/**
 * SOQL injection: quote and backslash payloads must stay inside the string literal,
 * and Id-typed inputs that aren't Ids must never reach Salesforce.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const m = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/db', () => ({ sql: vi.fn(async () => []) }));
vi.mock('$lib/server/error_log', () => ({
	logError: vi.fn(async () => {}),
	describeError: (e: unknown) => ({ errorMessage: String(e), stack: '' })
}));
vi.mock('$lib/server/salesforce/client', async (original) => ({
	...(await original<typeof import('../../src/lib/server/salesforce/client')>()),
	sfdcQuery: m.query
}));
vi.mock('$lib/server/salesforce/auth', async (original) => ({
	...(await original<typeof import('../../src/lib/server/salesforce/auth')>()),
	getAccessToken: vi.fn(async () => ({ instanceUrl: 'https://sf.test' }))
}));
vi.mock('$lib/server/admin/guard', () => ({ requireStaff: vi.fn() }));

import { escapeSoql, soqlString, soqlList, isSalesforceId } from '../../src/lib/server/salesforce/soql';
import * as cases from '../../src/lib/server/salesforce/cases';
import * as requiredFiles from '../../src/lib/server/salesforce/required-files';
import { listCasesForContract } from '../../src/lib/server/salesforce/service-cases';
import { listClientFeedback, fetchClientFeedback } from '../../src/lib/server/salesforce/client-feedback';
import { fetchCaseOnboarding, listOnboardingStatusForCases } from '../../src/lib/server/salesforce/case-onboarding';
import { isVuidBlank } from '../../src/lib/server/salesforce/vuid';
import { findContactByEmail } from '../../src/lib/server/salesforce/sync';
import { listAppMessages, listRecentAppMessagesForContexts, messageBelongsToContext } from '../../src/lib/server/salesforce/app-messages';
import { requireSfId } from '../../src/lib/server/integrations/http';
import { GET as exampleFile } from '../../src/routes/api/files/example/[s3DocId]/+server';
import { GET as pricebookDiagnostic } from '../../src/routes/api/sfdc/diagnostic/pricebook/+server';
import { load as caseDeepLink } from '../../src/routes/(app)/cases/[caseId]/+page.server';

const ID15 = '500Ab000001cDeF';
const ID18 = '500Ab000001cDeFGHI';

const PAYLOADS = [
	"'",
	"O'Brien",
	"''",
	'\\',
	"\\'",
	"x\\' OR Id != null OR Name = '",
	"x' OR Id != null --",
	"\\\\' OR Id != null OR Name = '",
	'trailing backslash \\',
	'say "hi"',
	'line1\nline2\r\n\ttab\b\f',
	'%_ unicode é 漢',
	''
];

/**
 * Reads SOQL the way Salesforce tokenises string literals: returns the query with
 * every literal replaced by `?`, plus the decoded literal values. Throws on an
 * unterminated literal or an escape SOQL does not accept.
 */
function parseSoql(soql: string): { skeleton: string; literals: string[] } {
	const decode: Record<string, string> = {
		n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', "'": "'", '\\': '\\'
	};
	let skeleton = '';
	const literals: string[] = [];
	for (let i = 0; i < soql.length; i++) {
		if (soql[i] !== "'") {
			skeleton += soql[i];
			continue;
		}
		let value = '';
		for (i++; ; i++) {
			if (i >= soql.length) throw new Error(`Unterminated literal in: ${soql}`);
			const c = soql[i];
			if (c === "'") break;
			if (c === '\n' || c === '\r') throw new Error('Raw newline in literal');
			if (c !== '\\') {
				value += c;
				continue;
			}
			const next = soql[++i];
			if (!(next in decode)) throw new Error(`Invalid escape \\${next}`);
			value += decode[next];
		}
		literals.push(value);
		skeleton += '?';
	}
	return { skeleton, literals };
}

const sentQueries = (): string[] => m.query.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
	m.query.mockReset().mockResolvedValue({ totalSize: 0, done: true, records: [] });
});

describe('parseSoql (test oracle)', () => {
	it('shows that the old quote-doubling escape let a payload leave the literal', () => {
		const old = `Id = '${"x\\' OR Id != null OR Name = '".replace(/'/g, "''")}'`;
		expect(() => parseSoql(old)).toThrow();
		const escapedOut = `Id = '${"x\\' OR Id != null //".replace(/'/g, "''")}`;
		expect(parseSoql(escapedOut).skeleton).toContain('OR Id != null');
	});
});

describe('soql helpers', () => {
	it('escapes backslashes and quotes with a backslash, in one pass', () => {
		expect(escapeSoql("a'b")).toBe("a\\'b");
		expect(escapeSoql('a\\b')).toBe('a\\\\b');
		expect(escapeSoql("\\'")).toBe("\\\\\\'");
		expect(escapeSoql('a"b\nc')).toBe('a\\"b\\nc');
		expect(escapeSoql('plain text 123')).toBe('plain text 123');
	});

	it.each(PAYLOADS)('soqlString keeps %j inside one literal', (payload) => {
		const parsed = parseSoql(`SELECT Id FROM Contact WHERE Email = ${soqlString(payload)} LIMIT 1`);
		expect(parsed.skeleton).toBe('SELECT Id FROM Contact WHERE Email = ? LIMIT 1');
		expect(parsed.literals).toEqual([payload]);
	});

	it('soqlList keeps every item inside its own literal', () => {
		const parsed = parseSoql(`Id IN (${soqlList(PAYLOADS)})`);
		expect(parsed.skeleton).toBe(`Id IN (${PAYLOADS.map(() => '?').join(',')})`);
		expect(parsed.literals).toEqual(PAYLOADS);
	});

	it('isSalesforceId accepts only 15 or 18 alphanumerics', () => {
		expect(isSalesforceId(ID15)).toBe(true);
		expect(isSalesforceId(ID18)).toBe(true);
		const bad = [
			...PAYLOADS, ID15.slice(1), ID15 + 'a', ID18 + 'a', ` ${ID15}`, `${ID15}\n`,
			`${ID15.slice(0, 14)}'`, undefined, null, 123, [ID15]
		];
		for (const v of bad) expect(isSalesforceId(v), String(v)).toBe(false);
	});

	it('requireSfId (v1 API and MCP) rejects payloads', () => {
		expect(requireSfId(ID18, 'Case')).toBe(ID18);
		for (const p of PAYLOADS) expect(() => requireSfId(p, 'Case')).toThrow('Case not found.');
	});
});

describe('free-text inputs are escaped', () => {
	it.each(PAYLOADS)('findContactByEmail with %j', async (payload) => {
		await findContactByEmail(payload);
		const parsed = parseSoql(sentQueries()[0]);
		expect(parsed.skeleton).toBe('SELECT Id, AccountId FROM Contact WHERE Email = ? LIMIT 1');
		expect(parsed.literals).toEqual([payload]);
	});

	it('pricebook diagnostic ?name=', async () => {
		const payload = "x\\' OR Id != null OR Name = '\\";
		const url = new URL(`http://localhost/api/sfdc/diagnostic/pricebook?name=${encodeURIComponent(payload)}`);
		await pricebookDiagnostic({ url } as never);
		const parsed = parseSoql(sentQueries()[0]);
		expect(parsed.skeleton).toBe('SELECT Id, Name, IsActive, IsStandard FROM Pricebook2 WHERE Name = ?');
		expect(parsed.literals).toEqual([payload]);
	});
});

type IdQuery = [string, (id: string) => unknown];

const SINGLE: IdQuery[] = [
	['findCaseStoreLookup', (id) => cases.findCaseStoreLookup(id)],
	['fetchCase', (id) => cases.fetchCase(id)],
	['listCasesForStore', (id) => cases.listCasesForStore(id)],
	['listCaseFiles', (id) => cases.listCaseFiles(id)],
	['listStoreFiles', (id) => cases.listStoreFiles(id)],
	['listCaseHistory', (id) => cases.listCaseHistory(id)],
	['listRequiredFilesForCase', (id) => requiredFiles.listRequiredFilesForCase(id)],
	['listRequiredFilesForStore', (id) => requiredFiles.listRequiredFilesForStore(id)],
	['listCasesForContract', (id) => listCasesForContract(id)],
	['listClientFeedback', (id) => listClientFeedback(id)],
	['fetchClientFeedback', (id) => fetchClientFeedback(id)],
	['fetchCaseOnboarding', (id) => fetchCaseOnboarding(id)],
	['isVuidBlank', (id) => isVuidBlank('Account', id)],
	['listAppMessages', (id) => listAppMessages({ contextType: 'Case', contextId: id })],
	['messageBelongsToContext', (id) => messageBelongsToContext(id, { contextType: 'Case', contextId: ID15 })]
];

const BATCH: [string, (ids: string[]) => unknown][] = [
	['listCasesForStores', (ids) => cases.listCasesForStores(ids)],
	['listPendingFilesForCases', (ids) => cases.listPendingFilesForCases(ids, 10)],
	['listRequiredFilesForCases', (ids) => requiredFiles.listRequiredFilesForCases(ids)],
	['listRequiredFilesForStores', (ids) => requiredFiles.listRequiredFilesForStores(ids)],
	['listOnboardingStatusForCases', (ids) => listOnboardingStatusForCases(ids)]
];

describe.each(SINGLE)('%s', (_name, run) => {
	it('sends no query for a quote or backslash payload', async () => {
		for (const payload of PAYLOADS) await run(payload);
		expect(m.query).not.toHaveBeenCalled();
	});

	it('queries a real Id as a single literal', async () => {
		await run(ID18);
		expect(m.query).toHaveBeenCalled();
		expect(parseSoql(sentQueries()[0]).literals).toContain(ID18);
	});
});

describe.each(BATCH)('%s', (_name, run) => {
	it('sends no query when no item is an Id', async () => {
		await run(PAYLOADS);
		expect(m.query).not.toHaveBeenCalled();
	});

	it('drops payloads and queries only the real Ids', async () => {
		await run([ID15, ...PAYLOADS, ID18]);
		const parsed = parseSoql(sentQueries()[0]);
		expect(parsed.literals).toEqual([ID15, ID18]);
		expect(parsed.skeleton).toContain('IN (?,?)');
	});
});

describe('not-found results for invalid Ids', () => {
	it('case lookups report notFound so routes answer 404', async () => {
		await expect(cases.findCaseStoreLookup("x\\'")).resolves.toMatchObject({ ok: false, notFound: true });
		await expect(cases.fetchCase("x\\'")).resolves.toMatchObject({ ok: false, notFound: true });
		await expect(fetchClientFeedback("x\\'")).resolves.toMatchObject({ ok: false, notFound: true });
	});

	it('batch message rollup refuses a payload', async () => {
		await expect(listRecentAppMessagesForContexts('Case', [ID15, "x\\'"], 5)).resolves.toMatchObject({ ok: false });
		expect(m.query).not.toHaveBeenCalled();
	});

	it('GET /cases/<id> deep link answers 404 without querying', async () => {
		const event = { params: { caseId: "x\\' OR Id != null OR Id = '" }, locals: { user: { id: 'u1' } } };
		await expect(caseDeepLink(event as never)).rejects.toMatchObject({ status: 404 });
		expect(m.query).not.toHaveBeenCalled();
	});

	it('GET /api/files/example/<id> answers 404 without querying', async () => {
		const event = {
			params: { s3DocId: "x\\' OR Id != null OR Id = '" },
			locals: { user: { id: 'u1' } },
			url: new URL('http://localhost/api/files/example/x')
		};
		await expect(exampleFile(event as never)).rejects.toMatchObject({ status: 404 });
		expect(m.query).not.toHaveBeenCalled();
	});
});

describe('source guard', () => {
	const root = join(import.meta.dirname, '..', '..', 'src');
	const files = (readdirSync(root, { recursive: true }) as string[])
		.filter((f) => /\.(ts|js|svelte)$/.test(f))
		.map((f) => join(root, f))
		.filter((f) => !f.endsWith(join('salesforce', 'soql.ts')));

	// Hand-quoted interpolation in a comparison or IN list, or a hand-rolled quote escape.
	const BANNED = [
		/(?:=|!=|<|>|\bLIKE|\bIN\s*\()\s*'%?\$\{/i,
		/`'\$\{[^}]*\}'`/,
		/\.replace(?:All)?\(\s*(?:\/'\/g|"'")/
	];

	it('no source file builds a SOQL literal by hand', () => {
		const offenders = files.flatMap((f) =>
			readFileSync(f, 'utf8')
				.split('\n')
				.map((line, i) => ({ line, at: `${relative(root, f)}:${i + 1}` }))
				.filter(({ line }) => BANNED.some((re) => re.test(line)))
				.map(({ at, line }) => `${at}  ${line.trim()}`)
		);
		expect(offenders, 'use soqlString() / soqlList() from salesforce/soql').toEqual([]);
	});
});
