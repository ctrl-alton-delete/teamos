<script lang="ts">
	import { api } from '../lib/api.js';
	import type { MemberSummary, Memo, TicketCounts, SiblingInfo } from '../lib/types.js';
	import MemberCard from './MemberCard.svelte';
	import TicketPipeline from './TicketPipeline.svelte';

	let members: MemberSummary[] = $state([]);
	let memos: Memo[] = $state([]);
	let tickets: TicketCounts | null = $state(null);
	let sibling: SiblingInfo | null = $state(null);
	let loading = $state(true);
	let stopPending = $state(false);
	let stoppingCycle = $state(false);

	async function load() {
		loading = true;
		const [m, memosData, t, s, cs] = await Promise.all([
			api.members(),
			api.memos(),
			api.tickets(),
			api.sibling().catch(() => null),
			api.cycleStatus().catch(() => ({ stopPending: false })),
		]);
		members = m;
		memos = memosData.items ?? [];
		tickets = t;
		sibling = s;
		stopPending = cs.stopPending;
		loading = false;
	}

	$effect(() => { load(); });

	async function cycleStop() {
		stoppingCycle = true;
		await api.cycleStop();
		stopPending = true;
		stoppingCycle = false;
	}

	async function archiveMemo(index: number) {
		await api.archiveMemo(index);
		memos = memos.filter((_, i) => i !== index);
	}

	const hasTickets = $derived(tickets && Object.values(tickets).some(v => v > 0));
</script>

{#if loading}
	<div class="loading">Loading...</div>
{:else}
	<section class="section">
		<div class="section-header">
			<h2 class="section-title">Team</h2>
			{#if stopPending}
				<span class="stop-status">Stop pending...</span>
			{:else}
				<button class="stop-btn" onclick={cycleStop} disabled={stoppingCycle}>
					{stoppingCycle ? 'Stopping...' : 'Stop Cycle'}
				</button>
			{/if}
		</div>
		<div class="member-grid">
			{#each members as member}
				<MemberCard {member} />
			{/each}
		</div>
	</section>

	{#if hasTickets && tickets}
		<section class="section">
			<h2 class="section-title">Ticket Pipeline</h2>
			<TicketPipeline {tickets} siblingUrl={sibling?.name === 'tess' ? sibling.url : null} />
		</section>
	{/if}

	{#if memos.length > 0}
		<section class="section">
			<h2 class="section-title">Active Memos</h2>
			<div class="memos">
				{#each memos as memo, i}
					<div class="memo" class:critical={memo.importance === 'critical'}>
						<div class="memo-header">
							<span class="memo-title">{memo.title}</span>
							<div class="memo-header-right">
								<span class="memo-meta">
									{memo.authorName} &middot; {new Date(memo.postedAt).toLocaleDateString()}
								</span>
								<button class="memo-archive" onclick={() => archiveMemo(i)} title="Archive memo">Archive</button>
							</div>
						</div>
						<p class="memo-content">{memo.content}</p>
						{#if memo.projectCodes?.length}
							<div class="memo-tags">
								{#each memo.projectCodes as code}
									<span class="tag">{code}</span>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/if}
{/if}

<style>
	.loading {
		text-align: center;
		padding: 3rem;
		color: var(--text-muted);
	}
	.section { margin-bottom: 2rem; }
	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}
	.section-header .section-title { margin-bottom: 0; }
	.stop-btn {
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--danger);
		border-radius: var(--radius);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--danger);
		background: transparent;
		transition: all var(--transition);
	}
	.stop-btn:hover:not(:disabled) {
		background: var(--danger);
		color: var(--on-primary);
	}
	.stop-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.stop-status {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--warning);
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--warning);
		border-radius: var(--radius);
	}
	.section-title {
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		margin-bottom: 0.75rem;
	}
	.member-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0.75rem;
	}
	.memos { display: flex; flex-direction: column; gap: 0.75rem; }
	.memo {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
	}
	.memo.critical { border-left: 3px solid var(--warning); }
	.memo-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		margin-bottom: 0.5rem;
	}
	.memo-title { font-weight: 600; font-size: 0.925rem; }
	.memo-header-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}
	.memo-meta { font-size: 0.8rem; color: var(--text-muted); white-space: nowrap; }
	.memo-archive {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.2rem 0.5rem;
		border-radius: var(--radius);
		color: var(--text-muted);
		border: 1px solid var(--border);
		transition: all var(--transition);
	}
	.memo-archive:hover { background: var(--bg); color: var(--text); }
	.memo-content {
		font-size: 0.875rem;
		color: var(--text-muted);
		line-height: 1.5;
		white-space: pre-line;
		max-height: 4.5em;
		overflow: hidden;
	}
	.memo-tags { display: flex; gap: 0.375rem; margin-top: 0.5rem; }
	.tag {
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.125rem 0.5rem;
		border-radius: 99px;
		background: var(--primary-subtle);
		color: var(--primary);
	}
</style>
