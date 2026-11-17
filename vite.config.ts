import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// GitHub Pages serves the app under /<repo>; the deploy workflow passes it in (configure-pages base_path).
const base = (process.env.BASE_PATH ?? '') as '' | `/${string}`;

// The version lives in package.json only; the commit comes from CI or the local checkout.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
	version: string;
};

function commit(): string {
	if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
	try {
		const git = (args: string) => execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
		return git('rev-parse --short=7 HEAD') + (git('status --porcelain') ? '+' : '');
	} catch {
		return '';
	}
}

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(version),
		__APP_COMMIT__: JSON.stringify(commit())
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: '404.html' }),
			paths: { base },
		})
	],
	ssr: {
		// Kit's `cookie` dependency is bundled when it can't be resolved from the project root
		// (pnpm doesn't hoist it). A stray node_modules in a parent directory can make Node find
		// an older, CommonJS `cookie` instead, which breaks prerendering; always bundle it.
		noExternal: ['cookie']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				ssr: { noExternal: ['cookie'] },
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
