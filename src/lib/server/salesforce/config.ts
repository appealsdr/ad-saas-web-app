/**
 * Salesforce JWT Bearer flow configuration.
 *
 * The RSA private key is loaded from one of two places, in order:
 *   1. SFDC_PRIVATE_KEY — the PEM contents inline (used in prod, where the key
 *      is injected from AWS Secrets Manager). JSON-escaped "\n" sequences are
 *      normalized back to real newlines so OpenSSL can parse the PEM.
 *   2. SFDC_PRIVATE_KEY_PATH — a file on disk (used in local dev). Avoids the
 *      PEM-formatting pitfalls that produce OpenSSL "DECODER routines::unsupported".
 *
 * This module is under src/lib/server/ — SvelteKit refuses to import from
 * client code, so neither the key bytes nor the parsed KeyObject can leak
 * to the browser.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { env } from '$env/dynamic/private';

export interface SalesforceConfig {
	clientId: string;             // Connected App "Consumer Key" — JWT iss claim
	username: string;             // Salesforce username to impersonate — JWT sub claim
	privateKey: KeyObject;        // Parsed key — pass to crypto.createSign().sign()
	privateKeyPath: string;       // Resolved absolute path (for diagnostics)
	loginUrl: string;             // https://test.salesforce.com (sandbox) or login.salesforce.com (prod)
	apiVersion: string;           // e.g. 'v60.0'
}

let cached: SalesforceConfig | null = null;

const DEFAULT_KEY_PATH = './keys/server.key';

function resolveKeyPath(raw: string): string {
	return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function readKeyFile(path: string): string {
	try {
		return readFileSync(path, 'utf8');
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(
			`Could not read Salesforce private key at "${path}". ` +
				`Set SFDC_PRIVATE_KEY (inline PEM) or SFDC_PRIVATE_KEY_PATH (file path) ` +
				`in the environment, or place the file at samdoctor-web/${DEFAULT_KEY_PATH}. ` +
				`Underlying error: ${msg}`
		);
	}
}

/**
 * Resolve the PEM, preferring the inline SFDC_PRIVATE_KEY env var (prod, from
 * Secrets Manager) and falling back to the file at SFDC_PRIVATE_KEY_PATH (dev).
 * Returns the PEM text plus a human-readable source label for diagnostics.
 */
function loadPrivateKeyPem(): { pem: string; source: string } {
	const inline = env.SFDC_PRIVATE_KEY?.trim();
	// Only treat the env var as an inline PEM if it actually looks like one.
	// This guards against a misconfigured value (e.g. a file path, a placeholder,
	// or blank) shadowing the file fallback used in local dev.
	if (inline && inline.includes('BEGIN') && inline.includes('PRIVATE KEY')) {
		// Secrets Manager / env injection can deliver newlines as literal "\n";
		// normalize them so OpenSSL sees a well-formed PEM.
		const pem = inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
		return { pem, source: '<SFDC_PRIVATE_KEY env var>' };
	}
	const path = resolveKeyPath(env.SFDC_PRIVATE_KEY_PATH ?? DEFAULT_KEY_PATH);
	return { pem: readKeyFile(path), source: path };
}

function parsePrivateKey(pem: string, path: string): KeyObject {
	// Strip a UTF-8 BOM if the file was saved with one (Windows editors).
	const cleaned = pem.replace(/^﻿/, '').trim();

	if (!cleaned.includes('BEGIN') || !cleaned.includes('PRIVATE KEY')) {
		throw new Error(
			`File at "${path}" does not look like a PEM-encoded private key. ` +
				`Expected a "-----BEGIN PRIVATE KEY-----" (PKCS#8) or ` +
				`"-----BEGIN RSA PRIVATE KEY-----" (PKCS#1) header.`
		);
	}

	try {
		return createPrivateKey({ key: cleaned, format: 'pem' });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const isEncrypted = cleaned.includes('ENCRYPTED');
		const hint = isEncrypted
			? 'The file is an ENCRYPTED private key — JWT bearer flow requires an unencrypted key. ' +
				'Decrypt with: openssl pkcs8 -topk8 -nocrypt -in encrypted.pem -out unencrypted.pem'
			: 'Likely causes: wrong file (public key or certificate, not the private key), ' +
				'unsupported format (DER instead of PEM), or corrupted content.';
		throw new Error(
			`Failed to parse Salesforce private key at "${path}". ${hint} ` +
				`OpenSSL error: ${msg}`
		);
	}
}

/**
 * Load and validate Salesforce config. Throws if any required env var is
 * missing, the key file is unreadable, or the key fails to parse.
 */
export function getSalesforceConfig(): SalesforceConfig {
	if (cached) return cached;

	const clientId = env.SFDC_CLIENT_ID;
	const username = env.SFDC_USERNAME;
	const loginUrl = env.SFDC_LOGIN_URL;
	const apiVersion = env.SFDC_API_VERSION ?? 'v60.0';

	const missing: string[] = [];
	if (!clientId) missing.push('SFDC_CLIENT_ID');
	if (!username) missing.push('SFDC_USERNAME');
	// No fallback here on purpose — silently defaulting to sandbox vs prod
	// sends JWT auth to the wrong Salesforce org with a confusing
	// "app_not_found" error instead of a clear config error.
	if (!loginUrl) missing.push('SFDC_LOGIN_URL');
	if (missing.length) {
		throw new Error(
			`Missing Salesforce env vars: ${missing.join(', ')}. ` +
				`Set them in samdoctor-web/.env (see .env.example).`
		);
	}

	const { pem, source: privateKeyPath } = loadPrivateKeyPem();
	const privateKey = parsePrivateKey(pem, privateKeyPath);

	// Normalize loginUrl — strip trailing slash; aud claim must match exactly.
	const normalizedLogin = loginUrl!.replace(/\/+$/, '');

	cached = Object.freeze({
		clientId: clientId!,
		username: username!,
		privateKey,
		privateKeyPath,
		loginUrl: normalizedLogin,
		apiVersion
	});
	return cached;
}

/** Test hook — forces the next getSalesforceConfig() call to re-read env + file. */
export function resetSalesforceConfigCache(): void {
	cached = null;
}
