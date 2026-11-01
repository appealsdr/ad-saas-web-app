// Local diagnostic: print the presigned INLINE preview URL the app would
// generate for a given S3 key, using the same config from .env.
// Usage: node scripts/presign-demo.mjs "<key>" "<filename>" "<mime>"
import { readFileSync } from 'node:fs';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const env = {};
for (const line of readFileSync('.env', 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (!m) continue;
	env[m[1]] = m[2]
		.replace(/\s+#.*$/, '') // strip inline comment (dotenv-style)
		.replace(/^["']|["']$/g, '')
		.trim();
}

const region = env.AWS_REGION || 'us-east-1';
const bucket = env.AWS_S3_BUCKET;
const key = process.argv[2];
const filename = process.argv[3] || 'file';
const mime = process.argv[4] || undefined;

const client = new S3Client({
	region,
	credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
});

const cmd = new GetObjectCommand({
	Bucket: bucket,
	Key: key,
	ResponseContentDisposition: `inline; filename="${encodeURIComponent(filename)}"`,
	ResponseContentType: mime
});

const url = await getSignedUrl(client, cmd, { expiresIn: 300 });

console.log('Region          :', region);
console.log('Bucket          :', bucket);
console.log('Access key (id) :', (env.AWS_ACCESS_KEY_ID || '').slice(0, 8) + '…');
console.log('Key             :', key);
console.log('\n=== Presigned INLINE preview URL (valid 5 min) ===\n');
console.log(url);
