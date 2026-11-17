<script lang="ts">
	import type { RecordController } from '#lib/domain/record-controller.svelte.ts';
	import type { RemainingTime } from '#lib/domain/camera-state.svelte.ts';
	import { formatRemaining } from '#lib/ui/format.ts';
	import { noticeText, recordErrorText } from '#lib/ui/messages.ts';

	let { record, remaining }: { record: RecordController; remaining: RemainingTime | null } = $props();

	const display = $derived(record.display);

	// The intent comes from what the button showed when pressed, never a blind toggle.
	function press() {
		if (display === 'recording') record.stop();
		else if (display === 'preview' || display === 'playback') record.start();
	}

	function ignoreRepeat(e: KeyboardEvent) {
		if (e.repeat) e.preventDefault();
	}

	const LABEL: Record<string, string> = {
		preview: 'REC',
		playback: 'REC',
		starting: 'Starting…',
		recording: 'STOP',
		stopping: 'Stopping…',
		syncing: 'Syncing…'
	};
</script>

<div class="record">
	{#if display === 'unknown'}
		<div class="split" aria-label="Recording state unknown">
			<button class="half start" onclick={() => record.start()} onkeydown={ignoreRepeat}>Start</button>
			<button class="half stop" onclick={() => record.stop()} onkeydown={ignoreRepeat}>Stop</button>
		</div>
		<p class="state">Recording state unknown</p>
	{:else if display === 'error' && record.error}
		<div class="errorbox" role="alert">
			<p>{recordErrorText(record.error)}</p>
			<button class="primary" onclick={() => (record.error?.intent === 'stop' ? record.stop() : record.start())}>
				Retry {record.error.intent}
			</button>
		</div>
	{:else}
		<button
			class="main {display}"
			onclick={press}
			onkeydown={ignoreRepeat}
			disabled={display === 'starting' || display === 'stopping' || display === 'syncing'}
			aria-label={display === 'recording'
				? 'Recording. Press to stop.'
				: display === 'syncing'
					? 'Reading the recording state from the camera.'
					: `${display}. Press to record.`}
		>
			<span class="dot" aria-hidden="true"></span>{LABEL[display]}
		</button>
		<p class="state">
			{display === 'recording'
				? 'Recording'
				: display === 'playback'
					? 'Playback'
					: display === 'preview'
						? 'Standing by'
						: display === 'syncing'
							? 'Reading camera state'
							: ''}
		</p>
	{/if}

	<p class="remaining">Remaining: {remaining ? formatRemaining(remaining) : '--'}</p>

	{#if record.notice}
		<div class="notice" class:warn={record.notice.kind !== 'media-unknown'}>
			<span>{noticeText(record.notice)}</span>
			<button class="small" onclick={() => record.dismissNotice()}>OK</button>
		</div>
	{/if}
</div>

<style>
	.record {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}
	.record {
		/* The button gives way first when the window is small, but stays the largest target. */
		--rec-size: clamp(6rem, min(60vw, 26dvh), 16rem);
	}
	@media (min-width: 600px) {
		/* The controls take one row here, or sit beside the button on a short window. */
		.record {
			--rec-size: clamp(6rem, min(60vw, 36dvh), 16rem);
		}
	}
	@media (max-height: 599px) and (max-width: 599px) {
		.record {
			--rec-size: clamp(5.5rem, min(60vw, 19dvh), 16rem);
		}
	}
	.main {
		width: var(--rec-size);
		height: var(--rec-size);
		flex: none;
		border-radius: 50%;
		font-size: clamp(1.05rem, calc(var(--rec-size) / 9), 1.6rem);
		font-weight: 700;
		letter-spacing: 0.08em;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		border: 4px solid var(--border);
		background: var(--surface);
	}
	.main .dot {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--rec);
		flex: none;
	}
	.main.recording {
		background: var(--rec);
		border-color: var(--rec);
		color: #fff;
	}
	.main.recording .dot {
		border-radius: 3px;
		background: #fff;
	}
	.main.syncing {
		border-style: dashed;
	}
	.main.starting,
	.main.stopping {
		border-color: var(--rec);
		border-style: dashed;
		animation: pulse 1s ease-in-out infinite;
		opacity: 1;
	}
	@keyframes pulse {
		50% {
			border-color: transparent;
		}
	}
	.split {
		display: flex;
		gap: 12px;
	}
	.half {
		width: min(8rem, 38vw);
		height: min(8rem, 38vw);
		border-radius: var(--radius);
		border: 3px dashed var(--text-dim);
		font-size: 1.2rem;
		font-weight: 700;
	}
	.state,
	.remaining {
		margin: 0;
		color: var(--text-dim);
		font-variant-numeric: tabular-nums;
	}
	.errorbox {
		border: 2px solid var(--danger);
		border-radius: var(--radius);
		padding: var(--pad);
		max-width: 24rem;
		text-align: center;
	}
	.errorbox p {
		margin: 0 0 12px;
	}
	.notice {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		max-width: 28rem;
	}
	.notice.warn {
		border: 1px solid var(--warn);
	}
	.small {
		min-height: var(--touch);
		padding: 0 12px;
	}
	@media (max-height: 699px) {
		/* The button label and the camera bar already say both. */
		.state,
		.remaining {
			display: none;
		}
	}
</style>
