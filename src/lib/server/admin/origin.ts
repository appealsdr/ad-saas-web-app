/**
 * CSRF / origin validation for state-changing admin requests. SvelteKit's
 * built-in check only covers form content types; admin JSON fetches (SQL
 * editor) need this too.
 */
export function isSafeMethod(method: string): boolean {
	return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

export function adminOriginOk(input: {
	method: string;
	origin: string | null;
	secFetchSite: string | null;
	requestOrigin: string; // url.origin of this request
	configuredOrigin?: string; // env.ORIGIN, if set
}): boolean {
	if (isSafeMethod(input.method)) return true;
	if (input.origin) {
		return input.origin === input.requestOrigin || (!!input.configuredOrigin && input.origin === input.configuredOrigin);
	}
	// No Origin header: accept only browser-declared same-origin fetches.
	return input.secFetchSite === 'same-origin';
}
