<script lang="ts">
	import type { CameraSession } from '#lib/domain/camera-session.svelte.ts';
	import { PHASE_LABEL } from '#lib/ui/messages.ts';
	import { formatRemaining } from '#lib/ui/format.ts';

	let { session }: { session: CameraSession } = $props();

	const s = $derived(session.state);
	const tone = $derived(
		session.phase === 'ready' ? (session.live ? 'ok' : 'warn') : session.phase === 'reconnecting' || session.phase === 'standby' ? 'warn' : 'off'
	);
	const battery = $derived(s.batteryPercent);
	const slot = $derived(s.activeSlot);
	const remaining = $derived(s.activeRemaining);
</script>

<header class="bar" class:stale={!session.live}>
	<div class="who">
		<span class="dot {tone}" aria-hidden="true"></span>
		<div class="id">
			<div class="name">{session.name ?? 'Camera'}</div>
			<div class="sub">{session.syncing ? 'Syncing' : PHASE_LABEL[session.phase]}{s.model ? ` · ${s.model}` : ''}</div>
		</div>
	</div>
	<div class="facts">
		<span title="Battery">{battery === null ? 'Batt --' : `Batt ${battery}%`}</span>
		<span title="Active media slot and remaining time">
			{slot === null ? 'Media --' : `Slot ${slot + 1} · ${remaining ? formatRemaining(remaining) : '--'}`}
		</span>
	</div>
</header>

<style>
	.bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--gap);
		padding: 10px var(--pad);
		background: var(--surface);
		border-bottom: 2px solid var(--accent);
	}
	.who {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.id {
		min-width: 0;
	}
	.name {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sub {
		font-size: 0.8rem;
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.dot {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		flex: none;
		background: var(--text-dim);
	}
	.dot.ok {
		background: var(--ok);
	}
	.dot.warn {
		background: var(--warn);
	}
	.facts {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		font-size: 0.85rem;
		color: var(--accent);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		flex: none;
	}
	.stale .facts {
		color: var(--text-dim);
	}
</style>
