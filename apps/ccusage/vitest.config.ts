import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		includeSource: [
			'src/cli.ts',
			'scripts/compare-pr-performance.ts',
			'scripts/generate-large-fixture.ts',
			'scripts/sync-rust-version.ts',
		],
		globals: true,
	},
});
