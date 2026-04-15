import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'bun:sqlite': new URL('./src/_sqlite-node.ts', import.meta.url).pathname,
		},
	},
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
});
