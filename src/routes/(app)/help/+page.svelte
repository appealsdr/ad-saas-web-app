<script lang="ts">
	import Topbar from '$components/layout/Topbar.svelte';

	// Client-facing "How to Use" guide. Static content — the (app) layout
	// guard already handles auth/onboarding, so no server load is needed.
	const sections = [
		{ id: 'getting-started', icon: '/icons/home.png',      title: 'Getting started' },
		{ id: 'dashboard',       icon: '/icons/home.png',      title: 'Your dashboard' },
		{ id: 'accounts',        icon: '/icons/account.png',   title: 'Account & team' },
		{ id: 'stores',          icon: '/icons/store.png',     title: 'Stores & Amazon' },
		{ id: 'documents',       icon: '/icons/upload.png',    title: 'Uploading documents' },
		{ id: 'services',        icon: '/icons/payment.png',   title: 'Buying services' },
		{ id: 'cases',           icon: '/icons/case.png',      title: 'Tracking your cases' },
		{ id: 'payments',        icon: '/icons/payment.png',   title: 'Invoices & payments' },
		{ id: 'faq',             icon: '/icons/guidance.png',  title: 'Tips & FAQ' }
	];
</script>

<svelte:head><title>How to Use — Appeals Doctor</title></svelte:head>

<Topbar title="How to Use Appeals Doctor" subtitle="A quick guide to getting the most out of your account" />

<div class="page">
	<div class="intro card">
		<h2>Welcome to Appeals Doctor 👋</h2>
		<p>
			This portal is where you manage your Amazon stores, submit the documents we need,
			track the progress of your appeals (we call them <strong>cases</strong>), and pay for
			services. This guide walks through each part of the app step by step. Use the menu
			below to jump to a topic, or read straight through.
		</p>
	</div>

	<!-- Table of contents -->
	<nav class="toc">
		{#each sections as s}
			<a class="toc-item" href={`#${s.id}`}>
				<img src={s.icon} alt="" aria-hidden="true" />
				<span>{s.title}</span>
			</a>
		{/each}
	</nav>

	<!-- Getting started -->
	<section id="getting-started" class="card">
		<h2>1. Getting started</h2>
		<p>You can sign in two ways:</p>
		<ol>
			<li><strong>Email &amp; password</strong> — enter the email and password you registered with on the sign-in screen.</li>
			<li><strong>Continue with Google</strong> — use your Google account with one click. The first time you sign up with Google, we'll ask for a few details (your <strong>company name</strong>, website, and phone) to finish setting up your account.</li>
		</ol>
		<div class="note">
			<strong>Forgot your password?</strong> Click <em>Forgot password?</em> on the sign-in screen and we'll email you a secure reset link. The link is valid for one hour.
		</div>
		<p>Once you're signed in, use the menu on the left to move between sections. You can sign out any time from the button next to your name at the bottom of the menu.</p>
	</section>

	<!-- Dashboard -->
	<section id="dashboard" class="card">
		<h2>2. Your dashboard</h2>
		<p>The <strong>Dashboard</strong> is your home screen. At a glance it shows:</p>
		<ul>
			<li><strong>Open Cases</strong> — appeals currently being worked on across all your stores.</li>
			<li><strong>Active Stores</strong> — how many stores you have and how many are connected to Amazon.</li>
			<li><strong>Pending Files</strong> — documents we still need from you. Click this to jump straight to what's outstanding.</li>
			<li><strong>Resolved This Month</strong> — cases closed out this month.</li>
		</ul>
		<p>
			Below the cards you'll find a <strong>Documents Pending</strong> banner (anything we're
			waiting on), your <strong>Recent Cases</strong>, and the <strong>Latest Comments</strong>
			from our team. Click any row to open it.
		</p>
	</section>

	<!-- Accounts -->
	<section id="accounts" class="card">
		<h2>3. Account &amp; team</h2>
		<p>The <strong>Accounts</strong> tab holds your company profile and the people on your account.</p>
		<ol>
			<li><strong>Company &amp; contact details</strong> — review your account information. Click <em>Edit</em> to update your primary contact (name, phone) or your billing address.</li>
			<li><strong>Account Team</strong> — invite colleagues so they can work in the portal too.</li>
		</ol>
		<div class="note">
			<strong>Roles:</strong> The <strong>owner</strong> (the person who registered) and any <strong>admins</strong>
			can add, edit, and remove team members and set the point of contact. <strong>Members</strong> can use
			the app and work on stores but can't change the team. The owner can't be removed.
		</div>
		<p>To add someone, click <strong>+ Add Team Member</strong>, fill in their name, email, and a starting password, then save. They can sign in right away.</p>
	</section>

	<!-- Stores -->
	<section id="stores" class="card">
		<h2>4. Stores &amp; connecting Amazon</h2>
		<p>Each Amazon store you work with lives under the <strong>Stores</strong> tab.</p>
		<ol>
			<li>Click <strong>+ Add Store</strong>, give it a name, choose its marketplaces, and save.</li>
			<li>On the store page, click <strong>Connect via SP-API</strong> to link it to Amazon Seller Central.</li>
			<li>You'll be sent to Amazon to approve access. After you approve, you're brought back here and the store shows a green <strong>Connected</strong> badge.</li>
		</ol>
		<div class="note">
			If the connection doesn't complete, or the badge turns orange/red, just open the store and
			click <strong>Reconnect</strong> to try again. Connecting Amazon lets us pull the information
			we need to work your appeals faster.
		</div>
	</section>

	<!-- Documents -->
	<section id="documents" class="card">
		<h2>5. Uploading documents</h2>
		<p>
			We'll request specific documents for a store or a case. Each request appears as a
			<strong>Required File</strong> slot with a short description and the formats we accept.
		</p>
		<ol>
			<li>Open the store or case and find the <strong>Required Files</strong> section.</li>
			<li>Drag a file onto the slot, or click it to browse. Some slots include an <strong>Example</strong> button so you can see what's expected.</li>
			<li>When the upload finishes, the slot turns to <strong>Uploaded</strong> and shows the file name and date.</li>
		</ol>
		<ul>
			<li><strong>Accepted types:</strong> PDF, images (PNG, JPEG, GIF, WebP, HEIC), Word, Excel, TXT, CSV, and ZIP.</li>
			<li><strong>Maximum size:</strong> 25&nbsp;MB per file.</li>
			<li>Click any uploaded file to preview it. Need to swap it? Use <strong>Re-upload</strong>, or <strong>✕ Remove</strong> to clear the slot.</li>
		</ul>
	</section>

	<!-- Services -->
	<section id="services" class="card">
		<h2>6. Buying services</h2>
		<p>You can purchase services for a store directly in the portal.</p>
		<ol>
			<li>Open a store and go to its <strong>Services</strong> list. Search or scroll to find what you need.</li>
			<li>Select one or more services — the running total updates as you go — then click <strong>Continue to checkout</strong>.</li>
			<li>Review the summary, click <strong>Continue to payment</strong>, and enter your card details on the secure payment screen.</li>
			<li>After payment succeeds you'll see a confirmation, and a contract is created under <strong>Payments</strong>.</li>
		</ol>
		<div class="note">
			Payments are processed securely by Stripe — we never see or store your full card number.
			Prices are always confirmed by our system before you're charged.
		</div>
	</section>

	<!-- Cases -->
	<section id="cases" class="card">
		<h2>7. Tracking your cases</h2>
		<p>
			A <strong>case</strong> is an appeal or issue we're handling for one of your stores.
			The <strong>Cases</strong> tab lists them all with their status and priority.
		</p>
		<ol>
			<li>Click a case to open its full detail page.</li>
			<li>The <strong>Timeline</strong> shows everything that has happened — status changes, comments, and document uploads.</li>
			<li>Use the <strong>comment box</strong> to message our team. You can format text (bold, lists, links) and post. We'll reply in the same thread.</li>
			<li>If a case needs documents, upload them in its <strong>Required Files</strong> section (see section 5).</li>
		</ol>
		<div class="note">
			You can filter the list by status (Open, In Progress, Waiting, Resolved) to focus on what needs attention. Links in our emails take you straight to the right case.
		</div>
	</section>

	<!-- Payments -->
	<section id="payments" class="card">
		<h2>8. Invoices &amp; payments</h2>
		<p>The <strong>Payments</strong> tab is your record of every purchase.</p>
		<ul>
			<li>Each row is a service contract: the amount, date paid, term, store, and how many services it covers.</li>
			<li>Click a contract to see the full breakdown — the exact services purchased and the total.</li>
		</ul>
		<p>Everything here is read-only history; there's nothing you need to action on this tab.</p>
	</section>

	<!-- FAQ -->
	<section id="faq" class="card">
		<h2>9. Tips &amp; FAQ</h2>
		<dl class="faq">
			<dt>How do I know what you need from me?</dt>
			<dd>Check the <strong>Pending Files</strong> card and the <strong>Documents Pending</strong> banner on your dashboard — they list every outstanding item with a direct link.</dd>

			<dt>Can I add my teammates?</dt>
			<dd>Yes — an owner or admin can invite them under <strong>Accounts → Account Team</strong>.</dd>

			<dt>My Amazon connection isn't working.</dt>
			<dd>Open the store and click <strong>Reconnect</strong>. If it still fails, contact us and we'll help.</dd>

			<dt>Is my information secure?</dt>
			<dd>Yes. Sign-in is protected, files are stored encrypted, and payments run through Stripe. We never store your full card details.</dd>

			<dt>I still need help.</dt>
			<dd>Leave a comment on the relevant case, or reach out to your Appeals Doctor contact directly.</dd>
		</dl>
	</section>

	<p class="foot">Thanks for working with Appeals Doctor. We're here to help your appeals succeed.</p>
</div>

<style>
	.page {
		flex: 1;
		overflow-y: auto;
		padding: 26px;
		max-width: 900px;
		width: 100%;
		box-sizing: border-box;
	}

	.card {
		background: #fff;
		border: 1px solid var(--grey-line);
		border-radius: var(--radius);
		padding: 22px 26px;
		margin-bottom: 18px;
	}

	.intro h2 { margin-top: 0; }
	.intro p { margin-bottom: 0; }

	h2 {
		font-size: 18px;
		font-weight: 700;
		color: var(--navy);
		margin: 0 0 12px;
	}

	p, li, dd {
		font-size: 14px;
		line-height: 1.6;
		color: var(--navy);
	}

	ol, ul { padding-left: 22px; margin: 10px 0; }
	li { margin-bottom: 7px; }

	/* Table of contents */
	.toc {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 10px;
		margin-bottom: 22px;
	}
	.toc-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		background: #fff;
		border: 1px solid var(--grey-line);
		border-radius: var(--radius-sm);
		text-decoration: none;
		color: var(--navy);
		font-size: 13px;
		font-weight: 600;
		transition: all 0.15s;
	}
	.toc-item:hover {
		border-color: var(--orange);
		background: var(--orange-lt);
	}
	.toc-item img { width: 18px; height: 18px; object-fit: contain; }

	/* Note callout */
	.note {
		background: var(--orange-lt);
		border-left: 3px solid var(--orange);
		border-radius: var(--radius-sm);
		padding: 12px 16px;
		margin: 14px 0;
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--navy);
	}

	/* FAQ */
	.faq { margin: 0; }
	.faq dt {
		font-weight: 700;
		color: var(--navy);
		font-size: 14px;
		margin-top: 14px;
	}
	.faq dt:first-child { margin-top: 0; }
	.faq dd { margin: 4px 0 0; }

	.foot {
		text-align: center;
		color: var(--grey-text);
		font-size: 13px;
		margin: 8px 0 30px;
	}

	section { scroll-margin-top: 16px; }
</style>
