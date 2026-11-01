/**
 * Salesforce email helpers.
 *
 * Uses the standard emailSimple invocable action so no Apex class is needed.
 * The call is fire-and-forget from the Salesforce side — Salesforce queues and
 * delivers the message via its own email infrastructure.
 *
 * Reference:
 *   POST /services/data/<v>/actions/standard/emailSimple
 *
 * Failures are logged to our own error_log (source 'salesforce.email') so a
 * silently-dropped send is still visible to us. When the recipient has a
 * known Salesforce Contact (e.g. a password-reset email), a successful send
 * is also logged as an EmailMessage related to that Contact (RelatedToId) —
 * this is what actually shows the email on the Contact's Activity history in
 * Salesforce.
 */
import { sfdcFetch, sobjectCreate, SalesforceApiError } from './client';
import { getSalesforceConfig } from './config';
import { logError } from '../error_log';

// Standard EmailMessage.Status picklist value for a sent (outbound) email.
const EMAIL_MESSAGE_STATUS_SENT = '3';

interface EmailSimpleInput {
	emailAddresses: string;
	emailSubject: string;
	emailBody: string;
	senderDisplayName?: string;
}

interface EmailSimpleResponse {
	actionName: string;
	errors: null | unknown[];
	isSuccess: boolean;
	outputValues: null | Record<string, unknown>;
}

export async function sendEmailViaSalesforce(input: EmailSimpleInput): Promise<void> {
	const { apiVersion } = getSalesforceConfig();
	const result = await sfdcFetch<EmailSimpleResponse[]>(
		`/services/data/${apiVersion}/actions/standard/emailSimple`,
		{
			method: 'POST',
			body: JSON.stringify({ inputs: [input] })
		}
	);
	const first = Array.isArray(result) ? result[0] : null;
	if (!first?.isSuccess) {
		const errors = first?.errors;
		throw new Error(
			`Salesforce emailSimple failed: ${errors ? JSON.stringify(errors) : 'unknown error'}`
		);
	}
}

/**
 * Best-effort: create an EmailMessage in Salesforce related to a Contact so
 * the send shows up on that Contact's Activity history. Never throws —
 * a logging failure shouldn't be mistaken for the email itself failing.
 */
async function logEmailToContact(
	sfdcContactId: string,
	fields: { toAddress: string; subject: string; textBody: string },
	context: { userId?: string; accountId?: string } = {}
): Promise<void> {
	try {
		await sobjectCreate('EmailMessage', {
			RelatedToId: sfdcContactId,
			ToAddress: fields.toAddress,
			Subject: fields.subject,
			TextBody: fields.textBody,
			Status: EMAIL_MESSAGE_STATUS_SENT,
			Incoming: false
		});
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		await logError({
			source: 'salesforce.email',
			operation: 'log_email_message',
			severity: 'warn',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'EmailMessage',
			errorCode: isSfErr ? e.errorCode ?? String(e.status) : undefined,
			errorMessage: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcContactId, toAddress: fields.toAddress }
		});
	}
}

export async function sendPasswordResetEmail(
	email: string,
	resetUrl: string,
	context: { sfdcContactId?: string | null; userId?: string; accountId?: string } = {}
): Promise<void> {
	const subject = 'Reset your Appeals Doctor password';
	const body = `
Hello,

We received a request to reset the password for your Appeals Doctor account (${email}).

Click the link below to choose a new password. The link expires in 1 hour.

${resetUrl}

If you did not request a password reset, you can safely ignore this email — your password has not been changed.

— The Appeals Doctor Team
`.trim();

	try {
		await sendEmailViaSalesforce({
			emailAddresses: email,
			emailSubject: subject,
			emailBody: body,
			senderDisplayName: 'Appeals Doctor'
		});
	} catch (e) {
		// Store a log of the failed send — callers may also log their own
		// context (e.g. cleaning up the reset token), but this ensures the
		// failure is captured here too, tied to the Contact when known.
		await logError({
			source: 'salesforce.email',
			operation: 'send_password_reset',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Contact',
			errorMessage: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack : undefined,
			context: { email, sfdcContactId: context.sfdcContactId ?? null }
		});
		throw e;
	}

	// Sent successfully — log it against the Contact so it's visible on their
	// Activity history in Salesforce, when we know who they are there.
	if (context.sfdcContactId) {
		await logEmailToContact(
			context.sfdcContactId,
			{ toAddress: email, subject, textBody: body },
			context
		);
	}
}

/**
 * Security notification: tell the account holder their password was changed.
 * Never contains the password. Best-effort — a delivery failure is logged and
 * returned as false, and must not undo the password change that already happened.
 *
 *   completed   the user finished a reset (link or forced reset) themselves
 *   admin       a platform administrator set a temporary password; they must choose a new one
 */
export async function sendPasswordChangedEmail(
	email: string,
	how: 'completed' | 'admin',
	context: { sfdcContactId?: string | null; userId?: string; accountId?: string } = {}
): Promise<boolean> {
	const subject = how === 'admin' ? 'Your Appeals Doctor password was reset by an administrator' : 'Your Appeals Doctor password was changed';
	const lead =
		how === 'admin'
			? `A member of the Appeals Doctor team reset the password for your account (${email}). You were signed out everywhere and will be asked to choose a new password the next time you sign in. Your administrator will share the temporary password with you separately.`
			: `The password for your Appeals Doctor account (${email}) was just changed, and you were signed out of all sessions.`;
	const body = `
Hello,

${lead}

If you did not expect this, contact us right away so we can secure your account.

— The Appeals Doctor Team
`.trim();
	try {
		await sendEmailViaSalesforce({ emailAddresses: email, emailSubject: subject, emailBody: body, senderDisplayName: 'Appeals Doctor' });
	} catch (e) {
		await logError({
			source: 'salesforce.email',
			operation: 'send_password_changed',
			severity: 'warn',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Contact',
			errorMessage: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack : undefined,
			context: { email, how }
		});
		return false;
	}
	if (context.sfdcContactId) await logEmailToContact(context.sfdcContactId, { toAddress: email, subject, textBody: body }, context);
	return true;
}
