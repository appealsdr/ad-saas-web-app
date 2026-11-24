import { json, type RequestHandler } from '@sveltejs/kit';
import { resourceMetadata, publicOrigin } from '$lib/server/oauth/meta';

export const GET: RequestHandler = ({ url }) =>
	json(resourceMetadata(publicOrigin(url.origin)), { headers: { 'cache-control': 'public, max-age=300' } });
