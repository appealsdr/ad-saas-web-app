/**
 * S3 storage helpers — server-only.
 *
 * Credentials resolution order (first match wins):
 *   1. Env vars: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional
 *      AWS_SESSION_TOKEN for STS / role-assume sessions).
 *      ← This is what `samdoctor-web/.env` uses in dev.
 *   2. AWS SDK default provider chain — `~/.aws/credentials`, EC2/ECS
 *      instance role, etc. Used when the env vars are absent (prod via
 *      ECS/Fargate task role).
 *
 * Bucket comes from AWS_S3_BUCKET; region from AWS_REGION.
 *
 * Three operations exposed:
 *   - putObject(key, bytes, contentType?) — write a file (SSE-AES256)
 *   - getDownloadUrl(key, filename?)     — presigned URL valid 5 min
 *   - deleteObject(key)                  — best-effort delete
 *
 * Plus checkS3Config() — verifies env vars exist (does NOT hit AWS).
 */
import { env } from '$env/dynamic/private';
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadBucketCommand,
	type S3ClientConfig
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

let cachedClient: S3Client | null = null;

function buildClient(): S3Client {
	const region = env.AWS_REGION?.trim() || 'us-east-1';
	const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
	const sessionToken = env.AWS_SESSION_TOKEN?.trim();

	const config: S3ClientConfig = { region };

	// If BOTH env-var credentials are set, use them explicitly. Otherwise let
	// the SDK fall through its default provider chain (~/.aws/credentials,
	// instance role, etc.). Setting just one of the two is almost certainly
	// a mistake — log it and refuse.
	if (accessKeyId && secretAccessKey) {
		config.credentials = {
			accessKeyId,
			secretAccessKey,
			...(sessionToken ? { sessionToken } : {})
		};
	} else if (accessKeyId || secretAccessKey) {
		throw new Error(
			'Only one of AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY is set in env. ' +
				'Provide both, or clear both and rely on the AWS default provider chain ' +
				'(~/.aws/credentials, ECS task role, etc.).'
		);
	}

	return new S3Client(config);
}

function getClient(): S3Client {
	if (cachedClient) return cachedClient;
	cachedClient = buildClient();
	return cachedClient;
}

export function getBucketName(): string {
	const b = env.AWS_S3_BUCKET?.trim();
	if (!b) {
		throw new Error(
			'AWS_S3_BUCKET is not set. Add it to samdoctor-web/.env (see ' +
				'src/lib/server/storage/README.md for setup).'
		);
	}
	return b;
}

export function getRegion(): string {
	return env.AWS_REGION?.trim() || 'us-east-1';
}

/**
 * Sync, env-only sanity check — returns { ok, problems[] }. Useful for
 * diagnostic endpoints. Does NOT make any AWS calls.
 */
export function checkS3Config(): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	if (!env.AWS_S3_BUCKET?.trim()) problems.push('AWS_S3_BUCKET is not set.');
	if (!env.AWS_REGION?.trim()) problems.push('AWS_REGION is not set (will default to us-east-1).');

	const hasKey = !!env.AWS_ACCESS_KEY_ID?.trim();
	const hasSecret = !!env.AWS_SECRET_ACCESS_KEY?.trim();
	if (hasKey !== hasSecret) {
		problems.push('Only one of AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY is set; provide both or neither.');
	}
	if (!hasKey && !hasSecret) {
		problems.push(
			'No AWS env-var credentials. Falling back to the SDK default chain — ' +
				'works in prod (ECS task role) and `aws configure`, fails everywhere else.'
		);
	}
	return { ok: problems.length === 0, problems };
}

/**
 * Async sanity check that actually hits AWS — HeadBucket on the configured
 * bucket. Returns { ok, error }. Cheap (HEAD is free) and tells you whether
 * credentials + region + bucket access all line up.
 */
export async function pingBucket(): Promise<{ ok: true } | { ok: false; error: string }> {
	const bucket = getBucketName();
	try {
		await getClient().send(new HeadBucketCommand({ Bucket: bucket }));
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function putObject(
	key: string,
	body: Buffer | Uint8Array,
	contentType?: string
): Promise<{ bucket: string; key: string }> {
	const bucket = getBucketName();
	await getClient().send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: contentType,
			ServerSideEncryption: 'AES256'
		})
	);
	return { bucket, key };
}

/**
 * Presigned URL the browser can fetch directly from S3. Honors `filename`
 * by setting Content-Disposition so the file downloads with the original name.
 */
export async function getDownloadUrl(
	key: string,
	filename?: string,
	opts: { disposition?: 'attachment' | 'inline'; contentType?: string | null } = {}
): Promise<string> {
	const disposition = opts.disposition ?? 'attachment';
	const cmd = new GetObjectCommand({
		Bucket: getBucketName(),
		Key: key,
		ResponseContentDisposition: filename
			? `${disposition}; filename="${encodeURIComponent(filename)}"`
			: disposition === 'inline'
				? 'inline'
				: undefined,
		// Force the right type so the browser renders inline previews correctly
		// even when the stored object's Content-Type is missing or wrong.
		ResponseContentType: opts.contentType ?? undefined
	});
	return getSignedUrl(getClient(), cmd, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
}

export async function deleteObject(key: string): Promise<void> {
	try {
		await getClient().send(
			new DeleteObjectCommand({ Bucket: getBucketName(), Key: key })
		);
	} catch {
		// best-effort
	}
}
