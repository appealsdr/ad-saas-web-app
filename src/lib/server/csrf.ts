/**
 * Cross-site form-POST guard (AD-1969).
 *
 * SvelteKit's built-in check (kit.csrf) rejects every non-same-origin form POST, including the OAuth token/revoke/
 * register endpoints that MCP clients call server-to-server (form-encoded, no Origin header). That check is turned
 * off in svelte.config.js and replaced by this one, which keeps the exact same rule for everything EXCEPT the
 * machine endpoints below. Those authenticate with PKCE / bearer tokens, never with cookies, so CSRF does not apply.
 */
export const CSRF_EXEMPT_PATHS = ['/oauth/token', '/oauth/revoke', '/oauth/register'];

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

export function crossSiteFormBlocked(r: { method: string; contentType: string | null; origin: string | null; urlOrigin: string; pathname: string }): boolean {
	if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)) return false;
	const ct = (r.contentType ?? '').split(';')[0].trim().toLowerCase();
	if (!FORM_TYPES.includes(ct)) return false;
	if (CSRF_EXEMPT_PATHS.includes(r.pathname)) return false;
	return r.origin !== r.urlOrigin;
}
