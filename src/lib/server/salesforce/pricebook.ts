/**
 * Pull catalogs from Salesforce price books.
 *
 * Salesforce data model recap:
 *   Pricebook2          — a price book (e.g. "SERVICE", "SUBSCRIPTION")
 *   Product2            — the actual product (Name, Description, Family, Category__c)
 *   PricebookEntry      — joins Product2 ↔ Pricebook2 with a UnitPrice
 *
 * SOQL fans out the relationship so we can read product fields off
 * PricebookEntry.Product2.* in one round trip.
 *
 * The two price book NAMES come from env (.env.example):
 *   SFDC_PRICE_SERVICE       (default 'SERVICE')
 *   SFDC_PRICE_SUBSCRIPTION  (default 'SUBSCRIPTION')
 *
 * Results are cached in-process for 5 minutes so a busy /services page doesn't
 * hammer SF (and avoids API limits). Hot-swap to Redis when we go multi-instance.
 */
import { env } from '$env/dynamic/private';
import { sfdcQuery } from './client';
import { logError } from '../error_log';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface PricebookEntryRow {
	Id: string;
	UnitPrice: number;
	Pricebook2Id: string;
	[key: string]: unknown;
	Product2: {
		Id: string;
		Name: string;
		Description: string | null;
		Family: string | null;
		Category__c: string | null;
		IsActive: boolean;
	};
}

export interface CatalogProduct {
	/** PricebookEntry Id — use this when creating a Stripe Checkout line item. */
	pricebookEntryId: string;
	/** Product2 Id. */
	productId: string;
	/** Pricebook2 Id — needed when creating ServiceContract / ContractLineItem. */
	pricebook2Id: string;
	name: string;
	description: string | null;
	category: string | null;       // Category__c — may be null
	family: string | null;         // Standard Product2.Family — fallback grouping
	unitPrice: number;
	/** PricebookEntry payment type: 'Full' (default) or 'Deposit'. */
	paymentType: 'Full' | 'Deposit';
	/** Per-unit deposit amount; only set when paymentType is 'Deposit'. */
	depositAmount: number | null;
	currency: string;              // default 'USD' — orgs without multi-currency don't expose CurrencyIsoCode
}

export interface CatalogCategory {
	category: string;              // human-readable label; "Uncategorized" when null
	products: CatalogProduct[];
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}
const cache = new Map<string, CacheEntry<CatalogCategory[]>>();

/**
 * Deposit fields on PricebookEntry. API names are overridable via env; if the
 * org doesn't have them (yet) the catalog query transparently falls back to
 * plain prices so the services page never breaks.
 */
function depositFields(): { type: string; deposit: string } {
	return {
		type: env.SFDC_PB_PAYMENT_TYPE_FIELD?.trim() || 'Payment_type__c', // picklist: 'Deposit' | 'Full Price'
		deposit: env.SFDC_PB_DEPOSIT_FIELD?.trim() || 'Deposit__c'
	};
}
let depositFieldsAvailable = true;

function getPricebookName(kind: 'service' | 'subscription'): string {
	const fromEnv =
		kind === 'service'
			? env.SFDC_PRICE_SERVICE
			: env.SFDC_PRICE_SUBSCRIPTION;
	return (fromEnv?.trim() || (kind === 'service' ? 'SERVICE' : 'Subscriptions'));
}

function readDeposit(r: PricebookEntryRow): { paymentType: 'Full' | 'Deposit'; depositAmount: number | null } {
	const f = depositFields();
	const get = (name: string) => {
		const k = Object.keys(r).find((x) => x.toLowerCase() === name.toLowerCase());
		return k ? r[k] : undefined;
	};
	const isDeposit = String(get(f.type) ?? '').trim().toLowerCase() === 'deposit';
	const dep = Number(get(f.deposit));
	if (!isDeposit || !Number.isFinite(dep) || dep <= 0) return { paymentType: 'Full', depositAmount: null };
	return { paymentType: 'Deposit', depositAmount: dep };
}

function bucketByCategory(rows: PricebookEntryRow[]): CatalogCategory[] {
	const buckets = new Map<string, CatalogProduct[]>();
	for (const r of rows) {
		const category = r.Product2.Category__c?.trim() || 'Uncategorized';
		const product: CatalogProduct = {
			pricebookEntryId: r.Id,
			productId: r.Product2.Id,
			pricebook2Id: r.Pricebook2Id,
			name: r.Product2.Name,
			description: r.Product2.Description,
			category: r.Product2.Category__c,
			family: r.Product2.Family,
			unitPrice: r.UnitPrice,
			...readDeposit(r),
			currency: 'USD'
		};
		const arr = buckets.get(category) ?? [];
		arr.push(product);
		buckets.set(category, arr);
	}
	// Stable ordering: real categories alphabetical, "Uncategorized" last.
	const labels = [...buckets.keys()].sort((a, b) => {
		if (a === 'Uncategorized') return 1;
		if (b === 'Uncategorized') return -1;
		return a.localeCompare(b);
	});
	return labels.map((label) => ({
		category: label,
		products: (buckets.get(label) ?? []).sort((a, b) => a.name.localeCompare(b.name))
	}));
}

async function fetchCatalog(pricebookName: string): Promise<CatalogCategory[]> {
	// Salesforce SOQL: escape single quotes by doubling.
	const escaped = pricebookName.replace(/'/g, "''");
	const build = (withDeposit: boolean) => {
		const f = depositFields();
		return `
		SELECT Id, UnitPrice, Pricebook2Id${withDeposit ? `, ${f.type}, ${f.deposit}` : ''},
		       Product2.Id, Product2.Name, Product2.Description,
		       Product2.Family, Product2.Category__c, Product2.IsActive
		FROM PricebookEntry
		WHERE Pricebook2.Name = '${escaped}'
		  AND IsActive = true
		  AND Product2.IsActive = true
		ORDER BY Product2.Category__c NULLS LAST, Product2.Name
	`.trim();
	};

	if (depositFieldsAvailable) {
		try {
			const result = await sfdcQuery<PricebookEntryRow>(build(true), { paginate: true });
			return bucketByCategory(result.records);
		} catch (e) {
			// Most likely INVALID_FIELD: deposit fields not deployed in this org.
			depositFieldsAvailable = false;
			await logError({
				source: 'salesforce.pricebook',
				operation: 'deposit_fields_unavailable',
				errorMessage: e instanceof Error ? e.message : String(e)
			});
		}
	}
	const result = await sfdcQuery<PricebookEntryRow>(build(false), { paginate: true });
	return bucketByCategory(result.records);
}

async function getCached(
	cacheKey: string,
	pricebookName: string,
	operation: 'list_services' | 'list_subscriptions'
): Promise<CatalogCategory[]> {
	const hit = cache.get(cacheKey);
	if (hit && hit.expiresAt > Date.now()) return hit.value;

	try {
		const value = await fetchCatalog(pricebookName);
		cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
		return value;
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.pricebook',
			operation,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { pricebookName }
		});
		// Return stale-if-error: better than blank UI during a brief SF blip.
		if (hit) return hit.value;
		return [];
	}
}

/** Services catalog from the SERVICE price book, grouped by Category__c. */
export function listServices(): Promise<CatalogCategory[]> {
	const name = getPricebookName('service');
	return getCached(`service:${name}`, name, 'list_services');
}

/** Subscription plans from the SUBSCRIPTION price book, grouped by Category__c. */
export function listSubscriptions(): Promise<CatalogCategory[]> {
	const name = getPricebookName('subscription');
	return getCached(`subscription:${name}`, name, 'list_subscriptions');
}

/** Look up a single product from either pricebook by PricebookEntry Id. */
export async function getCatalogProduct(
	pricebookEntryId: string,
	kind: 'service' | 'subscription'
): Promise<CatalogProduct | null> {
	const cats = kind === 'service' ? await listServices() : await listSubscriptions();
	for (const cat of cats) {
		const p = cat.products.find((x) => x.pricebookEntryId === pricebookEntryId);
		if (p) return p;
	}
	return null;
}

/**
 * What the customer pays AT CHECKOUT for one unit: the full price, or just the deposit for a
 * Deposit product. The rest of a Deposit product (balanceLater) is collected separately,
 * as its own payment, when the case is completed.
 */
export function dueNow(p: Pick<CatalogProduct, 'unitPrice' | 'paymentType' | 'depositAmount'>): number {
	if (p.paymentType === 'Deposit' && p.depositAmount != null) return Math.min(p.depositAmount, p.unitPrice);
	return p.unitPrice;
}
export function balanceLater(p: Pick<CatalogProduct, 'unitPrice' | 'paymentType' | 'depositAmount'>): number {
	return Math.round((p.unitPrice - dueNow(p)) * 100) / 100;
}

/** Test/admin hook — wipe the catalog cache. */
export function invalidatePricebookCache(): void {
	cache.clear();
}
