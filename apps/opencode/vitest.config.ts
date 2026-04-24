import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		includeSource: ['src/**/*.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
		},
	},
	define: {
		'import.meta.vitest': 'undefined',
	},
	resolve: {
		alias: {
			// bun:sqlite is a Bun built-in; stub it for Vitest (Node.js) test runs
			'bun:sqlite': new URL('./src/__mocks__/bun-sqlite.ts', import.meta.url).pathname,
		},
	},
});
