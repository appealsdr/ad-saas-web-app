// Issue a new Salesforce API key (see src/lib/server/auth/api_key.ts).
// Prints the raw key ONCE — store it in Salesforce's Named Credential /
// External Client App config immediately, it cannot be recovered later.
//
// Usage:
//   node scripts/issue-api-key.mjs "Salesforce - provisioning" provision,reset_password
//   node scripts/issue-api-key.mjs "Salesforce - provisioning" provision,reset_password 2027-01-01
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import postgres from 'postgres';

const env = {};
for (const line of readFileSync('.env', 'utf8').split('\n')) {
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (!m) continue;
	env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
}

const label = process.argv[2];
const scopes = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
const expiresAt = process.argv[4] ? new Date(process.argv[4]) : null;

if (!label || scopes.length === 0) {
	console.error('Usage: node scripts/issue-api-key.mjs "<label>" <scope1,scope2> [expiresAt ISO date]');
	console.error('Valid scopes: provision, reset_password');
	process.exit(1);
}

const sql = postgres(env.DATABASE_URL, { max: 1 });

const rawKey = `sfdc_${randomBytes(32).toString('base64url')}`;
const keyHash = createHash('sha256').update(rawKey).digest('hex');

const [row] = await sql`
	INSERT INTO api_keys (label, key_hash, scopes, expires_at)
	VALUES (${label}, ${keyHash}, ${scopes}, ${expiresAt})
	RETURNING id
`;

console.log(`API key id: ${row.id}`);
console.log(`Scopes:     ${scopes.join(', ')}`);
console.log(`Expires:    ${expiresAt ? expiresAt.toISOString() : 'never'}`);
console.log('');
console.log('Raw key (shown once — copy it now):');
console.log(rawKey);

await sql.end();
