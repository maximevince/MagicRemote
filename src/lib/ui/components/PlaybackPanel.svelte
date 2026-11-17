<script lang="ts">
	import type { PlaybackController } from '#lib/domain/playback-controller.svelte.ts';
	import Icon from '#lib/ui/components/Icon.svelte';
	import { playbackErrorText, playbackNoticeText } from '#lib/ui/messages.ts';

	/**
	 * Clip playback, shown instead of the record button while the camera is in playback.
	 * Nothing here can start a recording. Every state shown is what the camera last reported.
	 */
	let { playback }: { playback: PlaybackController } = $props();

	const display = $derived(playback.display);
	const speed = $derived(playback.speed);
	const playing = $derived(speed !== null && speed !== 0);
	const pendingSpeed = $derived(playback.pendingSpeed);

	const speedBlock = $derived(playback.block('speed'));
	const stepBlock = $derived(playback.block('step'));
	const exitBlock = $derived(playback.block('exit'));

	const status = $derived.by(() => {
		switch (display) {
			case 'entering':
				return 'Switching to playback…';
			case 'leaving':
				return 'Returning to the camera…';
			case 'changing':
				return pendingSpeed === 0 ? 'Pausing…' : pendingSpeed !== null ? 'Starting playback…' : 'Sending…';
			case 'syncing':
				return 'Reading camera state…';
			case 'unknown':
				return 'Camera state unknown';
			case 'paused':
				return 'Paused';
			case 'playing':
				return speed === 1 ? 'Playing' : speed !== null && speed < 0 ? `Reverse ×${-speed}` : `Playing ×${speed}`;
			case 'error':
				return playback.error ? playbackErrorText(playback.error) : '';
			default:
				return '';
		}
	});

	// Clip steps are never confirmed by the camera: only "sent" feedback, briefly.
	const stepText = $derived(
		playback.feedback
			? `${playback.feedback.step === 1 ? 'Next' : 'Previous'} clip ${playback.feedback.ok ? 'sent' : 'not sent'}`
			: ''
	);

	// The intent comes from what the button showed when pressed, never a blind toggle.
	function playPause() {
		if (playing) playback.pause();
		else playback.play();
	}

	function ignoreRepeat(e: KeyboardEvent) {
		if (e.repeat) e.preventDefault();
	}
</script>

<section class="playback" aria-label="Clip playback">
	<p class="mode"><Icon name="clips" size={18} /> Playback</p>

	<div class="transport">
		<button
			class="side"
			class:sent={playback.feedback?.step === 0 && playback.feedback.ok}
			class:failed={playback.feedback?.step === 0 && !playback.feedback.ok}
			onclick={() => playback.previousClip()}
			onkeydown={ignoreRepeat}
			disabled={!!stepBlock}
			aria-label="Previous clip"
		>
			<Icon name="previous" size={30} />
		</button>
		<button
			class="main"
			class:pending={display === 'changing' && pendingSpeed !== null}
			onclick={playPause}
			onkeydown={ignoreRepeat}
			disabled={!!speedBlock}
			aria-label={playing ? 'Playing. Press to pause.' : 'Paused. Press to play.'}
		>
			<Icon name={playing ? 'pause' : 'play'} size={44} />
		</button>
		<button
			class="side"
			class:sent={playback.feedback?.step === 1 && playback.feedback.ok}
			class:failed={playback.feedback?.step === 1 && !playback.feedback.ok}
			onclick={() => playback.nextClip()}
			onkeydown={ignoreRepeat}
			disabled={!!stepBlock}
			aria-label="Next clip"
		>
			<Icon name="next" size={30} />
		</button>
	</div>

	<p class="status" class:error={display === 'error'} aria-live="polite">{status}</p>
	<p class="step" aria-live="polite">{stepText}</p>

	{#if playback.notice}
		<div class="msg" role="status">
			<span>{playbackNoticeText(playback.notice)}</span>
			<button class="small" onclick={() => playback.dismissNotice()}>OK</button>
		</div>
	{/if}

	<button class="exit" onclick={() => playback.exit()} onkeydown={ignoreRepeat} disabled={!!exitBlock}>
		Back to camera
	</button>
</section>

<style>
	.playback {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		width: 100%;
		max-width: 24rem;
	}
	.mode {
		margin: 0;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 4px 12px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--accent);
		font-size: 0.85rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.transport {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 20px;
		margin-top: 8px;
	}
	.transport button {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border-radius: 50%;
	}
	.side {
		width: 72px;
		height: 72px;
		background: var(--surface);
		border: 2px solid var(--border);
		transition: border-color 0.15s;
	}
	.side.sent {
		border-color: var(--accent);
	}
	.side.failed {
		border-color: var(--warn);
	}
	.main {
		width: 104px;
		height: 104px;
		background: var(--accent);
		border: 2px solid var(--accent);
		color: var(--on-accent);
	}
	.main.pending {
		background: var(--surface);
		color: var(--accent);
		border-style: dashed;
		animation: pulse 1s ease-in-out infinite;
		opacity: 1;
	}
	@keyframes pulse {
		50% {
			border-color: transparent;
		}
	}
	.status {
		margin: 0;
		min-height: 1.4em;
		color: var(--text);
		text-align: center;
	}
	.status.error {
		color: var(--warn);
	}
	.step {
		margin: -8px 0 0;
		min-height: 1.4em;
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
	}
	.small {
		min-height: var(--touch);
		padding: 0 12px;
	}
	.exit {
		margin-top: 8px;
		width: 100%;
		max-width: 18rem;
		min-height: 56px;
		font-weight: 600;
	}
	@media (max-height: 699px) {
		.playback {
			gap: 6px;
		}
		.step:empty {
			display: none;
		}
	}
	@media (max-height: 520px) {
		.playback {
			width: auto;
		}
		.main {
			width: 84px;
			height: 84px;
		}
		.side {
			width: 60px;
			height: 60px;
		}
		.exit {
			min-height: var(--touch);
		}
	}
</style>
