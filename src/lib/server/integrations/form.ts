import type { IntegrationInput } from './service';
import { INTEGRATION_PERMISSIONS, PERMISSION_LABELS } from './permissions';

export const PERMISSION_OPTIONS = INTEGRATION_PERMISSIONS.map((id) => ({ id, label: PERMISSION_LABELS[id] }));

const int = (v: FormDataEntryValue | null): number | undefined => {
	const s = String(v ?? '').trim();
	return s === '' ? undefined : Number(s);
};

export function parseIntegrationForm(d: FormData): IntegrationInput {
	const ttl = String(d.get('credentialTtlDays') ?? '').trim();
	const copy = String(d.get('copyPermissionsFromId') ?? '').trim();
	return {
		name: String(d.get('name') ?? ''),
		description: String(d.get('description') ?? ''),
		defaultUserId: String(d.get('defaultUserId') ?? ''),
		// Unchecked boxes simply are not submitted; an empty list is rejected ("at least one").
		permissions: d.getAll('permissions').map(String),
		copyPermissionsFromId: copy || null,
		allowedIps: String(d.get('allowedIps') ?? ''),
		rateLimitPerMinute: int(d.get('rateLimitPerMinute')),
		credentialTtlDays: ttl === '' ? null : Number(ttl),
		rotationGraceHours: int(d.get('rotationGraceHours'))
	};
}
