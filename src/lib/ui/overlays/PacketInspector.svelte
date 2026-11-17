<script lang="ts">
	import type { LogRecord, PacketLog } from '#lib/domain/packet-log.svelte.ts';

	let { log }: { log: PacketLog } = $props();

	let open = $state(false);
	let hideTimecode = $state(true);

	const SHOWN = 300;
	const rows = $derived.by(() => {
		if (!open) return [];
		const all = log.recent(hideTimecode ? 3000 : SHOWN);
		const filtered = hideTimecode ? all.filter((r) => !(r.kind === 'in' && r.ch === 'timecode')) : all;
		return filtered.slice(-SHOWN).reverse();
	});

	function line(r: LogRecord): string {
		const { t: _t, kind: _k, ...rest } = r;
		return JSON.stringify(rest);
	}

	function exportJsonl() {
		const blob = new Blob([log.toJsonl()], { type: 'application/x-ndjson' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `magicremote-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
</script>

<button class="toggle" onclick={() => (open = !open)} aria-expanded={open}>Log</button>

{#if open}
	<div class="overlay" role="dialog" aria-label="Packet log">
		<div class="tools">
			<strong>Packet log</strong>
			<label><input type="checkbox" bind:checked={hideTimecode} /> hide timecode</label>
			<span class="count">{log.records.length} records</span>
			<button onclick={exportJsonl}>Export JSONL</button>
			<button onclick={() => log.clear()}>Clear</button>
			<button onclick={() => (open = false)}>Close</button>
		</div>
		<ol class="rows">
			{#each rows as r, i (i)}
				<li class={r.kind}>
					<span class="t">{r.t.toFixed(3)}</span>
					<span class="k">{r.kind}</span>
					<span class="d">{line(r)}</span>
				</li>
			{/each}
		</ol>
	</div>
{/if}

<style>
	.toggle {
		position: fixed;
		right: 12px;
		bottom: 12px;
		z-index: 20;
		opacity: 0.8;
	}
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 30;
		background: rgb(13 15 18 / 0.97);
		display: flex;
		flex-direction: column;
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding: 10px var(--pad);
		border-bottom: 1px solid var(--border);
	}
	.tools label {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: var(--touch);
	}
	.count {
		color: var(--text-dim);
		font-size: 0.85rem;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 8px var(--pad);
		overflow: auto;
		flex: 1;
		font-family: var(--mono);
		font-size: 0.75rem;
	}
	.rows li {
		display: flex;
		gap: 8px;
		padding: 2px 0;
		border-bottom: 1px solid var(--surface-2);
	}
	.t {
		color: var(--text-dim);
		flex: none;
		width: 5.5em;
		text-align: right;
	}
	.k {
		flex: none;
		width: 6em;
		color: var(--accent);
	}
	.d {
		word-break: break-all;
	}
	li.out .k {
		color: var(--warn);
	}
	li.error .k,
	li.rejected .k {
		color: var(--danger);
	}
</style>
