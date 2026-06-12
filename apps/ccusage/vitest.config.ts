import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		includeSource: ['src/cli.ts'],
		globals: true,
	},
});
