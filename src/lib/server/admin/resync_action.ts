import { fail, type RequestEvent } from '@sveltejs/kit';
import { workspace } from './workspace';
import { auditActor, clientIp, isUuid } from './guard';
import { ActionError } from './actions';
import { resyncRecord, type ResyncKind, type SyncMode } from './sf_sync';

const KINDS: ResyncKind[] = ['account', 'user', 'store', 'contract'];

/** Shared `?/resync` form action: re-sync one account / user / store to Salesforce. */
export async function resyncAction(event: RequestEvent) {
	const { staff, accountId } = await workspace(event, 'accounts.update');
	const d = await event.request.formData();
	const kind = String(d.get('kind') ?? '') as ResyncKind;
	const targetId = String(d.get('targetId') ?? '');
	const mode = String(d.get('mode') ?? '') as SyncMode;
	if (mode !== 'create' && mode !== 'update' && mode !== 'repair') return fail(400, { error: 'Choose whether to create the record or sync it.' });
	if (!KINDS.includes(kind) || !isUuid(targetId)) return fail(400, { error: 'Invalid request.' });
	try {
		const r = await resyncRecord({ actor: auditActor(staff), ip: clientIp(event) }, accountId, kind, targetId, String(d.get('reason') ?? ''), mode);
		return { ok: r.message };
	} catch (e) {
		if (e instanceof ActionError) return fail(e.status, { error: e.message });
		throw e;
	}
}
