<script lang="ts">
	let { size = 40 }: { size?: number } = $props();
</script>

<span class="logo">
	<svg viewBox="8 6 50 50" width={size} height={size} aria-hidden="true">
		<path
			d="M34.66 16.61A18 18 0 1 0 47.39 29.34"
			fill="none"
			stroke="var(--accent)"
			stroke-width="5"
			stroke-linecap="round"
		/>
		<circle cx="30" cy="34" r="7.5" fill="var(--rec)" />
		<path d="M45 9Q46.8 17.2 55 19Q46.8 20.8 45 29Q43.2 20.8 35 19Q43.2 17.2 45 9Z" fill="var(--text)" />
	</svg>
	<span class="word">Magic<span class="thin">Remote</span></span>
</span>

<style>
	.logo {
		display: inline-flex;
		align-items: center;
		gap: 0.5em;
	}
	.word {
		font-weight: 700;
		letter-spacing: 0.01em;
	}
	.thin {
		font-weight: 300;
		color: var(--accent);
	}
</style>
