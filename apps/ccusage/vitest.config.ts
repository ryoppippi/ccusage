import Macros from 'unplugin-macros/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		includeSource: [
			'src/**/*.{js,ts}',
			'scripts/compare-pr-performance.ts',
			'scripts/generate-large-fixture.ts',
		],
		globals: true,
	},
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing-fetcher.ts'],
		}) as any, // vitest bundles its own vite types, so relax plugin typing here
	],
});
