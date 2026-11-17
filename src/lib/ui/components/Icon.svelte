<script lang="ts" module>
	export type IconName =
		| 'iso'
		| 'shutter'
		| 'iris'
		| 'wb'
		| 'focus'
		| 'autofocus'
		| 'clips'
		| 'play'
		| 'pause'
		| 'stop'
		| 'previous'
		| 'next';
</script>

<script lang="ts">
	let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

<svg
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if name === 'iso'}
		<!-- sensitivity: a light source -->
		<circle cx="12" cy="12" r="3.6" />
		<path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
	{:else if name === 'shutter'}
		<!-- rotary shutter: a disc with an open sector -->
		<circle cx="12" cy="12" r="9" />
		<path d="M12 12V3a9 9 0 0 1 9 9z" fill="currentColor" stroke="none" />
		<path d="M12 12V3M12 12h9" />
	{:else if name === 'iris'}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7.4l8.98 5.19M15.98 9.7v10.37M15.98 14.3L7 19.49M12 16.6l-8.98-5.19M8.02 14.3V3.93M8.02 9.7L17 4.51" stroke-width="1.5" />
	{:else if name === 'wb'}
		<!-- colour temperature -->
		<path d="M10 13.6V5a2 2 0 0 1 4 0v8.6a4 4 0 1 1-4 0z" />
		<circle cx="12" cy="17" r="1.4" fill="currentColor" stroke="none" />
		<path d="M12 15.6V9" />
	{:else if name === 'focus'}
		<!-- focus ring -->
		<circle cx="12" cy="12" r="9" />
		<circle cx="12" cy="12" r="4.5" />
		<path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21" />
	{:else if name === 'autofocus'}
		<path d="M3.5 8.5v-5h5M15.5 3.5h5v5M20.5 15.5v5h-5M8.5 20.5h-5v-5" />
		<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
	{:else if name === 'clips'}
		<rect x="3" y="5" width="18" height="14" rx="2" />
		<path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" />
	{:else if name === 'play'}
		<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
	{:else if name === 'pause'}
		<path d="M8 5v14M16 5v14" stroke-width="3.4" />
	{:else if name === 'stop'}
		<rect x="5.5" y="5.5" width="13" height="13" rx="1.5" fill="currentColor" />
	{:else if name === 'previous'}
		<path d="M19 5v14L8.5 12z" fill="currentColor" />
		<path d="M5.5 5v14" stroke-width="2.4" />
	{:else if name === 'next'}
		<path d="M5 5v14l10.5-7z" fill="currentColor" />
		<path d="M18.5 5v14" stroke-width="2.4" />
	{/if}
</svg>

<style>
	svg {
		flex: none;
		display: block;
	}
</style>
