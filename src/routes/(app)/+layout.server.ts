/**
 * Auth guard for everything under (app).
 *
 * Unauthenticated requests are 303-redirected to /login with `?next=<path>`
 * pointing at the URL the user originally asked for, so deep links from
 * Salesforce emails ("new case 00001234 was created", "Mike R. replied") land
 * the user on the right record once they sign in.
 */
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { loginUrlPreserving } from '$lib/server/auth/redirects';
import { sql } from '$lib/server/db';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, loginUrlPreserving(url.pathname + url.search));
	}

	// Gate: first-time Google sign-ups must finish onboarding (company/phone/site)
	// before reaching the app. /onboarding lives outside (app) so it's not gated.
	const [acct] = await sql<{ onboarding_completed: boolean }[]>`
		SELECT a.onboarding_completed
		FROM accounts a JOIN users u ON u.account_id = a.id
		WHERE u.id = ${locals.user.id} LIMIT 1
	`;
	if (acct && acct.onboarding_completed === false) {
		throw redirect(303, '/onboarding');
	}

	return {};
};
