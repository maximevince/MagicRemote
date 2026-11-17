<script lang="ts">
	import type { CameraSession, HandshakeStep } from '#lib/domain/camera-session.svelte.ts';
	import type { Os } from '#lib/platform/detect.ts';
	import { failureText, hostBondRemoval, pinHint, STEP_LABEL } from '#lib/ui/messages.ts';

	let { session, os }: { session: CameraSession; os: Os } = $props();

	const STEPS: HandshakeStep[] = ['connecting', 'identifying', 'naming', 'pairing', 'subscribing', 'syncing'];

	/**
	 * The blocking "get ready for the PIN" step is only for re-pairing after a stale bond, where a
	 * PIN is certain. A normal connect cannot know beforehand whether the chosen camera is already
	 * bonded with this computer, so it goes straight to the chooser with a short note instead.
	 */
	let preparing = $state(false);
	let recovering = $state(false);
	let reuse = $state(false);

	const inProgress = $derived(session.phase === 'choosing' || session.step !== null);
	const failure = $derived(session.failure);
	const text = $derived(failure ? failureText(failure, os) : null);
	const stepIndex = $derived(session.step ? STEPS.indexOf(session.step) : -1);

	function prepare(options: { reuse: boolean; recovering?: boolean }) {
		reuse = options.reuse;
		recovering = options.recovering ?? false;
		preparing = true;
	}

	/** Runs in the click handler: the chooser needs the user gesture. */
	function start(reuseDevice: boolean) {
		void session.connect({ reuse: reuseDevice, recovered: false });
	}

	/** Runs in the click handler: the chooser needs the user gesture. */
	function go() {
		const options = { reuse, recovered: recovering };
		preparing = false;
		recovering = false;
		void session.connect(options);
	}
</script>

<section class="connect">
	<h1>MagicRemote</h1>

	{#if inProgress}
		<div class="card">
			<h2>{session.phase === 'choosing' ? 'Choose your camera in the dialog' : 'Connecting'}</h2>
			{#if session.step}
				<ol class="steps">
					{#each STEPS as s, i (s)}
						<li class:done={i < stepIndex} class:current={i === stepIndex}>{STEP_LABEL[s]}</li>
					{/each}
				</ol>
			{/if}
			{#if session.step === 'pairing'}
				<p class="pin">
					{session.known
						? 'Re-securing the link with the stored pairing. No PIN should be needed.'
						: 'If the camera shows a 6-digit PIN, type it into the dialog now (about 30 seconds).'}
				</p>
			{/if}
			<button onclick={() => session.disconnect()}>Cancel</button>
		</div>
	{:else if session.phase === 'bond-stale' && !preparing}
		<div class="card error">
			<h2>{text?.title}</h2>
			<p>{text?.body}</p>
			<p>To fix it, do both:</p>
			<ol>
				<li>{hostBondRemoval(os)}</li>
				<li>On the camera: Bluetooth settings, <strong>Clear paired devices</strong>.</li>
				<li>Then pair once more.</li>
			</ol>
			<button class="primary" onclick={() => prepare({ reuse: true, recovering: true })}>
				I've done both: pair again
			</button>
		</div>
	{:else if preparing}
		<div class="card">
			<h2>Get ready for the PIN</h2>
			<p>
				The camera will show a new 6-digit PIN. You'll have about 30 seconds to type it in. Each new try
				shows a new PIN.
			</p>
			<p class="hint">{pinHint(os)}</p>
			<div class="actions">
				<button class="primary" onclick={go}>I'm ready</button>
				<button
					onclick={() => {
						preparing = false;
						recovering = false;
					}}>Back</button
				>
			</div>
		</div>
	{:else}
		{#if text && failure?.kind !== 'bond-stale'}
			<div class="card" class:error={failure?.kind !== 'chooser-cancelled'} role="alert">
				<h2>{text.title}</h2>
				<p>{text.body}</p>
				{#if failure?.detail && failure.kind !== 'unexpected'}<p class="detail">{failure.detail}</p>{/if}
			</div>
		{/if}
		<div class="card">
			<p>Turn on the camera and enable Bluetooth in its setup menu.</p>
			<div class="actions">
				{#if session.hasDevice}
					<button class="primary" onclick={() => start(true)}>Connect again</button>
					<button onclick={() => start(false)}>Choose another camera</button>
				{:else}
					<button class="primary" onclick={() => start(false)}>Connect a camera</button>
				{/if}
			</div>
			<p class="hint first-time">
				Already paired with this computer? It connects without a PIN.
				{#if os === 'linux' || os === 'chromeos'}
					First time: {pinHint(os)}
				{:else}
					First time: the camera shows a 6-digit PIN and you have about 30 seconds to type it in.
					{pinHint(os)}
				{/if}
			</p>
		</div>
	{/if}

	<p class="disclaimer">
		MagicRemote is an independent project, not affiliated with or endorsed by Blackmagic Design.
	</p>
</section>

<style>
	.connect {
		max-width: 34rem;
		margin: 0 auto;
		padding: var(--pad);
		display: flex;
		flex-direction: column;
		gap: var(--gap);
	}
	h1 {
		margin: 8px 0;
		font-size: 1.5rem;
	}
	h2 {
		margin: 0 0 8px;
		font-size: 1.15rem;
	}
	.card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--pad);
	}
	.card.error {
		border-color: var(--danger);
	}
	.card p {
		margin: 0 0 12px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.hint {
		color: var(--text-dim);
	}
	.card p.first-time {
		margin: 12px 0 0;
		font-size: 0.9rem;
	}
	.detail {
		font-family: var(--mono);
		font-size: 0.85rem;
		color: var(--text-dim);
	}
	.pin {
		font-weight: 600;
		color: var(--warn);
	}
	.steps {
		margin: 0 0 12px;
		padding-left: 1.4rem;
		color: var(--text-dim);
	}
	.steps li.done {
		color: var(--ok);
	}
	.steps li.current {
		color: var(--text);
		font-weight: 600;
	}
	.disclaimer {
		font-size: 0.8rem;
		color: var(--text-dim);
	}
</style>
