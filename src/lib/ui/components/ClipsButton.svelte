<script lang="ts">
	import type { PlaybackController } from '#lib/domain/playback-controller.svelte.ts';
	import Icon from '#lib/ui/components/Icon.svelte';
	import { playbackBlockText, playbackErrorText, playbackNoticeText } from '#lib/ui/messages.ts';

	/** Entry to clip playback, next to the record button. Refused while recording. */
	let { playback }: { playback: PlaybackController } = $props();

	const block = $derived(playback.block('enter'));
	// Only say why when it is not obvious from the record button itself.
	const hint = $derived(block === 'recording' || block === 'record-busy' ? playbackBlockText(block) : null);

	function ignoreRepeat(e: KeyboardEvent) {
		if (e.repeat) e.preventDefault();
	}
</script>

<div class="clips">
	<button
		class="enter"
		onclick={() => playback.enter()}
		onkeydown={ignoreRepeat}
		disabled={!!block}
		aria-describedby={hint ? 'clips-hint' : undefined}
	>
		<Icon name="clips" size={22} />
		<span>Clips</span>
	</button>
	{#if hint}<span class="hint" id="clips-hint">{hint}</span>{/if}

	{#if playback.error}
		<div class="msg warn" role="alert">
			<span>{playbackErrorText(playback.error)}</span>
			<button class="small" onclick={() => playback.dismissError()}>OK</button>
		</div>
	{:else if playback.notice}
		<div class="msg" role="status">
			<span>{playbackNoticeText(playback.notice)}</span>
			<button class="small" onclick={() => playback.dismissNotice()}>OK</button>
		</div>
	{/if}
</div>

<style>
	.clips {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}
	.enter {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		justify-content: center;
		border-radius: 999px;
		color: var(--text);
	}
	.enter:not(:disabled):hover {
		border-color: var(--accent);
	}
	.hint {
		font-size: 0.85rem;
		color: var(--text-dim);
	}
	.msg {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		max-width: 28rem;
	}
	.msg.warn {
		border: 1px solid var(--warn);
	}
	.small {
		min-height: var(--touch);
		padding: 0 12px;
	}
</style>
