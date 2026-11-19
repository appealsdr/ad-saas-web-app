/**
 * Per-request admin time-zone context (Svelte context, NOT a module-level store — module state would be shared
 * between users during SSR). The console layout calls provideAdminTime(); any admin page calls useAdminTime().
 */
import { getContext, setContext } from 'svelte';
import { derived, writable, type Readable, type Writable } from 'svelte/store';
import { formatDate, formatDateTime, relativeTime, resolveTimeZone, type DateInput } from './time';

const UTC_VALUE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/;

const KEY = Symbol('admin-time');
interface Ctx { saved: Writable<string | null> }

export function provideAdminTime(initial: string | null): Writable<string | null> {
	const saved = writable<string | null>(initial);
	setContext<Ctx>(KEY, { saved });
	return saved;
}

export function useAdminTime(): {
	tz: Readable<string>;
	fmt: Readable<(v: DateInput, o?: { seconds?: boolean; abbr?: boolean }) => string>;
	fmtDate: Readable<(v: DateInput) => string>;
	/** Re-renders server-built "YYYY-MM-DD HH:mm:ss UTC" display strings in the admin's zone; other text is returned unchanged. */
	val: Readable<(v: string) => string>;
	rel: (v: DateInput) => string;
} {
	const ctx = getContext<Ctx | undefined>(KEY);
	const saved = ctx?.saved ?? writable<string | null>(null);
	const tz = derived(saved, ($s) => resolveTimeZone($s));
	return {
		tz,
		fmt: derived(tz, ($tz) => (v: DateInput, o?: { seconds?: boolean; abbr?: boolean }) => formatDateTime(v, $tz, o)),
		fmtDate: derived(tz, ($tz) => (v: DateInput) => formatDate(v, $tz)),
		val: derived(tz, ($tz) => (v: string) => (UTC_VALUE.test(v) ? formatDateTime(v, $tz, { seconds: true }) : v)),
		rel: (v) => relativeTime(v)
	};
}
