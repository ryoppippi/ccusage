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
			include: ['src/**/*.ts'],
			exclude: [
				'node_modules/**',
				'dist/**',
				'docs/**',
				'test/**',
				'**/*.config.*',
				'**/*.test.ts',
				'**/*.spec.ts',
				'src/commands/**', // CLI command files don't need coverage
				'src/index.ts',
			],
		},
	},
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing-fetcher.ts'],
		}),
	],
});
