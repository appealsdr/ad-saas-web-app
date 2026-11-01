import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { accountContracts, PAYMENT_FIELDS } from '$lib/server/admin/billing';
import { sfdcQuery } from '$lib/server/salesforce/client';
import { salesforceUrl, stripeUrl } from '$lib/server/admin/links';

interface SfPayment {
	Id: string; Name: string; Amount__c: number | null; Total_Paid__c: number | null; Status__c: string | null; Payment_Type__c: string | null;
	PaidAt__c: string | null; Description__c: string | null; CreatedDate: string; LastModifiedDate: string; Stripe_Payment_Intent_Id__c: string | null;
	Stripe_Checkout_Session_Id__c: string | null; Payment_Method__c: string | null; Service_Contract__c: string | null; Contract_Line_Item__c: string | null;
}

export const load: PageServerLoad = async (event) => {
	const { accountId } = await workspace(event, 'accounts.read');
	const key = decodeURIComponent(event.params.paymentId);
	// Tenancy: the payment must belong to one of THIS account's contracts.
	const { contracts } = await accountContracts(accountId);
	const contract = contracts.find((c) => c.payments.some((p) => p.key === key));
	const p = contract?.payments.find((x) => x.key === key);
	if (!contract || !p) throw error(404, 'Payment not found on this account.');

	let sf: SfPayment | null = null;
	if (p.sfId) {
		try { sf = (await sfdcQuery<SfPayment>(`SELECT ${PAYMENT_FIELDS} FROM Payment__c WHERE Id = '${p.sfId.replace(/'/g, '')}' LIMIT 1`)).records[0] ?? null; } catch { sf = null; }
	}
	const money = (n: number | null | undefined) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
	const ts = (s: string | null | undefined) => (s ? s.replace('T', ' ').slice(0, 19) + ' UTC' : '—');
	const SFo = 'sf' as const, LOC = 'local' as const, SYS = 'sys' as const;
	return {
		name: p.name, key, sfId: p.sfId, contract: { id: contract.id, ref: contract.ref },
		sfUrl: await salesforceUrl('Payment__c', p.sfId),
		stripePiUrl: stripeUrl('payment', p.stripePi),
		groups: [
			{ title: 'Payment', rows: [
				{ key: 'name', label: 'Payment', value: p.name, own: SFo, api: 'Payment__c.Name', mono: true },
				{ key: 'type', label: 'Type', value: p.kind, own: SFo, api: 'Payment__c.Payment_Type__c' },
				{ key: 'amount', label: 'Amount', value: money(sf?.Amount__c ?? p.amount), own: SFo, api: 'Payment__c.Amount__c' },
				{ key: 'paid', label: 'Total paid', value: money(sf?.Total_Paid__c), own: SFo, api: 'Payment__c.Total_Paid__c' },
				{ key: 'status', label: 'Status', value: p.statusRaw, own: SFo, api: 'Payment__c.Status__c' },
				{ key: 'paidAt', label: 'Paid at', value: sf?.PaidAt__c ? ts(sf.PaidAt__c) : p.status === 'paid' ? p.date : '—', own: SFo, api: 'Payment__c.PaidAt__c' },
				{ key: 'desc', label: 'Description', value: sf?.Description__c ?? '—', own: SFo, api: 'Payment__c.Description__c' },
				{ key: 'method', label: 'Payment method', value: sf?.Payment_Method__c ?? '—', own: SFo, api: 'Payment__c.Payment_Method__c', mono: true },
				{ key: 'line', label: 'Line payment', value: p.isLine ? 'Yes — a component of the First Payment' : 'No', own: SYS }
			] },
			{ title: 'Related', rows: [
				{ key: 'contract', label: 'Contract', value: contract.ref, own: SYS, note: 'local service contract' },
				{ key: 'store', label: 'Store', value: contract.storeName ?? '—', own: SYS },
				{ key: 'sfContract', label: 'Salesforce contract', value: contract.sfdcId ?? '—', own: LOC, mono: true },
				{ key: 'sfLine', label: 'Contract line item', value: sf?.Contract_Line_Item__c ?? '—', own: SFo, api: 'Payment__c.Contract_Line_Item__c', mono: true }
			] },
			{ title: 'Stripe', rows: [
				{ key: 'pi', label: 'Payment intent', value: p.stripePi ?? '—', own: SFo, api: 'Payment__c.Stripe_Payment_Intent_Id__c', mono: true, href: stripeUrl('payment', p.stripePi) ?? undefined },
				{ key: 'cs', label: 'Checkout session', value: sf?.Stripe_Checkout_Session_Id__c ?? '—', own: SFo, api: 'Payment__c.Stripe_Checkout_Session_Id__c', mono: true }
			] },
			{ title: 'IDs & system', rows: [
				{ key: 'id', label: 'Salesforce payment', value: p.sfId ?? 'none — synthesised from the Stripe charge', own: LOC, mono: !!p.sfId, note: p.sfId ? 'the link to Salesforce' : undefined },
				{ key: 'created', label: 'Created', value: ts(sf?.CreatedDate), own: SFo, api: 'Payment__c.CreatedDate' },
				{ key: 'modified', label: 'Last modified', value: ts(sf?.LastModifiedDate), own: SFo, api: 'Payment__c.LastModifiedDate' }
			] }
		]
	};
};
