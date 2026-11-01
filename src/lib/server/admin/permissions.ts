/**
 * Platform roles and their permissions. This is the single server-side map;
 * never derive platform access from users.role (customer roles) or email.
 */
export type PlatformRole = 'platform_admin' | 'platform_viewer';

export type Permission =
	| 'accounts.read'
	| 'accounts.update'
	| 'accounts.delete'
	| 'users.read'
	| 'users.manage'
	| 'logs.read'
	| 'data.read'
	| 'data.query'
	| 'staff.manage';

export const PLATFORM_ROLES: PlatformRole[] = ['platform_admin', 'platform_viewer'];

const ROLE_PERMISSIONS: Record<PlatformRole, ReadonlySet<Permission>> = {
	platform_admin: new Set<Permission>([
		'accounts.read',
		'accounts.update',
		'accounts.delete',
		'users.read',
		'users.manage',
		'logs.read',
		'data.read',
		'data.query',
		'staff.manage'
	]),
	platform_viewer: new Set<Permission>(['accounts.read', 'users.read', 'logs.read', 'data.read'])
};

export function isPlatformRole(v: unknown): v is PlatformRole {
	return v === 'platform_admin' || v === 'platform_viewer';
}

export function roleHas(role: PlatformRole | null | undefined, permission: Permission): boolean {
	if (!role || !isPlatformRole(role)) return false;
	return ROLE_PERMISSIONS[role].has(permission);
}
