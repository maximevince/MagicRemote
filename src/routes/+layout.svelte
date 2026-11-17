<script lang="ts">
	import '#lib/ui/tokens.css';
	import { onMount } from 'svelte';
	import { dev } from '$app/env';
	import { resolve } from '$app/paths';
	import { updates } from '#lib/platform/updates.svelte.ts';
	import UpdateNotice from '#lib/ui/components/UpdateNotice.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	onMount(() => {
		void updates.start({
			container: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
			// The worker sits at the base path, so its default scope is the whole app.
			scriptUrl: `${resolve('/')}service-worker.js`,
			dev,
			reload: () => location.reload()
		});
		// Coming back to the app is a good moment to look for a new version (it only installs).
		const onVisible = () => {
			if (document.visibilityState === 'visible') void updates.check();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});
</script>

{@render children()}

<UpdateNotice {updates} />
