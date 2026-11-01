/**
 * Single read point for admin-related environment variables. Uses SvelteKit's
 * dynamic private env (works in dev and in the built server). Tests alias
 * `$env/dynamic/private` to process.env (see vitest.config.ts).
 */
import { env } from '$env/dynamic/private';

export function adminEnv(name: string): string | undefined {
	const v = env[name];
	return v === undefined || v === '' ? undefined : v;
}

export function adminIssuer(): string {
	return adminEnv('ADMIN_MFA_ISSUER') ?? 'Appeals Doctor Admin';
}
