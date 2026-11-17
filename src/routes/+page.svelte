<script lang="ts">
	import { onMount } from 'svelte';
	import { CameraSession } from '#lib/domain/camera-session.svelte.ts';
	import { LocalKnownCameras } from '#lib/domain/known-cameras.ts';
	import { sessionConfigFromQuery } from '#lib/domain/url-config.ts';
	import { requestCameraLink, webBluetoothAvailable } from '#lib/transport/web-bluetooth-link.ts';
	import { detectOs, type Os } from '#lib/platform/detect.ts';
	import { updates } from '#lib/platform/updates.svelte.ts';
	import { LINUX_FLAG } from '#lib/ui/messages.ts';
	import CameraBar from '#lib/ui/components/CameraBar.svelte';
	import ConnectScreen from '#lib/ui/components/ConnectScreen.svelte';
	import RecordButton from '#lib/ui/components/RecordButton.svelte';
	import ClipsButton from '#lib/ui/components/ClipsButton.svelte';
	import PlaybackPanel from '#lib/ui/components/PlaybackPanel.svelte';
	import Timecode from '#lib/ui/components/Timecode.svelte';
	import ControlStrip from '#lib/ui/components/ControlStrip.svelte';
	import FormatLine from '#lib/ui/components/FormatLine.svelte';
	import PacketInspector from '#lib/ui/overlays/PacketInspector.svelte';

	let supported = $state<boolean | null>(null);
	let os = $state<Os>('other');
	let session = $state.raw<CameraSession | null>(null);
	let now = $state(Date.now());

	onMount(() => {
		os = detectOs();
		supported = webBluetoothAvailable();
		if (!supported) return;
		session = new CameraSession({
			requestLink: (options) => requestCameraLink(navigator.bluetooth, options),
			known: new LocalKnownCameras(),
			config: sessionConfigFromQuery(new URLSearchParams(location.search))
		});
	});

	const onCameraScreen = $derived(
		!!session && (session.phase === 'ready' || session.phase === 'standby' || session.phase === 'reconnecting')
	);
	const recording = $derived(session?.record.display === 'recording');
	const inPlayback = $derived(!!session?.playback.active);
	const connected = $derived(!!session && session.phase !== 'idle' && session.phase !== 'disconnected' && session.phase !== 'failed');

	// A new app version must not take over while a camera is connected.
	$effect(() => (connected ? updates.hold('camera connected') : undefined));

	// Notifications may have been missed while the tab was in the background.
	$effect(() => {
		const s = session;
		if (!s) return;
		const onVisibility = () => {
			if (document.visibilityState === 'visible') s.requestResync('tab visible');
		};
		document.addEventListener('visibilitychange', onVisibility);
		return () => document.removeEventListener('visibilitychange', onVisibility);
	});

	$effect(() => {
		if (session?.phase !== 'reconnecting') return;
		now = Date.now();
		const id = setInterval(() => (now = Date.now()), 500);
		return () => clearInterval(id);
	});

	const nextIn = $derived(
		session?.nextReconnectAt ? Math.max(0, Math.ceil((session.nextReconnectAt - now) / 1000)) : null
	);
</script>

<svelte:head>
	<title>{recording ? '● REC · MagicRemote' : 'MagicRemote'}</title>
</svelte:head>

<main class:rec={recording}>
	{#if supported === null}
		<p class="loading">Loading…</p>
	{:else if !supported}
		<section class="unsupported">
			<h1>MagicRemote</h1>
			<h2>This browser can't use Bluetooth</h2>
			<p>MagicRemote needs Web Bluetooth. Use Chrome or Edge on Windows, macOS, ChromeOS or Android.</p>
			<p>On Linux, Chrome or Chromium needs a flag first: open <code>{LINUX_FLAG}</code>, set it to Enabled, and restart the browser.</p>
			<p>Firefox and Safari do not support Web Bluetooth. On iPhone and iPad, the Bluefy browser may work.</p>
			<p class="disclaimer">MagicRemote is an independent project, not affiliated with or endorsed by Blackmagic Design.</p>
		</section>
	{:else if session && onCameraScreen}
		<CameraBar {session} />

		{#if session.record.alert}
			<div class="banner danger" role="alert">
				<strong>Recording stopped on the camera.</strong> The app did not ask for this stop.
				<button onclick={() => session?.record.dismissAlert()}>OK</button>
			</div>
		{/if}
		{#if session.phase === 'reconnecting'}
			<div class="banner warn" role="status">
				<span>
					Link lost. Reconnecting{session.step ? ` (${session.step})` : nextIn !== null ? `, next try in ${nextIn}s` : ''}…
					{session.reconnectAttempt > 0 ? `Attempt ${session.reconnectAttempt}.` : ''}
				</span>
				<span class="banner-actions">
					<button onclick={() => session?.reconnectNow()} disabled={session.busy}>Retry now</button>
					<button onclick={() => session?.disconnect()}>Stop</button>
				</span>
			</div>
		{:else if session.phase === 'standby'}
			<div class="banner warn" role="status">The camera is in standby. Switch it on at the camera.</div>
		{/if}
		{#if session.protocolWarning}
			<div class="banner warn">{session.protocolWarning}. Some controls may not work.</div>
		{/if}

		<div class="work">
		<div class="stage" class:playback={inPlayback}>
			<div class="readout">
				<Timecode timecode={session.state.timecode} live={session.live} />
				<FormatLine state={session.state} />
			</div>
			{#if inPlayback}
				<PlaybackPanel playback={session.playback} />
			{:else}
				<RecordButton record={session.record} remaining={session.state.activeRemaining} />
			{/if}
		</div>

		<!-- Exposure, colour and lens writes change the live camera, which nobody sees in playback. -->
		{#if !inPlayback}
			<ControlStrip controls={session.controls} state={session.state} />
		{/if}
		</div>

		<footer>
			<button onclick={() => session?.disconnect()}>Disconnect</button>
			{#if !inPlayback}
				<ClipsButton playback={session.playback} />
			{/if}
		</footer>
	{:else if session}
		<ConnectScreen {session} {os} />
	{/if}

	{#if session}
		<PacketInspector log={session.log} />
	{/if}
</main>

<style>
	main {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		border: 4px solid transparent;
	}
	main.rec {
		border-color: var(--rec);
		background: var(--rec-tint);
	}
	.loading {
		margin: auto;
		color: var(--text-dim);
	}
	.unsupported {
		max-width: 34rem;
		margin: 0 auto;
		padding: var(--pad);
	}
	.work {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.stage {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: clamp(8px, 2.5dvh, 24px);
		padding: clamp(8px, 2dvh, var(--pad)) var(--pad);
	}
	/* Short and wide (a phone on its side): readout and record on the left, controls on the right. */
	@media (max-height: 520px) and (min-width: 600px) {
		.work {
			flex-direction: row;
			align-items: center;
		}
		.work > :global(*) {
			flex: 1 1 0;
			min-width: 0;
		}
		.stage.playback {
			flex-direction: row;
			justify-content: space-evenly;
		}
	}
	.readout {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}
	.banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px var(--pad);
		border-bottom: 1px solid var(--border);
	}
	.banner.warn {
		background: rgb(246 194 68 / 0.15);
	}
	.banner.danger {
		background: var(--rec);
		color: #fff;
	}
	.banner-actions {
		display: flex;
		gap: 8px;
	}
	footer {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: clamp(8px, 2dvh, var(--pad)) var(--pad);
		padding-right: 84px;
	}
	.disclaimer {
		font-size: 0.8rem;
		color: var(--text-dim);
	}
</style>
