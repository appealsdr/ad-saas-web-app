/** The parts of a case action result the workspace reads (see createCaseActions). */
export type CaseActionForm = {
	revenueRiskSuccess?: string;
	revenueRiskError?: string;
	uploadSuccess?: string;
	uploadError?: string;
	onboardingSuccess?: string;
	onboardingError?: string;
	onboardingFieldErrors?: Record<string, string>;
	/** Read by the conversation panel from the page form, not by the workspace. */
	messageError?: string;
	messageSuccess?: string;
	readSuccess?: boolean;
	readError?: string;
	/** Set by a client action that leaves nothing outstanding on a waiting case. */
	promptNotify?: boolean;
	notifySuccess?: string;
	notifyError?: string;
} | null;
