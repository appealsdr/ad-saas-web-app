/**
 * DNS sanity check for the company website: a domain that doesn't exist (NXDOMAIN / no records) is almost
 * certainly junk. Fails OPEN on timeouts/other DNS errors so a flaky resolver never blocks a real signup.
 */
import { promises as dns } from 'node:dns';

export function hostFromWebsite(website: string): string | null {
	try {
		return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase();
	} catch {
		return null;
	}
}

export async function domainResolves(host: string, timeoutMs = 2500): Promise<boolean> {
	const lookup = async (): Promise<boolean> => {
		for (const fn of [() => dns.resolve4(host), () => dns.resolve6(host), () => dns.resolveMx(host)]) {
			try {
				const r = await fn();
				if (r.length) return true;
			} catch (e) {
				const code = (e as { code?: string }).code;
				if (code !== 'ENOTFOUND' && code !== 'ENODATA') return true; // SERVFAIL/timeout/refused → fail open
			}
		}
		return false;
	};
	return Promise.race([lookup(), new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs))]);
}
