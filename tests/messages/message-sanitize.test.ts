import { describe, it, expect } from 'vitest';
import {
	sanitizeMessageHtml,
	validateMessageBody,
	MAX_MESSAGE_BODY_LENGTH
} from '../../src/lib/server/sanitize';

describe('sanitizeMessageHtml', () => {
	it('strips scripts, event handlers and javascript: links', () => {
		const out = sanitizeMessageHtml(
			'<p onclick="x()">hi<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">l</a></p>'
		);
		expect(out).not.toMatch(/script|onclick|onerror|javascript:|<img/i);
		expect(out).toContain('hi');
	});
	it('keeps formatting and forces safe link targets', () => {
		const out = sanitizeMessageHtml('<b>b</b><ul><li>x</li></ul><a href="https://a.test">a</a>');
		expect(out).toContain('<b>b</b>');
		expect(out).toContain('<ul><li>x</li></ul>');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noopener noreferrer"');
	});
});

describe('validateMessageBody', () => {
	it('returns sanitized HTML for valid input', () => {
		const r = validateMessageBody('<p>Hello <script>x</script>world</p>');
		expect(r).toEqual({ ok: true, body: expect.not.stringContaining('script') });
	});
	it('rejects empty, whitespace-only, tag-only and non-string input', () => {
		for (const v of ['', '   ', '<p><br></p>', '<script>alert(1)</script>', null, undefined, 42]) {
			expect(validateMessageBody(v)).toEqual({ ok: false, error: expect.stringMatching(/empty/i) });
		}
	});
	it('enforces the maximum length', () => {
		expect(validateMessageBody('a'.repeat(MAX_MESSAGE_BODY_LENGTH)).ok).toBe(true);
		const r = validateMessageBody('a'.repeat(MAX_MESSAGE_BODY_LENGTH + 1));
		expect(r).toEqual({ ok: false, error: expect.stringMatching(/too long/i) });
	});
});
