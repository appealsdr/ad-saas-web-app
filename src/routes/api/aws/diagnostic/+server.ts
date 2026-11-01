/**
 * GET /api/aws/diagnostic
 *
 * Reports the S3 config the app reads from env + hits HeadBucket to verify
 * credentials + region + bucket access all line up.
 *
 * Platform staff only (admin session + MFA; `data.query` permission, i.e.
 * platform_admin). Customer sessions are never accepted here.
 */
import { json } from '@sveltejs/kit';
import { requireStaff } from '$lib/server/admin/guard';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { checkS3Config, getBucketName, getRegion, pingBucket } from '$lib/server/storage/s3';

function masked(v: string | undefined): string {
	if (!v) return '(unset)';
	if (v.length <= 8) return '****';
	return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

export const GET: RequestHandler = async (event) => {
	requireStaff(event, 'data.query');

	const sync = checkS3Config();
	const ping = sync.ok ? await pingBucket() : { ok: false as const, error: 'skipped — see sync.problems' };

	return json({
		envSummary: {
			AWS_REGION: env.AWS_REGION ?? '(unset; defaults to us-east-1)',
			AWS_S3_BUCKET: env.AWS_S3_BUCKET ?? '(unset)',
			AWS_ACCESS_KEY_ID: masked(env.AWS_ACCESS_KEY_ID),
			AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY ? 'set' : '(unset)',
			AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN ? 'set' : '(unset)'
		},
		resolved: {
			region: getRegion(),
			bucket: env.AWS_S3_BUCKET ? getBucketName() : null
		},
		syncCheck: sync,
		ping,
		hint:
			ping.ok
				? '✓ Credentials work and the bucket is reachable.'
				: sync.ok
					? 'Env vars look right but the actual S3 call failed — fix the error above.'
					: 'Fix the env-var problems first.'
	});
};
