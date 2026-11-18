<script lang="ts">
	import type { CameraSession, HandshakeStep } from '#lib/domain/camera-session.svelte.ts';
	import HelpDialog from '#lib/ui/components/HelpDialog.svelte';
	import Logo from '#lib/ui/components/Logo.svelte';
	import SupportLink from '#lib/ui/components/SupportLink.svelte';
	import type { Os } from '#lib/platform/detect.ts';
	import { VERSION_LABEL } from '#lib/platform/version.ts';
	import {
		disconnectNote,
		failureText,
		hostBondRemoval,
		pinHint,
		staleBondHostCauses,
		STEP_LABEL
	} from '#lib/ui/messages.ts';

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
	let help = $state(false);

	const inProgress = $derived(session.phase === 'choosing' || session.step !== null);
	const failure = $derived(session.failure);
	const text = $derived(failure ? failureText(failure, os) : null);
	const stepIndex = $derived(session.step ? STEPS.indexOf(session.step) : -1);
	/** The start screen: nothing in progress, no re-pairing flow open. */
	const splash = $derived(!inProgress && !preparing && session.phase !== 'bond-stale');
	/** After the user's own Disconnect (or Cancel): no failure attached. */
	const note = $derived(session.phase === 'disconnected' && !failure ? disconnectNote(os) : null);

	function prepare(options: { reuse: boolean; recovering?: boolean }) {
		reuse = options.reuse;
		recovering = options.recovering ?? false;
		preparing = true;
	}

	/** Runs in the click handler: the chooser needs the user gesture. */
	function start(reuseDevice: boolean) {
		void session.connect({ reuse: reuseDevice, recovered: false });
	}

	/** Tries the stored pairing again; the camera stays known, so nothing pairs on its own. */
	function retry(reuseDevice: boolean) {
		void session.connect({ reuse: reuseDevice, retry: true });
	}

	/** Runs in the click handler: the chooser needs the user gesture. */
	function go() {
		const options = { reuse, recovered: recovering };
		preparing = false;
		recovering = false;
		void session.connect(options);
	}
</script>

<section class="connect" class:splash>
	<header>
		{#if !splash}<h1><Logo size={44} /></h1>{/if}
		<button class="help" aria-label="Help" aria-haspopup="dialog" onclick={() => (help = true)}>?</button>
	</header>

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
			<p>Try again first. The app does not pair or remove anything when it retries.</p>
			<div class="actions">
				<button class="primary" onclick={() => retry(true)}>Try again</button>
				<button onclick={() => retry(false)}>Choose the camera again</button>
			</div>
			<p class="step">If that fails, check this device:</p>
			<ul>
				{#each staleBondHostCauses(os) as cause (cause)}
					<li>{cause}</li>
				{/each}
			</ul>
			<p class="step">
				Last resort, only if nothing above helped: remove the pairing on both sides, then pair again with
				a new PIN.
			</p>
			<ol>
				<li>{hostBondRemoval(os)}</li>
				<li>
					On the camera: Bluetooth settings, <strong>Clear paired devices</strong>. This removes every
					pairing on the camera.
				</li>
			</ol>
			<button onclick={() => prepare({ reuse: true, recovering: true })}>Removed on both sides: pair again</button>
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
		<div class="hero">
			<h1 class="name"><Logo size={64} /></h1>
			<p class="tag">Remote control for Blackmagic cinema cameras, over Bluetooth.</p>
			<p class="desc">
				Start and stop recording, set ISO, shutter, iris, white balance and focus, and play back clips,
				with timecode, battery and media always in view. Free, open-source, and fully in your browser:
				nothing to install.
			</p>
		</div>
		<div class="start">
			{#if note}
				<p class="note" role="status">
					Disconnected. This computer may still hold the Bluetooth link.
					<button class="link" onclick={() => (help = true)}>Free the camera</button>
				</p>
			{/if}
			{#if text && failure?.kind !== 'bond-stale'}
				<div class="card" class:error={failure?.kind !== 'chooser-cancelled'} role="alert">
					<h2>{text.title}</h2>
					<p>{text.body}</p>
					{#if failure?.detail && failure.kind !== 'unexpected'}<p class="detail">{failure.detail}</p>{/if}
				</div>
			{/if}
			<div class="actions">
				{#if session.hasDevice}
					<button class="primary" onclick={() => start(true)}>Connect again</button>
					<button onclick={() => start(false)}>Choose another camera</button>
				{:else}
					<button class="primary" onclick={() => start(false)}>Connect a camera</button>
				{/if}
			</div>
			<p class="ready">
				Turn on the camera and enable Bluetooth in its setup menu.
				<button class="link" onclick={() => (help = true)}>First time connecting?</button>
			</p>
			<div class="bmc-row">
				<SupportLink center />
			</div>
		</div>
	{/if}

	<p class="version">{VERSION_LABEL}</p>

	<HelpDialog {os} bind:open={help} />
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
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 8px 0;
	}
	h1 {
		margin: 0;
		font-size: 1.5rem;
	}
	.help {
		margin-left: auto;
		width: 44px;
		height: 44px;
		padding: 0;
		border-radius: 50%;
		font-weight: 700;
		color: var(--text-dim);
	}
	.help:hover {
		color: var(--accent);
		border-color: var(--accent);
	}
	.link {
		min-height: 0;
		padding: 4px 0;
		background: none;
		border: none;
		color: var(--text-dim);
		font-size: 0.9rem;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.note {
		margin: 0;
		color: var(--text-dim);
		font-size: 0.9rem;
	}
	.link:hover {
		color: var(--accent);
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
	.card p.step {
		margin-top: 16px;
	}
	.card ul,
	.card ol {
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
	/* Start screen: one centred column, with the help button in the window corner. */
	.connect.splash {
		position: relative;
		flex: 1;
		width: 100%;
		max-width: none;
		gap: 0;
		padding-top: calc(44px + 2 * var(--pad));
	}
	.connect.splash > header {
		position: absolute;
		top: var(--pad);
		right: var(--pad);
		margin: 0;
	}
	.hero,
	.start {
		width: 100%;
		max-width: 27rem;
		margin-inline: auto;
		text-align: center;
	}
	.hero {
		margin-top: auto;
	}
	.hero .name {
		display: flex;
		justify-content: center;
		font-size: clamp(1.5rem, 8vw, 2rem);
	}
	.tag {
		margin: 16px 0 0;
		font-weight: 600;
		text-wrap: balance;
	}
	.desc {
		margin: 10px 0 0;
		color: var(--text-dim);
		font-size: 0.92rem;
		line-height: 1.6;
		text-wrap: pretty;
	}
	.start {
		margin-top: 28px;
		margin-bottom: auto;
	}
	.start > .note,
	.start > .card {
		margin-bottom: var(--gap);
		text-align: left;
	}
	.start .actions {
		justify-content: center;
	}
	.start .primary {
		padding: 0.7rem 1.6rem;
		font-weight: 700;
	}
	.ready {
		margin: 14px 0 0;
		color: var(--text-dim);
		font-size: 0.85rem;
		line-height: 1.5;
		text-wrap: balance;
	}
	.ready .link {
		padding: 0;
		font-size: inherit;
	}
	.bmc-row {
		margin-top: 28px;
		padding-top: 20px;
		border-top: 1px solid var(--border);
	}
	.connect.splash > .version {
		margin-top: 24px;
	}
	/* Short windows: tighter, so the buttons stay on screen. */
	@media (max-height: 520px) {
		.connect.splash {
			padding-top: var(--pad);
		}
		.hero .name {
			font-size: 1.5rem;
		}
		.tag {
			margin-top: 10px;
		}
		.desc {
			margin-top: 6px;
		}
		.start,
		.bmc-row {
			margin-top: 16px;
		}
		.bmc-row {
			padding-top: 14px;
		}
		.connect.splash > .version {
			margin-top: 12px;
		}
	}
	/* Short and wide (a phone on its side): description on the left, buttons on the right. */
	@media (max-height: 520px) and (min-width: 600px) {
		.connect.splash {
			display: grid;
			grid-template-columns: minmax(0, 25rem) minmax(0, 19rem);
			grid-template-rows: 1fr auto;
			justify-content: center;
			align-items: center;
			column-gap: calc(3 * var(--pad));
		}
		.connect.splash > .hero,
		.connect.splash > .start {
			margin: 0;
		}
		.connect.splash > .version {
			grid-column: 1 / -1;
		}
	}
	.version {
		margin: 0;
		text-align: center;
		font-family: var(--mono);
		font-size: 0.75rem;
		color: var(--text-dim);
		opacity: 0.7;
	}
</style>
