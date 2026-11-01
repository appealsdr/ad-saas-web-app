export interface Crumb {
	label: string;
	href?: string;
}

const SEGMENT_LABELS: Record<string, string> = {
	dashboard: 'Dashboard',
	accounts: 'Account',
	subscription: 'Subscription & plans',
	stores: 'Stores',
	issues: 'Cases',
	cases: 'Cases',
	payments: 'Payments',
	feedback: 'Feedback',
	help: 'How to Use',
	services: 'Plan & Services',
	chat: 'AI Chat',
	assistants: 'Assistants',
	assistance: 'Assistance'
};

/** Segments that are record ids; resolved from the page data, else a generic label. */
function recordLabel(parent: string, data: Record<string, any>): string {
	switch (parent) {
		case 'stores':
			return data.storeTab?.name ?? data.store?.name ?? 'Store';
		case 'issues':
		case 'cases':
			return data.case?.CaseNumber ?? 'Case';
		case 'payments':
			return data.contract?.stripePaymentIntentId ? 'Service contract' : 'Invoice';
		case 'feedback':
			return 'Feedback detail';
		default:
			return 'Details';
	}
}

/**
 * Breadcrumb trail for an (app) route: Dashboard / <section> / <record> / …
 * Every crumb except the last links to its page.
 */
export function buildCrumbs(pathname: string, data: Record<string, any>): Crumb[] {
	const segs = pathname.split('/').filter(Boolean);
	const crumbs: Crumb[] = [];
	let href = '';
	segs.forEach((seg, i) => {
		href += `/${seg}`;
		// A case lives under /stores/<id>/issues/<caseId>; /stores/<id>/issues has no page.
		if (seg === 'issues' && segs[i - 2] === 'stores') return;
		const label = SEGMENT_LABELS[seg] ?? recordLabel(segs[i - 1] ?? '', data);
		crumbs.push({ label, href });
	});
	if (crumbs[0]?.label !== 'Dashboard') crumbs.unshift({ label: 'Dashboard', href: '/dashboard' });
	crumbs[crumbs.length - 1].href = undefined;
	return crumbs;
}
