/**
 * Shared guard for every account-workspace load/action: permission check,
 * UUID validation, account existence, and request-level account correlation.
 */
import { error, type RequestEvent } from '@sveltejs/kit';
import { getAccount } from './accounts';
import { requireUuidParam, requireStaff } from './guard';
import type { Permission } from './permissions';
import { setRequestAccount } from './request_context';

export async function workspace(event: RequestEvent, permission: Permission, opts: { freshMfa?: boolean } = {}) {
	const staff = requireStaff(event, permission, opts);
	const accountId = requireUuidParam(event.params.accountId);
	const account = await getAccount(accountId);
	if (!account) throw error(404, 'Account not found.');
	setRequestAccount(accountId);
	return { staff, account, accountId };
}

const FROM_KEYS = new Set(['q', 'onboarding', 'sort', 'dir', 'page', 'pageSize']);

/** Sanitised list context so "Back to accounts" restores search/page. */
export function sanitizeFrom(raw: string | null): string {
	if (!raw || raw.length > 500) return '';
	const out = new URLSearchParams();
	for (const [k, v] of new URLSearchParams(raw)) if (FROM_KEYS.has(k) && v.length <= 200) out.set(k, v);
	return out.toString();
}
