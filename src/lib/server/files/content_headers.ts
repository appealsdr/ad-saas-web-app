/**
 * Content-Type and Content-Disposition for every file we hand out (presigned S3 URLs and files streamed from disk).
 * Pure functions, no I/O.
 */

export const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/** Extension → type, used when a file has no usable stored type (e.g. added in Salesforce). */
const EXTENSION_TYPES: Record<string, string> = {
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	heic: 'image/heic',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	txt: 'text/plain',
	log: 'text/plain',
	rtf: 'application/rtf',
	csv: 'text/csv',
	zip: 'application/zip'
};

/** The only types a browser may render in place. Everything else — HTML, SVG, unknown — is downloaded. */
const INLINE_SAFE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'text/plain']);

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** The stored type when it is a well-formed MIME type, else the type implied by the file name, else octet-stream. */
export function resolveContentType(stored: string | null | undefined, fileName: string | null | undefined): string {
	const type = (stored ?? '').split(';')[0].trim().toLowerCase();
	if (MIME_RE.test(type) && type !== FALLBACK_CONTENT_TYPE) return type;
	const ext = /\.([a-z0-9]{1,8})$/i.exec((fileName ?? '').trim())?.[1]?.toLowerCase();
	return (ext && EXTENSION_TYPES[ext]) || FALLBACK_CONTENT_TYPE;
}

export type Disposition = 'attachment' | 'inline';

export const safeDisposition = (requested: Disposition | null | undefined, contentType: string): Disposition =>
	requested === 'inline' && INLINE_SAFE.has(contentType) ? 'inline' : 'attachment';

/**
 * RFC 6266: an ASCII `filename` for old clients plus `filename*` carrying the exact UTF-8 name.
 * (Percent-encoding inside `filename="…"` would be shown to the user literally.)
 */
export function contentDisposition(disposition: Disposition, fileName: string): string {
	// Drop control characters and unpaired surrogates, which cannot be encoded.
	const clean = fileName.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\p{Surrogate}/gu, '').trim() || 'file';
	const ascii = clean.replace(/[^\x20-\x7e]|["\\]/g, '_');
	const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
