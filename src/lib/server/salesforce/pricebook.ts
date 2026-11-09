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
 * Recurring products use a third, OPTIONAL price book:
 *   SFDC_PRICE_RECURRING     (no default — when unset or the book is empty/missing, the
 *                             "Recurring products" tab is simply not shown)
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
	/** Recurring products only: the price book's monthly UnitPrice (unitPrice is then monthly × term). */
	monthlyPrice?: number;
	/** Recurring products only: contract term in months chosen at checkout (→ ServiceContract.Term). */
	termMonths?: number;
}

export type RecurringPayOption = 'full' | 'monthly';
export const RECURRING_TERMS = [1, 3, 6, 12, 18, 24, 36] as const;
export const MAX_RECURRING_TERM = 36;

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

/** Recurring price book name, or null when SFDC_PRICE_RECURRING is not configured. */
function getRecurringPricebookName(): string | null {
	return env.SFDC_PRICE_RECURRING?.trim() || null;
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
	operation: 'list_services' | 'list_subscriptions' | 'list_recurring'
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

/**
 * Recurring products from the SFDC_PRICE_RECURRING price book, grouped by Category__c.
 * Empty when the env var is unset or the price book doesn't exist / has no active entries.
 */
export function listRecurring(): Promise<CatalogCategory[]> {
	const name = getRecurringPricebookName();
	if (!name) return Promise.resolve([]);
	return getCached(`recurring:${name}`, name, 'list_recurring');
}

/** Term + payment option picked at checkout for a recurring product. */
export interface RecurringOptions {
	termMonths: number;
	payOption: RecurringPayOption;
}

/** Parse + validate term/pay from untrusted input; null when invalid. */
export function parseRecurringOptions(term: unknown, pay: unknown): RecurringOptions | null {
	const termMonths = Number(term);
	if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > MAX_RECURRING_TERM) return null;
	if (pay !== 'full' && pay !== 'monthly') return null;
	return { termMonths, payOption: pay };
}

/**
 * Re-express a recurring entry (price book UnitPrice = price per month, per unit) so the existing
 * checkout maths works unchanged:
 *   unitPrice     = monthly × term            (the whole contract value of one unit)
 *   pay in full   → charged now = unitPrice   ((quantity × price) × term)
 *   pay monthly   → modelled as a "Deposit" of one month; dueNow = monthly (quantity × price),
 *                   balanceLater = monthly × (term − 1) — not charged at checkout.
 */
function applyRecurringOptions(p: CatalogProduct, o: RecurringOptions): CatalogProduct {
	const monthly = p.unitPrice;
	const termMonths = o.termMonths;
	const total = Math.round(monthly * termMonths * 100) / 100;
	return {
		...p,
		unitPrice: total,
		monthlyPrice: monthly,
		termMonths,
		paymentType: o.payOption === 'monthly' ? 'Deposit' : 'Full',
		depositAmount: o.payOption === 'monthly' ? monthly : null
	};
}

/**
 * Look up a single product by PricebookEntry Id. For kind 'recurring' pass `recurring` (term +
 * pay option): the returned product is already priced for that term/payment option.
 */
export async function getCatalogProduct(
	pricebookEntryId: string,
	kind: 'service' | 'subscription' | 'recurring',
	recurring?: RecurringOptions | null
): Promise<CatalogProduct | null> {
	if (kind === 'recurring' && !recurring) return null;
	const cats =
		kind === 'service' ? await listServices() : kind === 'subscription' ? await listSubscriptions() : await listRecurring();
	for (const cat of cats) {
		const p = cat.products.find((x) => x.pricebookEntryId === pricebookEntryId);
		if (p) return kind === 'recurring' ? applyRecurringOptions(p, recurring!) : p;
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
