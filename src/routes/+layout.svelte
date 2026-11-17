<script lang="ts">
	import '#lib/ui/tokens.css';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

{@render children()}
