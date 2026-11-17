<script lang="ts">
	import type { UpdateController } from '#lib/platform/updates.svelte.ts';

	let { updates }: { updates: UpdateController } = $props();

	let dismissed = $state(false);
	let showOffline = $state(false);

	// "Ready offline" is a one-off confirmation after the first install, then it goes away.
	$effect(() => {
		if (!updates.offlineReadyNow) return;
		showOffline = true;
		const id = setTimeout(() => (showOffline = false), 4000);
		return () => clearTimeout(id);
	});

	// A newer version arriving later is worth mentioning again.
	$effect(() => {
		if (!updates.waiting) dismissed = false;
	});

	const showUpdate = $derived((updates.offerUpdate && !dismissed) || updates.applying);
</script>

{#if showUpdate}
	<div class="notice" role="status">
		{#if updates.applying}
			<span>Updating…</span>
		{:else}
			<span>
				{updates.refused === 'other-windows' ? 'Close other MagicRemote windows to update' : 'Update available'}
			</span>
			<button class="primary" onclick={() => updates.apply()}>Reload</button>
			<button class="later" aria-label="Not now" onclick={() => (dismissed = true)}>✕</button>
		{/if}
	</div>
{:else if showOffline}
	<div class="notice" role="status"><span class="ok" aria-hidden="true"></span><span>Ready to work offline</span></div>
{/if}

<style>
	.notice {
		position: fixed;
		left: max(var(--pad), env(safe-area-inset-left));
		bottom: max(var(--pad), env(safe-area-inset-bottom));
		z-index: 50;
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: calc(100vw - 2 * var(--pad));
		padding: 4px 4px 4px 12px;
		min-height: 40px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text-dim);
		font-size: 14px;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.4);
	}

	.notice:not(:has(button)) {
		padding-right: 12px;
	}

	button {
		min-height: 32px;
		padding: 0 12px;
		font-size: 14px;
	}

	.later {
		padding: 0 10px;
		background: transparent;
		border-color: transparent;
		color: var(--text-dim);
	}

	.ok {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--ok);
	}
</style>
