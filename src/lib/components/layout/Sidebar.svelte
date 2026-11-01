<script lang="ts">
	import { page } from '$app/stores';
	import { auth, userInitials } from '$stores/auth';

	// Services are purchased per-store now (under /stores/<id>/services), so
	// there's no global Services tab in the sidebar.
	const navItems = [
		{ href: '/dashboard', icon: '/icons/home.png',    label: 'Dashboard' },
		{ href: '/accounts',  icon: '/icons/account.png', label: 'Accounts' },
		{ href: '/stores',    icon: '/icons/store.png',   label: 'Stores' },
		{ href: '/issues',    icon: '/icons/case.png',    label: 'Cases' },
		{ href: '/payments',  icon: '/icons/payment.png', label: 'Payments' },
		{ href: '/help',      icon: '/icons/guidance.png', label: 'How to Use' }
	];

	$: currentPath = $page.url.pathname;

	function isActive(href: string) {
		return currentPath === href || currentPath.startsWith(href + '/');
	}
</script>

<aside class="sidebar">
	<!-- Logo -->
	<div class="sidebar-logo">
		<img class="logo-img" src="/icons/company_logo.svg" alt="Appeals Doctor" />
	</div>

	<!-- Navigation -->
	<nav class="sidebar-nav">
		{#each navItems as item}
			<a
				href={item.href}
				title={item.label}
				aria-label={item.label}
				class="nav-item"
				class:active={isActive(item.href)}
				aria-current={isActive(item.href) ? 'page' : undefined}
			>
				<img class="nav-icon" src={item.icon} alt="" aria-hidden="true" />
			</a>
		{/each}
	</nav>

	<!-- User footer -->
	{#if $auth}
		<div class="sidebar-footer">
			<div class="user-pill">
				<div class="avatar" title={$auth.displayName || $auth.email}>{$userInitials}</div>
				<form action="/auth/logout" method="POST">
					<button class="logout-btn" title="Log out" type="submit">⏻</button>
				</form>
			</div>
		</div>
	{/if}
</aside>

<style>
	.sidebar {
		width: 72px;
		background: var(--navy-dark);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		height: 100vh;
		overflow: hidden;
	}

	.sidebar-logo {
		height: var(--topbar-h);
		padding: 0 10px;
		justify-content: center;
		box-sizing: border-box;
		background: #fff;
		border-bottom: 1px solid var(--grey-line);
		display: flex;
		align-items: center;
		gap: 10px;
		flex-shrink: 0;
	}
	.logo-img {
		height: 30px;
		max-width: 100%;
		object-fit: contain;
		display: block;
	}

	.sidebar-nav {
		flex: 1;
		padding: 10px 0;
		overflow-y: auto;
	}

	.nav-item {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px 0;
		color: rgba(255,255,255,.55);
		cursor: pointer;
		border-left: 3px solid transparent;
		transition: all 0.2s;
		text-decoration: none;
	}
	.nav-item:hover {
		color: white;
		background: rgba(255,255,255,.06);
	}
	.nav-item.active {
		color: white;
		background: rgba(245,161,0,.12);
		border-left-color: var(--orange);
		font-weight: 600;
	}

	.nav-icon {
		width: 20px;
		height: 20px;
		object-fit: contain;
		flex-shrink: 0;
	}

	.sidebar-footer {
		padding: 14px 0;
		border-top: 1px solid rgba(255,255,255,.08);
	}

	.user-pill {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}

	.avatar {
		width: 34px;
		height: 34px;
		border-radius: 50%;
		background: var(--orange);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		font-weight: 700;
		color: white;
		flex-shrink: 0;
	}


	.logout-btn {
		background: none;
		border: none;
		color: rgba(255,255,255,.35);
		font-size: 17px;
		padding: 4px;
		transition: color 0.2s;
		cursor: pointer;
	}
	.logout-btn:hover { color: rgba(255,255,255,.8); }
</style>
