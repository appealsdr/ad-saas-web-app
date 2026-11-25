/**
 * The one place values are turned into SOQL text. Every value interpolated into
 * a query goes through soqlString() / soqlList() — never hand-quote it.
 *
 * SOQL escapes with a backslash. SQL-style quote doubling ('') does NOT work,
 * and the backslash itself must be escaped too, otherwise an input ending in
 * `\` swallows the escape of the character after it and closes the literal.
 *
 * Escaping keeps a value inside its literal. Where a value must be a record Id,
 * also check isSalesforceId() and skip the query when it fails.
 */

const ESCAPES: Record<string, string> = {
	'\\': '\\\\',
	"'": "\\'",
	'"': '\\"',
	'\n': '\\n',
	'\r': '\\r',
	'\t': '\\t',
	'\b': '\\b',
	'\f': '\\f'
};

/** Escape the inside of a SOQL string literal (does not add the quotes). */
export function escapeSoql(value: string): string {
	// A single pass, so a backslash added by one escape is never escaped again.
	return value.replace(/[\\'"\n\r\t\b\f]/g, (c) => ESCAPES[c]);
}

/** A complete, quoted SOQL string literal. */
export function soqlString(value: string): string {
	return `'${escapeSoql(value)}'`;
}

/** Comma-separated literals for `IN (…)`. Callers skip the query when empty. */
export function soqlList(values: readonly string[]): string {
	return values.map(soqlString).join(',');
}

const SALESFORCE_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** 15- or 18-character alphanumeric Salesforce record Id. */
export function isSalesforceId(value: unknown): value is string {
	return typeof value === 'string' && SALESFORCE_ID_RE.test(value);
}
