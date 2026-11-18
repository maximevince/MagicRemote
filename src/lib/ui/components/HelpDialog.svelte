<script lang="ts">
	import type { Os } from '#lib/platform/detect.ts';
	import { VERSION_LABEL } from '#lib/platform/version.ts';
	import { disconnectNote, pinHint } from '#lib/ui/messages.ts';
	import SupportLink from '#lib/ui/components/SupportLink.svelte';

	let { os, open = $bindable(false) }: { os: Os; open?: boolean } = $props();

	let dialog = $state<HTMLDialogElement>();
	const note = $derived(disconnectNote(os));
	const linux = $derived(os === 'linux' || os === 'chromeos');

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	aria-labelledby="help-title"
	onclose={() => (open = false)}
	onclick={(e) => {
		if (e.target === dialog) open = false;
	}}
>
	<div class="sheet">
		<header>
			<h2 id="help-title">Help</h2>
			<button class="close" aria-label="Close help" onclick={() => (open = false)}>✕</button>
		</header>

		<section>
			<h3>Before you connect</h3>
			<ul>
				<li>Turn the camera on.</li>
				<li>On the camera, open the setup menu and turn Bluetooth on.</li>
				<li>Use Chrome or Edge. Other browsers have no Web Bluetooth.</li>
			</ul>
		</section>

		<section>
			<h3>First time: pairing</h3>
			{#if linux}
				<p>Chrome on Linux cannot ask for the PIN, so pair once in a terminal first:</p>
				<ol>
					<li><code>bluetoothctl</code></li>
					<li><code>agent KeyboardOnly</code>, then <code>default-agent</code></li>
					<li><code>scan on</code> and wait for the camera to appear</li>
					<li><code>pair &lt;camera address&gt;</code></li>
					<li>Type the 6-digit PIN the camera shows. You have about 30 seconds.</li>
				</ol>
				<p>GNOME Settings cannot pair this camera. After pairing, connect here.</p>
			{:else}
				<p>
					The camera shows a 6-digit PIN and you have about 30 seconds to type it in. Each new try shows
					a new PIN.
				</p>
				<p>{pinHint(os)}</p>
			{/if}
		</section>

		<section>
			<h3>After that</h3>
			<p>The pairing is kept on both sides. Connecting again needs no PIN.</p>
			{#if note}
				<p>{note}</p>
			{:else}
				<p>
					The camera takes one Bluetooth controller at a time. Disconnect other remotes before connecting
					here.
				</p>
			{/if}
		</section>

		<div class="support">
			<SupportLink />
		</div>

		<footer>
			<p>MagicRemote is an independent project, not affiliated with or endorsed by Blackmagic Design.</p>
			<p class="version">{VERSION_LABEL}</p>
		</footer>
	</div>
</dialog>

<style>
	dialog {
		width: min(32rem, calc(100vw - 2 * var(--pad)));
		max-height: calc(100dvh - 2 * var(--pad));
		padding: 0;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.6);
	}
	.sheet {
		padding: var(--pad);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 4px;
	}
	h2 {
		margin: 0;
		font-size: 1.15rem;
	}
	h3 {
		margin: 16px 0 6px;
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent);
	}
	p {
		margin: 0 0 8px;
	}
	ul,
	ol {
		margin: 0 0 8px;
		padding-left: 1.3rem;
	}
	li {
		margin-bottom: 4px;
	}
	code {
		font-family: var(--mono);
		font-size: 0.9em;
		background: var(--surface-2);
		padding: 1px 5px;
		border-radius: var(--radius-sm);
	}
	.close {
		min-width: 44px;
		min-height: 44px;
		padding: 0;
		background: none;
		border-color: transparent;
	}
	.support {
		margin-top: 16px;
	}
	footer {
		margin-top: 16px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
		font-size: 0.8rem;
		color: var(--text-dim);
	}
	.version {
		margin: 0;
		font-family: var(--mono);
	}
</style>
