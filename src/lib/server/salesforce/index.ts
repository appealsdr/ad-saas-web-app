/**
 * Salesforce JWT Bearer flow — server-only barrel.
 *
 * Server-only because it lives under $lib/server/. SvelteKit refuses to
 * import anything from $lib/server/ into client code, so the private key
 * and access token can never leak to the browser.
 *
 * Quick start (in a +server.ts endpoint or +page.server.ts load):
 *
 *   import { sfdcQuery, sfdcPing, sobjectCreate } from '$lib/server/salesforce';
 *
 *   // 1. Smoke test — confirms auth works and api version is valid
 *   const versions = await sfdcPing();
 *
 *   // 2. SOQL
 *   const { records } = await sfdcQuery<{ Id: string; Name: string }>(
 *     "SELECT Id, Name FROM Account LIMIT 5"
 *   );
 *
 *   // 3. Insert
 *   const created = await sobjectCreate('Account', { Name: 'Acme Co' });
 */
export { getSalesforceConfig, resetSalesforceConfigCache } from './config';
export type { SalesforceConfig } from './config';

export {
	getAccessToken,
	invalidateAccessToken,
	requestAccessToken,
	buildJwtAssertion
} from './auth';
export type { AccessToken } from './auth';

export {
	sfdcFetch,
	sfdcQuery,
	sfdcPing,
	sobjectCreate,
	sobjectGet,
	sobjectUpdate,
	sobjectUpsert,
	sobjectDelete,
	apexRest,
	SalesforceApiError
} from './client';
export type { QueryResult, CreateResult } from './client';

export {
	createSalesforceAccountAndContact,
	createSalesforceContactForAccount,
	enqueueAccountContactSync,
	findContactByEmail,
	splitFullName,
	updateSalesforceAccountStripeCustomerId
} from './sync';
export type { AccountContactInput, AccountContactResult, SyncContext } from './sync';

export {
	listServices,
	listSubscriptions,
	getCatalogProduct,
	dueNow,
	balanceLater,
	invalidatePricebookCache
} from './pricebook';
export type { CatalogProduct, CatalogCategory } from './pricebook';

export {
	fetchSalesforceAccount,
	fetchSalesforceContact,
	updateSalesforceContact,
	updateSalesforceAccount,
	ACCOUNT_FIELDS,
	CONTACT_FIELDS
} from './records';

export {
	createSalesforceStore,
	updateSalesforceStore,
	getStoreMarketplaceOptions,
	fetchStoreMetrics,
	getWhiteGloveStoreRecordTypeId,
	updateStoreRecordType
} from './stores';
export type { StoreFields, SfStoreResult, StoreMetrics } from './stores';

export { VUID_FIELD, isVuidBlank, withVuidBackfill } from './vuid';

export { createServiceContractWithLines } from './contracts';
export type { ServiceContractInput, ServiceContractResult } from './contracts';

export { createServiceCase, listCasesForContract, getCaseCustomRecordTypeId } from './service-cases';
export type { ServiceCaseInput, ServiceCaseResult } from './service-cases';

export { createPayment } from './payments';
export type { PaymentInput, PaymentResult } from './payments';

export { cancelServiceContract, setAccountActiveServiceContract, setStoreActiveServiceContract } from './subscriptions';
export type { SfResult as SubscriptionSfResult } from './subscriptions';

export { createS3Document } from './s3-documents';
export type { S3DocumentInput, S3DocumentResult } from './s3-documents';

export {
	listRequiredFilesForCase,
	listRequiredFilesForStore,
	listRequiredFilesForCases,
	listRequiredFilesForStores,
	attachUploadToRequiredFile,
	clearRequiredFile
} from './required-files';
export type {
	RequiredFile,
	RequiredFileVersion,
	RequiredFileWithParent,
	AttachInput,
	AttachResult
} from './required-files';

export {
	listCasesForStore,
	listCasesForStores,
	fetchCase,
	updateCaseEstimatedRevenueAtRisk,
	findCaseStoreLookup,
	listCaseMessages,
	createCaseMessage,
	markCaseMessageRead,
	listCaseFiles,
	listStoreFiles,
	updateCaseFile,
	listRecentMessagesForCases,
	listPendingFilesForCases,
	listCaseHistory,
	buildCaseTimeline
} from './cases';
export type {
	CaseSummary,
	CaseSummaryWithStore,
	CaseDetail,
	CaseMessage,
	CaseFile,
	RecentCaseMessage,
	PendingCaseFile,
	CaseHistoryEntry,
	CaseTimelineEvent,
	CaseTimelineEventType,
	CaseTimelineFileInput
} from './cases';
export type {
	SalesforceAccount,
	SalesforceContact,
	ContactPatch,
	AccountPatch
} from './records';

export {
	listClientFeedback,
	fetchClientFeedback,
	createClientFeedback,
	updateClientFeedbackBody
} from './client-feedback';
export type { ClientFeedback } from './client-feedback';
