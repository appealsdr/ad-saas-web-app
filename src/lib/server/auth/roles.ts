import type { UserRole } from '$lib/types';

export function canManageAccountContacts(role: string | null | undefined): boolean {
	return role === 'owner' || role === 'admin';
}

export function isAccountOwner(role: string | null | undefined): boolean {
	return role === 'owner';
}

export function parseUserRole(role: string | null | undefined): UserRole {
	if (role === 'owner' || role === 'admin' || role === 'member') return role;
	return 'member';
}
