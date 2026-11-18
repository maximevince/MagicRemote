<script lang="ts">
	let { center = false }: { center?: boolean } = $props();

	const BMC_URL = 'https://www.buymeacoffee.com/maximevince';
</script>

<p class="support" class:center>
	<span class="lead">If you like this project, consider supporting me:</span>
	<a class="bmc" href={BMC_URL} target="_blank" rel="noopener noreferrer">
		<span class="cup" aria-hidden="true">☕</span>
		<span>Buy me a coffee</span>
	</a>
</p>

<style>
	.support {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 10px;
	}
	.support.center {
		flex-direction: column;
	}
	.lead {
		color: var(--text-dim);
		font-size: 0.85rem;
	}
	.bmc {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		background: #ffdd00;
		color: #0d0c22;
		text-decoration: none;
		font-weight: 700;
		font-size: 0.9rem;
		padding: 0.5rem 1rem;
		border-radius: var(--radius);
		border: 1px solid rgb(0 0 0 / 0.15);
		transition: transform 0.1s ease;
		touch-action: manipulation;
	}
	.bmc:hover {
		transform: translateY(-1px);
	}
	.cup {
		font-size: 1.1rem;
	}
</style>
