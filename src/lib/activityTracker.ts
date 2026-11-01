/**
 * Browser-side activity tracker for signed-in customers.
 *
 * Sends page views (with time spent on the previous page) and clicks on links
 * and buttons — the label and destination only, never typed text or form
 * values — in small batches to /api/activity. Anything inside an element
 * marked `data-no-track` is ignored.
 */
import type { AfterNavigate } from '@sveltejs/kit';

interface Ev { type: 'page_view' | 'click'; path: string; ts: number; [k: string]: unknown }

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

	let active = false;
	function onNavigate(nav: AfterNavigate) {
		if (!active) return;
		const path = nav.to?.url.pathname ?? location.pathname;
		const now = Date.now();
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
	const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
	let stop: (() => void) | null = null;
	/** Turn tracking on/off (sign-in, sign-out, admin read-only views). Safe to call repeatedly. */
	function setEnabled(on: boolean) {
		if (typeof document === 'undefined') return;
		if (on === active) return;
		active = on;
		if (on) {
			document.addEventListener('click', onClick, true);
			document.addEventListener('visibilitychange', onHide);
			window.addEventListener('pagehide', flush);
			stop = () => {
				document.removeEventListener('click', onClick, true);
				document.removeEventListener('visibilitychange', onHide);
				window.removeEventListener('pagehide', flush);
				flush();
			};
		} else {
			stop?.();
			stop = null;
		}
	}
	return { setEnabled, onNavigate };
}
