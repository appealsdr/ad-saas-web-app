/** Public (API) shapes — never expose internal ids, S3 keys or tokens. */
import type { ApiStore } from './resources';
import type { CaseDetail, CaseSummary, CaseMessage, RequiredFile } from '../salesforce';
import { sanitizeMessageHtml } from '../sanitize';

export const storeJson = (s: ApiStore) => ({
	id: s.id,
	name: s.name,
	marketplaces: s.marketplaces ? s.marketplaces.split(';').filter(Boolean) : [],
	sellerId: s.seller_id,
	sellerPrimaryEmail: s.seller_primary_email,
	storeEmail: s.store_email,
	businessName: s.business_name,
	country: s.country,
	description: s.description,
	amazonConnection: s.spapi_status,
	createdAt: s.created_at.toISOString(),
	updatedAt: s.updated_at.toISOString()
});

export const caseSummaryJson = (c: CaseSummary) => ({
	id: c.Id,
	caseNumber: c.CaseNumber,
	subject: c.Subject,
	status: c.Status,
	priority: c.Priority,
	type: c.recordTypeName,
	createdAt: c.CreatedDate,
	updatedAt: c.LastModifiedDate
});

export const caseDetailJson = (c: CaseDetail) => ({
	...caseSummaryJson(c),
	description: c.Description,
	origin: c.Origin,
	caseType: c.Type,
	asin: c.asin
});

export const messageJson = (m: CaseMessage) => ({
	id: m.Id,
	body: sanitizeMessageHtml(m.body),
	senderType: m.senderType,
	sender: m.displayName,
	replyToMessageId: m.replyToMessageId,
	createdAt: m.createdAt
});

export const requiredFileJson = (f: RequiredFile) => ({
	id: f.id,
	name: f.name,
	shortDescription: f.shortDescription,
	instructions: f.instructions,
	acceptedFormats: f.acceptedFormats,
	uploaded: f.uploaded,
	upload: f.upload
		? { fileName: f.upload.fileName, contentType: f.upload.contentType, uploadedAt: f.upload.uploadedDate }
		: null,
	example: f.example ? { fileName: f.example.fileName, contentType: f.example.contentType } : null,
	createdAt: f.createdAt
});
