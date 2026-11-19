/**
 * Browser-side activity tracker for signed-in customers.
 *
 * Sends page views, time spent on each page (VISIBLE time only — the clock pauses while the tab is hidden and each
 * report is capped, so idle tabs do not inflate durations), and clicks on links
 * and buttons — the label and destination only, never typed text or form
 * values — in small batches to /api/activity. Anything inside an element
 * marked `data-no-track` is ignored.
 */
import type { AfterNavigate } from '@sveltejs/kit';

interface Ev { type: 'page_view' | 'page_time' | 'click'; path: string; ts: number; [k: string]: unknown }

export function createActivityTracker(): { setEnabled: (on: boolean) => void; onNavigate: (nav: AfterNavigate) => void } {
	let queue: Ev[] = [];
	let lastPage: { path: string; at: number } | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function flush() {
		if (timer) { clearTimeout(timer); timer = null; }
		if (!queue.length) return;
		const events = queue.splice(0, 50);
		try {
			void fetch('/api/activity', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ events }),
				keepalive: true
			}).catch(() => undefined);
		} catch { /* never break the page */ }
		if (queue.length) timer = setTimeout(flush, 500);
	}
	function push(e: Ev) {
		queue.push(e);
		if (queue.length >= 20) flush();
		else if (!timer) timer = setTimeout(flush, 4000);
	}

	// ── Visible-time accounting for the current page ──
	const MAX_REPORT_MS = 30 * 60_000; // one report never exceeds 30 min (covers a visible-but-idle tab)
	let visibleSince: number | null = null;
	let visibleMs = 0;
	const pauseClock = () => { if (visibleSince !== null) { visibleMs += Date.now() - visibleSince; visibleSince = null; } };
	const resumeClock = () => { if (visibleSince === null && typeof document !== 'undefined' && document.visibilityState === 'visible') visibleSince = Date.now(); };
	/** Report (and reset) the visible time spent on `lastPage` so far. */
	function reportTime() {
		pauseClock();
		if (lastPage && visibleMs >= 1000) push({ type: 'page_time', path: lastPage.path, ts: Date.now(), ms: Math.min(Math.round(visibleMs), MAX_REPORT_MS) });
		visibleMs = 0;
	}

	let active = false;
	function onNavigate(nav: AfterNavigate) {
		if (!active) return;
		const path = nav.to?.url.pathname ?? location.pathname;
		const now = Date.now();
		reportTime(); // time on the page we just left (visible time only)
		// Title is set after navigation settles.
		setTimeout(() => {
			push({
				type: 'page_view', path, ts: now,
				from: nav.from?.url.pathname,
				title: document.title.replace(/\s*[—-]\s*Appeals Doctor$/, ''),
				msOnPrev: lastPage ? now - lastPage.at : undefined
			});
		}, 0);
		lastPage = { path, at: now };
		visibleMs = 0;
		visibleSince = null;
		resumeClock();
	}

	function onClick(e: MouseEvent) {
		const el = (e.target as Element | null)?.closest<HTMLElement>('a, button, [role="button"], input[type="submit"]');
		if (!el || el.closest('[data-no-track]')) return;
		const a = el.closest('a');
		const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || (el as HTMLInputElement).value || '')
			.replace(/\s+/g, ' ').trim().slice(0, 80);
		if (!label && !a) return;
		push({
			type: 'click', path: location.pathname, ts: Date.now(), label,
			href: a?.getAttribute('href') ?? undefined,
			kind: a ? 'link' : 'button'
		});
	}
	const onHide = () => {
		if (document.visibilityState === 'hidden') { reportTime(); flush(); } else resumeClock();
	};
	const onLeave = () => { reportTime(); flush(); };
	let stop: (() => void) | null = null;
	/** Turn tracking on/off (sign-in, sign-out, admin read-only views). Safe to call repeatedly. */
	function setEnabled(on: boolean) {
		if (typeof document === 'undefined') return;
		if (on === active) return;
		active = on;
		if (on) {
			document.addEventListener('click', onClick, true);
			document.addEventListener('visibilitychange', onHide);
			window.addEventListener('pagehide', onLeave);
			stop = () => {
				document.removeEventListener('click', onClick, true);
				document.removeEventListener('visibilitychange', onHide);
				window.removeEventListener('pagehide', onLeave);
				flush();
			};
		} else {
			stop?.();
			stop = null;
		}
	}
	return { setEnabled, onNavigate };
}
