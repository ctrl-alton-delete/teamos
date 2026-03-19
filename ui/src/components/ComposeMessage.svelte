<script lang="ts">
	import { api } from '../lib/api.js';
	import { router } from '../lib/router.svelte.js';
	import { identity } from '../lib/identity.svelte.js';
	import type { MemberSummary, Project } from '../lib/types.js';

	let members: MemberSummary[] = $state([]);
	let projects: Project[] = $state([]);
	let loading = $state(true);
	let sending = $state(false);
	let sent = $state(false);

	let selected: Set<string> = $state(new Set());
	let from = $state(identity.name ?? '');
	let subject = $state('');
	let projectCode = $state('');
	let requestResponse = $state(false);
	let body = $state('');

	$effect(() => {
		if (identity.name && !from) from = identity.name;
	});

	async function load() {
		const [m, p] = await Promise.all([api.members(), api.projects()]);
		members = m;
		projects = p.projects ?? [];
		loading = false;

		const to = router.query.to;
		if (to) selected = new Set(to.split(','));
	}

	$effect(() => { load(); });

	function toggleRecipient(name: string) {
		const next = new Set(selected);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		selected = next;
	}

	function selectAllAI() {
		selected = new Set(members.filter(m => m.type === 'ai').map(m => m.name));
	}

	async function send() {
		if (selected.size === 0 || !body.trim() || !from.trim()) return;
		sending = true;
		const msg = {
			from,
			requestResponse,
			projectCode: projectCode || undefined,
			subject: subject || undefined,
			body: body.trim(),
		};
		await Promise.all([...selected].map(name => api.sendMessage(name, msg)));
		sending = false;
		sent = true;
	}

	function reset() {
		selected = new Set();
		subject = '';
		projectCode = '';
		requestResponse = false;
		body = '';
		sent = false;
	}
</script>

<div class="compose">
	<div class="compose-header">
		<button class="back" onclick={() => router.navigate('/')}>← Back</button>
		<h1 class="compose-title">Compose Message</h1>
	</div>

	{#if sent}
		<div class="sent-confirmation">
			<div class="sent-icon">&#10003;</div>
			<p>Message sent to {[...selected].join(', ')}</p>
			<div class="sent-actions">
				<button class="btn btn-primary" onclick={reset}>Compose Another</button>
				<button class="btn btn-ghost" onclick={() => router.navigate('/')}>Back to Dashboard</button>
			</div>
		</div>
	{:else if loading}
		<div class="loading">Loading...</div>
	{:else}
		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="label">To</label>
			<div class="recipients">
				{#each members as member}
					<button
						class="recipient"
						class:selected={selected.has(member.name)}
						onclick={() => toggleRecipient(member.name)}
					>
						{member.name}
						{#if identity.name === member.name}
							<span class="recipient-type">(you)</span>
						{/if}
					</button>
				{/each}
				<button class="recipient select-all" onclick={selectAllAI}>All AI</button>
			</div>
		</div>

		<div class="form-row">
			<div class="form-group" style="flex:1">
				<label class="label" for="from">From</label>
				<input id="from" type="text" bind:value={from} placeholder="Your name" />
			</div>
			<div class="form-group" style="flex:1">
				<label class="label" for="subject">Subject (optional, used in filename)</label>
				<input id="subject" type="text" bind:value={subject} placeholder="e.g. deployment-status" />
			</div>
		</div>

		<div class="form-row">
			<div class="form-group" style="flex:1">
				<label class="label" for="project">Project</label>
				<select id="project" bind:value={projectCode}>
					<option value="">None</option>
					{#each projects as project}
						<option value={project.code}>{project.name} ({project.code})</option>
					{/each}
				</select>
			</div>
			<div class="form-group" style="flex:1; display:flex; align-items:flex-end;">
				<label class="checkbox-label">
					<input type="checkbox" bind:checked={requestResponse} />
					Request response
				</label>
			</div>
		</div>

		<div class="form-group">
			<label class="label" for="body">Message</label>
			<textarea id="body" bind:value={body} rows="10" placeholder="Write your message (markdown supported)..."></textarea>
		</div>

		<div class="form-actions">
			<button
				class="btn btn-primary"
				onclick={send}
				disabled={selected.size === 0 || !body.trim() || !from.trim() || sending}
			>
				{sending ? 'Sending...' : `Send to ${selected.size} recipient${selected.size !== 1 ? 's' : ''}`}
			</button>
		</div>
	{/if}
</div>

<style>
	.compose { max-width: 720px; }
	.compose-header {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1.5rem;
	}
	.back {
		color: var(--text-muted);
		font-size: 0.875rem;
		padding: 0.375rem 0.75rem;
		border-radius: var(--radius);
		transition: all var(--transition);
	}
	.back:hover { background: var(--surface); color: var(--text); }
	.compose-title { font-size: 1.25rem; font-weight: 700; }
	.loading { text-align: center; padding: 3rem; color: var(--text-muted); }

	.form-group { margin-bottom: 1rem; }
	.form-row { display: flex; gap: 1rem; }
	.label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		margin-bottom: 0.375rem;
	}

	.recipients { display: flex; gap: 0.375rem; flex-wrap: wrap; }
	.recipient {
		padding: 0.375rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: 99px;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--text-muted);
		transition: all var(--transition);
		background: var(--surface);
	}
	.recipient:hover { border-color: var(--primary); color: var(--text); }
	.recipient.selected {
		background: var(--primary);
		color: var(--on-primary);
		border-color: var(--primary);
	}
	.recipient-type { font-size: 0.7rem; opacity: 0.7; }
	.recipient.select-all {
		border-style: dashed;
		color: var(--primary);
	}
	.recipient.select-all:hover {
		background: var(--primary-subtle);
	}

	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		cursor: pointer;
	}
	.checkbox-label input[type="checkbox"] {
		width: 1rem;
		height: 1rem;
		accent-color: var(--primary);
	}

	input, select, textarea {
		width: 100%;
	}

	.form-actions { margin-top: 1.5rem; }

	.btn {
		padding: 0.625rem 1.25rem;
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.875rem;
		transition: all var(--transition);
	}
	.btn-primary {
		background: var(--primary);
		color: var(--on-primary);
	}
	.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost {
		color: var(--text-muted);
	}
	.btn-ghost:hover { background: var(--bg); color: var(--text); }

	.sent-confirmation {
		text-align: center;
		padding: 3rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
	}
	.sent-icon {
		width: 48px;
		height: 48px;
		border-radius: 50%;
		background: var(--success-subtle);
		color: var(--success);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 1.5rem;
		font-weight: 700;
		margin-bottom: 1rem;
	}
	.sent-confirmation p {
		font-size: 1.1rem;
		font-weight: 600;
		margin-bottom: 1.5rem;
	}
	.sent-actions { display: flex; gap: 0.75rem; justify-content: center; }
</style>
