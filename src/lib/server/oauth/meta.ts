import { env } from '$env/dynamic/private';
import { ALL_SCOPES } from './core';

/** Public origin of the app (ORIGIN env behind a proxy, else the request's origin). No trailing slash. */
export const publicOrigin = (reqOrigin: string) => (env.ORIGIN || reqOrigin).replace(/\/$/, '');

export const oauthMetadata = (origin: string) => ({
	issuer: origin,
	authorization_endpoint: `${origin}/oauth/authorize`,
	token_endpoint: `${origin}/oauth/token`,
	registration_endpoint: `${origin}/oauth/register`,
	revocation_endpoint: `${origin}/oauth/revoke`,
	response_types_supported: ['code'],
	grant_types_supported: ['authorization_code', 'refresh_token'],
	code_challenge_methods_supported: ['S256'],
	token_endpoint_auth_methods_supported: ['none'],
	scopes_supported: ALL_SCOPES
});

export const resourceMetadata = (origin: string) => ({
	resource: `${origin}/mcp`,
	authorization_servers: [origin],
	scopes_supported: ALL_SCOPES,
	bearer_methods_supported: ['header']
});

export const JSON_HEADERS = { 'cache-control': 'no-store', pragma: 'no-cache' };
