<script lang="ts">
	import { formatTimecode, type Timecode } from '#lib/protocol/index.ts';

	let { timecode, live }: { timecode: Timecode | null; live: boolean } = $props();
</script>

<div class="tc" class:stale={!live} aria-label="Timecode">
	{timecode ? formatTimecode(timecode) : '--:--:--:--'}
</div>

<style>
	.tc {
		font-family: var(--mono);
		font-size: clamp(2rem, 11vw, 3.5rem);
		font-variant-numeric: tabular-nums;
		text-align: center;
		letter-spacing: 0.02em;
	}
	.stale {
		color: var(--text-dim);
	}
</style>
