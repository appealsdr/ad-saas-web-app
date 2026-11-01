/**
 * S3 key shape for Appeals Doctor uploads.
 *
 *   appealsDrApp/                                        ← AWS_S3_APP_ROOT
 *     Accounts/
 *       <accounts.id>/                                   ← local Account UUID
 *         Stores/
 *           <stores.id>/                                 ← local Store UUID
 *             Issues/
 *               <sfdcCaseId>/                            ← Salesforce Case Id
 *                 Files/<docId>_<file>                   ← CASE-level uploads
 *             Documents/<docId>_<file>                   ← STORE-level uploads
 *         Contracts/                                     ← (future) contract files
 *     Templates/                                         ← (future) template files
 *
 * S3 has no real folders — a "folder" is just a key prefix that exists once an
 * object lives under it. `ensureFolderPlaceholder()` PUTs a zero-byte
 * `.placeholder` so empty prefixes still render in the AWS console.
 */
import { env } from '$env/dynamic/private';
import { putObject } from './s3';

const PLACEHOLDER_NAME = '.placeholder';

export function appRoot(): string {
	return env.AWS_S3_APP_ROOT?.trim() || 'appealsDrApp';
}

// ─── Path builders ──────────────────────────────────────────────────────

export function accountPrefix(accountId: string): string {
	return `${appRoot()}/Accounts/${accountId}`;
}

export function storesPrefix(accountId: string): string {
	return `${accountPrefix(accountId)}/Stores`;
}

export function storePrefix(accountId: string, storeId: string): string {
	return `${storesPrefix(accountId)}/${storeId}`;
}

export function contractsPrefix(accountId: string): string {
	return `${accountPrefix(accountId)}/Contracts`;
}

export function caseFilesPrefix(accountId: string, storeId: string, sfdcCaseId: string): string {
	return `${storePrefix(accountId, storeId)}/Issues/${sfdcCaseId}/Files`;
}

export function storeDocsPrefix(accountId: string, storeId: string): string {
	return `${storePrefix(accountId, storeId)}/Documents`;
}

export function templatesPrefix(): string {
	return `${appRoot()}/Templates`;
}

// ─── Key builders for individual uploads ────────────────────────────────

/**
 * CASE-level upload key:
 *   appealsDrApp/Accounts/<accountId>/Stores/<storeId>/Issues/<sfdcCaseId>/Files/<docId>_<file>
 */
export function caseFileKey(args: {
	accountId: string;
	storeId: string;
	sfdcCaseId: string;
	docId: string;
	filename: string;
}): string {
	return `${caseFilesPrefix(args.accountId, args.storeId, args.sfdcCaseId)}/${args.docId}_${args.filename}`;
}

/**
 * STORE-level upload key:
 *   appealsDrApp/Accounts/<accountId>/Stores/<storeId>/Documents/<docId>_<file>
 */
export function storeFileKey(args: {
	accountId: string;
	storeId: string;
	docId: string;
	filename: string;
}): string {
	return `${storeDocsPrefix(args.accountId, args.storeId)}/${args.docId}_${args.filename}`;
}

// ─── Folder placeholders (best-effort) ──────────────────────────────────

export async function ensureFolderPlaceholder(prefix: string): Promise<void> {
	try {
		await putObject(`${prefix}/${PLACEHOLDER_NAME}`, Buffer.alloc(0), 'text/plain');
	} catch {
		// best-effort; never fail the caller
	}
}

/**
 * Reserve the standard folders when a new Account is created:
 *   Accounts/<id>/ , Accounts/<id>/Stores/ , Accounts/<id>/Contracts/
 * Store / issue subfolders are created when their first upload lands.
 */
export async function ensureAccountFolders(accountId: string): Promise<void> {
	await Promise.all([
		ensureFolderPlaceholder(accountPrefix(accountId)),
		ensureFolderPlaceholder(storesPrefix(accountId)),
		ensureFolderPlaceholder(contractsPrefix(accountId))
	]);
}
