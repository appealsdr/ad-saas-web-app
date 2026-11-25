import { describe, expect, it } from 'vitest';
import { contentDisposition, resolveContentType, safeDisposition } from '../../src/lib/server/files/content_headers';
import { MIME_EXTENSIONS } from '../../src/lib/server/files/required_file_upload';

const INLINE = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'text/plain'];

describe('content type', () => {
	it('knows every uploadable type from the stored type or, failing that, the file name', () => {
		for (const [mime, exts] of Object.entries(MIME_EXTENSIONS)) {
			expect(resolveContentType(mime, 'x'), mime).toBe(mime);
			for (const ext of exts) {
				expect(resolveContentType(null, `File.${ext.toUpperCase()}`), ext).toBe(mime);
				expect(resolveContentType('application/octet-stream', `a.${ext}`), ext).toBe(mime);
			}
		}
	});
	it('normalises parameters and case, and falls back to octet-stream', () => {
		expect(resolveContentType('Text/Plain; charset=utf-8', 'a')).toBe('text/plain');
		for (const bad of [null, '', 'pdf', 'text/plain\r\nx-evil: 1', 'a b/c']) expect(resolveContentType(bad, 'noext'), String(bad)).toBe('application/octet-stream');
		expect(resolveContentType(null, 'program.exe')).toBe('application/octet-stream');
	});
});

describe('inline versus attachment', () => {
	it('allows inline only for PDF, images and plain text', () => {
		for (const mime of Object.keys(MIME_EXTENSIONS)) expect(safeDisposition('inline', mime), mime).toBe(INLINE.includes(mime) ? 'inline' : 'attachment');
		for (const mime of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/octet-stream', 'video/mp4']) {
			expect(safeDisposition('inline', mime), mime).toBe('attachment');
		}
	});
	it('defaults to attachment', () => {
		expect(safeDisposition(undefined, 'application/pdf')).toBe('attachment');
		expect(safeDisposition('attachment', 'application/pdf')).toBe('attachment');
	});
});

describe('Content-Disposition', () => {
	const utf8 = (h: string) => decodeURIComponent(/filename\*=UTF-8''(\S+)$/.exec(h)![1]);
	it('carries non-ASCII names in filename* with an ASCII fallback', () => {
		for (const name of ['Rechnung März.pdf', 'счёт №5.docx', '請求書.xlsx', "it's (final) *v2*.txt", '100% done.csv', '😀.png']) {
			const h = contentDisposition('attachment', name);
			expect(utf8(h), name).toBe(name);
			expect(h).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~!-]+$/);
		}
		expect(contentDisposition('inline', 'März.pdf')).toBe(`inline; filename="M_rz.pdf"; filename*=UTF-8''M%C3%A4rz.pdf`);
	});
	it('cannot be broken out of', () => {
		const h = contentDisposition('attachment', 'a"; filename="evil.html\r\nX: 1\\.pdf');
		expect(h).not.toMatch(/[\r\n]/);
		expect(h.match(/"/g)).toHaveLength(2);
		expect(contentDisposition('attachment', '\u0000')).toContain('filename="file"');
		expect(() => contentDisposition('attachment', 'bad\ud800name')).not.toThrow();
	});
});
