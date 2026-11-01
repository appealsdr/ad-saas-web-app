/**
 * Client-side companion to the server's read-only session guard (hooks.server.ts
 * is the real enforcement — every non-GET request is rejected there).
 *
 * In an admin "view as user" session this disables, and keeps disabled as the
 * DOM changes: anything tagged `data-mutates`, and every control inside a POST
 * form, so buttons, uploads and message editors can be looked at but not used.
 * Sign-out and "exit view-as" forms are left alone.
 */
const ALLOWED_ACTIONS = ['/auth/logout', '/auth/impersonation-exit'];
const TITLE = 'Read-only mode — viewing as a customer';

function lock(el: Element) {
	if (el.getAttribute('data-ro-locked')) return;
	el.setAttribute('data-ro-locked', '1');
	el.setAttribute('aria-disabled', 'true');
	el.setAttribute('title', TITLE);
	if ('disabled' in el) (el as HTMLButtonElement).disabled = true;
	else {
		el.classList.add('ro-disabled');
		el.setAttribute('tabindex', '-1');
	}
	if (el.hasAttribute('contenteditable')) el.setAttribute('contenteditable', 'false');
}

function sweep(root: ParentNode) {
	root.querySelectorAll('[data-mutates]').forEach(lock);
	root.querySelectorAll('form').forEach((f) => {
		if ((f.getAttribute('method') ?? 'get').toLowerCase() !== 'post') return;
		const action = f.getAttribute('action') ?? '';
		if (ALLOWED_ACTIONS.some((a) => action.startsWith(a))) return;
		f.querySelectorAll('button, input, select, textarea, [contenteditable]').forEach(lock);
	});
}

export function readOnlyGuard(node: HTMLElement, enabled: boolean) {
	let obs: MutationObserver | null = null;
	const block = (e: Event) => {
		const t = (e.target as Element | null)?.closest('[data-ro-locked]');
		if (t) {
			e.preventDefault();
			e.stopPropagation();
		}
	};
	function start() {
		sweep(node);
		obs = new MutationObserver(() => sweep(node));
		obs.observe(node, { childList: true, subtree: true });
		node.addEventListener('click', block, true);
		node.addEventListener('submit', block, true);
	}
	function stop() {
		obs?.disconnect();
		node.removeEventListener('click', block, true);
		node.removeEventListener('submit', block, true);
	}
	if (enabled) start();
	return {
		update(v: boolean) {
			stop();
			if (v) start();
		},
		destroy: stop
	};
}
