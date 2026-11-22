/**
 * HTML sanitization for user-authored rich text (App Messages — Case, Account and Store conversations).
 *
 * Messages are composed as HTML in the browser and rendered back with {@html},
 * so they MUST be sanitized — on write (before storing in Salesforce) and on
 * read (existing/SF-authored messages may contain anything). Allowlist only:
 * basic formatting, lists, and links (links forced to open safely).
 */
import sanitizeHtml from 'sanitize-html';

const OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [
		'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's',
		'ul', 'ol', 'li', 'a', 'blockquote', 'h3', 'h4', 'span'
	],
	allowedAttributes: { a: ['href', 'target', 'rel'] },
	allowedSchemes: ['http', 'https', 'mailto'],
	transformTags: {
		a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' })
	}
};

/** Sanitize rich-text HTML down to the allowlist above. */
export function sanitizeMessageHtml(html: string | null | undefined): string {
	return sanitizeHtml(html ?? '', OPTIONS);
}

/** Strip all tags → plain text. Used for empty checks and search. */
export function htmlToText(html: string | null | undefined): string {
	return sanitizeHtml(html ?? '', { allowedTags: [], allowedAttributes: {} })
		.replace(/&nbsp;/g, ' ')
		.trim();
}

/** Max stored length of a sanitized message body (Message_Body__c is a long text area). */
export const MAX_MESSAGE_BODY_LENGTH = 32000;

/**
 * Validate + sanitize a submitted message body. The sanitized HTML is what gets
 * stored and rendered; the empty check runs on the plain-text projection so a
 * body of only tags/whitespace is rejected.
 */
export function validateMessageBody(
	raw: unknown
): { ok: true; body: string } | { ok: false; error: string } {
	if (typeof raw !== 'string') return { ok: false, error: 'Message cannot be empty.' };
	const body = sanitizeMessageHtml(raw);
	if (!htmlToText(body)) return { ok: false, error: 'Message cannot be empty.' };
	if (body.length > MAX_MESSAGE_BODY_LENGTH) {
		return { ok: false, error: 'Message is too long. Please shorten it and try again.' };
	}
	return { ok: true, body };
}
