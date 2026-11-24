import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { createHash } from 'node:crypto';

const e = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => e);
vi.mock('$lib/server/db', () => ({ sql: () => Promise.resolve([]) }));
vi.mock('$lib/server/security/alerts', () => ({ raiseAlert: async () => true }));
vi.mock('$lib/server/mcp/killswitch', () => ({ mcpAvailable: async () => ({ ok: true }) }));

import { crossSiteFormBlocked } from '../../src/lib/server/csrf';
import { pkceMatches, parseScopes, scopesToPermissions, validRedirectUri, validChallenge } from '../../src/lib/server/oauth/core';
import { parseClamReply, scanBuffer, scanRequired } from '../../src/lib/server/files/virus_scan';

describe('csrf guard', () => {
	const base = { method: 'POST', contentType: 'application/x-www-form-urlencoded', origin: 'https://evil.example', urlOrigin: 'https://app.example', pathname: '/accounts' };
	it('blocks cross-site and origin-less form posts, allows same-origin and JSON', () => {
		expect(crossSiteFormBlocked(base)).toBe(true);
		expect(crossSiteFormBlocked({ ...base, origin: null })).toBe(true);
		expect(crossSiteFormBlocked({ ...base, origin: 'https://app.example' })).toBe(false);
		expect(crossSiteFormBlocked({ ...base, contentType: 'application/json' })).toBe(false);
		expect(crossSiteFormBlocked({ ...base, method: 'GET' })).toBe(false);
		expect(crossSiteFormBlocked({ ...base, contentType: 'multipart/form-data; boundary=x' })).toBe(true);
	});
	it('exempts only the OAuth machine endpoints', () => {
		for (const p of ['/oauth/token', '/oauth/revoke', '/oauth/register']) expect(crossSiteFormBlocked({ ...base, origin: null, pathname: p })).toBe(false);
		expect(crossSiteFormBlocked({ ...base, origin: null, pathname: '/oauth/authorize' })).toBe(true); // consent form needs CSRF protection
		expect(crossSiteFormBlocked({ ...base, origin: null, pathname: '/oauth/token/x' })).toBe(true);
	});
});

describe('oauth helpers', () => {
	it('verifies PKCE S256 and rejects malformed verifiers', () => {
		const verifier = 'a'.repeat(50);
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		expect(validChallenge(challenge)).toBe(true);
		expect(pkceMatches(verifier, challenge)).toBe(true);
		expect(pkceMatches('b'.repeat(50), challenge)).toBe(false);
		expect(pkceMatches('short', challenge)).toBe(false);
		expect(pkceMatches(verifier + ' ', challenge)).toBe(false);
	});
	it('always includes read, drops unknown scopes and maps to exact permissions', () => {
		expect(parseScopes('')).toEqual(['read']);
		expect(parseScopes('files:write admin bogus')).toEqual(['read', 'files:write']);
		expect(scopesToPermissions(['read'])).not.toContain('files.upload');
		expect(scopesToPermissions(['read', 'files:write', 'messages:write'])).toEqual(expect.arrayContaining(['files.upload', 'messages.create', 'stores.list']));
		expect(scopesToPermissions(['bogus'])).toEqual([]);
	});
	it('accepts https and loopback http redirect URIs only', () => {
		expect(validRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
		expect(validRedirectUri('http://localhost:33418/cb')).toBe(true);
		expect(validRedirectUri('http://127.0.0.1/cb')).toBe(true);
		for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'https://a.example/cb#frag', 'https://u:p@a.example/cb', 'not a url', 'myapp://cb']) expect(validRedirectUri(bad)).toBe(false);
	});
});

describe('virus scan', () => {
	it('parses clamd replies', () => {
		expect(parseClamReply('stream: OK\0')).toEqual({ status: 'clean' });
		expect(parseClamReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({ status: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
		expect(parseClamReply('INSTREAM size limit exceeded. ERROR')).toMatchObject({ status: 'error' });
	});

	let server: net.Server | undefined;
	afterEach(() => { server?.close(); server = undefined; e.env = {}; });
	/** Fake clamd: parses the real INSTREAM framing (command, then length-prefixed chunks, 0-length terminator), answers once. */
	const fakeClamd = (answer: (data: Buffer) => string | null) =>
		new Promise<number>((resolve) => {
			server = net.createServer((sock) => {
				let buf = Buffer.alloc(0);
				let answered = false;
				sock.on('error', () => {});
				sock.on('data', (d) => {
					buf = Buffer.concat([buf, d]);
					if (answered || buf.length < 10 || buf.subarray(0, 10).toString() !== 'zINSTREAM\0') return;
					let off = 10;
					const chunks: Buffer[] = [];
					for (;;) {
						if (buf.length < off + 4) return;
						const len = buf.readUInt32BE(off);
						if (len === 0) break;
						if (buf.length < off + 4 + len) return;
						chunks.push(buf.subarray(off + 4, off + 4 + len));
						off += 4 + len;
					}
					answered = true;
					const reply = answer(Buffer.concat(chunks));
					if (reply !== null) sock.end(reply);
				});
			}).listen(0, '127.0.0.1', () => resolve((server!.address() as net.AddressInfo).port));
		});

	beforeEach(() => { e.env = {}; });
	it('is skipped when not configured, and "required" mode is detectable', async () => {
		expect(await scanBuffer(new Uint8Array([1]))).toEqual({ status: 'skipped' });
		e.env.VIRUS_SCAN_REQUIRED = 'true';
		expect(scanRequired()).toBe(true);
	});
	it('reports clean and infected files from the scanner', async () => {
		const port = await fakeClamd((d) => (d.includes(Buffer.from('EICAR')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0'));
		e.env = { CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(port) };
		expect(await scanBuffer(new Uint8Array(Buffer.from('hello world')))).toEqual({ status: 'clean' });
		expect(await scanBuffer(new Uint8Array(Buffer.from('xx EICAR xx')))).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
	});
	it('streams large files in chunks', async () => {
		const port = await fakeClamd((d) => (d.length > 200_000 ? 'stream: OK\0' : 'stream: Short FOUND\0'));
		e.env = { CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(port) };
		expect(await scanBuffer(new Uint8Array(250_000))).toEqual({ status: 'clean' });
	});
	it('returns an error (not a crash) when the scanner is unreachable or silent', async () => {
		e.env = { CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1' };
		expect((await scanBuffer(new Uint8Array([1]))).status).toBe('error');
		const port = await fakeClamd(() => null);
		e.env = { CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(port), CLAMAV_TIMEOUT_MS: '150' };
		expect(await scanBuffer(new Uint8Array([1]))).toMatchObject({ status: 'error', message: 'scanner timed out' });
	});
});
