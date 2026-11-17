/// <reference types="web-bluetooth" />
// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	/** From package.json, set at build time (vite.config.ts). */
	const __APP_VERSION__: string;
	/** Short commit hash of the build, with a trailing + for uncommitted changes; empty if unknown. */
	const __APP_COMMIT__: string;
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
