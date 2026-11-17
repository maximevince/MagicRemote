<script lang="ts">
	import type { CameraState } from '#lib/domain/camera-state.svelte.ts';
	import { formatCodec, formatDynamicRange, formatRecordingFormat } from '#lib/ui/control-format.ts';

	let { state: cam }: { state: CameraState } = $props();

	// Read-only: what the camera last reported, dimmed while it is not current.
	const parts = $derived(
		[
			cam.codec.confirmed ? formatCodec(cam.codec.confirmed) : null,
			cam.recordingFormat.confirmed ? formatRecordingFormat(cam.recordingFormat.confirmed) : null,
			cam.dynamicRange.confirmed !== undefined ? formatDynamicRange(cam.dynamicRange.confirmed) : null
		].filter((p): p is string => !!p)
	);
	const fresh = $derived(cam.codec.fresh || cam.recordingFormat.fresh || cam.dynamicRange.fresh);
</script>

<p class="format" class:stale={!fresh} aria-label="Recording format">
	{parts.length ? parts.join(' · ') : 'Format --'}
</p>

<style>
	.format {
		margin: 0;
		text-align: center;
		font-size: 0.9rem;
		color: var(--text);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.02em;
	}
	.stale {
		color: var(--text-dim);
	}
</style>
