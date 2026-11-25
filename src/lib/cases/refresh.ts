/**
 * Revalidation plumbing for case data. Pure (dependencies injected) so the timing
 * rules are testable; refresh-client.ts wires it to SvelteKit.
 */
export const ISSUES_DEPENDENCY = 'app:issues';
export const CASE_DEPENDENCY = 'app:case';
export const POLL_INTERVAL_MS = 30_000;

export type CaseDependency = typeof ISSUES_DEPENDENCY | typeof CASE_DEPENDENCY;

export interface RefresherDeps {
	invalidate: (dep: CaseDependency) => Promise<unknown>;
	/** SvelteKit's invalidate() cancels a navigation in progress, so wait for it. */
	isNavigating: () => boolean;
	/** A failed data request would replace the page with the error screen, so check first. */
	isReachable: () => Promise<boolean>;
	wait?: (ms: number) => Promise<void>;
}

/** Coalescing refresh queue: concurrent requests share one run, nothing is dropped. */
export function createRefresher(deps: RefresherDeps) {
	const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const pending = new Set<CaseDependency>();
	let running: Promise<void> | null = null;

	async function drain() {
		while (pending.size) {
			if (deps.isNavigating()) {
				await wait(200);
				continue;
			}
			if (!(await deps.isReachable())) {
				pending.clear(); // offline / server restarting: keep what's on screen, retry on the next trigger
				return;
			}
			if (deps.isNavigating()) continue;
			const batch = [...pending];
			pending.clear();
			// Same tick, so SvelteKit batches them into one data request.
			await Promise.all(batch.map((d) => deps.invalidate(d)));
		}
	}

	return function refresh(...targets: CaseDependency[]): Promise<void> {
		for (const t of targets) pending.add(t);
		running ??= drain()
			.catch(() => undefined)
			.finally(() => (running = null));
		return running;
	};
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
type VisibleDocument = Listenable & { visibilityState: string };

/** Revalidate when the window regains focus or the tab becomes visible (deduplicated). */
export function watchFocusRevalidation(opts: {
	refresh: () => void;
	win: Listenable;
	doc: VisibleDocument;
	dedupeMs?: number;
	now?: () => number;
}): () => void {
	const now = opts.now ?? Date.now;
	const dedupeMs = opts.dedupeMs ?? 2000;
	let last = -Infinity;
	const trigger = () => {
		if (opts.doc.visibilityState !== 'visible' || now() - last < dedupeMs) return;
		last = now();
		opts.refresh();
	};
	opts.win.addEventListener('focus', trigger);
	opts.doc.addEventListener('visibilitychange', trigger);
	return () => {
		opts.win.removeEventListener('focus', trigger);
		opts.doc.removeEventListener('visibilitychange', trigger);
	};
}

/** Interval polling that only runs while the tab is visible. Returns the cleanup. */
export function startVisiblePolling(opts: {
	refresh: () => void;
	doc: VisibleDocument;
	intervalMs?: number;
}): () => void {
	let timer: ReturnType<typeof setInterval> | null = null;
	const stop = () => {
		if (timer !== null) clearInterval(timer);
		timer = null;
	};
	const sync = () => {
		if (opts.doc.visibilityState !== 'visible') return stop();
		timer ??= setInterval(opts.refresh, opts.intervalMs ?? POLL_INTERVAL_MS);
	};
	opts.doc.addEventListener('visibilitychange', sync);
	sync();
	return () => {
		stop();
		opts.doc.removeEventListener('visibilitychange', sync);
	};
}
