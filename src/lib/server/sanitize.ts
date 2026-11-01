/**
 * HTML sanitization for user-authored rich text (case messages).
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
