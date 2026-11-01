/**
 * Salesforce helpers for the subscription lifecycle.
 *
 * An account's active subscription ServiceContract is tracked in
 * Account.Service_Contract__c (and mirrored to each Store__c.Service_Contract__c).
 * Subscribing to a new plan cancels the
 * store's previous active ServiceContract in Salesforce and repoints the
 * lookup at the new one.
 *
 * Note: this assumes the org's ServiceContract.Status picklist includes a
 * "Cancelled" value — if your org uses a different label, update
 * CANCELLED_STATUS below.
 */
import { sobjectUpdate, SalesforceApiError } from './client';
import { logError } from '../error_log';

const CANCELLED_STATUS = 'Cancelled';

export type SfResult = { ok: true } | { ok: false; error: string; errorCode?: string };

function todaySfDate(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * Mark a ServiceContract cancelled (Status + EndDate = today).
 * Also sets Payment_Status__c = 'Canceled' unless `skipPaymentStatus` is
 * passed (e.g. when the contract being replaced was never a paid
 * subscription in the first place). Best-effort.
 */
export async function cancelServiceContract(
	sfdcServiceContractId: string,
	context: { userId?: string; accountId?: string; skipPaymentStatus?: boolean } = {}
): Promise<SfResult> {
	try {
		await sobjectUpdate('ServiceContract', sfdcServiceContractId, {
			Status: CANCELLED_STATUS,
			EndDate: todaySfDate(),
			...(context.skipPaymentStatus ? {} : { Payment_Status__c: 'Canceled' })
		});
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.subscriptions',
			operation: 'cancel_service_contract',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'ServiceContract',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcServiceContractId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/** Point Account.Service_Contract__c at the account's current active subscription (null clears it). */
export async function setAccountActiveServiceContract(
	sfdcAccountId: string,
	sfdcServiceContractId: string | null,
	context: { userId?: string; accountId?: string } = {}
): Promise<SfResult> {
	try {
		await sobjectUpdate('Account', sfdcAccountId, {
			Service_Contract__c: sfdcServiceContractId
		});
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.subscriptions',
			operation: 'set_account_active_service_contract',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Account',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcAccountId, sfdcServiceContractId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/** Point Store__c.Service_Contract__c at the store's current active contract (null clears it). */
export async function setStoreActiveServiceContract(
	sfdcStoreId: string,
	sfdcServiceContractId: string | null,
	context: { userId?: string; accountId?: string } = {}
): Promise<SfResult> {
	try {
		await sobjectUpdate('Store__c', sfdcStoreId, {
			Service_Contract__c: sfdcServiceContractId
		});
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.subscriptions',
			operation: 'set_store_active_service_contract',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Store__c',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcStoreId, sfdcServiceContractId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}
