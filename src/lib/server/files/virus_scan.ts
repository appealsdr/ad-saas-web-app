/**
 * Virus scanning for API/MCP uploads (AD-1969) via a ClamAV daemon (clamd, INSTREAM protocol).
 *
 *   CLAMAV_HOST / CLAMAV_PORT (3310)     where clamd listens. Unset = scanning not configured.
 *   VIRUS_SCAN_REQUIRED=true             refuse uploads when scanning is not configured or the scanner is unreachable
 *                                        (fail closed — set this in production). Otherwise such uploads proceed unscanned.
 *   CLAMAV_TIMEOUT_MS (20000)
 */
import net from 'node:net';
import { env } from '$env/dynamic/private';

export type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string } | { status: 'skipped' } | { status: 'error'; message: string };

export const scanRequired = () => (env.VIRUS_SCAN_REQUIRED ?? '').toLowerCase() === 'true';
export const scanConfigured = () => !!env.CLAMAV_HOST;

/** Parse clamd's reply: "stream: OK" | "stream: <Sig> FOUND" | "... ERROR". */
export function parseClamReply(reply: string): ScanResult {
	const r = reply.replace(/\0/g, '').trim();
	if (/\bOK$/.test(r)) return { status: 'clean' };
	const found = /:\s*(.+?)\s+FOUND$/.exec(r);
	if (found) return { status: 'infected', signature: found[1].slice(0, 100) };
	return { status: 'error', message: r.slice(0, 200) || 'empty reply' };
}

export function scanBuffer(bytes: Uint8Array): Promise<ScanResult> {
	if (!scanConfigured()) return Promise.resolve({ status: 'skipped' });
	const host = env.CLAMAV_HOST!;
	const port = Number(env.CLAMAV_PORT ?? 3310);
	const timeout = Number(env.CLAMAV_TIMEOUT_MS ?? 20000);
	return new Promise((resolve) => {
		let reply = '';
		let settled = false;
		const done = (r: ScanResult) => { if (!settled) { settled = true; socket.destroy(); resolve(r); } };
		const socket = net.createConnection({ host, port });
		socket.setTimeout(timeout, () => done({ status: 'error', message: 'scanner timed out' }));
		socket.on('error', (e) => done({ status: 'error', message: e.message }));
		socket.on('data', (d) => { reply += d.toString('utf8'); });
		socket.on('end', () => done(parseClamReply(reply)));
		socket.on('connect', () => {
			socket.write('zINSTREAM\0');
			const CHUNK = 64 * 1024;
			for (let i = 0; i < bytes.length; i += CHUNK) {
				const part = bytes.subarray(i, i + CHUNK);
				const len = Buffer.alloc(4);
				len.writeUInt32BE(part.length);
				socket.write(len);
				socket.write(part);
			}
			socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
		});
	});
}
