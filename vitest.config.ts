import Macros from 'unplugin-macros/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		includeSource: ['src/**/*.{js,ts}'],
		globals: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'lcov', 'html'],
			exclude: [
				'node_modules/**',
				'test/**',
				'*.config.ts',
				'*.config.js',
				'src/**/*.test.ts',
				'src/**/*.spec.ts',
			],
		},
	},
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing-fetcher.ts'],
		}),
	],
});
