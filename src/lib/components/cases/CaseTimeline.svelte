<script lang="ts">
	import type { CaseTimelineEvent } from '$lib/types/case-timeline';

	export let events: CaseTimelineEvent[] = [];
	export let historyError: string | null = null;

	const DOT_CLASS: Record<CaseTimelineEvent['type'], string> = {
		case_opened: 'tl-dot-open',
		status_changed: 'tl-dot-status',
		priority_changed: 'tl-dot-status',
		owner_changed: 'tl-dot-status',
		field_changed: 'tl-dot-status',
		comment_added: 'tl-dot-comment',
		document_uploaded: 'tl-dot-doc',
		document_requested: 'tl-dot-doc'
	};

	function fmtDate(iso: string) {
		try {
			return new Date(iso).toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			});
		} catch {
			return iso;
		}
	}

	function fmtTime(iso: string) {
		try {
			return new Date(iso).toLocaleTimeString('en-US', {
				hour: 'numeric',
				minute: '2-digit',
				hour12: true
			}).toLowerCase();
		} catch {
			return '';
		}
	}
</script>

<div class="card timeline-card">
	<div class="card-title">Case Timeline</div>

	{#if historyError}
		<div class="alert alert-warn timeline-warn">
			Could not load full case history from Salesforce. Showing comments and documents only.
		</div>
	{/if}

	<div class="timeline-scroll">
		<div class="timeline">
			{#each events as event (event.id)}
				<div class="tl-item">
					<div class="tl-dot {DOT_CLASS[event.type]}"></div>
					<div class="tl-date">{fmtDate(event.date)} · {fmtTime(event.date)}</div>
					<div class="tl-text">{event.text}</div>
					{#if event.actor && event.type !== 'comment_added'}
						<div class="tl-meta">by {event.actor}</div>
					{/if}
					{#if event.detail}
						<div class="tl-detail">{event.detail}</div>
					{/if}
				</div>
			{:else}
				<p class="timeline-empty">No activity recorded yet.</p>
			{/each}
		</div>
	</div>
</div>

<style>
	.timeline-card {
		margin-bottom: 14px;
	}

	.card {
		background: white;
		border: 1px solid var(--grey-line);
		border-radius: var(--radius);
		padding: 18px 20px;
	}

	.card-title {
		display: flex;
		align-items: center;
		gap: 10px;
		justify-content: space-between;
		font-size: 14px;
		font-weight: 700;
		color: var(--navy);
		margin-bottom: 14px;
		padding-bottom: 10px;
		border-bottom: 1px solid var(--grey-line);
	}

	.timeline-warn {
		margin-bottom: 12px;
		font-size: 12px;
		padding: 10px 12px;
	}

	.timeline-scroll {
		max-height: 360px;
		overflow-y: auto;
		padding-right: 4px;
	}

	.timeline {
		padding-left: 22px;
		position: relative;
	}

	.timeline::before {
		content: '';
		position: absolute;
		left: 7px;
		top: 6px;
		bottom: 6px;
		width: 2px;
		background: var(--grey-line);
	}

	.tl-item {
		position: relative;
		margin-bottom: 14px;
	}

	.tl-item:last-child {
		margin-bottom: 0;
	}

	.tl-dot {
		position: absolute;
		left: -19px;
		top: 5px;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--orange);
		border: 2px solid white;
		box-shadow: 0 0 0 2px var(--orange);
	}

	.tl-dot-open {
		background: var(--navy-soft, #334155);
		box-shadow: 0 0 0 2px var(--navy-soft, #334155);
	}

	.tl-dot-status {
		background: #3b82f6;
		box-shadow: 0 0 0 2px #3b82f6;
	}

	.tl-dot-comment {
		background: var(--green, #059669);
		box-shadow: 0 0 0 2px var(--green, #059669);
	}

	.tl-dot-doc {
		background: #d97706;
		box-shadow: 0 0 0 2px #d97706;
	}

	.tl-date {
		font-size: 11px;
		color: var(--grey-text);
		margin-bottom: 2px;
	}

	.tl-text {
		font-size: 13px;
		font-weight: 600;
		color: var(--navy);
		line-height: 1.4;
	}

	.tl-meta,
	.tl-detail {
		font-size: 11px;
		color: var(--grey-text);
		margin-top: 2px;
		line-height: 1.45;
	}

	.tl-detail {
		white-space: pre-wrap;
		word-break: break-word;
	}

	.timeline-empty {
		font-size: 13px;
		color: var(--grey-text);
		margin: 0;
	}

	.alert {
		border-radius: 9px;
	}

	.alert-warn {
		background: #fef3c7;
		border: 1px solid #fcd34d;
		color: #92400e;
	}
</style>
