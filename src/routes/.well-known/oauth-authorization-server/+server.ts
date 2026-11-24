import { json, type RequestHandler } from '@sveltejs/kit';
import { oauthMetadata, publicOrigin } from '$lib/server/oauth/meta';

export const GET: RequestHandler = ({ url }) =>
	json(oauthMetadata(publicOrigin(url.origin)), { headers: { 'cache-control': 'public, max-age=300' } });
