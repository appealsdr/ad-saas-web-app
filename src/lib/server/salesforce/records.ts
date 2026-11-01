/**
 * Typed fetchers for Salesforce Account and Contact records.
 *
 * We pull a curated set of standard fields plus the custom fields this app
 * uses. To add more, append the API name to the FIELDS array — the SOQL is
 * generated from it.
 *
 * NOT cached: account/contact pages should reflect post-edit state immediately.
 * If you need to lower SF API usage, add a short TTL (e.g. 30s) keyed by Id.
 */
import { sobjectGet, SalesforceApiError } from './client';
import { logError } from '../error_log';
import { isVuidBlank, VUID_FIELD } from './vuid';

/** Standard + custom Account fields shown on the account page. */
export const ACCOUNT_FIELDS = [
	'Id',
	'Name',
	'AccountNumber',
	'Type',
	'Industry',
	'Phone',
	'Fax',
	'Website',
	'Description',
	'Rating',
	'Ownership',
	'AnnualRevenue',
	'NumberOfEmployees',
	'BillingStreet',
	'BillingCity',
	'BillingState',
	'BillingPostalCode',
	'BillingCountry',
	'ShippingStreet',
	'ShippingCity',
	'ShippingState',
	'ShippingPostalCode',
	'ShippingCountry',
	'OwnerId',
	'CreatedDate',
	'LastModifiedDate',
	// Custom — match the names in sync.ts
	'Primary_Email__c',
	'Start_Date__c',
	'Enable_AI_Chat__c',
	'Enable_AI_Assistant__c'
] as const;

/** Standard Contact fields shown on the account page. */
export const CONTACT_FIELDS = [
	'Id',
	'AccountId',
	'Salutation',
	'FirstName',
	'LastName',
	'Title',
	'Department',
	'Email',
	'Phone',
	'MobilePhone',
	'Fax',
	'OtherPhone',
	'MailingStreet',
	'MailingCity',
	'MailingState',
	'MailingPostalCode',
	'MailingCountry',
	'Description',
	'LeadSource',
	'Birthdate',
	'OwnerId',
	'CreatedDate',
	'LastModifiedDate'
] as const;

export interface SalesforceAccount {
	Id: string;
	Name: string;
	AccountNumber: string | null;
	Type: string | null;
	Industry: string | null;
	Phone: string | null;
	Fax: string | null;
	Website: string | null;
	Description: string | null;
	Rating: string | null;
	Ownership: string | null;
	AnnualRevenue: number | null;
	NumberOfEmployees: number | null;
	BillingStreet: string | null;
	BillingCity: string | null;
	BillingState: string | null;
	BillingPostalCode: string | null;
	BillingCountry: string | null;
	ShippingStreet: string | null;
	ShippingCity: string | null;
	ShippingState: string | null;
	ShippingPostalCode: string | null;
	ShippingCountry: string | null;
	OwnerId: string;
	CreatedDate: string;
	LastModifiedDate: string;
	Primary_Email__c: string | null;
	Start_Date__c: string | null;
	Enable_AI_Chat__c: boolean | null;
	Enable_AI_Assistant__c: boolean | null;
}

export interface SalesforceContact {
	Id: string;
	AccountId: string | null;
	Salutation: string | null;
	FirstName: string | null;
	LastName: string;
	Title: string | null;
	Department: string | null;
	Email: string | null;
	Phone: string | null;
	MobilePhone: string | null;
	Fax: string | null;
	OtherPhone: string | null;
	MailingStreet: string | null;
	MailingCity: string | null;
	MailingState: string | null;
	MailingPostalCode: string | null;
	MailingCountry: string | null;
	Description: string | null;
	LeadSource: string | null;
	Birthdate: string | null;
	OwnerId: string;
	CreatedDate: string;
	LastModifiedDate: string;
}

export interface ContactPatch {
	FirstName?: string | null;
	LastName?: string;
	Phone?: string | null;
	/** Cleared (set null) once a temp/forced password reset is completed. */
	Temp_Password_For_App__c?: string | null;
	/** Timestamp of the last completed password reset. Never the password itself. */
	Password_Reset_At__c?: string | null;
	Failed_Login_Attempts__c?: number | null;
	Account_Locked_Until__c?: string | null;
}

/** Sparse-update payload for Account. Only the fields included are written. */
export interface AccountPatch {
	BillingStreet?: string | null;
	BillingCity?: string | null;
	BillingState?: string | null;
	BillingPostalCode?: string | null;
	BillingCountry?: string | null;
	Name?: string;
	Phone?: string | null;
	Fax?: string | null;
	Website?: string | null;
	Primary_Email__c?: string | null;
	Industry?: string | null;
	NumberOfEmployees?: number | null;
	AnnualRevenue?: number | null;
}

async function fetchOne<T>(
	objectName: 'Account' | 'Contact',
	id: string,
	fields: readonly string[],
	context: { userId?: string; accountId?: string }
): Promise<{ ok: true; record: T } | { ok: false; error: string; notFound?: boolean }> {
	try {
		const record = await sobjectGet<T>(objectName, id, [...fields]);
		return { ok: true, record };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const notFound = isSfErr && e.status === 404;
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.records',
			operation: `fetch_${objectName.toLowerCase()}`,
			severity: notFound ? 'warn' : 'error',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: objectName,
			errorCode: isSfErr ? (e.errorCode ?? String(e.status)) : undefined,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcId: id }
		});
		return { ok: false, error: errorMessage, notFound };
	}
}

export function fetchSalesforceAccount(
	id: string,
	context: { userId?: string; accountId?: string } = {}
) {
	return fetchOne<SalesforceAccount>('Account', id, ACCOUNT_FIELDS, context);
}

export function fetchSalesforceContact(
	id: string,
	context: { userId?: string; accountId?: string } = {}
) {
	return fetchOne<SalesforceContact>('Contact', id, CONTACT_FIELDS, context);
}

async function patchRecord(
	objectName: 'Account' | 'Contact',
	id: string,
	patch: Record<string, unknown>,
	context: { userId?: string; accountId?: string }
): Promise<{ ok: true } | { ok: false; error: string; errorCode?: string }> {
	try {
		const { sobjectUpdate } = await import('./client');
		await sobjectUpdate(objectName, id, patch);
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.records',
			operation: `update_${objectName.toLowerCase()}`,
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: objectName,
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcId: id, patch }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/** PATCH a Contact in Salesforce — backfills appealsdoctor_vuid__c if blank. */
export async function updateSalesforceContact(
	id: string,
	patch: ContactPatch,
	context: { userId?: string; accountId?: string } = {}
) {
	const merged: Record<string, unknown> = { ...patch };
	if (context.userId && (await isVuidBlank('Contact', id))) {
		merged[VUID_FIELD] = context.userId;
	}
	return patchRecord('Contact', id, merged, context);
}

/** PATCH an Account in Salesforce — backfills appealsdoctor_vuid__c if blank. */
export async function updateSalesforceAccount(
	id: string,
	patch: AccountPatch,
	context: { userId?: string; accountId?: string } = {}
) {
	const merged: Record<string, unknown> = { ...patch };
	if (context.accountId && (await isVuidBlank('Account', id))) {
		merged[VUID_FIELD] = context.accountId;
	}
	return patchRecord('Account', id, merged, context);
}
