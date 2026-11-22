/** API error type carrying a stable machine-readable code. */
import type { IntegrationPrincipal } from './auth';

export class ApiError extends Error {
	/** Set once the credential resolved to an integration, so the failure is still audited against it. */
	principal?: Pick<IntegrationPrincipal, 'integrationId' | 'integrationName' | 'accountId' | 'credentialId' | 'defaultUserId'>;
	requiredPermission?: string;
	retryAfterSeconds?: number;
	constructor(
		readonly status: number,
		readonly code: string,
		message: string
	) {
		super(message);
	}
}
