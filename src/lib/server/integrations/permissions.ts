/**
 * Permission profile for API integrations (AD-1966).
 *
 * Permissions are explicit and never imply one another (`stores.read` does not
 * grant `stores.list`, `messages.list` does not grant `messages.create`, ...).
 * The DB CHECK on integration_clients.permissions mirrors this allowlist.
 */
export type IntegrationPermission =
	| 'stores.list'
	| 'stores.read'
	| 'stores.create'
	| 'stores.update'
	| 'cases.list'
	| 'cases.read'
	| 'cases.create'
	| 'messages.list'
	| 'messages.create'
	| 'files.requirements.read'
	| 'files.upload';

export const INTEGRATION_PERMISSIONS: readonly IntegrationPermission[] = [
	'stores.list',
	'stores.read',
	'stores.create',
	'stores.update',
	'cases.list',
	'cases.read',
	'cases.create',
	'messages.list',
	'messages.create',
	'files.requirements.read',
	'files.upload'
] as const;

export const PERMISSION_LABELS: Record<IntegrationPermission, string> = {
	'stores.list': 'List account stores',
	'stores.read': 'Read one store',
	'stores.create': 'Create a store',
	'stores.update': 'Update a store',
	'cases.list': 'List cases related to a store',
	'cases.read': 'Read one case',
	'cases.create': 'Create a case',
	'messages.list': 'Read case messages/comments',
	'messages.create': 'Create a case message/comment',
	'files.requirements.read': 'Read required-file instructions and status',
	'files.upload': 'Upload files into a required-file slot'
};

export function isIntegrationPermission(v: unknown): v is IntegrationPermission {
	return typeof v === 'string' && (INTEGRATION_PERMISSIONS as readonly string[]).includes(v);
}

/**
 * Validate + normalise a submitted permission list: every entry must be in the
 * allowlist, duplicates are dropped, at least one must remain. Stable order.
 */
export function normalizePermissions(input: unknown): IntegrationPermission[] {
	if (!Array.isArray(input)) throw new Error('permissions must be a list.');
	const seen = new Set<IntegrationPermission>();
	for (const p of input) {
		if (!isIntegrationPermission(p)) throw new Error(`Unsupported permission "${String(p).slice(0, 60)}".`);
		seen.add(p);
	}
	if (seen.size === 0) throw new Error('At least one permission must be selected.');
	return INTEGRATION_PERMISSIONS.filter((p) => seen.has(p));
}

export function diffPermissions(before: readonly string[], after: readonly string[]) {
	return {
		addedPermissions: after.filter((p) => !before.includes(p)),
		removedPermissions: before.filter((p) => !after.includes(p))
	};
}
