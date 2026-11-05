/**
 * "Steps not completed" for case tables: required documents not yet uploaded, plus
 * onboarding information not yet provided. Same idea as the setup steps on the stores list.
 */
import { listRequiredFilesForCases } from './required-files';
import { listOnboardingStatusForCases } from './case-onboarding';

export interface CaseSteps {
	docsTotal: number;
	docsUploaded: number;
	/** Names of required documents not uploaded yet. */
	pendingDocs: string[];
	/** null = the case has no onboarding config. */
	onboardingProvided: boolean | null;
}

export async function getCaseSteps(caseIds: string[]): Promise<Map<string, CaseSteps>> {
	const out = new Map<string, CaseSteps>();
	if (caseIds.length === 0) return out;

	const [files, onboarding] = await Promise.all([
		listRequiredFilesForCases(caseIds),
		listOnboardingStatusForCases(caseIds)
	]);

	const get = (id: string): CaseSteps => {
		let s = out.get(id);
		if (!s) {
			s = { docsTotal: 0, docsUploaded: 0, pendingDocs: [], onboardingProvided: null };
			out.set(id, s);
		}
		return s;
	};
	if (files.ok) {
		for (const f of files.files) {
			const s = get(f.parentId);
			s.docsTotal += 1;
			if (f.uploaded) s.docsUploaded += 1;
			else s.pendingDocs.push(f.name);
		}
	}
	for (const [id, o] of onboarding) get(id).onboardingProvided = o.provided;
	return out;
}
