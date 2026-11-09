/**
 * The "Onboarding Documents" Required_File__c that every case created from the app
 * starts with.
 */
import { sobjectCreate, SalesforceApiError } from './client';
import { logError } from '../error_log';

export const ONBOARDING_DOCS_NAME = 'Onboarding Documents';

/** Instructions__c is rich text, so this is HTML. */
export const ONBOARDING_DOCS_INSTRUCTIONS = `
<p><strong>Before you start</strong></p>
<p>Onboarding documents let our team verify your business and build a strong appeal. Please have the following ready:</p>
<ul>
<li><strong>Business verification:</strong> a document showing your legal business name and address (for example, a business license or registration certificate).</li>
<li><strong>Marketplace account proof:</strong> a screenshot or export showing the affected account or listing and the notice you received.</li>
<li><strong>Supporting records:</strong> invoices, purchase orders, supplier letters, or any other records related to the issue.</li>
<li><strong>Signed authorization:</strong> any form we’ve asked you to sign so we can act on your behalf.</li>
</ul>
<p><strong>How to upload</strong></p>
<ul>
<li>Select the requested slot and choose your file. You can add several files to the same slot.</li>
<li>Accepted formats: PDF, JPG, PNG (up to 30 MB per file).</li>
<li>Make sure every page is readable and complete. Please don’t upload photos taken at an angle or with cut-off edges.</li>
<li>If a slot doesn’t apply to you, leave it empty and tell us in the case notes.</li>
</ul>
<p><strong>After you upload</strong></p>
<p>Our team reviews your documents, usually within one business day. If something is missing or unclear, the slot will be marked <strong>Needs attention</strong> and you’ll get a message explaining what to fix. When all slots are complete, we begin work on your case.</p>
<p><strong>Need help?</strong> Contact support from the Issues page and mention your case number.</p>
`.trim();

// The spec says ".pdf"; the multi-select picklist may instead hold "pdf". Try both.
const ACCEPTED_FORMAT_CANDIDATES = ['.pdf', 'pdf'];

/** Create the Onboarding Documents slot on a new Case. Best-effort: logs and returns on failure. */
export async function createOnboardingDocsRequiredFile(
	caseId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	let lastError = 'unknown error';
	for (const format of ACCEPTED_FORMAT_CANDIDATES) {
		try {
			const created = await sobjectCreate('Required_File__c', {
				Case__c: caseId,
				Name: ONBOARDING_DOCS_NAME,
				Accepted_Format__c: format,
				Instructions__c: ONBOARDING_DOCS_INSTRUCTIONS
			});
			if (created.success) return { ok: true, id: created.id };
			lastError = `success=false: ${JSON.stringify(created.errors)}`;
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
			// Only a rejected picklist value is worth retrying with the other spelling.
			const picklist = e instanceof SalesforceApiError && /PICKLIST/i.test(e.errorCode ?? lastError);
			if (!picklist) break;
		}
	}
	await logError({
		source: 'salesforce.service_cases',
		operation: 'create_onboarding_required_file',
		severity: 'warn',
		userId: context.userId,
		accountId: context.accountId,
		sfdcObject: 'Required_File__c',
		errorMessage: lastError,
		context: { caseId }
	});
	return { ok: false, error: lastError };
}
