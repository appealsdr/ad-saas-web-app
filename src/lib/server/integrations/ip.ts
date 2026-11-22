/** IP allowlist helpers (IPv4 + IPv6 CIDR) built on node:net BlockList. */
import { BlockList, isIP } from 'node:net';

/** Strip an IPv4-mapped IPv6 prefix (::ffff:1.2.3.4) so v4 CIDRs match. */
export function normalizeIp(ip: string): string {
	const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
	return m ? m[1] : ip.trim();
}

/** Parse "1.2.3.4", "1.2.3.0/24", "2001:db8::/32" → canonical CIDR text, or null if invalid. */
export function parseCidr(raw: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	const [addr, bitsRaw, extra] = s.split('/');
	if (extra !== undefined) return null;
	const fam = isIP(addr);
	if (!fam) return null;
	const max = fam === 4 ? 32 : 128;
	let bits = max;
	if (bitsRaw !== undefined) {
		if (!/^\d{1,3}$/.test(bitsRaw)) return null;
		bits = Number(bitsRaw);
		if (bits > max) return null;
	}
	return `${addr}/${bits}`;
}

/** Parse a textarea/comma/newline separated list. Throws on the first invalid entry. */
export function parseCidrList(raw: string): string[] {
	const out: string[] = [];
	for (const part of raw.split(/[\s,;]+/).filter(Boolean)) {
		const c = parseCidr(part);
		if (!c) throw new Error(`"${part.slice(0, 60)}" is not a valid IP address or CIDR range.`);
		if (!out.includes(c)) out.push(c);
	}
	return out;
}

/** Empty / null allowlist = no restriction. A non-empty list fails closed when the IP is unknown. */
export function ipAllowed(ranges: readonly string[] | null | undefined, ip: string | null | undefined): boolean {
	if (!ranges || ranges.length === 0) return true;
	if (!ip) return false;
	const addr = normalizeIp(ip);
	const fam = isIP(addr);
	if (!fam) return false;
	const list = new BlockList();
	for (const r of ranges) {
		const [a, bits] = r.split('/');
		const f = isIP(a);
		if (!f) continue;
		list.addSubnet(a, Number(bits ?? (f === 4 ? 32 : 128)), f === 4 ? 'ipv4' : 'ipv6');
	}
	return list.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}
