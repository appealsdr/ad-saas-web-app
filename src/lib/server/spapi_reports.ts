/**
 * Amazon SP-API Reports — GET_SALES_AND_TRAFFIC_REPORT.
 *
 * Used to compute a per-ASIN average daily revenue figure, which the case
 * detail page's "Recalculate" action multiplies by a fixed days-at-risk
 * assumption (see estimateRevenueAtRisk in the case route) to derive
 * Case.Estimated_Revenue_at_Risk__c.
 *
 * This is a brand-new integration — until now spapi.ts only handled the
 * LWA OAuth flow (getting/refreshing a seller's access token). Nothing in
 * this codebase had called an actual SP-API data-plane endpoint before.
 *
 * Flow (SP-API Reports API is async):
 *   1. POST /reports — request a report for a date range + marketplace
 *   2. GET  /reports/{id} — poll until processingStatus is DONE
 *   3. GET  /documents/{id} — get a signed download URL for the report body
 *   4. fetch that URL, gunzip if compressed, parse JSON
 *
 * IMPORTANT: this requires the "Amazon Reports" role to be enabled for this
 * app in Seller Central's Developer Console — buildConsentUrl() (spapi.ts)
 * carries no explicit scope, so whether that role is granted is invisible
 * from code. If report creation fails with 403, that's the first thing to
 * check, not a bug here.
 */
import { gunzipSync } from 'node:zlib';
import { logError } from './error_log';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

/** SP-API is split into three regional endpoints. */
const REGION_BASE_URL: Record<'NA' | 'EU' | 'FE', string> = {
	NA: 'https://sellingpartnerapi-na.amazon.com',
	EU: 'https://sellingpartnerapi-eu.amazon.com',
	FE: 'https://sellingpartnerapi-fe.amazon.com'
};

/**
 * Marketplace code (as stored in stores.marketplaces, e.g. "US", "UK") →
 * Amazon marketplace ID + region. Codes are the short forms used by this
 * app's marketplace picklist; extend as new marketplaces are enabled.
 */
const MARKETPLACES: Record<string, { id: string; region: 'NA' | 'EU' | 'FE' }> = {
	US: { id: 'ATVPDKIKX0DER', region: 'NA' },
	CA: { id: 'A2EUQ1WTGCTBG2', region: 'NA' },
	MX: { id: 'A1AM78C64UM0Y8', region: 'NA' },
	BR: { id: 'A2Q3Y263D00KWC', region: 'NA' },
	UK: { id: 'A1F83G8C2ARO7P', region: 'EU' },
	GB: { id: 'A1F83G8C2ARO7P', region: 'EU' },
	DE: { id: 'A1PA6795UKMFR9', region: 'EU' },
	FR: { id: 'A13V1IB3VIYZZH', region: 'EU' },
	IT: { id: 'APJ6JRA9NG5V4', region: 'EU' },
	ES: { id: 'A1RKKUPIHCS9HS', region: 'EU' },
	NL: { id: 'A1805IZSGTT6HS', region: 'EU' },
	SE: { id: 'A2NODRKZP88ZB9', region: 'EU' },
	PL: { id: 'A1C3SOZRARQ6R3', region: 'EU' },
	TR: { id: 'A33AVAJ2PDY3EV', region: 'EU' },
	AE: { id: 'A2VIGQ35RCS4UG', region: 'EU' },
	SA: { id: 'A17E79C6D8DWNP', region: 'EU' },
	EG: { id: 'ARBP9OOSHTCHU', region: 'EU' },
	IN: { id: 'A21TJRUUN4KGV', region: 'EU' },
	JP: { id: 'A1VC38T7YXB528', region: 'FE' },
	AU: { id: 'A39IBJ37TRP1C6', region: 'FE' },
	SG: { id: 'A19VAU5U5O7RUS', region: 'FE' }
};

const MARKETPLACE_ID_TO_CODE: Record<string, string> = Object.fromEntries(
	Object.entries(MARKETPLACES).map(([code, m]) => [m.id, code])
);

/** Amazon marketplace ID (e.g. "ATVPDKIKX0DER") → this app's short code (e.g. "US"), or null if unrecognized. */
export function marketplaceIdToCode(marketplaceId: string): string | null {
	return MARKETPLACE_ID_TO_CODE[marketplaceId] ?? null;
}

/** First marketplace code from a store's ';'-joined marketplaces string that we recognize. */
export function resolvePrimaryMarketplace(
	marketplaces: string | null
): { code: string; id: string; region: 'NA' | 'EU' | 'FE' } | null {
	if (!marketplaces) return null;
	for (const raw of marketplaces.split(';')) {
		const code = raw.trim().toUpperCase();
		const m = MARKETPLACES[code];
		if (m) return { code, ...m };
	}
	return null;
}

function fmtDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

interface CreateReportResponse {
	reportId: string;
}
interface ReportStatusResponse {
	reportId: string;
	processingStatus: 'IN_QUEUE' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED' | 'FATAL';
	reportDocumentId?: string;
}
interface ReportDocumentResponse {
	url: string;
	compressionAlgorithm?: 'GZIP';
}
interface SalesAndTrafficByAsin {
	parentAsin?: string;
	childAsin?: string;
	sales?: {
		orderedProductSales?: { amount: number; currencyCode: string };
		unitsOrdered?: number;
	};
}
interface SalesAndTrafficReport {
	salesAndTrafficByAsin?: SalesAndTrafficByAsin[];
}

async function spapiFetch<T>(
	baseUrl: string,
	path: string,
	accessToken: string,
	init: RequestInit = {}
): Promise<T> {
	const res = await fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			'x-amz-access-token': accessToken,
			'content-type': 'application/json',
			...init.headers
		}
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`SP-API ${path} failed (${res.status}): ${text}`);
	}
	return text ? (JSON.parse(text) as T) : ({} as T);
}

async function createSalesAndTrafficReport(
	baseUrl: string,
	accessToken: string,
	marketplaceId: string,
	startDate: Date,
	endDate: Date
): Promise<string> {
	const body = JSON.stringify({
		reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
		marketplaceIds: [marketplaceId],
		dataStartTime: `${fmtDate(startDate)}T00:00:00Z`,
		dataEndTime: `${fmtDate(endDate)}T23:59:59Z`,
		reportOptions: { asinGranularity: 'CHILD' }
	});
	const res = await spapiFetch<CreateReportResponse>(baseUrl, '/reports/2021-06-30/reports', accessToken, {
		method: 'POST',
		body
	});
	return res.reportId;
}

async function pollReportUntilDone(
	baseUrl: string,
	accessToken: string,
	reportId: string
): Promise<string> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const status = await spapiFetch<ReportStatusResponse>(
			baseUrl,
			`/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
			accessToken
		);
		if (status.processingStatus === 'DONE') {
			if (!status.reportDocumentId) throw new Error('Report marked DONE but no reportDocumentId returned.');
			return status.reportDocumentId;
		}
		if (status.processingStatus === 'CANCELLED' || status.processingStatus === 'FATAL') {
			throw new Error(`Report processing ${status.processingStatus}.`);
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	throw new Error(`Report did not finish within ${POLL_TIMEOUT_MS / 1000}s.`);
}

async function downloadReport(
	baseUrl: string,
	accessToken: string,
	reportDocumentId: string
): Promise<SalesAndTrafficReport> {
	const doc = await spapiFetch<ReportDocumentResponse>(
		baseUrl,
		`/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`,
		accessToken
	);
	const res = await fetch(doc.url);
	if (!res.ok) throw new Error(`Report document download failed (${res.status}).`);
	const buf = Buffer.from(await res.arrayBuffer());
	const json = doc.compressionAlgorithm === 'GZIP' ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
	return JSON.parse(json) as SalesAndTrafficReport;
}

export type AsinRevenueResult =
	| { ok: true; averageDailyRevenue: number; currencyCode: string; lookbackDays: number }
	| { ok: false; error: string };

/**
 * Average daily ordered-product revenue for one ASIN over the trailing
 * `lookbackDays`, via GET_SALES_AND_TRAFFIC_REPORT. The report aggregates
 * across the whole requested range per ASIN, so this is just totalSales / days
 * — no per-day iteration needed.
 */
export async function getAsinAverageDailyRevenue(
	accessToken: string,
	marketplaces: string | null,
	asin: string,
	lookbackDays = 30,
	context: { userId?: string; accountId?: string; storeId?: string } = {}
): Promise<AsinRevenueResult> {
	const marketplace = resolvePrimaryMarketplace(marketplaces);
	if (!marketplace) {
		return { ok: false, error: `Could not resolve a supported Amazon marketplace from "${marketplaces ?? ''}".` };
	}
	const baseUrl = REGION_BASE_URL[marketplace.region];
	const endDate = new Date();
	const startDate = new Date(endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

	try {
		const reportId = await createSalesAndTrafficReport(baseUrl, accessToken, marketplace.id, startDate, endDate);
		const documentId = await pollReportUntilDone(baseUrl, accessToken, reportId);
		const report = await downloadReport(baseUrl, accessToken, documentId);

		const entry = (report.salesAndTrafficByAsin ?? []).find(
			(r) => r.childAsin === asin || r.parentAsin === asin
		);
		if (!entry?.sales?.orderedProductSales) {
			return { ok: false, error: `No sales data found for ASIN ${asin} in the last ${lookbackDays} days.` };
		}
		const { amount, currencyCode } = entry.sales.orderedProductSales;
		return { ok: true, averageDailyRevenue: amount / lookbackDays, currencyCode, lookbackDays };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'spapi.reports',
			operation: 'get_asin_average_daily_revenue',
			userId: context.userId,
			accountId: context.accountId,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { storeId: context.storeId, asin, marketplace: marketplace.code, lookbackDays }
		});
		return { ok: false, error: errorMessage };
	}
}
