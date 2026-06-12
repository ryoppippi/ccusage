import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		includeSource: ['src/cli.ts', 'scripts/generate-large-fixture.ts'],
		globals: true,
	},
});
