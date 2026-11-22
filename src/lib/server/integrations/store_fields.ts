import { ApiError } from './errors';
import { optStr } from './http';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateStoreFields(body: Record<string, unknown>, requireName: boolean) {
	const name = optStr(body, 'name', 200);
	if (requireName && !name) throw new ApiError(422, 'VALIDATION_ERROR', 'name is required.');
	if (name === null) throw new ApiError(422, 'VALIDATION_ERROR', 'name cannot be empty.');
	const sellerPrimaryEmail = optStr(body, 'sellerPrimaryEmail', 254);
	const storeEmail = optStr(body, 'storeEmail', 254);
	for (const [k, v] of [['sellerPrimaryEmail', sellerPrimaryEmail], ['storeEmail', storeEmail]] as const) {
		if (v && !EMAIL_RE.test(v)) throw new ApiError(422, 'VALIDATION_ERROR', `${k} is not a valid email address.`);
	}
	return {
		name,
		sellerPrimaryEmail,
		storeEmail,
		businessName: optStr(body, 'businessName', 200),
		country: optStr(body, 'country', 100),
		description: optStr(body, 'description', 2000)
	};
}
