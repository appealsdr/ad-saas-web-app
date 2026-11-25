import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRefresher, startVisiblePolling, watchFocusRevalidation, ISSUES_DEPENDENCY, CASE_DEPENDENCY } from '../../src/lib/cases/refresh';

const deps = (over: Partial<Parameters<typeof createRefresher>[0]> = {}) => {
	const invalidate = vi.fn(async (_dep: string) => {});
	return {
		isNavigating: () => false,
		isReachable: async () => true,
		wait: async () => {},
		...over,
		invalidate
	};
};

describe('createRefresher', () => {
	it('invalidates only the requested dependencies', async () => {
		const d = deps();
		await createRefresher(d)(ISSUES_DEPENDENCY);
		expect(d.invalidate.mock.calls).toEqual([['app:issues']]);
	});
	it('coalesces requests made together', async () => {
		const d = deps();
		const refresh = createRefresher(d);
		await Promise.all([refresh(ISSUES_DEPENDENCY), refresh(CASE_DEPENDENCY, ISSUES_DEPENDENCY)]);
		expect(d.invalidate.mock.calls.flat().sort()).toEqual(['app:case', 'app:issues']);
	});
	it('waits for a navigation to finish so it is not cancelled', async () => {
		let navigating = true;
		const d = deps({ isNavigating: () => navigating, wait: vi.fn(async () => void (navigating = false)) });
		await createRefresher(d)(ISSUES_DEPENDENCY);
		expect(d.wait).toHaveBeenCalled();
		expect(d.invalidate).toHaveBeenCalledTimes(1);
	});
	it('does nothing while the server is unreachable, and works again afterwards', async () => {
		let up = false;
		const d = deps({ isReachable: async () => up });
		const refresh = createRefresher(d);
		await refresh(ISSUES_DEPENDENCY);
		expect(d.invalidate).not.toHaveBeenCalled();
		up = true;
		await refresh(ISSUES_DEPENDENCY);
		expect(d.invalidate).toHaveBeenCalledTimes(1);
	});
	it('never rejects when a refresh fails (a successful action must still show its result)', async () => {
		const refresh = createRefresher({ ...deps(), invalidate: async () => { throw new Error('boom'); } });
		await expect(refresh(ISSUES_DEPENDENCY)).resolves.toBeUndefined();
	});
});

function fakeDom() {
	const win = new EventTarget();
	const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
	const show = (state: 'visible' | 'hidden') => {
		doc.visibilityState = state;
		doc.dispatchEvent(new Event('visibilitychange'));
	};
	return { win, doc, show };
}

describe('revalidation triggers', () => {
	afterEach(() => vi.useRealTimers());

	it('polls every 30 seconds only while visible, and cleans up', () => {
		vi.useFakeTimers();
		const { doc, show } = fakeDom();
		const refresh = vi.fn();
		const stop = startVisiblePolling({ refresh, doc });
		vi.advanceTimersByTime(29_999);
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(refresh).toHaveBeenCalledTimes(1);
		show('hidden');
		vi.advanceTimersByTime(120_000);
		expect(refresh).toHaveBeenCalledTimes(1);
		show('visible');
		vi.advanceTimersByTime(30_000);
		expect(refresh).toHaveBeenCalledTimes(2);
		stop();
		show('visible');
		vi.advanceTimersByTime(120_000);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('does not start a timer in a hidden tab', () => {
		vi.useFakeTimers();
		const { doc } = fakeDom();
		doc.visibilityState = 'hidden';
		const stop = startVisiblePolling({ refresh: vi.fn(), doc });
		expect(vi.getTimerCount()).toBe(0);
		stop();
	});
	it('refreshes on focus and on becoming visible, deduplicating the pair', () => {
		const { win, doc, show } = fakeDom();
		const refresh = vi.fn();
		let t = 0;
		const stop = watchFocusRevalidation({ refresh, win, doc, now: () => t });
		show('visible');
		win.dispatchEvent(new Event('focus'));
		expect(refresh).toHaveBeenCalledTimes(1);
		t = 5000;
		show('hidden');
		expect(refresh).toHaveBeenCalledTimes(1);
		win.dispatchEvent(new Event('focus'));
		expect(refresh).toHaveBeenCalledTimes(1); // hidden: nothing to refresh
		show('visible');
		expect(refresh).toHaveBeenCalledTimes(2);
		stop();
		t = 20_000;
		win.dispatchEvent(new Event('focus'));
		expect(refresh).toHaveBeenCalledTimes(2);
	});
});
